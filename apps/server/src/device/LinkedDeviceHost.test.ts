// @effect-diagnostics nodeBuiltinImport:off - The linked environment is a fake Node HTTP server.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  type DeviceHostId,
  EnvironmentId,
  PEER_LINK_DEVICES_ROUTE_PREFIX,
  type PeerLink,
  PeerLinkError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forwardHubRequest } from "./DeviceHubProxy.ts";
import * as DeviceService from "./DeviceService.ts";
import * as LinkedDeviceHost from "./LinkedDeviceHost.ts";

const environmentId = EnvironmentId.make("environment-mac");
const SIM = {
  id: "SIM-1",
  name: "iPhone",
  version: "iOS 27.0",
  platform: "ios",
  booted: true,
  physical: false,
} as const;
const RENEWED = "2030-01-01T00:00:00.000Z";
const noPhase = () => Effect.void;
const HUB_STREAM = "/vendor/serve-sim/helper/SIM-1/stream.avcc";

/**
 * The Mac's `/api/links/devices` routes: records each bearer and answers the daemon with
 * `daemonStatus`. `/shutdown` answers only as the test ends and `/screenshot` never finishes its body.
 */
const serveMac = Effect.gen(function* () {
  const bearers = yield* Ref.make<ReadonlyArray<string>>([]);
  const paths = yield* Ref.make<ReadonlyArray<string>>([]);
  const daemonStatus = yield* Ref.make(200);
  const shutdownRequested = yield* Deferred.make<void>();
  const shutdownAnswered = yield* Deferred.make<void>();
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: "127.0.0.1",
    port: 0,
  });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* Ref.update(bearers, (all) => [...all, request.headers.authorization ?? ""]);
      yield* Ref.update(paths, (all) => [...all, request.url]);
      const headers = { [McpInvocationContext.LINK_EXPIRES_AT_HEADER]: RENEWED };
      if (request.url.endsWith("/shutdown"))
        return yield* Deferred.succeed(shutdownRequested, undefined).pipe(
          Effect.andThen(Deferred.await(shutdownAnswered)),
          Effect.as(HttpServerResponse.empty()),
        );
      if (request.url.endsWith("/screenshot"))
        return HttpServerResponse.stream(
          Stream.concat(Stream.make(Uint8Array.of(1)), Stream.never),
        );
      if (request.url === `${PEER_LINK_DEVICES_ROUTE_PREFIX}/hub${HUB_STREAM}`)
        return HttpServerResponse.stream(
          Stream.concat(Stream.make(Uint8Array.of(1)), Stream.never),
          {
            contentType: "application/octet-stream",
          },
        );
      if (request.url.startsWith(`${PEER_LINK_DEVICES_ROUTE_PREFIX}/daemon/`))
        return HttpServerResponse.jsonUnsafe(
          { jsonrpc: "2.0", id: 1, result: { ok: true } },
          { status: yield* Ref.get(daemonStatus), headers },
        );
      return HttpServerResponse.jsonUnsafe(
        { platforms: [{ platform: "ios", available: true }], devices: [] },
        { headers },
      );
    }),
  );
  // Runs before the server closes, which waits on the held answer.
  yield* Effect.addFinalizer(() => Deferred.succeed(shutdownAnswered, undefined));
  if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die("no TCP address");
  return {
    url: `http://127.0.0.1:${server.address.port}`,
    bearers,
    paths,
    daemonStatus,
    shutdownRequested,
  };
});

/** A link to the Mac whose stored row and token the test changes, as linking and unlinking would. */
const makeLinkedHost = Effect.gen(function* () {
  const mac = yield* serveMac;
  const linkedAt = yield* DateTime.now;
  const stored = yield* Ref.make<{ link: PeerLink; token: string } | undefined>({
    link: {
      environmentId,
      label: "Mac",
      urls: [mac.url],
      access: "full-access",
      linkedAt,
      expiresAt: DateTime.add(linkedAt, { hours: 1 }),
      lastReachedAt: null,
      lastError: null,
    },
    token: "token-1",
  });
  const resolves = yield* Ref.make(0);
  const held = yield* Ref.make<
    | { readonly probing: Deferred.Deferred<void>; readonly answer: Deferred.Deferred<void> }
    | undefined
  >(undefined);
  const screenshotAnswered = yield* Deferred.make<void>();
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.provide(
      ServerSettings.ServerSettingsService.layerTest({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }),
    ),
  );
  const expiries = yield* Ref.make<ReadonlyArray<string>>([]);
  const links = Layer.mock(PeerLinks.PeerLinks)({
    get: () => Ref.get(stored).pipe(Effect.map((value) => Option.fromNullishOr(value?.link))),
    resolve: () =>
      Effect.gen(function* () {
        yield* Ref.update(resolves, (count) => count + 1);
        const value = yield* Ref.get(stored);
        if (value === undefined)
          return yield* new PeerLinkError({ reason: "unknown_link", message: "gone" });
        if (DateTime.isLessThanOrEqualTo(value.link.expiresAt, yield* DateTime.now))
          return yield* new PeerLinkError({ reason: "expired", message: "The link expired." });
        // Probing the peer, after the row and token were read.
        const probe = yield* Ref.getAndSet(held, undefined);
        if (probe !== undefined) {
          yield* Deferred.succeed(probe.probing, undefined);
          yield* Deferred.await(probe.answer);
        }
        return {
          link: value.link,
          url: mac.url,
          token: value.token,
          capabilities: descriptorOf("environment-mac", "Mac", { linkDevices: true }).capabilities,
        };
      }),
    recordExpiry: (_, expiresAt) =>
      Ref.update(expiries, (all) => [...all, DateTime.formatIso(expiresAt)]),
  });
  const host = yield* LinkedDeviceHost.make({
    kind: "linked",
    id: "mac" as DeviceHostId,
    label: "Mac",
    environmentId,
  }).pipe(
    Effect.provideService(ServerSettings.ServerSettingsService, settings),
    Effect.provide(
      Layer.mergeAll(
        links,
        Layer.effect(
          HttpClient.HttpClient,
          HttpClient.HttpClient.pipe(
            Effect.map(
              HttpClient.tap((response) =>
                response.request.url.endsWith("/screenshot")
                  ? Deferred.succeed(screenshotAnswered, undefined)
                  : Effect.void,
              ),
            ),
          ),
        ).pipe(Layer.provide(FetchHttpClient.layer)),
        NodeCrypto.layer,
      ),
    ),
  );
  /** Holds the next resolve in its probe of the peer until `answer` completes. */
  const holdNextResolve = Effect.gen(function* () {
    const probe = { probing: yield* Deferred.make<void>(), answer: yield* Deferred.make<void>() };
    yield* Ref.set(held, probe);
    return probe;
  });
  const relink = (patch: Partial<PeerLink>, token: string) =>
    Effect.gen(function* () {
      const now = DateTime.add(yield* DateTime.now, { seconds: 1 });
      yield* Ref.update(stored, (value) =>
        value === undefined ? value : { link: { ...value.link, ...patch, linkedAt: now }, token },
      );
    });
  return {
    host,
    mac,
    stored,
    resolves,
    expiries,
    relink,
    settings,
    holdNextResolve,
    screenshotAnswered,
  };
});

/** This environment's hub route for the linked host's readiness, as the Device panel reaches it. */
const serveHubProxy = (ready: DeviceService.DeviceReadiness) =>
  Effect.gen(function* () {
    const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
      disablePreemptiveShutdown: true,
    });
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        return yield* forwardHubRequest(request, url, url.pathname, ready, Effect.never);
      }).pipe(
        Effect.orDie,
        Effect.provideService(
          DeviceService.DeviceService,
          {} as DeviceService.DeviceService["Service"],
        ),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die("no TCP address");
    return `http://127.0.0.1:${server.address.port}`;
  });

/** Opens a hub stream and waits for its first bytes; the returned fiber ends with the stream. */
const openStream = (origin: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(`${origin}${HUB_STREAM}`);
    const first = yield* Deferred.make<void>();
    const reading = yield* response.stream.pipe(
      Stream.runForEach(() => Deferred.succeed(first, undefined)),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* Deferred.await(first);
    return reading;
  }).pipe(Effect.provide(FetchHttpClient.layer));

const awaitEnded = (stream: Fiber.Fiber<void>) =>
  Fiber.await(stream).pipe(Effect.timeoutOption("3 seconds"), Effect.map(Option.isSome));

/** Whether a stream routed through the link has been told to end. */
const hasEnded = (routed: { readonly ended?: Effect.Effect<void> } | null) =>
  Effect.forkChild(routed!.ended!, { startImmediately: true }).pipe(
    Effect.map((fiber) => fiber.pollUnsafe() !== undefined),
  );

const rpc = (endpoint: { readonly baseUrl: string }, token: string) =>
  HttpClient.execute(
    HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setBody(
        HttpBody.text(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent_device.command", params: {} }),
          "application/json",
        ),
      ),
    ),
  ).pipe(
    Effect.map((response) => response.status),
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
  );

it.effect("stopping agent tools closes the forwarder, and starting again issues a new token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, mac } = yield* makeLinkedHost;
      yield* host.ensureAgentReady(noPhase);
      const ready = (yield* host.current)!;
      const first = yield* ready.devices.agentEndpoint!("SIM-1");
      expect(yield* rpc(first, first.token)).toBe(200);
      // Agent tools start without asking the Mac for anything; its daemon starts on first use.
      expect(yield* Ref.get(mac.paths)).toEqual([`${PEER_LINK_DEVICES_ROUTE_PREFIX}/daemon/rpc`]);

      yield* host.stopAgent;
      expect(yield* rpc(first, first.token).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      expect(yield* ready.devices.agentEndpoint!("SIM-1").pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });

      yield* host.ensureAgentReady(noPhase);
      const second = yield* ready.devices.agentEndpoint!("SIM-1");
      expect(second.token).not.toBe(first.token);
      expect(yield* rpc(second, first.token)).toBe(401);
      expect(yield* rpc(second, second.token)).toBe(200);

      yield* host.stop;
      expect(yield* rpc(second, second.token).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a relinked, downgraded or removed link is resolved again instead of reused", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, mac, resolves, stored, relink } = yield* makeLinkedHost;
      expect((yield* host.summary).platforms).toEqual([]);
      const ready = yield* host.ensureReady(noPhase);
      // Readiness checks the link only; the Mac lists its devices when asked to.
      expect(yield* Ref.get(mac.paths)).toEqual([]);
      yield* ready.devices.list;
      yield* ready.devices.list;
      expect(yield* Ref.get(resolves)).toBe(1);
      expect((yield* host.summary).platforms).toEqual([{ platform: "ios", available: true }]);

      yield* relink({}, "token-2");
      yield* ready.devices.list;
      expect(yield* Ref.get(resolves)).toBe(2);
      expect((yield* Ref.get(mac.bearers)).at(-1)).toBe("Bearer token-2");
      const routed = yield* ready.upstream!("/stream", new URLSearchParams());
      expect(routed?.headers).toEqual({ authorization: "Bearer token-2" });

      yield* relink({ access: "auto" }, "token-3");
      const downgraded = yield* ready.devices.list.pipe(Effect.flip);
      expect(downgraded.cause).toMatchObject({
        message: expect.stringContaining("below full access"),
      });
      expect(yield* ready.upstream!("/stream", new URLSearchParams())).toBeNull();

      yield* Ref.set(stored, undefined);
      const unlinked = yield* ready.devices.list.pipe(Effect.flip);
      expect(unlinked.cause).toMatchObject({
        message: expect.stringContaining("no longer linked to Mac"),
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a link replaced while it resolves is resolved again, not used or cached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, mac, resolves, relink, holdNextResolve } = yield* makeLinkedHost;
      const ready = yield* host.ensureReady(noPhase);
      yield* TestClock.adjust("61 seconds");
      const probe = yield* holdNextResolve;
      const slow = yield* Effect.forkChild(ready.devices.list);
      yield* Deferred.await(probe.probing);

      yield* relink({}, "token-2");
      yield* ready.devices.list;
      const routed = yield* ready.upstream!("/stream", new URLSearchParams());
      yield* Deferred.succeed(probe.answer, undefined);
      yield* Fiber.join(slow);

      expect(yield* Ref.get(resolves)).toBe(4);
      expect(yield* Ref.get(mac.bearers)).toEqual(["Bearer token-2", "Bearer token-2"]);
      expect((yield* ready.upstream!("/stream", new URLSearchParams()))?.headers).toEqual({
        authorization: "Bearer token-2",
      });
      expect(yield* hasEnded(routed)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an expired link is not reused and its streams end", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, stored, resolves } = yield* makeLinkedHost;
      const ready = yield* host.ensureReady(noPhase);
      const routed = yield* ready.upstream!("/stream", new URLSearchParams());
      const now = yield* DateTime.now;
      yield* Ref.update(
        stored,
        (value) => value && { ...value, link: { ...value.link, expiresAt: now } },
      );

      const expired = yield* ready.devices.list.pipe(Effect.flip);
      expect(expired.cause).toMatchObject({ message: "The link expired." });
      expect(yield* Ref.get(resolves)).toBe(2);
      expect(yield* hasEnded(routed)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a linked environment that stalls its answer's body does not hang the call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, screenshotAnswered } = yield* makeLinkedHost;
      const ready = yield* host.ensureReady(noPhase);
      const screenshot = yield* Effect.forkChild(ready.devices.screenshot(SIM));
      yield* Deferred.await(screenshotAnswered);
      yield* TestClock.adjust("61 seconds");
      const failed = yield* Fiber.join(screenshot).pipe(Effect.flip);
      expect(failed.cause).toMatchObject({ message: "Mac did not answer." });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("shutting a device down gives up on a silent linked environment within 15 seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, mac } = yield* makeLinkedHost;
      const ready = yield* host.ensureReady(noPhase);
      const shutdown = yield* Effect.forkChild(ready.devices.shutdown(SIM));
      yield* Deferred.await(mac.shutdownRequested);
      yield* TestClock.adjust("16 seconds");
      const failed = yield* Fiber.join(shutdown).pipe(Effect.flip);
      expect(failed.cause).toMatchObject({ message: "Mac did not answer." });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a refused forwarded request forgets the link's token and releasing stays quiet", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, mac, resolves } = yield* makeLinkedHost;
      yield* host.ensureAgentReady(noPhase);
      const ready = (yield* host.current)!;
      const endpoint = yield* ready.devices.agentEndpoint!("SIM-1");
      expect(yield* Ref.get(resolves)).toBe(1);

      yield* Ref.set(mac.daemonStatus, 401);
      expect(yield* rpc(endpoint, endpoint.token)).toBe(401);
      yield* ready.releaseAgentSession!("session-1", "SIM-1");
      yield* ready.devices.list;
      expect(yield* Ref.get(resolves)).toBe(3);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("records the link's renewed expiry from each answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, expiries } = yield* makeLinkedHost;
      yield* host.ensureAgentReady(noPhase);
      const ready = (yield* host.current)!;
      yield* ready.devices.list;
      expect(yield* Ref.get(expiries)).toEqual([RENEWED]);
      const endpoint = yield* ready.devices.agentEndpoint!("SIM-1");
      expect(yield* rpc(endpoint, endpoint.token)).toBe(200);
      expect(yield* Ref.get(expiries)).toEqual([RENEWED, RENEWED]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("hub streams through the link end when the host stops", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host } = yield* makeLinkedHost;
      const ready = yield* host.ensureReady(noPhase);
      const origin = yield* serveHubProxy({ ...ready, hostId: host.id });
      const stream = yield* openStream(origin);
      yield* host.stop;
      expect(yield* awaitEnded(stream)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("hub streams end when the link is linked again or removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, stored, relink } = yield* makeLinkedHost;
      const ready = yield* host.ensureReady(noPhase);
      const origin = yield* serveHubProxy({ ...ready, hostId: host.id });
      const first = yield* openStream(origin);
      yield* relink({}, "token-2");
      yield* ready.devices.list;
      expect(yield* awaitEnded(first)).toBe(true);

      const second = yield* openStream(origin);
      yield* Ref.set(stored, undefined);
      yield* ready.devices.list.pipe(Effect.ignore);
      expect(yield* awaitEnded(second)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the forwarder refuses agents once this environment turns agent access off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, mac, settings } = yield* makeLinkedHost;
      yield* host.ensureAgentReady(noPhase);
      const endpoint = yield* (yield* host.current)!.devices.agentEndpoint!("SIM-1");
      yield* settings.updateSettings({ enableAgentDeviceAccess: false });
      const refused = yield* HttpClient.execute(
        HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
          HttpClientRequest.bearerToken(endpoint.token),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 7, method: "x", params: {} }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(Effect.map((body) => ({ status: response.status, body }))),
        ),
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
      );
      expect(refused).toMatchObject({
        status: 403,
        body: { jsonrpc: "2.0", id: 7, error: { code: -32000 } },
      });
      expect(yield* Ref.get(mac.paths)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the forwarder keeps the link's expiry to itself", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, expiries } = yield* makeLinkedHost;
      yield* host.ensureAgentReady(noPhase);
      const endpoint = yield* (yield* host.current)!.devices.agentEndpoint!("SIM-1");
      const headers = yield* HttpClient.execute(
        HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
          HttpClientRequest.bearerToken(endpoint.token),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, method: "x", params: {} }),
        ),
      ).pipe(
        Effect.map((response) => response.headers),
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
      );
      expect(yield* Ref.get(expiries)).toEqual([RENEWED]);
      expect(headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
