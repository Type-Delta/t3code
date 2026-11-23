// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Mime from "effect/http/Mime";

import { resolveStaticDir } from "../config.ts";
import { guardHttpResponseWriteErrors, keepIdleConnections } from "../httpResponseErrorGuard.ts";
import { acceptsPrivateNetworkConnection } from "../startupAccess.ts";
import type { GatewayConfig } from "./GatewayConfig.ts";
import { makeGatewayConfigSource } from "./GatewayConfigLoader.ts";
import {
  currentGatewayPlatform,
  type GatewayAccountId,
  type ConnectionOwner,
} from "./platform/GatewayPlatform.ts";
import { readPendingUsers } from "./GatewayPending.ts";
import { makeGatewayHelperHandler } from "./gatewayHelper.ts";
import {
  backendCookieHeader,
  backendRequestHeaders,
  hardenBackendResponseHeaders,
  isBackendPath,
  renameSetCookies,
  routeCookie,
  routeRequest,
  tagIssuedBearerToken,
  unroutedMessage,
  withoutHopByHop,
  type GatewayRoute,
} from "./GatewayRouting.ts";

export class GatewayError extends Schema.TaggedError<
  GatewayError,
  { readonly brand: unique symbol }
>()("GatewayError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface GatewayOptions {
  readonly configPath: string;
  readonly pairingDir: string;
  /** The web client to serve. Defaults to the one the running `t3` build serves. */
  readonly staticDir?: string;
}

type Headers = Record<string, string | Array<string>>;

// Same framing policy the server puts on the SPA document.
const SPA_DOCUMENT_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
};
const COMPRESSIBLE_TYPE =
  /^(?:text\/|application\/(?:javascript|json|manifest\+json|xml)|image\/svg\+xml)/;
const UPGRADE_HANDSHAKE_TIMEOUT_MS = 30_000;
// Only for the response head; a long-lived body (an event stream) is not bounded.
const UPSTREAM_HEADER_TIMEOUT_MS = 120_000;
// Pending pairing routes only credential-free discovery; anything else could carry a ticket or
// pairing code meant for another user's backend.
const PENDING_DISCOVERY_PATH = "/.well-known/t3/environment";
// Where a pairing code is spent, and how to read it from the body; it goes to the user whose live
// marker names the code's hash.
const CODE_EXCHANGES: Record<string, { contentType: string; code: (body: string) => unknown }> = {
  "/oauth/token": {
    contentType: "application/x-www-form-urlencoded",
    code: (body) => new URLSearchParams(body).get("subject_token"),
  },
  "/api/auth/browser-session": {
    contentType: "application/json",
    code: (body) => Object(JSON.parse(body)).credential,
  },
};
const MAX_CODE_EXCHANGE_BODY_BYTES = 16 * 1024;
const TOKEN_ISSUE_PATH = "/oauth/token";
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
// Matches PAIRING_TOKEN_PATTERN in auth/PairingGrantStore.ts.
const PAIRING_TOKEN_PATTERN = new RegExp(
  `^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`,
  "i",
);
// Picks up config edits even when no request arrives, so removed users' open sockets are cut off.
const CONFIG_POLL_INTERVAL = "2 seconds";
// Marks a backend that is down or not the registered user's, which answers 503 rather than 502.
const BACKEND_UNAVAILABLE = "T3GW_BACKEND_UNAVAILABLE";
const BACKEND_TIMEOUT = "T3GW_BACKEND_TIMEOUT";

type Backend = { readonly user: string; readonly uid: GatewayAccountId; readonly port: number };
const backendKey = (backend: Backend) => `${backend.user}:${backend.uid}:${backend.port}`;
const isValidStatus = (status: number | undefined): status is number =>
  status !== undefined && status >= 100 && status <= 599;

const isBackendUnavailable = (error: Error & { code?: unknown }) =>
  error.code === BACKEND_UNAVAILABLE || error.code === "ECONNREFUSED";

/**
 * A `createConnection` for 127.0.0.1:<port> that hands the socket over only once `connectionOwner`
 * shows the accepting end belongs to the backend's account, so no request byte reaches a squatter on
 * a restarting backend's port. `track` sees every socket as it is created.
 */
export const connectVerified =
  (backend: Backend, track: (socket: NodeNet.Socket) => void, connectionOwner: ConnectionOwner) =>
  (_options: unknown, callback: (error: Error | null, socket: NodeStream.Duplex) => void) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port: backend.port });
    track(socket);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(error, socket);
    };
    socket.on("error", fail);
    // A reload destroys sockets without an error, which must still fail the waiting request.
    socket.once("close", () => {
      fail(new Error(`The connection to ${backend.user}'s backend closed before it was verified.`));
    });
    socket.once("connect", () => {
      const peerOwner = async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const owner = await connectionOwner(backend.port, socket.localPort ?? 0);
          if (owner !== undefined) return owner;
        }
        return undefined;
      };
      void peerOwner().then(
        (owner) => {
          if (owner === backend.uid && !socket.destroyed) {
            if (settled) return;
            settled = true;
            socket.off("error", fail);
            callback(null, socket);
            return;
          }
          fail(
            Object.assign(
              new Error(
                `Port ${backend.port} is held by account ${owner ?? "unknown"}, not ${backend.user} (${backend.uid}).`,
              ),
              { code: BACKEND_UNAVAILABLE },
            ),
          );
        },
        (error: unknown) => fail(new Error(`Could not verify ${backend.user}'s backend: ${error}`)),
      );
    });
    return undefined;
  };

const serializeHead = (statusLine: string, headers: Headers): string => {
  const lines = [statusLine];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of typeof value === "string" ? [value] : value) lines.push(`${name}: ${item}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
};

// `refresh` renews a cookie route too, so an active user's route does not expire. A token route
// says nothing about which user the client's other requests belong to.
const withRouteCookie = (
  headers: Headers,
  route: GatewayRoute,
  refresh: boolean,
  nowMs: number,
): Headers =>
  route._tag === "Routed" && route.via !== "token" && (refresh || route.via !== "cookie")
    ? {
        ...headers,
        "set-cookie": [...[headers["set-cookie"] ?? []].flat(), routeCookie(route, nowMs)],
      }
    : headers;

// Upgrade responses lose `Connection`/`Upgrade` too; the caller sets them.
const backendResponseHeaders = (
  incoming: NodeHttp.IncomingHttpHeaders,
  user: string,
  route: GatewayRoute,
  nowMs: number,
  refreshRoute: boolean,
): Headers => {
  const headers = hardenBackendResponseHeaders(withoutHopByHop(incoming));
  const setCookies = renameSetCookies([headers["set-cookie"] ?? []].flat(), user);
  delete headers["set-cookie"];
  return withRouteCookie(
    setCookies.length > 0 ? { ...headers, "set-cookie": setCookies } : headers,
    route,
    refreshRoute,
    nowMs,
  );
};

const acceptsGzip = (header: string) => {
  const quality = (coding: string) => {
    for (const part of header.split(",")) {
      const [name, ...params] = part.split(";").map((item) => item.trim().toLowerCase());
      if (name !== coding) continue;
      const q = params.find((param) => param.startsWith("q="));
      return q === undefined ? 1 : Number(q.slice(2));
    }
    return undefined;
  };
  return (quality("gzip") ?? quality("*") ?? 0) > 0;
};

const statFile = (filePath: string) =>
  NodeFS.promises.stat(filePath).then(
    (info) => (info.isFile() ? info : undefined),
    () => undefined,
  );

// Undefined when the body is over `limit` or the client left before sending all of it.
const readBody = (request: NodeHttp.IncomingMessage, limit: number) =>
  new Promise<Buffer | undefined>((resolve) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      request.off("data", onData);
      resolve(undefined);
    };
    request.on("data", onData);
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("close", () => resolve(undefined));
  });

const serveStatic = async (
  staticRoot: string,
  pathname: string,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  // Only the navigation document pins a route, so only it pays for resolving one.
  withDocumentRoute: (headers: Headers) => Promise<Headers>,
) => {
  let relativePath: string;
  try {
    relativePath = NodePath.normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  } catch {
    response.writeHead(400, { "content-type": "text/plain" }).end("Invalid path\n");
    return;
  }
  if (relativePath.startsWith("..") || relativePath.includes("\0")) {
    response.writeHead(400, { "content-type": "text/plain" }).end("Invalid path\n");
    return;
  }
  const requested = NodePath.join(staticRoot, relativePath || "index.html");
  const candidate = NodePath.extname(requested)
    ? requested
    : NodePath.join(requested, "index.html");
  let filePath = candidate;
  let info = await statFile(filePath);
  if (info === undefined) {
    filePath = NodePath.join(staticRoot, "index.html");
    info = await statFile(filePath);
  }
  if (info === undefined) {
    response.writeHead(404, { "content-type": "text/plain" }).end("Not Found\n");
    return;
  }
  const mimeType = Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");
  const isHtml = mimeType === "text/html";
  const isImmutable =
    !isHtml &&
    /^assets\/.+-[\w-]{8}\.[^/]+$/.test(
      NodePath.relative(staticRoot, filePath).split(NodePath.sep).join("/"),
    );
  const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  const baseHeaders: Headers = {
    "content-type": isHtml ? "text/html; charset=utf-8" : mimeType,
    "cache-control": isImmutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    vary: "Accept-Encoding",
    ...(isHtml ? SPA_DOCUMENT_HEADERS : { etag }),
  };
  // Assets are shared across users and may sit in caches, so only the navigation pins the route.
  const headers = isHtml ? await withDocumentRoute(baseHeaders) : baseHeaders;
  const ifNoneMatch = request.headers["if-none-match"];
  if (
    !isHtml &&
    ifNoneMatch?.split(",").some((value) => value.trim() === etag || value.trim() === "*")
  ) {
    response.writeHead(304, headers).end();
    return;
  }
  const accepted = String(request.headers["accept-encoding"] ?? "");
  // Gzip only: on-the-fly brotli at its default quality costs seconds of CPU per large chunk.
  const encoding = COMPRESSIBLE_TYPE.test(mimeType) && acceptsGzip(accepted) ? "gzip" : undefined;
  response.writeHead(
    200,
    encoding === undefined
      ? { ...headers, "content-length": String(info.size) }
      : { ...headers, "content-encoding": encoding },
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const file = NodeFS.createReadStream(filePath);
  const done = () => undefined;
  if (encoding === undefined) NodeStream.pipeline(file, response, done);
  else NodeStream.pipeline(file, NodeZlib.createGzip(), response, done);
};

/** Serves the gateway on `config.listen` for the life of the scope. */
export const serveGateway = Effect.fn("Gateway.serve")(function* (options: GatewayOptions) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const clock = yield* Clock.Clock;
  const warn = (message: string) => runFork(Effect.logWarning(message));
  const staticRoot = options.staticDir ?? (yield* resolveStaticDir());
  if (staticRoot === undefined) {
    return yield* new GatewayError({
      detail: "No built web client found next to this t3 install.",
    });
  }
  const configSource = yield* Effect.tryPromise({
    try: () =>
      makeGatewayConfigSource(options.configPath, (error) =>
        warn(`Kept the previous gateway config: ${String(error)}`),
      ),
    catch: (cause) =>
      new GatewayError({ detail: `Could not load ${options.configPath}: ${String(cause)}` }),
  });
  const platform = yield* currentGatewayPlatform();
  const connectionOwner = yield* platform.makeConnectionOwner;

  // One keep-alive pool per registration: a verified socket never serves another user, uid or port.
  const agents = new Map<string, NodeHttp.Agent>();
  // Every socket to a backend (pooled, verifying, or upgraded), by registration, so a removed or
  // changed registration is cut off at once.
  const backendSockets = new Map<string, Set<NodeNet.Socket>>();
  const trackFor = (backend: Backend) => (socket: NodeNet.Socket) => {
    const key = backendKey(backend);
    let sockets = backendSockets.get(key);
    if (sockets === undefined) {
      sockets = new Set();
      backendSockets.set(key, sockets);
    }
    const owned = sockets.add(socket);
    socket.once("close", () => {
      owned.delete(socket);
      if (owned.size === 0 && backendSockets.get(key) === owned) backendSockets.delete(key);
    });
  };
  const agentFor = (backend: Backend) => {
    const key = backendKey(backend);
    let agent = agents.get(key);
    if (agent === undefined) {
      agent = new NodeHttp.Agent({ keepAlive: true });
      agent.createConnection = connectVerified(backend, trackFor(backend), connectionOwner);
      agents.set(key, agent);
    }
    return agent;
  };
  let currentConfig = configSource.initial;
  const loadConfig = async () => {
    const config = await configSource.get();
    if (config === currentConfig) return config;
    currentConfig = config;
    const bound = configSource.initial.listen;
    if (config.listen.host !== bound.host || config.listen.port !== bound.port) {
      warn("The gateway config changed `listen`; restart the gateway to apply it.");
    }
    const live = new Set(
      Object.entries(config.users).map(([user, entry]) => backendKey({ user, ...entry })),
    );
    for (const key of new Set([...agents.keys(), ...backendSockets.keys()])) {
      if (live.has(key)) continue;
      agents.get(key)?.destroy();
      agents.delete(key);
      for (const socket of backendSockets.get(key) ?? []) socket.destroy();
      backendSockets.delete(key);
    }
    return config;
  };
  // The registration as of now: the config may have changed while the route resolved.
  const backendFor = (user: string): Backend | undefined => {
    const entry = currentConfig.users[user];
    return entry === undefined ? undefined : { user, ...entry };
  };

  const now = () => clock.currentTimeMillisUnsafe();
  // `pendingAllowed` only for requests that cannot carry a credential: the gateway's own document
  // and a bare, bodiless descriptor GET.
  const routeOf = async (
    request: NodeHttp.IncomingMessage,
    url: URL,
    users: GatewayConfig["users"],
    pendingAllowed: boolean,
  ) => {
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const input = {
      url,
      cookieHeader: request.headers.cookie,
      authorization: header("authorization"),
      users,
      fetch: {
        site: header("sec-fetch-site"),
        mode: header("sec-fetch-mode"),
        dest: header("sec-fetch-dest"),
      },
    };
    const firstPass = routeRequest({ ...input, pendingUsers: new Map() });
    // Credentials meant for one backend must never reach whoever happens to be pairing.
    const carriesCredentials =
      request.headers.authorization !== undefined || request.headers.dpop !== undefined;
    if (firstPass._tag === "Routed" || carriesCredentials || !pendingAllowed) return firstPass;
    return routeRequest({
      ...input,
      pendingUsers: await readPendingUsers(
        options.pairingDir,
        users,
        now(),
        platform.markerAttribution,
      ),
    });
  };

  // A code whose hash only one user's live markers name is that user's ("owner"); under another
  // user's route it is a "conflict". A code several users claim, or any unreadable pairing folder,
  // is "ambiguous". Any other exchange routes like every credential-bearing request.
  const codeExchangeRoute = async (
    request: NodeHttp.IncomingMessage,
    url: URL,
    users: GatewayConfig["users"],
    body: Buffer,
  ): Promise<{
    readonly route: GatewayRoute;
    readonly code?: "owner" | "conflict" | "ambiguous";
  }> => {
    const route = await routeOf(request, url, users, false);
    const exchange = CODE_EXCHANGES[url.pathname]!;
    const defaultContentType =
      url.pathname === "/api/auth/browser-session" ? exchange.contentType : "";
    const contentType = String(request.headers["content-type"] ?? defaultContentType)
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (contentType !== exchange.contentType) return { route };
    let token: unknown;
    try {
      token = exchange.code(body.toString("utf8"));
    } catch {
      return { route };
    }
    if (typeof token !== "string") return { route };
    const compactToken = token.replace(/[\s-]/g, "");
    const pairingToken = PAIRING_TOKEN_PATTERN.test(compactToken)
      ? compactToken.toUpperCase()
      : token;
    const tokenSha256 = NodeCrypto.createHash("sha256").update(pairingToken).digest("hex");
    const pending = await readPendingUsers(
      options.pairingDir,
      users,
      now(),
      platform.markerAttribution,
    );
    if (pending === "unknown") return { route, code: "ambiguous" };
    // Markers are world-readable, so a co-user can copy another's hash into their own folder.
    const owners = [...pending].filter(([, { tokens }]) => tokens.has(tokenSha256));
    if (owners.length === 0) return { route };
    if (owners.length > 1) return { route, code: "ambiguous" };
    const [owner, { tokens }] = owners[0]!;
    if (route._tag === "Routed" && route.user === owner) return { route, code: "owner" };
    const ownerRoute = {
      _tag: "Routed",
      user: owner,
      via: "pending",
      expiresAt: tokens.get(tokenSha256)!,
    } as const;
    return { route: ownerRoute, code: route._tag === "Routed" ? "conflict" : "owner" };
  };

  const upstreamFailure = (backend: Backend, error: Error) => {
    warn(`Gateway request to ${backend.user} failed: ${error.message}`);
    if (isBackendUnavailable(error)) {
      return { status: 503, message: `T3 Code is not running for ${backend.user}.\n` };
    }
    return Object(error).code === BACKEND_TIMEOUT
      ? { status: 504, message: "Gateway Timeout\n" }
      : { status: 502, message: "Bad Gateway\n" };
  };

  const handleRequest = async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) => {
    const config = await loadConfig();
    const url = new URL(request.url ?? "/", "http://gateway");
    const isRead = request.method === "GET" || request.method === "HEAD";
    const hasBody =
      request.headers["transfer-encoding"] !== undefined ||
      Number(request.headers["content-length"] ?? 0) > 0;
    // The only requests pending pairing may route: nothing in them can carry a ticket or code.
    const isBareGet = request.method === "GET" && url.search === "" && !hasBody;
    if (!isBackendPath(url.pathname) && isRead) {
      return serveStatic(staticRoot, url.pathname, request, response, async (headers) => {
        const route = await routeOf(request, url, config.users, isBareGet);
        // A marker's short route becomes a lasting one only once its user signed in.
        const refresh =
          route._tag === "Routed" &&
          backendCookieHeader(request.headers.cookie, route.user, Object.keys(config.users)) !==
            undefined;
        return withRouteCookie(headers, route, refresh, now());
      });
    }
    let body: Buffer | undefined;
    let route: GatewayRoute;
    let pairsByCode = false;
    if (request.method === "POST" && Object.hasOwn(CODE_EXCHANGES, url.pathname)) {
      body = await readBody(request, MAX_CODE_EXCHANGE_BODY_BYTES);
      if (body === undefined) {
        if (!request.socket.destroyed) {
          response
            .writeHead(413, { "content-type": "text/plain", connection: "close" })
            .end("Payload Too Large\n");
        }
        return;
      }
      const exchange = await codeExchangeRoute(request, url, config.users, body);
      route = exchange.route;
      pairsByCode = exchange.code === "owner";
      // Spending the code here would pair this browser's other account; the short route lets the
      // client's retry rediscover the code's user.
      if (exchange.code === "conflict") {
        if (request.socket.destroyed) return;
        response
          .writeHead(409, withRouteCookie({ "content-type": "text/plain" }, route, false, now()))
          .end(
            "This pairing code belongs to a different account than the one this browser is signed in to. Scan the code again.\n",
          );
        return;
      }
      if (exchange.code === "ambiguous") {
        if (request.socket.destroyed) return;
        response
          .writeHead(409, { "content-type": "text/plain" })
          .end("Could not tell which account this pairing code belongs to. Try again.\n");
        return;
      }
    } else {
      route = await routeOf(
        request,
        url,
        config.users,
        isBareGet && url.pathname === PENDING_DISCOVERY_PATH,
      );
    }
    // The client may have left while the route resolved.
    if (request.socket.destroyed) return;
    const backend = route._tag === "Routed" ? backendFor(route.user) : undefined;
    if (backend === undefined) {
      const reason = route._tag === "Unrouted" ? route.reason : "none";
      response.writeHead(421, { "content-type": "text/plain" }).end(unroutedMessage(reason));
      return;
    }
    const headers = backendRequestHeaders({
      headers: withoutHopByHop(request.headers),
      user: backend.user,
      users: Object.keys(currentConfig.users),
      peerAddress: request.socket.remoteAddress,
    });
    if (body !== undefined) {
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.length);
    }
    const issuesTokens = request.method === "POST" && url.pathname === TOKEN_ISSUE_PATH;
    // The issued token must be readable to be tagged.
    if (issuesTokens) delete headers["accept-encoding"];
    const upstream = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: backend.port,
        method: request.method,
        path: request.url,
        headers,
        agent: agentFor(backend),
      },
      (upstreamResponse) => {
        clearHeaderTimer();
        try {
          const status = upstreamResponse.statusCode;
          if (!isValidStatus(status)) throw new Error(`invalid status ${status}`);
          // A cookie-routed page load renews the route like the gateway's own document does.
          const isDocument = /^\s*text\/html\b/i.test(
            upstreamResponse.headers["content-type"] ?? "",
          );
          // A spent pairing code signed this browser in, so its route lasts like any other.
          const paired = pairsByCode && status >= 200 && status < 300;
          const headers = backendResponseHeaders(
            upstreamResponse.headers,
            backend.user,
            paired ? { _tag: "Routed", user: backend.user, via: "cookie" } : route,
            now(),
            isDocument || paired,
          );
          if (
            issuesTokens &&
            status >= 200 &&
            status < 300 &&
            upstreamResponse.headers["content-encoding"] === undefined
          ) {
            void readBody(upstreamResponse, MAX_TOKEN_RESPONSE_BYTES).then((issued) => {
              if (response.destroyed) return;
              if (issued === undefined) {
                upstreamResponse.destroy();
                warn(`Gateway token response from ${backend.user} was incomplete or too large.`);
                if (!response.headersSent) {
                  response.writeHead(502, { "content-type": "text/plain" }).end("Bad Gateway\n");
                }
                return;
              }
              const tagged = tagIssuedBearerToken(issued.toString("utf8"), backend.user);
              const answer = tagged === undefined ? issued : Buffer.from(tagged);
              delete headers["transfer-encoding"];
              headers["content-length"] = String(answer.length);
              response.writeHead(status, upstreamResponse.statusMessage, headers).end(answer);
            });
            return;
          }
          response.writeHead(status, upstreamResponse.statusMessage, headers);
        } catch (error) {
          upstreamResponse.destroy();
          warn(`Gateway request to ${backend.user} got an unusable response: ${String(error)}`);
          try {
            response.writeHead(502, { "content-type": "text/plain" }).end("Bad Gateway\n");
          } catch {
            response.destroy();
          }
          return;
        }
        // An aborted upstream response destroys the downstream one instead of leaving it open.
        NodeStream.pipeline(upstreamResponse, response, () => undefined);
      },
    );
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    const startHeaderTimer = () => {
      headerTimer = setTimeout(
        () =>
          upstream.destroy(
            Object.assign(new Error("The backend did not answer in time."), {
              code: BACKEND_TIMEOUT,
            }),
          ),
        UPSTREAM_HEADER_TIMEOUT_MS,
      );
    };
    const clearHeaderTimer = () => {
      upstream.off("finish", startHeaderTimer);
      clearTimeout(headerTimer);
    };
    upstream.once("finish", startHeaderTimer);
    const fail = (error: Error) => {
      clearHeaderTimer();
      const failure = upstreamFailure(backend, error);
      if (response.headersSent) response.destroy();
      else
        response.writeHead(failure.status, { "content-type": "text/plain" }).end(failure.message);
    };
    upstream.on("error", fail);
    // The request asked for no upgrade, so a 101 is a broken backend. Node detaches the socket
    // from the request before this fires, so it never reports an error of its own.
    upstream.on("upgrade", (_upstreamResponse, upstreamSocket: NodeStream.Duplex) => {
      upstreamSocket.destroy();
      fail(new Error("The backend switched protocols on a plain request."));
    });
    response.on("close", () => {
      clearHeaderTimer();
      if (!response.writableFinished) upstream.destroy();
    });
    if (body === undefined) request.pipe(upstream);
    else upstream.end(body);
  };

  // Tracked from the first byte, so shutdown also closes sockets still resolving or handshaking.
  const upgradeSockets = new Set<NodeNet.Socket>();
  const handleUpgrade = async (
    request: NodeHttp.IncomingMessage,
    socket: NodeNet.Socket,
    head: Buffer,
  ) => {
    let answered = false;
    // A client that hangs up mid-handshake cannot use the socket it asked for.
    socket.once("end", () => {
      if (!answered) socket.destroy();
    });
    const config = await loadConfig();
    const route = await routeOf(
      request,
      new URL(request.url ?? "/", "http://gateway"),
      config.users,
      false,
    );
    if (socket.destroyed) return;
    const refuse = (status: string, message: string) => {
      answered = true;
      socket.end(
        serializeHead(`HTTP/1.1 ${status}`, { "content-type": "text/plain", connection: "close" }) +
          message,
      );
    };
    const backend = route._tag === "Routed" ? backendFor(route.user) : undefined;
    if (backend === undefined) {
      refuse(
        "421 Misdirected Request",
        unroutedMessage(route._tag === "Unrouted" ? route.reason : "none"),
      );
      return;
    }
    const upstream = NodeHttp.request({
      host: "127.0.0.1",
      port: backend.port,
      method: request.method,
      path: request.url,
      createConnection: connectVerified(backend, trackFor(backend), connectionOwner),
      headers: backendRequestHeaders({
        headers: request.headers,
        user: backend.user,
        users: Object.keys(currentConfig.users),
        peerAddress: request.socket.remoteAddress,
      }),
    });
    const handshakeTimer = setTimeout(
      () => upstream.destroy(new Error("The backend did not answer the upgrade in time.")),
      UPGRADE_HANDSHAKE_TIMEOUT_MS,
    );
    const answer = () => {
      answered = true;
      clearTimeout(handshakeTimer);
    };
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      upstream.destroy();
    });
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      answer();
      const headers = backendResponseHeaders(
        upstreamResponse.headers,
        backend.user,
        route,
        now(),
        true,
      );
      socket.write(
        serializeHead(`HTTP/1.1 101 ${upstreamResponse.statusMessage ?? "Switching Protocols"}`, {
          ...headers,
          connection: "Upgrade",
          upgrade: upstreamResponse.headers.upgrade ?? "websocket",
        }),
      );
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      const close = () => {
        upstreamSocket.destroy();
        socket.destroy();
      };
      upstreamSocket.on("error", close).on("close", close);
      socket.on("error", close).on("close", close);
      if (socket.destroyed) close();
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on("response", (upstreamResponse) => {
      answer();
      if (!isValidStatus(upstreamResponse.statusCode)) {
        upstreamResponse.destroy();
        refuse("502 Bad Gateway", "Bad Gateway\n");
        return;
      }
      const headers = backendResponseHeaders(
        upstreamResponse.headers,
        backend.user,
        route,
        now(),
        false,
      );
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      socket.write(
        serializeHead(
          `HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage ?? ""}`,
          {
            ...headers,
            connection: "close",
          },
        ),
      );
      NodeStream.pipeline(upstreamResponse, socket, () => undefined);
    });
    upstream.on("error", (error) => {
      const failure = upstreamFailure(backend, error);
      if (answered) socket.destroy();
      else {
        answer();
        refuse(
          failure.status === 503 ? "503 Service Unavailable" : "502 Bad Gateway",
          failure.message,
        );
      }
    });
    upstream.end();
  };

  const server = keepIdleConnections(guardHttpResponseWriteErrors(NodeHttp.createServer()));
  server.on("connection", (socket) => {
    if (!acceptsPrivateNetworkConnection(socket)) socket.destroy();
  });
  server.on("request", (request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      warn(`Gateway request failed: ${String(error)}`);
      if (response.headersSent) response.destroy();
      else response.writeHead(500, { "content-type": "text/plain" }).end("Internal Server Error\n");
    });
  });
  server.on("upgrade", (request, socket: NodeNet.Socket, head: Buffer) => {
    upgradeSockets.add(socket);
    // The server drops its own error handler from upgraded sockets.
    socket.on("error", () => socket.destroy());
    socket.once("close", () => upgradeSockets.delete(socket));
    handleUpgrade(request, socket, head).catch((error: unknown) => {
      warn(`Gateway upgrade failed: ${String(error)}`);
      socket.destroy();
    });
  });

  yield* Effect.promise(loadConfig).pipe(
    Effect.repeat(Schedule.spaced(CONFIG_POLL_INTERVAL)),
    Effect.forkScoped,
  );

  const { host, port } = configSource.initial.listen;
  const helperServer =
    platform.helperHost === "gateway"
      ? NodeHttp.createServer(
          makeGatewayHelperHandler({
            platform,
            configPath: options.configPath,
            context: yield* Effect.context<never>(),
          }),
        )
      : undefined;
  if (helperServer !== undefined) {
    yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            helperServer.once("error", reject);
            helperServer.listen(3774, "127.0.0.1", () => resolve());
          }),
      ),
      () =>
        Effect.callback<void>((resume) => {
          helperServer.close(() => resume(Effect.void));
        }),
    );
  }
  yield* Effect.acquireRelease(
    Effect.callback<void, GatewayError>((resume) => {
      const onError = (error: Error) =>
        resume(
          Effect.fail(
            new GatewayError({ detail: `Could not listen on ${host}:${port}: ${error.message}` }),
          ),
        );
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resume(Effect.void);
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const socket of upgradeSockets) socket.destroy();
        for (const agent of agents.values()) agent.destroy();
        for (const sockets of backendSockets.values())
          for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* new GatewayError({ detail: `Gateway is not listening on ${host}:${port}.` });
  }
  yield* Effect.logInfo(`T3 Code gateway listening on ${address.address}:${address.port}`);
  return address;
});

/** Runs the gateway until interrupted. */
export const runGateway = (options: GatewayOptions) =>
  serveGateway(options).pipe(Effect.andThen(Effect.never), Effect.scoped);
