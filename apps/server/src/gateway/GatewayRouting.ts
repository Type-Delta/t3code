import { isDevProxiedPath } from "@t3tools/shared/devProxy";

import {
  GATEWAY_ROUTE_COOKIE,
  GATEWAY_USER_QUERY_PARAM,
  type GatewayConfig,
} from "./GatewayConfig.ts";

// The server answers only these prefixes itself; every other GET is the static web client.
export const isBackendPath = isDevProxiedPath;

export type GatewayRoute =
  | { readonly _tag: "Routed"; readonly user: string; readonly via: "token" | "tag" | "cookie" }
  | {
      readonly _tag: "Routed";
      readonly user: string;
      readonly via: "pending";
      readonly expiresAt: number;
    }
  | { readonly _tag: "Unrouted"; readonly reason: "none" | "ambiguous" };

const parseCookies = (header: string | undefined): ReadonlyArray<readonly [string, string]> =>
  (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const index = part.indexOf("=");
      return index === -1
        ? ([part, ""] as const)
        : ([part.slice(0, index), part.slice(index + 1)] as const);
    });

// Clients send bearer-authenticated requests with `credentials: "omit"`, and Android's React Native
// networking then drops cookies, so the gateway hands out bearer tokens that name their user.
// Clients treat tokens as opaque; backends only ever see the original.
const BEARER_TAG = "t3gw~";
const BEARER_PATTERN = /^Bearer\s+t3gw~([^~\s]+)~(\S+)\s*$/i;

const taggedBearer = (authorization: string | undefined) => {
  const match = authorization === undefined ? null : BEARER_PATTERN.exec(authorization);
  return match === null ? undefined : { user: match[1]!, token: match[2]! };
};

/**
 * The JSON of a token response with its Bearer `access_token` tagged for `user`, or undefined when
 * there is none. A token that already looks tagged is tagged again, so it can only route back to
 * the backend that issued it. DPoP tokens stay as issued: their proofs hash the exact token.
 */
export const tagIssuedBearerToken = (body: string, user: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { access_token: token, token_type: type } = parsed as Record<string, unknown>;
  if (typeof token !== "string" || typeof type !== "string" || type.toLowerCase() !== "bearer")
    return undefined;
  return JSON.stringify({ ...parsed, access_token: `${BEARER_TAG}${user}~${token}` });
};

// GatewayUserName reserves `__` as the cookie separator.
const cookieOwner = (name: string, users: ReadonlyArray<string>): string | undefined =>
  users
    .filter((user) => name.length > user.length + 2 && name.endsWith(`__${user}`))
    .toSorted((left, right) => right.length - left.length)[0];

/**
 * Gateway-tagged bearer token > `?u=` tag > route cookie > the one user with a live pending pairing.
 * `"unknown"` pending means a pairing folder could not be fully read, so no single user can be
 * named. Callers pass no pending users for requests that may carry credentials.
 */
export const routeRequest = (input: {
  readonly url: URL;
  readonly cookieHeader: string | undefined;
  readonly authorization?: string | undefined;
  readonly users: GatewayConfig["users"];
  readonly pendingUsers: ReadonlyMap<string, { readonly expiresAt: number }> | "unknown";
  readonly fetch: {
    readonly site: string | undefined;
    readonly mode: string | undefined;
    readonly dest: string | undefined;
  };
}): GatewayRoute => {
  const isUser = (name: string | undefined): name is string =>
    name !== undefined && Object.hasOwn(input.users, name);
  // The token's own backend is the only one that can accept it, whatever the cookie says.
  const bearer = taggedBearer(input.authorization);
  if (bearer !== undefined) {
    return isUser(bearer.user)
      ? { _tag: "Routed", user: bearer.user, via: "token" }
      : { _tag: "Unrouted", reason: "none" };
  }
  const cookies = parseCookies(input.cookieHeader);
  // Plain-http LAN origins get no Fetch Metadata, so a /pair request without it counts too;
  // browsers refuse SameSite=Lax cookies from cross-site subresource responses.
  const isPairingNavigation =
    input.url.pathname === "/pair" &&
    (input.fetch.mode === undefined ||
      (input.fetch.mode === "navigate" && input.fetch.dest === "document"));
  // A pairing link opened from mail or chat is a cross-site navigation to /pair.
  const tagged =
    input.fetch.site === "cross-site" && !isPairingNavigation
      ? undefined
      : (input.url.searchParams.get(GATEWAY_USER_QUERY_PARAM) ?? undefined);
  const cookie = cookies.find(
    ([name, value]) => name === GATEWAY_ROUTE_COOKIE && isUser(value),
  )?.[1];
  // Without Fetch Metadata a foreign site's tagged link looks same-site, so a tag only moves an
  // existing route to a user this browser already has a session with, or from a pairing link.
  const mayReplace = (target: string) =>
    isPairingNavigation ||
    cookies.some(([name]) => cookieOwner(name, Object.keys(input.users)) === target);
  if (isUser(tagged) && (cookie === undefined || cookie === tagged || mayReplace(tagged))) {
    return { _tag: "Routed", user: tagged, via: "tag" };
  }
  if (cookie !== undefined) return { _tag: "Routed", user: cookie, via: "cookie" };
  if (input.pendingUsers === "unknown") return { _tag: "Unrouted", reason: "ambiguous" };
  const pending = [...input.pendingUsers].filter(([user]) => isUser(user));
  if (pending.length === 1) {
    const [user, { expiresAt }] = pending[0]!;
    return { _tag: "Routed", user, via: "pending", expiresAt };
  }
  return { _tag: "Unrouted", reason: pending.length > 1 ? "ambiguous" : "none" };
};

export const unroutedMessage = (reason: "none" | "ambiguous"): string =>
  reason === "ambiguous"
    ? "Cannot tell which user is pairing right now. Open your pairing link again, or try in a moment.\n"
    : "This T3 Code gateway does not know which user you are. Open the pairing link from `t3 gateway pair`.\n";

const ROUTE_COOKIE_MAX_AGE_S = 31_536_000;

/** A pending route only lasts as long as its marker; tag and cookie routes last a year. */
export const routeCookie = (route: GatewayRoute & { _tag: "Routed" }, nowMs: number): string => {
  const maxAge =
    route.via === "pending"
      ? Math.min(ROUTE_COOKIE_MAX_AGE_S, Math.max(0, Math.ceil((route.expiresAt - nowMs) / 1000)))
      : ROUTE_COOKIE_MAX_AGE_S;
  return `${GATEWAY_ROUTE_COOKIE}=${route.user}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
};

/** Only the routed user's cookies reach their backend, under the names that backend set. */
export const backendCookieHeader = (
  header: string | undefined,
  user: string,
  users: ReadonlyArray<string>,
): string | undefined => {
  const cookies = parseCookies(header)
    .filter(([name]) => cookieOwner(name, users) === user)
    .map(([name, value]) => `${name.slice(0, -(user.length + 2))}=${value}`);
  return cookies.length > 0 ? cookies.join("; ") : undefined;
};

export const renameSetCookies = (values: ReadonlyArray<string>, user: string): Array<string> =>
  values.flatMap((value) => {
    const index = value.indexOf("=");
    const name = index === -1 ? "" : value.slice(0, index).trim();
    return name.length === 0 ? [] : [`${name}__${user}${value.slice(index)}`];
  });

// Node frames bodies itself, so `transfer-encoding` is left to it.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
];

/**
 * A copy without hop-by-hop headers, including any the `Connection` header names. Apply it before
 * adding the gateway's own headers, which the sender must not be able to name away.
 */
export const withoutHopByHop = (
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
): Record<string, string | Array<string>> => {
  const dropped = new Set([
    ...HOP_BY_HOP,
    ...[headers.connection ?? []]
      .flat()
      .flatMap((value) => value.split(","))
      .map((name) => name.trim().toLowerCase()),
  ]);
  const kept: Record<string, string | Array<string>> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || dropped.has(name)) continue;
    kept[name] = typeof value === "string" ? value : [...value];
  }
  return kept;
};

const SPOOFABLE_REQUEST_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
];

export const backendRequestHeaders = (input: {
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly user: string;
  readonly users: ReadonlyArray<string>;
  readonly peerAddress: string | undefined;
}): Record<string, string | Array<string>> => {
  const headers: Record<string, string | Array<string>> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (value === undefined || name === "cookie" || SPOOFABLE_REQUEST_HEADERS.includes(name))
      continue;
    headers[name] = typeof value === "string" ? value : [...value];
  }
  const cookie = backendCookieHeader(
    typeof input.headers.cookie === "string" ? input.headers.cookie : undefined,
    input.user,
    input.users,
  );
  if (cookie !== undefined) headers.cookie = cookie;
  const bearer = taggedBearer(
    typeof input.headers.authorization === "string" ? input.headers.authorization : undefined,
  );
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer.token}`;
  if (input.peerAddress !== undefined) {
    headers["x-forwarded-for"] = input.peerAddress.replace(/^::ffff:/, "");
  }
  headers["x-forwarded-proto"] = "http";
  return headers;
};

// Types a browser never runs as a document with the origin's privileges. Everything else, untyped
// responses included, may be (HTML, SVG, XML with an XSLT stylesheet, multipart, ...).
const INERT_CONTENT_TYPE =
  /^(?:application\/(?:[\w.-]+\+)?json|application\/(?:pdf|javascript|octet-stream)|text\/(?:plain|css|javascript|event-stream)|image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|(?:audio|video|font)\/[\w.+-]+)$/;
// Never `allow-same-origin`: every backend shares the gateway's origin.
const BACKEND_DOCUMENT_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
// Both act on the whole shared origin, so one user's backend could wipe or claim the others'.
const ORIGIN_WIDE_RESPONSE_HEADERS = ["clear-site-data", "service-worker-allowed"];

/**
 * Every backend shares the gateway's origin, so backend documents must not run with it. Browsers
 * enforce every CSP header, so the added sandbox only tightens whatever the backend sent.
 */
export const hardenBackendResponseHeaders = (
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
): Record<string, string | Array<string>> => {
  const hardened: Record<string, string | Array<string>> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || ORIGIN_WIDE_RESPONSE_HEADERS.includes(name)) continue;
    hardened[name] = typeof value === "string" ? value : [...value];
  }
  hardened["x-content-type-options"] = "nosniff";
  // The same URL answers differently per routed user.
  const vary = [hardened.vary ?? []].flat();
  if (!vary.some((value) => /(?:^|,)\s*(?:cookie|\*)\s*(?:,|$)/i.test(value))) {
    hardened.vary = [...vary, "Cookie"].join(", ");
  }
  const contentType = String(headers["content-type"] ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (INERT_CONTENT_TYPE.test(contentType)) return hardened;
  hardened["content-security-policy"] = [
    ...[hardened["content-security-policy"] ?? []].flat(),
    BACKEND_DOCUMENT_SANDBOX,
  ];
  return hardened;
};
