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
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as PeerLinks from "../peer/PeerLinks.ts";
import { requestUrl } from "../requestUrl.ts";
import { agentDaemonAuthHeaders, agentDaemonClientToken, forwardAgentDaemonRequest } from "./agentDaemonProxy.ts";
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

const decodeFailure = Schema.decodeUnknownEffect(PeerLinkDeviceFailure);
const decodeList = HttpClientResponse.schemaBodyJson(PeerLinkDeviceList);
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
  const http = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const nodePath = yield* HostProcess.ExecutablePath;
  const hostScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const fail = (message: string) => new LinkedDeviceHostFailure({ message });

  let peer: { readonly url: string; readonly token: string; readonly at: number } | undefined;
  let platforms: ReadonlyArray<DevicePlatformAvailability> = [
    { platform: "ios", available: true },
    { platform: "android", available: true },
  ];
  let ready: DeviceHost.DeviceHostReady | null = null;
  let agent: DeviceHost.AgentDaemonEndpoint | null = null;

  const resolvePeer = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    // Reuse never outlives the stored link: unlinking here must stop use at once.
    if (
      peer &&
      now - peer.at < Duration.toMillis(PEER_REUSE) &&
      Option.isSome(yield* links.get(config.environmentId).pipe(Effect.orElseSucceed(Option.none)))
    )
      return peer;
    const resolved = yield* links.resolve(config.environmentId).pipe(
      Effect.mapError((error) =>
        fail(
          error.reason === "unknown_link"
            ? `This environment is no longer linked to ${config.label}. Link it again with full access, or remove this device host.`
            : error.message,
        ),
      ),
    );
    if (resolved.link.access !== "full-access")
      return yield* fail(
        `The link to ${resolved.link.label} is below full access. Using its devices runs apps as its user, so link it again with full access.`,
      );
    if (resolved.capabilities.linkDevices !== true)
      return yield* fail(
        `${resolved.link.label} runs a T3 Code version that cannot lend its devices. Update it.`,
      );
    peer = { url: resolved.url, token: resolved.token, at: now };
    return peer;
  });

  /** Forgets the address and token after a failure, so the next call resolves the link again. */
  const forgetPeer = Effect.sync(() => {
    peer = undefined;
  });

  const call = Effect.fn("LinkedDeviceHost.call")(function* <A, E>(
    path: string,
    options: {
      readonly body?: unknown;
      readonly timeout?: Duration.Input;
      readonly read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>;
    },
  ) {
    const { url, token } = yield* resolvePeer;
    const target = `${url}${PEER_LINK_DEVICES_ROUTE_PREFIX}${path}`;
    const request =
      options.body === undefined
        ? HttpClientRequest.get(target)
        : HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(target), options.body);
    const response = yield* http
      .pipe(HttpClient.withScope)
      .execute(HttpClientRequest.bearerToken(request, token))
      .pipe(
        Effect.timeout(options.timeout ?? REQUEST_TIMEOUT),
        Effect.tapError(() => forgetPeer),
        Effect.mapError(() => fail(`${config.label} did not answer.`)),
      );
    if (response.status >= 400) {
      if (response.status === 401 || response.status === 403) yield* forgetPeer;
      const failure = yield* response.json.pipe(
        Effect.flatMap(decodeFailure),
        Effect.orElseSucceed(() => ({ message: `${config.label} answered HTTP ${response.status}.` })),
      );
      return yield* fail(failure.message);
    }
    return yield* options
      .read(response)
      .pipe(
        Effect.mapError(() => fail(`${config.label} answered in a shape this version cannot read.`)),
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
        if (listed.platforms.length > 0) platforms = listed.platforms;
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
        : Effect.succeed({ ...agent, agentDeviceId: deviceId }),
  };

  // Streams go to the peer's hub as they do to a local one, with the link's session on each.
  const upstream: NonNullable<DeviceHost.DeviceHostReady["upstream"]> = (hubPath, search) =>
    resolvePeer.pipe(
      Effect.map(({ url, token }) => ({
        url: `${url}${PEER_LINK_DEVICES_ROUTE_PREFIX}/hub${hubPath}${search.size > 0 ? `?${search}` : ""}`,
        headers: { authorization: `Bearer ${token}` },
        protocols: [],
      })),
      Effect.orElseSucceed(() => null),
    );

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (ready) return ready;
        yield* onPhase("starting", `Connecting to ${config.label}…`);
        // The first listing proves the link reaches a machine that lends its devices.
        yield* listDevices.pipe(
          Effect.mapError(
            (cause) =>
              new DeviceHost.DeviceHostError({ hostId: config.id, step: "connecting", cause }),
          ),
        );
        ready = {
          nodePath,
          hub: { origin: `linked:${config.environmentId}` },
          devices,
          upstream,
          releaseAgentSession: (session) =>
            agent === null ? Effect.void : releaseAgentDeviceSession(http, agent)(session),
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
      }),
    );

  /** A loopback daemon address for agents here, forwarding to the peer's daemon over the link. */
  const startForwarder = Effect.gen(function* () {
    const localToken = Hex.encode(yield* random.randomBytes(32));
    const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
    }).pipe(Scope.provide(hostScope));
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
      const target = yield* resolvePeer.pipe(Effect.option);
      if (url._tag === "None" || target._tag === "None")
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: `${config.label} is not reachable.`, code: "COMMAND_FAILED" },
          { status: 503 },
        );
      return yield* forwardAgentDaemonRequest(request, {
        path: url.value.pathname,
        search: url.value.search,
        baseUrl: `${target.value.url}${PEER_LINK_DEVICES_ROUTE_PREFIX}/daemon`,
        headers: { authorization: `Bearer ${target.value.token}` },
        uploadTicket: (uploadId) => ({
          url: `${origin}/upload/direct/${uploadId}`,
          headers: agentDaemonAuthHeaders(localToken),
        }),
      }).pipe(
        Effect.catch(() =>
          forgetPeer.pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe(
                { ok: false, error: `${config.label} stopped answering.`, code: "COMMAND_FAILED" },
                { status: 502 },
              ),
            ),
          ),
        ),
      );
    });
    yield* server
      .serve(handler.pipe(Effect.provideService(HttpClient.HttpClient, http)))
      .pipe(Scope.provide(hostScope));
    return { baseUrl: origin, token: localToken };
  });

  const ensureAgentReady: DeviceHost.DeviceHost["Service"]["ensureAgentReady"] = (onPhase) =>
    ensureReady(onPhase).pipe(
      Effect.tap(() =>
        lock.withPermit(
          Effect.gen(function* () {
            // Starts the peer's daemon, or says why its agent access is off.
            yield* call("/agent", { body: {}, timeout: BOOT_TIMEOUT, read: () => Effect.void });
            if (agent === null) agent = yield* startForwarder;
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

  const platformAvailability = (platform: DevicePlatformAvailability["platform"]) =>
    Effect.sync(
      () =>
        platforms.find((candidate) => candidate.platform === platform) ?? {
          platform,
          available: false,
          reason: `${config.label} did not report this platform.`,
        },
    );

  return DeviceHost.DeviceHost.of({
    id: config.id,
    label: config.label,
    summary: Effect.sync(() => ({
      id: config.id,
      label: config.label,
      kind: "linked" as const,
      platforms,
      // The linked machine installs its own tools.
      hubInstalled: true,
      agentDeviceInstalled: true,
    })),
    platformAvailability,
    ensureReady,
    ensureAgentReady,
    current: Effect.sync(() => ready),
    stopAgent: Effect.void,
    // Devices and the peer's tools keep running; the peer's owner stops them there.
    stop: Effect.sync(() => {
      ready = null;
      peer = undefined;
    }),
  });
});
