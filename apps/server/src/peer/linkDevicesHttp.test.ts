// @effect-diagnostics nodeBuiltinImport:off - The fake hub and daemon are Node HTTP servers.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  type DeviceHostId,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Toolkit } from "effect/ai";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";

import * as DeviceHost from "../device/DeviceHost.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as LinkedDeviceHost from "../device/LinkedDeviceHost.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as LinkDevicesHttp from "./linkDevicesHttp.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerLinks from "./PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  type ServedPeer,
  servePeer,
} from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const mac = descriptorOf("environment-mac", "Mac", { linkDevices: true });
const NoTools = Toolkit.make();
const DAEMON_TOKEN = "daemon-secret";
const decodeObject = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const simulator = {
  id: "SIM-1",
  platform: "ios" as const,
  name: "iPhone 17",
  version: "iOS 26.0",
  booted: false,
  physical: false,
};

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/** A loopback HTTP server that records each request and answers with `respond`. */
const serveFake = (respond: (seen: Seen) => Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<Seen>>([]);
    const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
    });
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
        const entry = { method: request.method, url: request.url, headers: request.headers, body };
        yield* Ref.update(seen, (all) => [...all, entry]);
        return yield* respond(entry);
      }).pipe(Effect.interruptible),
    );
    if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die("no TCP address");
    return { origin: `http://127.0.0.1:${server.address.port}`, seen };
  });

/** The Mac: its own device service, with a hub and an agent-device daemon on its loopback. */
const serveMac = Effect.fnUntraced(function* (waitForReadiness: Effect.Effect<void> = Effect.void) {
  const hub = yield* serveFake(() => Effect.succeed(HttpServerResponse.text("frame")));
  const rpcStarted = yield* Deferred.make<void>();
  const rpcClosed = yield* Deferred.make<void>();
  const artifactClosed = yield* Deferred.make<void>();
  const stopFake = yield* Deferred.make<void>();
  const daemonToken = yield* Ref.make(DAEMON_TOKEN);
  const daemon = yield* serveFake(
    Effect.fnUntraced(function* (request) {
      if (request.url === "/rpc?pending") {
        yield* Deferred.succeed(rpcStarted, undefined);
        yield* Deferred.await(stopFake).pipe(
          Effect.onInterrupt(() => Deferred.succeed(rpcClosed, undefined)),
        );
        return HttpServerResponse.empty();
      }
      if (request.url.startsWith("/artifacts/")) {
        return HttpServerResponse.stream(
          Stream.concat(
            Stream.make(new TextEncoder().encode("first chunk")),
            Stream.fromEffect(Deferred.await(stopFake)).pipe(Stream.drain),
          ).pipe(Stream.ensuring(Deferred.succeed(artifactClosed, undefined))),
        );
      }
      if (request.url.startsWith("/upload/preflight")) {
        if (request.url.endsWith("?cache")) {
          return HttpServerResponse.jsonUnsafe({ ok: true, uploadId: "up-1", cacheHit: true });
        }
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          uploadId: request.url.endsWith("?malformed") ? null : "up-1",
          upload: {
            url: "http://127.0.0.1:1/upload/direct/up-1",
            headers: { authorization: `Bearer ${DAEMON_TOKEN}`, "content-type": "application/zip" },
          },
        });
      }
      if (request.headers.authorization !== `Bearer ${yield* Ref.get(daemonToken)}`)
        return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });
      return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    }),
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(stopFake, undefined));
  const booted = yield* Ref.make<ReadonlyArray<string>>([]);
  const readinessCalls = yield* Ref.make(0);
  const daemonAvailable = yield* Ref.make(true);
  const ready: DeviceService.DeviceReadiness = {
    hostId: LOCAL_DEVICE_HOST_ID,
    nodePath: "node",
    hub: { origin: hub.origin },
    devices: {
      list: Effect.succeed({ devices: [simulator], detail: undefined }),
      boot: (device) => Ref.update(booted, (ids) => [...ids, device.id]).pipe(Effect.as(device.id)),
      attach: () => Effect.void,
      shutdown: () => Effect.void,
      screenshot: () => Effect.succeed(new Uint8Array()),
    },
    run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  const devices = Layer.mock(DeviceService.DeviceService)({
    readiness: () =>
      Ref.update(readinessCalls, (count) => count + 1).pipe(
        Effect.andThen(waitForReadiness),
        Effect.as(ready),
      ),
    currentReadiness: () => Effect.succeed(ready),
    agentReadinessIfSupported: () =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(daemonAvailable))) return null;
        const token = yield* Ref.get(daemonToken);
        return { ...ready, agentDevice: { baseUrl: daemon.origin, token, entryPath: "" } };
      }),
    state: Effect.succeed({
      hosts: [
        {
          id: LOCAL_DEVICE_HOST_ID,
          label: "This machine",
          kind: "local" as const,
          platforms: [{ platform: "ios" as const, available: true }],
          hubInstalled: true,
          agentDeviceInstalled: true,
        },
      ],
      hostStatus: "ready" as const,
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: true,
      agentAccessEnabled: true,
      hubBasePath: "/api/device-hub",
      revision: 0,
    }),
  });
  const peer = yield* servePeer(
    mac as ExecutionEnvironmentDescriptor,
    McpHttpServer.toolkitRegistration(NoTools, McpToolAccess.toLayer(NoTools, {})),
    LinkDevicesHttp.layer.pipe(Layer.provide(devices), Layer.provide(FetchHttpClient.layer)),
  );
  yield* peer.settings.updateSettings({ enableDeviceSupport: true, enableAgentDeviceAccess: true });
  return {
    peer,
    hub,
    daemon,
    booted,
    readinessCalls,
    daemonAvailable,
    daemonToken,
    rpcStarted,
    rpcClosed,
    artifactClosed,
  };
});

const makeLaptop = Effect.gen(function* () {
  const linking = yield* Layer.build(layerLinkingEnvironment(laptop));
  const links = Context.get(linking, PeerLinks.PeerLinks);
  yield* Context.get(linking, ServerSettings.ServerSettingsService).updateSettings({
    enableDeviceSupport: true,
    enableAgentDeviceAccess: true,
  });
  const host = yield* LinkedDeviceHost.make({
    kind: "linked",
    id: "mac" as DeviceHostId,
    label: "Mac",
    environmentId: EnvironmentId.make(mac.environmentId),
  }).pipe(Effect.provide(Layer.merge(Layer.succeedContext(linking), FetchHttpClient.layer)));
  return { links, host };
});

const noPhase = () => Effect.void;

const fetch = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => ({ status: response.status, headers: response.headers, body })),
      ),
    ),
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
  );

const linkToken = (links: PeerLinks.PeerLinks["Service"]) =>
  links.resolve(EnvironmentId.make(mac.environmentId)).pipe(Effect.map((peer) => peer.token));

it.effect("a full-access link lists, boots and streams the linked machine's devices", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, hub, booted, readinessCalls } = yield* serveMac();
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "full-access");

      const token = yield* linkToken(laptopSide.links);
      for (const path of ["/missing", "/agent"]) {
        const missing = yield* fetch(
          HttpClientRequest.post(`${peer.url}/api/links/devices${path}`).pipe(
            HttpClientRequest.bearerToken(token),
          ),
        );
        expect(missing.status).toBe(404);
      }
      const wrongMethod = yield* askMac(peer, token, {}, "/boot");
      expect(wrongMethod.status).toBe(405);
      expect(yield* Ref.get(readinessCalls)).toBe(0);
      const operations = yield* askMac(peer, token);
      expect(operations.headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]).toMatch(
        /^\d{4}-\d\d-\d\dT.*Z$/,
      );

      const ready = yield* laptopSide.host.ensureReady(noPhase);
      const listed = yield* ready.devices.list;
      expect(listed.devices).toEqual([simulator]);
      expect(yield* laptopSide.host.platformAvailability("ios")).toMatchObject({ available: true });
      expect(yield* ready.devices.boot(simulator)).toBe("SIM-1");
      expect(yield* Ref.get(booted)).toEqual(["SIM-1"]);

      // The Device panel's proxy sends hub requests where the host routes them.
      const routed = yield* ready.upstream!(
        "/vendor/serve-sim/helper/SIM-1/stream.mjpeg",
        new URLSearchParams({ device: "SIM-1" }),
      );
      if (routed === null) return yield* Effect.die("no upstream");
      const frame = yield* fetch(
        HttpClientRequest.get(routed.url).pipe(HttpClientRequest.setHeaders(routed.headers)),
      );
      expect(frame).toMatchObject({ status: 200, body: "frame" });
      const [hubRequest] = yield* Ref.get(hub.seen);
      expect(hubRequest?.url).toBe("/vendor/serve-sim/helper/SIM-1/stream.mjpeg?device=SIM-1");
      // The link's token stops at the linked environment.
      expect(hubRequest?.headers.authorization).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an emulator is refused when the linked machine's ffmpeg cannot encode its video", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, booted } = yield* serveMac();
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "full-access");
      const ready = yield* laptopSide.host.ensureReady(noPhase);
      const emulator = {
        ...simulator,
        id: "Pixel_API_35",
        platform: "android" as const,
        booted: false,
      };

      const refused = yield* ready.devices.boot(emulator).pipe(Effect.flip);

      expect(refused.cause).toMatchObject({ message: expect.stringContaining("libx264") });
      expect(yield* Ref.get(booted)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("unlinking refuses a boot waiting for readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const readinessStarted = yield* Deferred.make<void>();
      const releaseReadiness = yield* Deferred.make<void>();
      const { peer, booted } = yield* serveMac(
        Deferred.succeed(readinessStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseReadiness)),
        ),
      );
      const { links } = yield* makeLaptop;
      yield* linkTo(links, peer, "full-access");
      const token = yield* linkToken(links);
      const boot = yield* fetch(
        HttpClientRequest.post(`${peer.url}/api/links/devices/boot`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({ device: simulator }),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(readinessStarted);
      expect((yield* links.unlink(EnvironmentId.make(mac.environmentId))).endedThere).toBe(true);
      yield* Deferred.succeed(releaseReadiness, undefined);
      const refused = yield* Fiber.join(boot);
      expect(yield* Ref.get(booted)).toEqual([]);
      expect(refused.status).toBe(403);
      expect(decodeObject(refused.body).error).toBe("link_revoked");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("turning off device support refuses requests to the running hub", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, hub } = yield* serveMac();
      const { links } = yield* makeLaptop;
      yield* linkTo(links, peer, "full-access");
      const token = yield* linkToken(links);
      const path = "/hub/vendor/serve-sim/helper/SIM-1/stream.mjpeg";
      expect((yield* askMac(peer, token, {}, path)).status).toBe(200);
      yield* peer.settings.updateSettings({ enableDeviceSupport: false });
      const refused = yield* askMac(peer, token, {}, path);
      expect(refused.status).toBe(403);
      expect(decodeObject(refused.body).error).toBe("device_support_off");
      expect(yield* Ref.get(hub.seen)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("agents reach the linked daemon only through a loopback token of their own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, daemon } = yield* serveMac();
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "full-access");
      const token = yield* linkToken(laptopSide.links);

      yield* laptopSide.host.ensureAgentReady(noPhase);
      const ready = yield* laptopSide.host.current;
      const endpoint = yield* ready!.devices.agentEndpoint!("SIM-1");
      expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(endpoint.token).not.toBe(token);

      const rpc = (bearer: string) =>
        fetch(
          HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
            HttpClientRequest.bearerToken(bearer),
            HttpClientRequest.setBody(
              HttpBody.text(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "agent_device.command",
                  params: { command: "snapshot", token: bearer },
                }),
                "application/json",
              ),
            ),
          ),
        );
      expect((yield* rpc("wrong")).status).toBe(401);
      expect((yield* rpc(endpoint.token)).status).toBe(200);
      const [command] = yield* Ref.get(daemon.seen);
      expect(command?.headers.authorization).toBe(`Bearer ${DAEMON_TOKEN}`);
      expect(decodeObject(command!.body).params).toEqual({
        command: "snapshot",
        token: DAEMON_TOKEN,
      });

      // An upload ticket names the loopback forwarder, never the daemon's address or token.
      const ticket = yield* fetch(
        HttpClientRequest.post(`${endpoint.baseUrl}/upload/preflight`).pipe(
          HttpClientRequest.bearerToken(endpoint.token),
          HttpClientRequest.setBody(HttpBody.text("{}", "application/json")),
        ),
      );
      expect(ticket.body).not.toContain(DAEMON_TOKEN);
      expect(decodeObject(ticket.body).upload).toEqual({
        url: `${endpoint.baseUrl}/upload/direct/up-1`,
        headers: {
          "content-type": "application/zip",
          authorization: `Bearer ${endpoint.token}`,
          "x-agent-device-token": endpoint.token,
        },
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const askMac = (
  peer: ServedPeer,
  bearer: string,
  headers: Record<string, string> = {},
  path = "",
) =>
  fetch(
    HttpClientRequest.get(`${peer.url}/api/links/devices${path}`).pipe(
      HttpClientRequest.setHeaders({ authorization: `Bearer ${bearer}`, ...headers }),
    ),
  );

it.effect("only a full-access link's session may use the linked machine's devices", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer } = yield* serveMac();
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "auto");
      const token = yield* linkToken(laptopSide.links);

      const refused = yield* askMac(peer, token);
      expect(refused.status).toBe(403);
      expect(decodeObject(refused.body).error).toBe("not_a_full_access_link");
      // This side says why before asking.
      const error = yield* laptopSide.host.ensureReady(noPhase).pipe(Effect.flip);
      expect(error).toBeInstanceOf(DeviceHost.DeviceHostError);
      expect(LinkedDeviceHost.isLinkedDeviceHostFailure(error.cause)).toBe(true);
      expect((error.cause as LinkedDeviceHost.LinkedDeviceHostFailure).message).toContain(
        "full access",
      );

      // A client's own session is no link's.
      const issued = yield* peer.auth.issueSession({ label: "Phone" });
      expect((yield* askMac(peer, issued.token)).status).toBe(401);
      expect((yield* askMac(peer, "not-a-token")).status).toBe(401);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a browser origin is refused and unlinking ends the host's access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer } = yield* serveMac();
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "full-access");
      const token = yield* linkToken(laptopSide.links);
      expect((yield* askMac(peer, token)).status).toBe(200);
      expect((yield* askMac(peer, token, { origin: "https://evil.example" })).status).toBe(403);

      yield* laptopSide.links.unlink(EnvironmentId.make(mac.environmentId));
      // The linked environment revoked the session, so the old token no longer works there.
      expect((yield* askMac(peer, token)).status).toBe(401);
      yield* laptopSide.host.stop;
      const error = yield* laptopSide.host.ensureReady(noPhase).pipe(Effect.flip);
      expect((error.cause as LinkedDeviceHost.LinkedDeviceHostFailure).message).toContain(
        "no longer linked",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "the daemon route rejects malformed upload tickets and non-object or oversized RPCs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, daemon } = yield* serveMac();
        const { links } = yield* makeLaptop;
        yield* linkTo(links, peer, "full-access");
        const token = yield* linkToken(links);
        const post = (path: string, body: string) =>
          fetch(
            HttpClientRequest.post(`${peer.url}/api/links/devices/daemon${path}`).pipe(
              HttpClientRequest.bearerToken(token),
              HttpClientRequest.setBody(HttpBody.text(body, "application/json")),
            ),
          );
        expect((yield* post("/rpc", "[]")).status).toBe(400);
        expect(
          (yield* post("/rpc", JSON.stringify({ value: "é".repeat(2 * 1024 * 1024) }))).status,
        ).toBe(400);
        expect(yield* Ref.get(daemon.seen)).toEqual([]);

        const malformed = yield* post("/upload/preflight?malformed", "{}");
        expect(malformed.body).not.toContain(DAEMON_TOKEN);
        expect(malformed).toMatchObject({ status: 502 });
        const cached = yield* post("/upload/preflight?cache", "{}");
        expect(cached).toMatchObject({ status: 200 });
        expect(decodeObject(cached.body)).toEqual({ ok: true, uploadId: "up-1", cacheHit: true });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("daemon RPC refusals report disabled settings and startup failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, daemon, daemonAvailable } = yield* serveMac();
      const { links } = yield* makeLaptop;
      yield* linkTo(links, peer, "full-access");
      const token = yield* linkToken(links);
      const rpc = fetch(
        HttpClientRequest.post(`${peer.url}/api/links/devices/daemon/rpc`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setBody(HttpBody.text('{"jsonrpc":"2.0","id":42}', "application/json")),
        ),
      );
      expect((yield* rpc).status).toBe(200);
      yield* peer.settings.updateSettings({ enableAgentDeviceAccess: false });
      const refused = yield* rpc;
      expect(refused.status).toBe(403);
      expect(decodeObject(refused.body)).toMatchObject({
        jsonrpc: "2.0",
        id: 42,
        error: { message: expect.stringContaining("Agent device access is off there") },
      });
      yield* peer.settings.updateSettings({
        enableDeviceSupport: false,
        enableAgentDeviceAccess: true,
      });
      const disabled = yield* rpc;
      expect(disabled.status).toBe(403);
      expect(decodeObject(disabled.body)).toMatchObject({
        jsonrpc: "2.0",
        id: 42,
        error: { message: expect.stringContaining("Device support is off there") },
      });
      yield* Ref.set(daemonAvailable, false);
      yield* peer.settings.updateSettings({ enableDeviceSupport: true });
      const unavailable = yield* rpc;
      expect(unavailable.status).toBe(503);
      expect(decodeObject(unavailable.body)).toMatchObject({
        jsonrpc: "2.0",
        id: 42,
        error: { message: expect.stringContaining("could not start") },
      });
      expect(yield* Ref.get(daemon.seen)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a restarted daemon is found again, and a refused caller's body stays unread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, daemonToken } = yield* serveMac();
      const { links } = yield* makeLaptop;
      yield* linkTo(links, peer, "full-access");
      const rpc = (bearer: string) =>
        fetch(
          HttpClientRequest.post(`${peer.url}/api/links/devices/daemon/rpc`).pipe(
            HttpClientRequest.bearerToken(bearer),
            HttpClientRequest.setBody(
              HttpBody.text('{"jsonrpc":"2.0","id":7}', "application/json"),
            ),
          ),
        );
      const token = yield* linkToken(links);
      expect((yield* rpc(token)).status).toBe(200);
      yield* Ref.set(daemonToken, "rotated-secret");
      expect((yield* rpc(token)).status).toBe(401);
      expect((yield* rpc(token)).status).toBe(200);

      const stranger = yield* rpc("not-a-link");
      expect(stranger.status).toBe(401);
      expect(decodeObject(stranger.body)).toMatchObject({ jsonrpc: "2.0", id: null });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("unlinking cancels pending RPCs and interrupts daemon artifact downloads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, rpcStarted, rpcClosed, artifactClosed } = yield* serveMac();
      const { links } = yield* makeLaptop;
      yield* linkTo(links, peer, "full-access");
      const token = yield* linkToken(links);
      const response = yield* HttpClient.execute(
        HttpClientRequest.get(`${peer.url}/api/links/devices/daemon/artifacts/example`).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      ).pipe(Effect.provide(FetchHttpClient.layer));
      expect(response.status).toBe(200);
      const firstChunk = yield* Deferred.make<string>();
      const download = yield* response.stream.pipe(
        Stream.runForEach((bytes) => Deferred.succeed(firstChunk, new TextDecoder().decode(bytes))),
        Effect.result,
        Effect.forkScoped,
      );
      expect(yield* Deferred.await(firstChunk)).toBe("first chunk");
      const command = yield* fetch(
        HttpClientRequest.post(`${peer.url}/api/links/devices/daemon/rpc?pending`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setBody(
            HttpBody.text('{"jsonrpc":"2.0","id":"pending"}', "application/json"),
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(rpcStarted);
      yield* links.unlink(EnvironmentId.make(mac.environmentId));
      const refused = yield* Fiber.join(command);
      expect(refused.status).toBe(403);
      expect(decodeObject(refused.body)).toMatchObject({
        jsonrpc: "2.0",
        id: "pending",
        error: { message: expect.stringContaining("no longer allows device access") },
      });
      expect(Result.isFailure(yield* Fiber.join(download))).toBe(true);
      yield* Deferred.await(rpcClosed);
      yield* Deferred.await(artifactClosed);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
