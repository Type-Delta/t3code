import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import { FetchHttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  emptyGatewayConfig,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_PAIRING_DIR_ENV,
  GatewayPendingPairing,
} from "./GatewayConfig.ts";
import {
  buildGatewayPairingLinks,
  gatewayPairingOrigin,
  pairThroughGateway,
  registerPendingPairing,
} from "./gatewayPairing.ts";

it.effect(
  "builds tagged web and app links and uses only a private address for a wildcard listener",
  () =>
    Effect.gen(function* () {
      const origin = yield* gatewayPairingOrigin({
        ...emptyGatewayConfig,
        publicUrl: "http://t3.example/",
      });
      const { pairingUrl, appLink } = buildGatewayPairingLinks(origin, "alice", "a+b/c=");

      assert.equal(pairingUrl, "http://t3.example/pair?u=alice#token=a%2Bb%2Fc%3D");
      assert.equal(new URL(appLink).searchParams.get("pairingUrl"), pairingUrl);
      assert.equal(new URL(appLink).protocol, "t3code:");
      assert.equal(new URL(appLink).hostname, "pair");
      const missingOrigin = yield* Effect.flip(gatewayPairingOrigin(emptyGatewayConfig, {}));
      assert.include(missingOrigin.message, "reachable HTTP origin");

      const discovered = yield* gatewayPairingOrigin(emptyGatewayConfig, {
        eth0: [
          {
            address: "192.168.1.2",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "192.168.1.2/24",
          },
        ],
      });
      assert.equal(discovered.origin, "http://192.168.1.2:3773");
    }),
);

const decodePending = Schema.decodeEffect(Schema.fromJsonString(GatewayPendingPairing));

it.effect.each([
  { ttl: "3600001ms", publicUrl: "http://t3.example/", message: "TTL cannot exceed 1h" },
  { ttl: "1h", publicUrl: "https://t3.example/", message: "HTTPS is unsupported" },
])("rejects invalid gateway pairing options before contacting the backend ($message)", (input) =>
  Effect.gen(function* () {
    const config = {
      ...emptyGatewayConfig,
      publicUrl: input.publicUrl,
      users: { alice: { uid: 1001, port: 3801 } },
    };
    const error = yield* Effect.flip(
      pairThroughGateway(input.ttl).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.UserId, 1001),
        Effect.provideService(HostProcess.Username, "alice"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.succeed(JSON.stringify(config)),
            access: () => Effect.die("Pairing reached filesystem access before validation"),
          }),
        ),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
      ),
    );
    assert.include(error.message, input.message);
  }),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Digest.layerWebCrypto))(
  "pending pairing",
  (it) => {
    it.effect("asks an admin to repair a missing user folder before minting a token", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pairingDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-pairing-" });
        const configPath = path.join(pairingDir, "gateway.json");
        yield* fs.writeFileString(
          configPath,
          JSON.stringify({
            ...emptyGatewayConfig,
            publicUrl: "http://t3.example/",
            users: { alice: { uid: 1001, port: 3801 } },
          }),
        );
        const error = yield* Effect.flip(
          pairThroughGateway().pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.UserId, 1001),
            Effect.provideService(HostProcess.Username, "alice"),
            Effect.provideService(HostProcess.HomeDirectory, pairingDir),
            Effect.provideService(HostProcess.Environment, {
              [GATEWAY_CONFIG_PATH_ENV]: configPath,
              [GATEWAY_PAIRING_DIR_ENV]: pairingDir,
            }),
            Effect.provide(NetService.layer),
          ),
        );
        assert.include(error.message, "ask an admin to run t3 gateway add alice");
        assert.isFalse(yield* fs.exists(path.join(pairingDir, "alice")));
      }),
    );

    it.effect(
      "publishes a readable marker and removes only expired markers owned by the caller",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-pairing-" });
          const pairingRoot = path.join(root, "pairing");
          const pairingDir = path.join(pairingRoot, "alice");
          const configPath = path.join(root, "gateway.json");
          const baseDir = path.join(root, ".t3");
          yield* fs.makeDirectory(pairingDir, { recursive: true });
          const uid = (yield* HostProcess.UserId)!;
          const pairingUid = uid || 1001;
          const port = 3801;
          yield* fs.writeFileString(
            configPath,
            JSON.stringify({
              ...emptyGatewayConfig,
              publicUrl: "http://t3.example/",
              users: { alice: { uid: pairingUid, port } },
            }),
          );
          yield* persistServerRuntimeState({
            path: path.join(baseDir, "userdata", "server-runtime.json"),
            state: yield* makePersistedServerRuntimeState({
              config: { host: "127.0.0.1", devUrl: undefined },
              port,
            }),
          });
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const pairing = yield* pairThroughGateway("1s").pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.UserId, pairingUid),
            Effect.provideService(HostProcess.Username, "alice"),
            Effect.provideService(HostProcess.HomeDirectory, root),
            Effect.provideService(HostProcess.Environment, {
              [GATEWAY_CONFIG_PATH_ENV]: configPath,
              [GATEWAY_PAIRING_DIR_ENV]: pairingRoot,
            }),
            Effect.provideService(FetchHttpClient.Fetch, async (input) => {
              assert.equal(String(input), "http://127.0.0.1:3801/.well-known/t3/environment");
              return Response.json({
                environmentId: "gateway-pairing-test",
                label: "alice",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.1",
                orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                capabilities: { repositoryIdentity: true },
              });
            }),
            Effect.provide(NetService.layer),
          );
          assert.match(pairing.pairingUrl, /^http:\/\/t3\.example\/pair\?u=alice#token=[A-Z2-9]+$/);
          assert.isFalse(yield* fs.exists(path.join(baseDir, "gateway-pairing")));
          assert.deepEqual(yield* fs.readDirectory(pairingRoot), ["alice"]);

          const names = yield* fs.readDirectory(pairingDir);
          assert.lengthOf(names, 1);
          const firstName = names[0]!;
          assert.match(firstName, /^[\da-f-]{36}\.json$/);
          const first = path.join(pairingDir, firstName);
          const info = yield* fs.lstat(first);
          assert.equal(info.mode & 0o777, 0o644);
          assert.equal(Option.getOrUndefined(info.uid), uid);
          const token = new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1)).get(
            "token",
          )!;
          const digest = yield* Digest.Digest;
          assert.deepEqual(yield* decodePending(yield* fs.readFileString(first)), {
            version: 1,
            expiresAt: DateTime.toEpochMillis(pairing.expiresAt),
            tokenSha256: yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(token)),
          });

          const secondExpiry = now + 5_000;
          yield* registerPendingPairing({
            directory: pairingDir,
            uid,
            expiresAt: secondExpiry,
            token: "other",
          });
          assert.isTrue(yield* fs.exists(first));

          yield* TestClock.adjust("1 second");
          const otherExpired = path.join(pairingDir, "00000000-0000-0000-0000-000000000000.json");
          yield* fs.writeFileString(
            otherExpired,
            JSON.stringify({ version: 1, expiresAt: DateTime.toEpochMillis(pairing.expiresAt) }),
          );
          yield* registerPendingPairing({
            directory: pairingDir,
            uid,
            expiresAt: secondExpiry,
            token: "other",
          });

          assert.isFalse(yield* fs.exists(first));
          assert.isFalse(yield* fs.exists(otherExpired));
          assert.lengthOf(yield* fs.readDirectory(pairingDir), 2);

          const liveMarker = yield* fs.readFileString(
            path.join(pairingDir, (yield* fs.readDirectory(pairingDir))[0]!),
          );
          for (let index = 0; index < 62; index++) {
            const name = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}.json`;
            yield* fs.writeFileString(path.join(pairingDir, name), liveMarker);
          }
          const overflow = yield* Effect.flip(
            registerPendingPairing({
              directory: pairingDir,
              uid,
              expiresAt: secondExpiry,
              token: "overflow",
            }),
          );
          assert.match(overflow.message, /64 pending pairings/);
          assert.lengthOf(yield* fs.readDirectory(pairingDir), 64);
        }),
    );
  },
);
