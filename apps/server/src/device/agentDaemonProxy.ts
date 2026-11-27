import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpIncomingMessage,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

class AgentDaemonAccessEndedError extends Schema.TaggedError<
  AgentDaemonAccessEndedError,
  { readonly brand: unique symbol }
>()("AgentDaemonAccessEndedError", {}) {}

const decodeRpc = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeUploadTicket = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Literal(true),
    uploadId: Schema.String.check(Schema.isPattern(/^(?!\.{1,2}$)[\w.~_-]+$/)),
    cacheHit: Schema.optionalKey(Schema.Boolean),
    upload: Schema.optionalKey(
      Schema.Struct({
        url: Schema.NonEmptyString,
        headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  }),
);

/** An RPC body is a command and its flags; artifacts go through the upload routes. */
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
const rpcBodyLimit = ByteSize.bytes(MAX_RPC_BODY_BYTES);

const readRpc = (request: HttpServerRequest.HttpServerRequest) =>
  request.arrayBuffer.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, rpcBodyLimit),
    Effect.map((body) =>
      body.byteLength > MAX_RPC_BODY_BYTES ? undefined : decodeRpc(new TextDecoder().decode(body)),
    ),
    Effect.orElseSucceed(() => undefined),
  );

export const agentDaemonRpcRefusal = Effect.fn("agentDaemonProxy.rpcRefusal")(function* (
  request: HttpServerRequest.HttpServerRequest,
  status: number,
  message: string,
) {
  const parsed = yield* readRpc(request);
  const id = parsed?._tag === "Some" ? parsed.value.id : null;
  return HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: typeof id === "number" || typeof id === "string" ? id : null,
      error: { code: -32000, message },
    },
    { status, headers: { "cache-control": "no-store" } },
  );
});

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
    readonly invalidated?: Effect.Effect<void>;
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
    const parsed = yield* readRpc(request);
    if (parsed === undefined) {
      return json(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }
    if (parsed._tag === "None") {
      return json(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const rpc = parsed.value;
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
  if (options.path === "/upload/preflight") {
    if (response.status < 200 || response.status >= 300) {
      return json(response.status, { ok: false, error: "Upload preflight failed" });
    }
    const ticket = yield* response.json.pipe(Effect.option);
    const rewritten =
      ticket._tag === "Some" ? rewriteUploadTicket(ticket.value, options.uploadTicket) : undefined;
    return rewritten === undefined
      ? json(502, { ok: false, error: "Invalid upload ticket" })
      : json(response.status, rewritten);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
  }
  const body = response.stream;
  const invalidated = options.invalidated?.pipe(
    Effect.andThen(Effect.fail(new AgentDaemonAccessEndedError({}))),
  );
  return HttpServerResponse.stream(
    invalidated === undefined ? body : body.pipe(Stream.interruptWhen(invalidated)),
    { status: response.status, headers },
  );
});

// Keeps only the ticket's content type: its other headers carry the daemon's own token.
const rewriteUploadTicket = (
  ticket: unknown,
  uploadTicket: (uploadId: string) => {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  },
) => {
  const parsed = decodeUploadTicket(ticket);
  if (parsed._tag === "None") return undefined;
  const { uploadId, upload, cacheHit } = parsed.value;
  if (cacheHit === true) return { ok: true, uploadId, cacheHit };
  if (upload === undefined) return undefined;
  const contentType = Object.entries(upload.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  const next = uploadTicket(uploadId);
  return {
    ok: true,
    uploadId,
    ...(cacheHit === undefined ? {} : { cacheHit }),
    upload: {
      url: next.url,
      headers: {
        ...(contentType === undefined ? {} : { "content-type": contentType }),
        ...next.headers,
      },
    },
  };
};
