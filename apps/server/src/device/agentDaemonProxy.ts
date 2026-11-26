import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** An RPC body is a command and its flags; artifacts go through the upload routes. */
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;

// The routes agent-device's own proxy passes to a daemon, by method.
const ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/health$/],
  ["POST", /^\/rpc$/],
  ["POST", /^\/upload(\/preflight|\/finalize)?$/],
  ["PUT", /^\/upload\/direct\/[^/]+$/],
  ["GET", /^\/artifacts(\/[^/]+)*$/],
  ["GET", /^\/sessions\/[^/]+\/requests\/[^/]+\/diagnostics$/],
];

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "cookie",
  "authorization",
  "x-agent-device-token",
  "dpop",
  "origin",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
  "clear-site-data",
]);

/** The credential headers agent-device sends with every daemon request. */
export const agentDaemonAuthHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "x-agent-device-token": token,
});

/** The token an agent-device client sent, from either header it sets. */
export const agentDaemonClientToken = (request: HttpServerRequest.HttpServerRequest) => {
  const authorization = request.headers.authorization ?? "";
  if (/^Bearer /i.test(authorization)) return authorization.slice(7).trim();
  return request.headers["x-agent-device-token"]?.trim() ?? "";
};

const isAgentDaemonRoute = (method: string, path: string) =>
  ROUTES.some(([allowed, pattern]) => allowed === method && pattern.test(path));

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });

/**
 * Forwards one agent-device daemon request to `baseUrl` with `headers` in place of the client's
 * credentials. An RPC's own `params.token` becomes `rpcToken`, or is dropped without one. A daemon's
 * upload ticket names the daemon's address and token, so `uploadTicket` replaces both with where
 * this client sends the upload.
 */
export const forwardAgentDaemonRequest = Effect.fn("agentDaemonProxy.forward")(function* (
  request: HttpServerRequest.HttpServerRequest,
  options: {
    readonly path: string;
    readonly search: string;
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly rpcToken?: string | undefined;
    readonly uploadTicket: (uploadId: string) => {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };
  },
) {
  const method = request.method;
  if (!HttpMethod.isHttpMethod(method) || !isAgentDaemonRoute(method, options.path)) {
    return json(404, { ok: false, error: "Not found", code: "NOT_FOUND" });
  }
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || name.startsWith("x-forwarded-"))
      continue;
    forwarded[name] = value;
  }
  let upstream = HttpClientRequest.make(method)(
    `${options.baseUrl}${options.path}${options.search}`,
  ).pipe(HttpClientRequest.setHeaders({ ...forwarded, ...options.headers }));
  if (options.path === "/rpc") {
    const body = yield* request.text.pipe(Effect.option);
    if (body._tag === "None" || body.value.length > MAX_RPC_BODY_BYTES) {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    }
    const parsed = yield* decodeJson(body.value).pipe(Effect.option);
    if (parsed._tag === "None" || typeof parsed.value !== "object" || parsed.value === null) {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const rpc = parsed.value as { params?: unknown };
    const { token: _clientToken, ...params } =
      typeof rpc.params === "object" && rpc.params !== null
        ? (rpc.params as Record<string, unknown>)
        : {};
    upstream = HttpClientRequest.bodyJsonUnsafe(upstream, {
      ...rpc,
      params: options.rpcToken === undefined ? params : { ...params, token: options.rpcToken },
    });
  } else if (method !== "GET" && method !== "HEAD") {
    upstream = HttpClientRequest.bodyStream(upstream, request.stream, {
      contentType: request.headers["content-type"],
    });
  }
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* httpClient.execute(upstream);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
  }
  if (options.path === "/upload/preflight") {
    const ticket = yield* response.json.pipe(Effect.option);
    if (ticket._tag === "None") return json(502, { ok: false, error: "Invalid upload ticket" });
    return json(response.status, rewriteUploadTicket(ticket.value, options.uploadTicket));
  }
  return HttpServerResponse.stream(response.stream.pipe(Stream.orDie), {
    status: response.status,
    headers,
  });
});

// Keeps only the ticket's content type: its other headers carry the daemon's own token.
const rewriteUploadTicket = (
  ticket: unknown,
  uploadTicket: (uploadId: string) => {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  },
) => {
  if (typeof ticket !== "object" || ticket === null) return ticket;
  const { uploadId, upload } = ticket as { uploadId?: unknown; upload?: unknown };
  if (typeof uploadId !== "string" || /[/?#]/.test(uploadId)) return ticket;
  if (typeof upload !== "object" || upload === null) return ticket;
  const previous = (upload as { headers?: unknown }).headers;
  const contentType =
    typeof previous === "object" && previous !== null
      ? Object.entries(previous).find(([name]) => name.toLowerCase() === "content-type")?.[1]
      : undefined;
  const next = uploadTicket(encodeURIComponent(uploadId));
  return {
    ...ticket,
    upload: {
      ...upload,
      url: next.url,
      headers: {
        ...(typeof contentType === "string" ? { "content-type": contentType } : {}),
        ...next.headers,
      },
    },
  };
};
