import {
  type DeviceError,
  LOCAL_DEVICE_HOST_ID,
  PEER_LINK_DEVICES_ROUTE_PREFIX,
  PeerLinkDeviceRequest,
  PeerLinkDeviceShutdownRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientError,
  HttpServerError,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import type { AgentDaemonEndpoint } from "../device/DeviceHost.ts";
import {
  agentDaemonAuthHeaders,
  agentDaemonRpcRefusal,
  forwardAgentDaemonRequest,
} from "../device/agentDaemonProxy.ts";
import { forwardHubRequest, hubRequestScope } from "../device/DeviceHubProxy.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ServerSettings from "../serverSettings.ts";

/** How soon an open stream ends after the Linked environments beta is turned off. */
const ACCESS_RECHECK_INTERVAL = Duration.seconds(30);
const NO_STORE = { "cache-control": "no-store" };

const refusal = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error, message }, { status, headers: NO_STORE });

const withLinkExpiry = (
  response: HttpServerResponse.HttpServerResponse,
  linkExpiresAt: DateTime.Utc | undefined,
) =>
  linkExpiresAt === undefined
    ? response
    : HttpServerResponse.setHeader(
        response,
        McpInvocationContext.LINK_EXPIRES_AT_HEADER,
        DateTime.formatIso(linkExpiresAt),
      );

const decodeDeviceRequest = Schema.decodeUnknownEffect(PeerLinkDeviceRequest);
const decodeShutdownRequest = Schema.decodeUnknownEffect(PeerLinkDeviceShutdownRequest);

/** The response for a failed device request; only device errors carry words worth showing. */
const deviceFailure = (
  error: DeviceError | HttpClientError.HttpClientError | HttpServerError.HttpServerError,
) =>
  Effect.succeed(
    error._tag === "DeviceHostUnavailableError"
      ? refusal(503, error._tag, error.reason)
      : error._tag === "DevicePlatformUnavailableError"
        ? refusal(503, error._tag, error.message)
        : error._tag === "HttpClientError" || error._tag === "HttpServerError"
          ? refusal(502, "request_failed", "Its device tools stopped answering. Try again.")
          : refusal(502, error._tag, error.message),
  );

/**
 * Admits a full-access link's session, as client pairing does. Driving a simulator installs and
 * runs apps as this machine's user, which only a full-access link's agents may already do, and
 * not when an administrator's ceiling holds them below full access.
 */
const admitLink = Effect.fnUntraced(function* (
  url: URL,
  refuse: (
    status: number,
    error: string,
    message: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>,
  services: {
    readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
    readonly sessions: SessionStore.SessionStore["Service"];
  },
) {
  const { auth, settings, sessions } = services;
  const request = yield* HttpServerRequest.HttpServerRequest;
  // A browser never holds a link's token; refuse one before reading credentials, as `/mcp` does.
  // The linking environment's hub proxy names this origin, as serve-emu requires for input.
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== url.origin)
    return yield* refuse(403, "origin_not_allowed", "This route does not accept browser requests.");
  const linksEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  // Verifying renews the link's session, as each `/mcp` call does.
  const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
  if (Option.isNone(client))
    return yield* refuse(
      401,
      "unauthorized",
      "Only a linked environment's session is accepted here.",
    );
  const linkExpiresAt = client.value.linkExpiresAt;
  const reject = (status: number, error: string, message: string) =>
    refuse(status, error, message).pipe(
      Effect.map((response) => withLinkExpiry(response, linkExpiresAt)),
    );
  if (!client.value.peerLink)
    return yield* reject(
      403,
      "not_a_link_session",
      "Only a linked environment's session is accepted here.",
    );
  if (!(yield* linksEnabled))
    return yield* reject(
      403,
      "linked_environments_off",
      "Linked environments is off there. Turn it on in its Settings → Labs.",
    );
  const maxRuntimeMode = settings.managedPolicy?.limits?.maxRuntimeMode;
  if (
    client.value.access !== "full-access" ||
    (maxRuntimeMode !== undefined && maxRuntimeMode !== "full-access")
  )
    return yield* reject(
      403,
      "not_a_full_access_link",
      "Only a full-access link may use its devices. Link it again with full access.",
    );
  return {
    linkExpiresAt,
    /** Completes once the link's session is revoked or the beta is turned off. */
    revoked: Effect.raceFirst(
      sessions.awaitInvalidation(client.value.sessionId).pipe(Effect.ignore),
      linksEnabled.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(ACCESS_RECHECK_INTERVAL),
          until: (enabled) => !enabled,
        }),
        Effect.asVoid,
      ),
    ),
  };
});

const make = Effect.gen(function* () {
  const devices = yield* DeviceService.DeviceService;
  const httpClient = yield* HttpClient.HttpClient;
  const forwarding = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(DeviceService.DeviceService, devices),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
  const services = {
    auth: yield* EnvironmentAuth.EnvironmentAuth,
    settings: yield* ServerSettings.ServerSettingsService,
    sessions: yield* SessionStore.SessionStore,
  };
  /** This machine's agent-device daemon, kept between calls so each command does not restart it. */
  const daemon = yield* Ref.make(Option.none<AgentDaemonEndpoint>());

  const startDaemon = Effect.gen(function* () {
    const ready = yield* devices.agentReadinessIfSupported(LOCAL_DEVICE_HOST_ID);
    if (ready?.agentDevice == null) return Option.none<AgentDaemonEndpoint>();
    const endpoint = { baseUrl: ready.agentDevice.baseUrl, token: ready.agentDevice.token };
    yield* Ref.set(daemon, Option.some(endpoint));
    return Option.some(endpoint);
  });

  const operations = Effect.fn("linkDevicesHttp.operations")(function* (
    path: string,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    if (path === "") {
      if (request.method !== "GET") return refusal(405, "method_not_allowed", "Use GET.");
      const ready = yield* devices.readiness(LOCAL_DEVICE_HOST_ID);
      const listed = yield* ready.devices.list;
      const state = yield* devices.state;
      const platforms = state.hosts.find((host) => host.id === LOCAL_DEVICE_HOST_ID)?.platforms;
      return HttpServerResponse.jsonUnsafe(
        { ...listed, platforms: platforms ?? [] },
        { headers: NO_STORE },
      );
    }
    if (path !== "/boot" && path !== "/attach" && path !== "/screenshot" && path !== "/shutdown") {
      return refusal(404, "not_found", "No such device operation.");
    }
    if (request.method !== "POST") return refusal(405, "method_not_allowed", "Use POST.");
    const ready = yield* devices.readiness(LOCAL_DEVICE_HOST_ID);
    const json = yield* request.json.pipe(Effect.option);
    if (path === "/shutdown") {
      const body = yield* Effect.option(decodeShutdownRequest(Option.getOrUndefined(json)));
      if (Option.isNone(body)) return refusal(400, "invalid_request", "Name a device.");
      yield* devices.shutdown({
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: body.value.device.id,
        platform: body.value.device.platform,
      });
      return HttpServerResponse.jsonUnsafe({}, { headers: NO_STORE });
    }
    const body = yield* Effect.option(decodeDeviceRequest(Option.getOrUndefined(json)));
    if (Option.isNone(body)) return refusal(400, "invalid_request", "Name a device.");
    const { device } = body.value;
    switch (path) {
      case "/boot":
        return HttpServerResponse.jsonUnsafe(
          { id: yield* ready.devices.boot(device) },
          { headers: NO_STORE },
        );
      case "/attach":
        yield* ready.devices.attach(device);
        return HttpServerResponse.jsonUnsafe({}, { headers: NO_STORE });
      case "/screenshot":
        return HttpServerResponse.uint8Array(
          (yield* devices.screenshot({ hostId: LOCAL_DEVICE_HOST_ID, deviceId: device.id })).png,
          {
            contentType: "image/png",
            headers: NO_STORE,
          },
        );
    }
  }, Effect.catch(deviceFailure));

  const handleAdmitted = Effect.fnUntraced(function* (
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    path: string,
    revoked: Effect.Effect<void>,
    refuse: (
      status: number,
      error: string,
      message: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>,
  ) {
    if (path.startsWith("/hub/")) {
      const hubPath = path.slice("/hub".length);
      // A full-access link holds both scopes; only the path and method checks apply.
      const refused = hubRequestScope(request, hubPath);
      if (HttpServerResponse.isHttpServerResponse(refused)) return refused;
      const ready =
        (yield* devices.currentReadiness(LOCAL_DEVICE_HOST_ID)) ??
        (yield* devices.readiness(LOCAL_DEVICE_HOST_ID).pipe(Effect.option)).pipe(Option.getOrNull);
      if (!ready) return HttpServerResponse.text("Device hub is not running", { status: 503 });
      return yield* forwardHubRequest(request, url, hubPath, ready, revoked).pipe(
        forwarding,
        Effect.catch(deviceFailure),
      );
    }

    if (path.startsWith("/daemon/")) {
      const settings = yield* services.settings.getSettings.pipe(Effect.option);
      const enabled = Option.isSome(settings) && settings.value.enableDeviceSupport;
      const agentEnabled = enabled && settings.value.enableAgentDeviceAccess;
      if (!agentEnabled) {
        yield* Ref.set(daemon, Option.none());
        return yield* enabled
          ? refuse(
              403,
              "agent_access_off",
              "Agent device access is off there. Turn it on in its Settings > Integrations > Devices.",
            )
          : refuse(
              403,
              "device_support_off",
              "Device support is off there. Turn it on in its Settings > Integrations > Devices.",
            );
      }
      const cached = yield* Ref.get(daemon);
      const started = Option.isSome(cached)
        ? Result.succeed(cached)
        : yield* Effect.result(startDaemon);
      if (Result.isFailure(started) || Option.isNone(started.success))
        return yield* refuse(
          503,
          "agent_unavailable",
          "Its agent tools could not start. Try again.",
        );
      const current = started.success;
      const { baseUrl, token } = current.value;
      return yield* forwardAgentDaemonRequest(request, {
        path: path.slice("/daemon".length),
        search: url.search,
        baseUrl,
        headers: agentDaemonAuthHeaders(token),
        rpcToken: token,
        invalidated: revoked,
        // The linking environment's own forwarder rewrites the address again for its client.
        uploadTicket: (uploadId) => ({
          url: `${url.origin}${PEER_LINK_DEVICES_ROUTE_PREFIX}/daemon/upload/direct/${uploadId}`,
          headers: {},
        }),
      }).pipe(
        forwarding,
        // A daemon that stopped is started again on the next call.
        Effect.catch(() =>
          Ref.set(daemon, Option.none()).pipe(
            Effect.andThen(refuse(503, "agent_unreachable", "Its agent tools stopped. Try again.")),
          ),
        ),
      );
    }

    return yield* operations(path, request);
  });

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) return refusal(400, "invalid_request", "Bad request.");
    const path = url.value.pathname.slice(PEER_LINK_DEVICES_ROUTE_PREFIX.length);
    const refuse = (status: number, error: string, message: string) =>
      path === "/daemon/rpc" && request.method === "POST"
        ? agentDaemonRpcRefusal(request, status, message)
        : Effect.succeed(refusal(status, error, message));
    const admitted = yield* admitLink(url.value, refuse, services);
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;

    const handle = handleAdmitted(request, url.value, path, admitted.revoked, refuse);
    const response = yield* path.startsWith("/daemon/")
      ? Effect.raceFirst(handle, admitted.revoked.pipe(Effect.as(null)))
      : handle;
    return withLinkExpiry(
      response ?? (yield* refuse(403, "link_revoked", "Its link no longer allows device access.")),
      admitted.linkExpiresAt,
    );
  });

  return HttpRouter.add("*", `${PEER_LINK_DEVICES_ROUTE_PREFIX}/*`, handler).pipe(
    Layer.merge(HttpRouter.add("*", PEER_LINK_DEVICES_ROUTE_PREFIX, handler)),
  );
});

/** What an environment serves of its own simulators and emulators to full-access links. */
export const layer = Layer.unwrap(make);
