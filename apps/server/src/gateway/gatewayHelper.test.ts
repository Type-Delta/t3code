// @effect-diagnostics nodeBuiltinImport:off -- real loopback HTTP is the protocol under test.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  GATEWAY_HELPER_HEADER,
  GatewayHelperError,
  GatewayHelperStatus,
  GatewayHelperUpdateState,
} from "@t3tools/contracts";
import { cliReleaseAssetUrl } from "@t3tools/shared/cliRelease";
import { gatewayHostFiles } from "@t3tools/shared/gatewayHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import { helperKeyPath, listenGatewayHelper } from "./gatewayHelper.ts";
import { darwinGatewayPaths } from "./platform/darwin.ts";
import { linuxGatewayPaths } from "./platform/linux.ts";
import { win32GatewayPaths } from "./platform/win32.ts";
import {
  GatewayPlatformError,
  type GatewayAccountId,
  type GatewayPlatform,
} from "./platform/GatewayPlatform.ts";
import { makeTestGatewayPlatform, makeTestGatewayRoot } from "./platform/testing.ts";

const RUNTIME = "0.1.9-gwtest.1";
const NEXT = "0.1.9-gwtest.2";
const BASE_URL = "https://updates.test/download";
const PASSWORD = "hunter2-correct-horse";
const KEYS = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
// As desktop apps read it from the file the gateway publishes.
const PUBLISHED_KEY = KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const joinBody = (password: string) =>
  JSON.stringify({
    encryptedPassword: NodeCrypto.publicEncrypt(
      { key: PUBLISHED_KEY, oaepHash: "sha256" },
      Buffer.from(password),
    ).toString("base64"),
  });
const HELPER_HEADERS = { host: "127.0.0.1:3774", [GATEWAY_HELPER_HEADER]: "1" };

const services = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(GatewayHelperStatus));
const decodeError = Schema.decodeUnknownSync(Schema.fromJsonString(GatewayHelperError));
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(GatewayHelperUpdateState));

interface Answer {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly text: string;
}

const send = (
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: NodeHttp.OutgoingHttpHeaders = {
    ...HELPER_HEADERS,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
) =>
  Effect.promise(
    () =>
      new Promise<Answer>((resolve, reject) => {
        const call = NodeHttp.request(
          { host: "127.0.0.1", port, path, method, headers, agent: false },
          (response) => {
            const chunks: Array<Buffer> = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                text: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        call.once("error", reject);
        call.end(body);
      }),
  );

const releaseFiles = (
  files: ReadonlyMap<string, Uint8Array | string>,
  onRequest: (url: string) => void = () => {},
) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      onRequest(request.url);
      return HttpClientResponse.fromWeb(
        request,
        files.has(request.url)
          ? new Response(files.get(request.url))
          : new Response("missing", { status: 404 }),
      );
    }),
  );

/** A real `t3-<version>-linux-x64.tar.gz` whose top-level folder holds an executable `t3`. */
const buildRelease = Effect.fn("test.buildRelease")(function* (root: string, version: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const name = `t3-${version}-linux-x64.tar.gz`;
  const source = path.join(root, "release");
  const stem = `t3-${version}-linux-x64`;
  yield* fs.makeDirectory(path.join(source, stem), { recursive: true });
  yield* fs.writeFileString(path.join(source, stem, "t3"), "#!/bin/sh\n", { mode: 0o755 });
  const result = yield* runner.run({
    command: "tar",
    args: ["-czf", name, stem],
    cwd: source,
  });
  assert.equal(result.code, 0, result.stderr);
  const archive = yield* fs.readFile(path.join(source, name));
  const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  return new Map<string, Uint8Array | string>([
    [cliReleaseAssetUrl(version, name, BASE_URL), archive],
    [cliReleaseAssetUrl(version, "SHA256SUMS", BASE_URL), `${digest}  ${name}\n`],
  ]);
});

const startHelper = Effect.fn("test.startHelper")(function* (
  input: {
    readonly selfService?: boolean;
    readonly owner?: GatewayAccountId | undefined;
    readonly platform?: (platform: GatewayPlatform) => GatewayPlatform;
    readonly files?: ReadonlyMap<string, Uint8Array | string>;
    readonly onRequest?: (url: string) => void;
    readonly passwordKey?: NodeCrypto.KeyObject;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* makeTestGatewayRoot("t3-gateway-helper-");
  const { platform: base, calls } = makeTestGatewayPlatform(root);
  const owner = "owner" in input ? input.owner : 1001;
  const owned = { ...base, makeConnectionOwner: Effect.succeed(async () => owner) };
  const platform = input.platform?.(owned) ?? owned;
  const { configPath, installRoot } = platform.layout;
  yield* fs.makeDirectory(installRoot, { recursive: true });
  yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
  yield* fs.writeFileString(
    configPath,
    `{"version":1,"listen":{"host":"0.0.0.0","port":3773},"users":{},"selfService":${
      input.selfService ?? true
    },"updates":{"baseUrl":"${BASE_URL}"}}`,
  );
  const logs: Array<string> = [];
  const port = yield* listenGatewayHelper(
    {
      platform,
      configPath,
      runtimeVersion: RUNTIME,
      ...(input.passwordKey === undefined ? {} : { passwordKey: input.passwordKey }),
    },
    0,
  ).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      releaseFiles(input.files ?? new Map(), input.onRequest),
    ),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(
      Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))], {
        mergeWithExisting: false,
      }),
    ),
  );
  const stagingDirs = Effect.map(fs.readDirectory(installRoot), (names) =>
    names
      .filter((name) => name.startsWith(".helper-staging-"))
      .map((name) => path.join(installRoot, name)),
  );
  const updateStatePath = path.join(
    path.dirname(configPath),
    ".t3code-gateway-helper",
    "update.json",
  );
  const updateState = Effect.map(fs.readFileString(updateStatePath), decodeState);
  return {
    calls,
    logs,
    stagingDirs,
    updateState,
    updateStatePath,
    send: (method: string, route: string, body?: string, headers?: NodeHttp.OutgoingHttpHeaders) =>
      send(port, method, route, body, headers),
  };
});

// Real sockets and a real tar: these run on the wall clock.
const live = <E>(
  name: string,
  test: () => Effect.Effect<void, E, Layer.Success<typeof services> | Scope.Scope>,
) => it.live(name, () => test().pipe(Effect.provide(services)));

describe("gateway host files", () => {
  it("match where each platform installs the gateway", () => {
    for (const [platform, paths] of [
      ["linux", linuxGatewayPaths],
      ["darwin", darwinGatewayPaths],
    ] as const) {
      assert.deepEqual(gatewayHostFiles(platform, {}), {
        currentLink: `${paths.installRoot}/current`,
        runtimeExecutable: `${paths.installRoot}/current/t3`,
      });
    }
    const { programFiles, programData, installRoot, configPath } = win32GatewayPaths;
    assert.deepEqual(
      gatewayHostFiles("win32", { ProgramFiles: programFiles, ProgramData: programData }),
      {
        currentLink: `${installRoot}\\current`,
        runtimeExecutable: `${installRoot}\\current\\t3.exe`,
        helperKeyFile: helperKeyPath(NodePath.win32, configPath),
      },
    );
  });
});

describe("gateway helper", () => {
  live("refuses requests a browser or another host could make", () =>
    Effect.gen(function* () {
      const helper = yield* startHelper();
      for (const headers of [
        { host: "127.0.0.1:3774" },
        { host: "evil.test:3774", [GATEWAY_HELPER_HEADER]: "1" },
        { host: "localhost:3774", [GATEWAY_HELPER_HEADER]: "1" },
      ]) {
        const denied = yield* helper.send("GET", "/v1/status", undefined, headers);
        assert.equal(denied.status, 403);
        assert.equal(decodeError(denied.text).error, "Gateway helper access denied.");
      }
      const preflight = yield* helper.send("OPTIONS", "/v1/join", undefined, {
        host: "127.0.0.1:3774",
        origin: "https://evil.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": GATEWAY_HELPER_HEADER,
      });
      assert.equal(preflight.status, 404);
      assert.deepStrictEqual(
        Object.keys(preflight.headers).filter((name) => name.startsWith("access-control-")),
        [],
      );
      assert.equal((yield* helper.send("GET", "/v1/nope")).status, 404);
      assert.equal((yield* helper.send("PUT", "/v1/join")).status, 405);
      const plain = yield* helper.send("POST", "/v1/join", "{}", {
        ...HELPER_HEADERS,
        "content-type": "text/plain",
      });
      assert.equal(plain.status, 415);
      const large = yield* helper.send("POST", "/v1/join", `{"password":"${"x".repeat(17_000)}"}`);
      assert.equal(large.status, 413);
      assert.deepStrictEqual(helper.calls, []);
    }),
  );

  live("names the caller only by the socket's owner and a matching OS account", () =>
    Effect.gen(function* () {
      const unknown = yield* startHelper({ owner: undefined });
      assert.equal((yield* unknown.send("GET", "/v1/status")).status, 403);
      const nameless = yield* startHelper({ owner: 1002 });
      assert.equal((yield* nameless.send("GET", "/v1/status")).status, 403);
      const mismatch = yield* startHelper({
        platform: (platform) => ({
          ...platform,
          lookupUser: (name) => Effect.succeed({ name, accountId: 1002, home: "/home/x" }),
        }),
      });
      const denied = yield* mismatch.send("POST", "/v1/join", "{}");
      assert.equal(denied.status, 403);
      assert.equal(decodeError(denied.text).error, "Could not identify the connecting account.");
      assert.deepStrictEqual(mismatch.calls, []);
    }),
  );

  live("joins with the caller's password, rejoins idempotently and leaves", () =>
    Effect.gen(function* () {
      const passwords: Array<string | undefined> = [];
      const helper = yield* startHelper({
        passwordKey: KEYS.privateKey,
        platform: (platform) => ({
          ...platform,
          accountName: () => Effect.succeed("Alice"),
          services: {
            ...platform.services,
            enableUser: (user, _executable, options) =>
              Effect.sync(() => void passwords.push(options?.password)),
          },
        }),
      });
      const first = yield* helper.send("GET", "/v1/status", undefined, {
        ...HELPER_HEADERS,
        connection: "keep-alive",
      });
      // A kept-alive connection would keep reaching a helper that predates an update.
      assert.equal(first.headers.connection, "close");
      const before = decodeStatus(first.text);
      assert.deepInclude(before, { user: "alice", enrolled: false, selfService: true });
      assert.isUndefined(before.backendPort);

      const unreadable = yield* helper.send(
        "POST",
        "/v1/join",
        JSON.stringify({ encryptedPassword: Buffer.from(PASSWORD).toString("base64") }),
      );
      assert.equal(
        decodeError(unreadable.text).error,
        "Shared T3 Code could not read the password. Try again.",
      );
      const join = yield* helper.send("POST", "/v1/join", joinBody(PASSWORD));
      assert.equal(join.status, 200);
      assert.deepInclude(decodeStatus(join.text), { enrolled: true, backendPort: 3801 });
      const rejoin = yield* helper.send("POST", "/v1/join", "{}");
      assert.deepInclude(decodeStatus(rejoin.text), { enrolled: true, backendPort: 3801 });
      assert.deepStrictEqual(passwords, [PASSWORD, undefined]);
      assert.notInclude(join.text + rejoin.text + helper.logs.join("\n"), PASSWORD);

      const leave = yield* helper.send("POST", "/v1/leave", "{}");
      assert.equal(leave.status, 200);
      assert.deepInclude(decodeStatus(leave.text), { enrolled: false });
      assert.include(helper.calls, "disableUser alice");
    }),
  );

  live("answers enrollment failures without leaking the password or hanging", () =>
    Effect.gen(function* () {
      const refused = yield* startHelper({
        passwordKey: KEYS.privateKey,
        platform: (platform) => ({
          ...platform,
          services: {
            ...platform.services,
            enableUser: (_user, _executable, options) =>
              Effect.fail(
                new GatewayPlatformError({ message: `Logon failure for ${options?.password}` }),
              ),
          },
        }),
      });
      const failed = yield* refused.send("POST", "/v1/join", joinBody(PASSWORD));
      assert.equal(failed.status, 400);
      assert.equal(decodeError(failed.text).error, "Logon failure for [redacted]");
      // A refused first join leaves no enrollment whose backend never starts.
      const after = yield* refused.send("GET", "/v1/status");
      assert.deepInclude(decodeStatus(after.text), { enrolled: false });

      const crashed = yield* startHelper({
        passwordKey: KEYS.privateKey,
        platform: (platform) => ({
          ...platform,
          services: {
            ...platform.services,
            enableUser: (_user, _executable, options) =>
              Effect.die(new Error(`boom ${options?.password}`)),
          },
        }),
      });
      const died = yield* crashed.send("POST", "/v1/join", joinBody(PASSWORD));
      assert.equal(died.status, 500);
      assert.equal(decodeError(died.text).error, "Gateway helper request failed.");
      assert.isNotEmpty(crashed.logs);
      assert.notInclude(crashed.logs.join("\n"), PASSWORD);

      // Without the gateway's key, there is no password to read.
      const keyless = yield* startHelper();
      const noKey = yield* keyless.send("POST", "/v1/join", joinBody(PASSWORD));
      assert.equal(decodeError(noKey.text).error, "This gateway takes no password.");
    }),
  );

  live("refuses join, leave and update when self-service is off", () =>
    Effect.gen(function* () {
      const helper = yield* startHelper({ selfService: false });
      assert.equal((yield* helper.send("GET", "/v1/status")).status, 200);
      for (const [route, body] of [
        ["/v1/join", "{}"],
        ["/v1/leave", "{}"],
        ["/v1/update", JSON.stringify({ version: NEXT })],
      ] as const) {
        const answer = yield* helper.send("POST", route, body);
        assert.equal(answer.status, 403, route);
      }
      assert.deepStrictEqual(helper.calls, []);
    }),
  );

  live("updates only to a newer version, one at a time", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const helper = yield* startHelper({
        files: yield* buildRelease(yield* makeTestGatewayRoot("t3-gateway-release-"), NEXT),
      });
      const update = (version: string) =>
        helper.send("POST", "/v1/update", JSON.stringify({ version }));
      assert.equal((yield* update(RUNTIME)).status, 200);
      assert.equal((yield* update("0.1.9-gwtest.0")).status, 400);
      assert.equal((yield* update("0.1.8")).status, 400);
      assert.equal((yield* update("latest")).status, 400);
      for (const unsafe of ["0.1.10-../../../etc/x", "0.1.10+build", "v0.1.10", " 0.1.10"]) {
        assert.equal((yield* update(unsafe)).status, 400, unsafe);
      }
      assert.deepStrictEqual(yield* helper.stagingDirs, []);

      const started = yield* update(NEXT);
      assert.equal(started.status, 202, started.text);
      assert.deepInclude(decodeStatus(started.text).update ?? {}, {
        state: "running",
        version: NEXT,
      });
      const [staging] = yield* helper.stagingDirs;
      assert.isDefined(staging);
      const executable = path.join(staging!, "t3");
      assert.isTrue(yield* fs.exists(executable));
      assert.include(helper.calls, `runDetached update ${executable} gateway install`);
      assert.deepInclude(yield* helper.updateState, { state: "running", version: NEXT });

      // A second app asking for the same update waits on the running one.
      assert.equal((yield* update(NEXT)).status, 202);
      assert.equal((yield* update("0.1.9-gwtest.3")).status, 409);
      assert.equal((yield* helper.stagingDirs).length, 1);
      assert.equal(helper.calls.filter((call) => call.startsWith("runDetached")).length, 1);

      // An install that died long ago no longer holds the slot.
      yield* fs.writeFileString(
        helper.updateStatePath,
        JSON.stringify({ state: "running", version: NEXT, updatedAt: 0 }),
      );
      assert.equal((yield* update(NEXT)).status, 202);
    }),
  );

  live("drops an update whose claim another install cleared during the download", () =>
    Effect.gen(function* () {
      let statePath = "";
      const helper = yield* startHelper({
        files: yield* buildRelease(yield* makeTestGatewayRoot("t3-gateway-release-"), NEXT),
        onRequest: (url) => {
          if (url.endsWith(".tar.gz")) NodeFS.rmSync(statePath, { force: true });
        },
      });
      statePath = helper.updateStatePath;
      const answer = yield* helper.send("POST", "/v1/update", JSON.stringify({ version: NEXT }));
      assert.equal(answer.status, 409);
      assert.equal(
        decodeError(answer.text).error,
        `Another install replaced the update to ${NEXT}.`,
      );
      assert.isFalse(helper.calls.some((call) => call.startsWith("runDetached")));
      assert.deepStrictEqual(yield* helper.stagingDirs, []);
      assert.isFalse(NodeFS.existsSync(statePath));
    }),
  );

  live("discards a release whose checksum does not match", () =>
    Effect.gen(function* () {
      const files = new Map(
        yield* buildRelease(yield* makeTestGatewayRoot("t3-gateway-release-"), NEXT),
      );
      files.set(
        cliReleaseAssetUrl(NEXT, "SHA256SUMS", BASE_URL),
        `${"0".repeat(64)}  t3-${NEXT}-linux-x64.tar.gz\n`,
      );
      const helper = yield* startHelper({ files });
      const answer = yield* helper.send("POST", "/v1/update", JSON.stringify({ version: NEXT }));
      assert.equal(answer.status, 502);
      assert.equal(decodeError(answer.text).error, "The update checksum did not match.");
      assert.deepStrictEqual(yield* helper.stagingDirs, []);
      assert.deepInclude(yield* helper.updateState, { state: "failed", version: NEXT });
      assert.isFalse(helper.calls.some((call) => call.startsWith("runDetached")));
    }),
  );

  live("records a failed update when the installer cannot start", () =>
    Effect.gen(function* () {
      const helper = yield* startHelper({
        files: yield* buildRelease(yield* makeTestGatewayRoot("t3-gateway-release-"), NEXT),
        platform: (platform) => ({
          ...platform,
          services: {
            ...platform.services,
            runDetached: () => Effect.fail(new GatewayPlatformError({ message: "no systemd" })),
          },
        }),
      });
      const answer = yield* helper.send("POST", "/v1/update", JSON.stringify({ version: NEXT }));
      assert.equal(answer.status, 500);
      assert.equal(decodeError(answer.text).error, "Could not start the update: no systemd");
      assert.deepStrictEqual(yield* helper.stagingDirs, []);
      assert.deepInclude(yield* helper.updateState, {
        state: "failed",
        version: NEXT,
        message: "Could not start the update: no systemd",
      });
      const status = decodeStatus((yield* helper.send("GET", "/v1/status")).text);
      assert.equal(status.update?.state, "failed");
    }),
  );
});
