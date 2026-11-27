// @effect-diagnostics nodeBuiltinImport:off - The agent-device forwarder is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DevicePlatformAvailability,
  type LinkedDeviceHostConfig,
  PEER_LINK_DEVICES_ROUTE_PREFIX,
  PeerLinkDeviceBooted,
  PeerLinkDeviceFailure,
  PeerLinkDeviceList,
  PeerLinkDevicePlatforms,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  agentDaemonAuthHeaders,
  agentDaemonClientToken,
  agentDaemonRpcRefusal,
  forwardAgentDaemonRequest,
} from "./agentDaemonProxy.ts";
import { releaseAgentDeviceSession } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";

/** Why a linked environment cannot lend its devices right now, in words the Device panel shows. */
export class LinkedDeviceHostFailure extends Schema.TaggedError<LinkedDeviceHostFailure>()(
  "LinkedDeviceHostFailure",
  { message: Schema.String },
) {}
export const isLinkedDeviceHostFailure = Schema.is(LinkedDeviceHostFailure);

/** A resolved link is reused this long; resolving asks the peer who it is first. */
const PEER_REUSE = Duration.seconds(60);
const BOOT_TIMEOUT = Duration.minutes(4);
const REQUEST_TIMEOUT = Duration.seconds(60);
// Closing a device runs under the device service's lock, so an unreachable peer must not hold it long.
const CLOSE_TIMEOUT = Duration.seconds(15);
// An open stream makes no further calls, so it rechecks its link on its own.
const LINK_RECHECK = Duration.seconds(10);

const decodeFailure = Schema.decodeUnknownEffect(PeerLinkDeviceFailure);
const decodeList = HttpClientResponse.schemaBodyJson(PeerLinkDeviceList);
const decodePlatforms = HttpClientResponse.schemaBodyJson(PeerLinkDevicePlatforms);
const decodeBooted = HttpClientResponse.schemaBodyJson(PeerLinkDeviceBooted);

/** Compares in time that depends only on the length, which is fixed for the tokens compared. */
const sameToken = (expected: string, actual: string) => {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
};

/**
 * Simulators and emulators of an environment this one links to. Device operations, the hub's
 * streams and agent-device all reach that machine over the link with the link's own session, so
 * they end when it is unlinked or revoked there. Agents get a loopback address and a token of
 * their own: the link's token never leaves this server.
 */
export const make = Effect.fn("LinkedDeviceHost.make")(function* (config: LinkedDeviceHostConfig) {
  const links = yield* PeerLinks.PeerLinks;
  const http = HttpClient.transform(yield* HttpClient.HttpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
  const random = yield* SecureRandom.SecureRandom;
  const settings = yield* ServerSettings.ServerSettingsService;
  const nodePath = yield* HostProcess.ExecutablePath;
  const hostScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const fail = (message: string) => new LinkedDeviceHostFailure({ message });
  const closed = () => hostScope.state._tag === "Closed";
  const removed = fail(
    `The device host ${config.label} was removed. Add it again in Settings > Integrations > Devices.`,
  );

  let peer:
    | {
        readonly url: string;
        readonly token: string;
        readonly linkedAt: DateTime.Utc;
        readonly at: number;
        readonly ended: Deferred.Deferred<void>;
      }
    | undefined;
  // Streams opened under one link end when it is unlinked, linked again or downgraded.
  let generation:
    | { readonly linkedAt: DateTime.Utc; readonly ended: Deferred.Deferred<void> }
    | undefined;
  // Unknown until the linked environment lists its devices.
  let platforms: ReadonlyArray<DevicePlatformAvailability> | undefined;
  let ready: DeviceHost.DeviceHostReady | null = null;
  let agent: {
    readonly endpoint: DeviceHost.AgentDaemonEndpoint;
    readonly scope: Scope.Closeable;
  } | null = null;
  // Only agents claim sessions on the linked environment, so a host they never used has none to release.
  let agentUsed = false;
  // Counts stops, so a resolve that a stop overtook cannot open a stream afterwards.
  let stops = 0;

  const endGeneration = Effect.suspend(() => {
    const ending = generation;
    generation = undefined;
    return ending === undefined ? Effect.void : Deferred.succeed(ending.ended, undefined);
  });
  yield* Scope.addFinalizer(
    hostScope,
    Effect.suspend(() => {
      ready = null;
      peer = undefined;
      return endGeneration;
    }),
  );

  /** The stored link if it is still the one linked at `linkedAt`; linking again sets a new one. */
  const storedSince = (linkedAt: DateTime.Utc) =>
    links
      .get(config.environmentId)
      .pipe(Effect.map(Option.filter((stored) => DateTime.Equivalence(stored.linkedAt, linkedAt))));

  const resolvePeer = Effect.gen(function* () {
    const since = stops;
    const halted = () => closed() || stops !== since;
    const halt = Effect.failSync(() =>
      closed() ? removed : fail(`${config.label} was turned off. Try again.`),
    );
    const now = yield* Clock.currentTimeMillis;
    if (halted()) return yield* halt;
    if (peer && now - peer.at < Duration.toMillis(PEER_REUSE)) {
      const cached = peer;
      // Reuse never outlives the stored link: unlinking, expiring, or linking again with another
      // token or less access must stop use at once.
      const stored = yield* storedSince(cached.linkedAt).pipe(Effect.orElseSucceed(Option.none));
      const currentTime = yield* DateTime.now;
      if (halted()) return yield* halt;
      if (
        Option.isSome(stored) &&
        stored.value.access === "full-access" &&
        DateTime.isGreaterThan(stored.value.expiresAt, currentTime)
      )
        return cached;
      peer = undefined;
    }
    for (let attempt = 1; ; attempt++) {
      if (halted()) return yield* halt;
      const resolved = yield* links.resolve(config.environmentId).pipe(
        Effect.tapError((error) =>
          error.reason === "unknown_link" || error.reason === "expired"
            ? endGeneration
            : Effect.void,
        ),
        Effect.mapError((error) =>
          closed()
            ? removed
            : fail(
                error.reason === "unknown_link"
                  ? `This environment is no longer linked to ${config.label}. Link it again with full access, or remove this device host.`
                  : error.message,
              ),
        ),
      );
      // Linking again while `resolve` probed the peer leaves this token stale, and it must not end
      // the streams of the newer link.
      const stored = yield* storedSince(resolved.link.linkedAt).pipe(
        Effect.orElseSucceed(Option.none),
      );
      if (halted()) return yield* halt;
      if (
        Option.isNone(stored) ||
        (generation !== undefined &&
          DateTime.isGreaterThan(generation.linkedAt, resolved.link.linkedAt))
      ) {
        if (attempt < 2) continue;
        return yield* fail(
          `The link to ${resolved.link.label} changed while connecting. Try again.`,
        );
      }
      if (stored.value.access !== "full-access") {
        yield* endGeneration;
        return yield* fail(
          `The link to ${resolved.link.label} is below full access. Using its devices runs apps as its user, so link it again with full access.`,
        );
      }
      if (resolved.capabilities.linkDevices !== true)
        return yield* fail(
          `${resolved.link.label} runs a T3 Code version that cannot lend its devices. Update it.`,
        );
      const previous = generation;
      const current =
        previous !== undefined && DateTime.Equivalence(previous.linkedAt, resolved.link.linkedAt)
          ? previous
          : { linkedAt: resolved.link.linkedAt, ended: Deferred.makeUnsafe<void>() };
      generation = current;
      const connected = {
        url: resolved.url,
        token: resolved.token,
        linkedAt: resolved.link.linkedAt,
        at: now,
        ended: current.ended,
      };
      peer = connected;
      if (previous !== undefined && previous !== current)
        yield* Deferred.succeed(previous.ended, undefined);
      if (halted()) return yield* halt;
      return connected;
    }
  });

  /** Forgets the address and token after a failure, so the next call resolves the link again. */
  const forgetPeer = Effect.sync(() => {
    peer = undefined;
  });

  /** The linked environment renews the link's session on each use and says when it now ends. */
  const recordRenewal = (headers: Readonly<Record<string, string | undefined>>) => {
    const renewed = Option.flatMap(
      Option.fromNullishOr(headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]),
      DateTime.make,
    );
    return Option.isSome(renewed)
      ? links.recordExpiry(config.environmentId, renewed.value)
      : Effect.void;
  };

  const recordPeerAnswer = (response: {
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly status: number;
  }) =>
    // A redirect may come from whatever answers the link's address, not the peer.
    response.status >= 300 && response.status < 400
      ? Effect.void
      : Effect.andThen(
          recordRenewal(response.headers),
          response.status === 401 || response.status === 403 ? forgetPeer : Effect.void,
        );

  const call = Effect.fn("LinkedDeviceHost.call")(function* <A, E>(
    path: string,
    options: {
      readonly body?: unknown;
      readonly timeout?: Duration.Input;
      readonly read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>;
    },
  ) {
    const notAnswered = forgetPeer.pipe(
      Effect.andThen(Effect.fail(fail(`${config.label} did not answer.`))),
    );
    // The timeout covers resolving the link too, so a power-off under the device lock stays bounded.
    return yield* Effect.gen(function* () {
      const resolved = yield* resolvePeer;
      const { url, token } = resolved;
      const target = `${url}${PEER_LINK_DEVICES_ROUTE_PREFIX}${path}`;
      const request =
        options.body === undefined
          ? HttpClientRequest.get(target)
          : HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(target), options.body);
      // An operation in flight stops with its link, as a stream does.
      const changed = linkEnded(resolved).pipe(
        Effect.andThen(Effect.fail(fail(`The link to ${config.label} changed. Try again.`))),
      );
      return yield* Effect.raceFirst(
        Effect.gen(function* () {
          const response = yield* http
            .pipe(HttpClient.withScope)
            .execute(HttpClientRequest.bearerToken(request, token))
            .pipe(Effect.catch(() => notAnswered));
          if (response.status >= 300 && response.status < 400)
            return yield* fail(`${config.label} answered HTTP ${response.status}.`);
          yield* recordPeerAnswer(response);
          if (response.status >= 400) {
            const failure = yield* response.json.pipe(
              Effect.flatMap(decodeFailure),
              Effect.orElseSucceed(() => ({
                message: `${config.label} answered HTTP ${response.status}.`,
              })),
            );
            return yield* fail(failure.message);
          }
          return yield* options
            .read(response)
            .pipe(
              Effect.mapError(() =>
                fail(`${config.label} answered in a shape this version cannot read.`),
              ),
            );
        }),
        changed,
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.timeout ?? REQUEST_TIMEOUT,
        orElse: () => notAnswered,
      }),
    );
  }, Effect.scoped);

  const operationError = (operation: string) => (cause: LinkedDeviceHostFailure) =>
    new DeviceOperationError({ operation, reason: "request_failed", cause });
  const unavailable = (cause: LinkedDeviceHostFailure) =>
    new DeviceHostUnavailableError({
      hostId: config.id,
      hostLabel: config.label,
      reason: cause.message,
      cause,
    });

  const listDevices = call("", { read: decodeList }).pipe(
    Effect.tap((listed) =>
      Effect.sync(() => {
        platforms = listed.platforms;
      }),
    ),
  );

  const devices: DeviceHost.DeviceOperations = {
    list: listDevices.pipe(
      Effect.map((listed) => ({
        devices: listed.devices,
        detail: listed.detail,
        ...(listed.androidDiscoveryIncomplete ? { androidDiscoveryIncomplete: true } : {}),
        ...(listed.incompletePlatforms ? { incompletePlatforms: listed.incompletePlatforms } : {}),
      })),
      Effect.mapError(operationError("list")),
    ),
    boot: (device) =>
      call("/boot", { body: { device }, timeout: BOOT_TIMEOUT, read: decodeBooted }).pipe(
        Effect.map((booted) => booted.id),
        Effect.mapError(unavailable),
      ),
    attach: (device) =>
      call("/attach", { body: { device }, timeout: BOOT_TIMEOUT, read: () => Effect.void }).pipe(
        Effect.mapError(operationError("open")),
      ),
    shutdown: (device) =>
      call("/shutdown", {
        body: { device: { id: device.id, platform: device.platform } },
        timeout: CLOSE_TIMEOUT,
        read: () => Effect.void,
      }).pipe(Effect.mapError(operationError("shutdown"))),
    screenshot: (device) =>
      call("/screenshot", {
        body: { device },
        read: (response) => response.arrayBuffer.pipe(Effect.map((bytes) => new Uint8Array(bytes))),
      }).pipe(Effect.mapError(operationError("screenshot"))),
    agentEndpoint: (deviceId) =>
      agent === null
        ? Effect.fail(
            new DeviceHostUnavailableError({
              hostId: config.id,
              hostLabel: config.label,
              reason: "Agent tools for this host are not running. Call device_open again.",
            }),
          )
        : Effect.succeed({ ...agent.endpoint, agentDeviceId: deviceId }),
  };

  // Streams go to the peer's hub as they do to a local one, with the link's session on each.
  /** Completes once the link at `linkedAt` is gone or below full access, such as after relinking lower. */
  const linkReplaced = Effect.fn("LinkedDeviceHost.linkReplaced")(function* (
    linkedAt: DateTime.Utc,
  ) {
    while (true) {
      yield* Effect.sleep(LINK_RECHECK);
      // An unreadable store is not an unlink; open streams wait for the next check.
      const stored = yield* storedSince(linkedAt).pipe(Effect.option);
      if (Option.isNone(stored)) continue;
      if (Option.isNone(stored.value) || stored.value.value.access !== "full-access") return;
    }
  });

  /** Completes when traffic under this resolved link must stop: the host stopped or the link changed. */
  const linkEnded = (resolved: {
    readonly ended: Deferred.Deferred<void>;
    readonly linkedAt: DateTime.Utc;
  }) => Effect.raceFirst(Deferred.await(resolved.ended), linkReplaced(resolved.linkedAt));

  const upstream: NonNullable<DeviceHost.DeviceHostReady["upstream"]> = (hubPath, search) =>
    resolvePeer.pipe(
      Effect.map(({ url, token, ended, linkedAt }) => ({
        url: `${url}${PEER_LINK_DEVICES_ROUTE_PREFIX}/hub${hubPath}${search.size > 0 ? `?${search}` : ""}`,
        headers: { authorization: `Bearer ${token}` },
        protocols: [],
        refuseRedirects: true,
        ended: linkEnded({ ended, linkedAt }),
      })),
      Effect.orElseSucceed(() => null),
    );

  const releaseHttp = http.pipe(HttpClient.tap(recordPeerAnswer));
  const releaseAgentSession = (session: string) =>
    !agentUsed
      ? Effect.void
      : resolvePeer.pipe(
          Effect.flatMap(({ url, token }) =>
            releaseAgentDeviceSession(releaseHttp, {
              baseUrl: `${url}${PEER_LINK_DEVICES_ROUTE_PREFIX}/daemon`,
              token,
            })(session),
          ),
          Effect.timeout(CLOSE_TIMEOUT),
          Effect.catch((cause) =>
            Effect.logWarning("Could not release a linked agent-device session", { cause }),
          ),
        );

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (closed()) return yield* removed;
        if (ready) return ready;
        yield* onPhase("starting", `Connecting to ${config.label}…`);
        // Only the link is checked here: listing waits on the linked environment's own device
        // lock, which a host there lending back to this one could hold while it waits on ours.
        yield* resolvePeer;
        if (closed()) return yield* removed;
        ready = {
          nodePath,
          hub: { origin: `linked:${config.environmentId}` },
          devices,
          upstream,
          releaseAgentSession,
          // Device settings run simctl on the simulator's own machine, which the link does not expose.
          run: () =>
            Effect.succeed({
              stdout: "",
              stderr: "Devices from a linked environment cannot run host commands.",
              code: 127,
            }),
          helpers: { serveSimAxSettings: null, serveSimCli: null },
        };
        return ready;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DeviceHost.DeviceHostError({ hostId: config.id, step: "connecting", cause }),
        ),
      ),
    );

  /** A loopback daemon address for agents here, forwarding to the peer's daemon over the link. */
  const serveForwarder = Effect.fnUntraced(function* (scope: Scope.Closeable) {
    const localToken = Hex.encode(yield* random.randomBytes(32));
    // Closing cuts in-flight requests too, so a revoked token reaches nothing more.
    const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
      disablePreemptiveShutdown: true,
    }).pipe(Scope.provide(scope));
    const port = NetAddress.isInetAddress(server.address) ? server.address.port : undefined;
    if (port === undefined) return yield* fail("The agent-device forwarder did not bind.");
    const origin = `http://127.0.0.1:${port}`;
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!sameToken(localToken, agentDaemonClientToken(request)))
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "Invalid daemon token", code: "UNAUTHORIZED" },
          { status: 401 },
        );
      const url = requestUrl(request);
      // agent-device reads only a JSON-RPC error from /rpc; anything else becomes "Invalid daemon RPC response".
      const refuse = (status: number, message: string, code = "COMMAND_FAILED") =>
        request.method === "POST" && url._tag === "Some" && url.value.pathname === "/rpc"
          ? agentDaemonRpcRefusal(request, status, message)
          : Effect.succeed(
              HttpServerResponse.jsonUnsafe({ ok: false, error: message, code }, { status }),
            );
      const current = yield* settings.getSettings.pipe(Effect.option);
      const enabled = Option.isSome(current) && current.value.enableDeviceSupport;
      if (!enabled || !current.value.enableAgentDeviceAccess)
        return yield* refuse(
          403,
          `${enabled ? "Agent device access" : "Device support"} is off. Turn it on in Settings > Integrations > Devices.`,
          "UNAUTHORIZED",
        );
      const target = yield* resolvePeer.pipe(Effect.result);
      if (url._tag === "None" || target._tag === "Failure")
        return yield* refuse(
          503,
          target._tag === "Failure" ? target.failure.message : `${config.label} is not reachable.`,
        );
      const ended = linkEnded(target.success);
      return yield* forwardAgentDaemonRequest(request, {
        path: url.value.pathname,
        search: url.value.search,
        baseUrl: `${target.success.url}${PEER_LINK_DEVICES_ROUTE_PREFIX}/daemon`,
        headers: { authorization: `Bearer ${target.success.token}` },
        invalidated: ended,
        uploadTicket: (uploadId) => ({
          url: `${origin}/upload/direct/${uploadId}`,
          headers: agentDaemonAuthHeaders(localToken),
        }),
      }).pipe(
        Effect.raceFirst(
          ended.pipe(
            Effect.andThen(refuse(503, `The link to ${config.label} changed. Try again.`)),
          ),
        ),
        Effect.tap(recordPeerAnswer),
        Effect.flatMap((response) =>
          response.status >= 300 && response.status < 400
            ? refuse(502, `${config.label} answered HTTP ${response.status}.`)
            : Effect.succeed(
                HttpServerResponse.removeHeader(
                  response,
                  McpInvocationContext.LINK_EXPIRES_AT_HEADER,
                ),
              ),
        ),
        Effect.catch(() =>
          forgetPeer.pipe(Effect.andThen(refuse(502, `${config.label} stopped answering.`))),
        ),
      );
    });
    yield* server
      .serve(handler.pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.interruptible))
      .pipe(Scope.provide(scope));
    return { endpoint: { baseUrl: origin, token: localToken }, scope };
  });
  const startForwarder = Effect.flatMap(Scope.fork(hostScope, "sequential"), (scope) =>
    serveForwarder(scope).pipe(Effect.onError(() => Scope.close(scope, Exit.void))),
  );

  const stopForwarder = Effect.suspend(() => {
    const running = agent;
    agent = null;
    return running === null ? Effect.void : Scope.close(running.scope, Exit.void);
  });

  // The linked environment starts its daemon on the first forwarded request.
  const ensureAgentReady: DeviceHost.DeviceHost["Service"]["ensureAgentReady"] = (onPhase) =>
    ensureReady(onPhase).pipe(
      Effect.tap(() =>
        lock.withPermit(
          Effect.gen(function* () {
            if (closed()) return yield* removed;
            if (agent === null) agent = yield* startForwarder;
            agentUsed = true;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new DeviceHost.DeviceHostError({
                  hostId: config.id,
                  step: "starting agent tools",
                  cause,
                }),
            ),
          ),
        ),
      ),
      Effect.map((value) => ({ ...value, agentDevice: null })),
    );

  const platformAvailability = Effect.fn("LinkedDeviceHost.platformAvailability")(function* (
    platform: DevicePlatformAvailability["platform"],
  ) {
    if (platforms === undefined) {
      const asked = yield* call("/platforms", { read: decodePlatforms }).pipe(Effect.result);
      if (asked._tag === "Failure")
        return { platform, available: false, reason: asked.failure.message };
      platforms = asked.success.platforms;
    }
    return (
      platforms?.find((candidate) => candidate.platform === platform) ?? {
        platform,
        available: false,
        reason: `${config.label} did not report this platform.`,
      }
    );
  });

  return DeviceHost.DeviceHost.of({
    id: config.id,
    label: config.label,
    summary: Effect.sync(() => ({
      id: config.id,
      label: config.label,
      kind: "linked" as const,
      platforms: platforms ?? [],
      // The linked machine installs its own tools.
      hubInstalled: true,
      agentDeviceInstalled: true,
    })),
    platformAvailability,
    ensureReady,
    ensureAgentReady,
    current: Effect.sync(() => ready),
    stopAgent: lock.withPermit(stopForwarder),
    // Devices and the peer's tools keep running; the peer's owner stops them there.
    stop: lock.withPermit(
      Effect.andThen(
        stopForwarder,
        Effect.sync(() => {
          stops++;
          ready = null;
          peer = undefined;
        }).pipe(Effect.andThen(endGeneration)),
      ),
    ),
  });
});
