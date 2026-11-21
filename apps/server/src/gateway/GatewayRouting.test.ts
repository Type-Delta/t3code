import { describe, expect, it } from "@effect/vitest";

import {
  backendCookieHeader,
  backendRequestHeaders,
  hardenBackendResponseHeaders,
  renameSetCookies,
  routeCookie,
  routeRequest,
  tagIssuedBearerToken,
  withoutHopByHop,
} from "./GatewayRouting.ts";

const users = { alice: { uid: 1001, port: 3801 }, bob: { uid: 1002, port: 3802 } };
const EXPIRES = 1_800_000_060_000;

describe("routeRequest", () => {
  const route = (
    path: string,
    cookieHeader: string | undefined,
    pending: Array<string> | "unknown" = [],
    site?: string,
    mode?: string,
    dest?: string,
  ) =>
    routeRequest({
      url: new URL(path, "http://gateway"),
      cookieHeader,
      users,
      pendingUsers:
        pending === "unknown"
          ? pending
          : new Map(pending.map((user) => [user, { expiresAt: EXPIRES }])),
      fetch: { site, mode, dest },
    });

  it.each([
    ["tag beats cookie", "/pair?u=bob", "t3gw_user=alice", [], { user: "bob", via: "tag" }],
    [
      "unknown tag falls to cookie",
      "/?u=mallory",
      "t3gw_user=alice",
      [],
      { user: "alice", via: "cookie" },
    ],
    ["cookie beats pending", "/", "t3gw_user=alice", ["bob"], { user: "alice", via: "cookie" }],
    [
      "unknown cookie falls to pending",
      "/",
      "t3gw_user=mallory",
      ["bob"],
      { user: "bob", via: "pending", expiresAt: EXPIRES },
    ],
    ["inherited names are not users", "/?u=constructor", "t3gw_user=__proto__", [], undefined],
    [
      "pending ignores unregistered users",
      "/",
      undefined,
      ["bob", "mallory"],
      { user: "bob", via: "pending", expiresAt: EXPIRES },
    ],
    [
      "first enrolled route cookie wins",
      "/",
      "t3gw_user=mallory; t3gw_user=bob; t3gw_user=alice",
      [],
      { user: "bob", via: "cookie" },
    ],
    [
      "tag cannot replace another user's route",
      "/api/x?u=bob",
      "t3gw_user=alice",
      [],
      { user: "alice", via: "cookie" },
    ],
    [
      "tag replaces a route when the browser has the target's session",
      "/?u=bob",
      "t3gw_user=alice; t3_session__bob=b",
      [],
      { user: "bob", via: "tag" },
    ],
    [
      "same-site fetch of /pair cannot replace a route",
      "/pair?u=bob",
      "t3gw_user=alice",
      [],
      { user: "alice", via: "cookie" },
      "same-origin",
      "cors",
      "empty",
    ],
    [
      "cross-site tag is ignored",
      "/?u=bob",
      "t3gw_user=alice",
      [],
      { user: "alice", via: "cookie" },
      "cross-site",
    ],
    ["same-site tag counts", "/?u=bob", undefined, [], { user: "bob", via: "tag" }, "same-site"],
    [
      "cross-site tag is ignored without a route too",
      "/?u=bob",
      undefined,
      [],
      undefined,
      "cross-site",
    ],
    [
      "cross-site navigation to /pair keeps its tag",
      "/pair?u=bob",
      "t3gw_user=alice",
      [],
      { user: "bob", via: "tag" },
      "cross-site",
      "navigate",
      "document",
    ],
    [
      "cross-site frame of /pair ignores its tag",
      "/pair?u=bob",
      "t3gw_user=alice",
      [],
      { user: "alice", via: "cookie" },
      "cross-site",
      "navigate",
      "iframe",
    ],
    [
      "cross-site navigation elsewhere ignores its tag",
      "/settings?u=bob",
      "t3gw_user=alice",
      [],
      { user: "alice", via: "cookie" },
      "cross-site",
      "navigate",
      "document",
    ],
  ] as const)(
    "%s",
    (_name, path, cookie, pending, expected, site?: string, mode?: string, dest?: string) => {
      const result = route(path, cookie, [...pending], site, mode, dest);
      expect(result).toEqual(
        expected === undefined
          ? { _tag: "Unrouted", reason: "none" }
          : { _tag: "Routed", ...expected },
      );
    },
  );

  it("routes a gateway-tagged bearer token to its user ahead of tag, cookie and pending", () => {
    const byToken = (authorization: string, path = "/api/x?u=bob") =>
      routeRequest({
        url: new URL(path, "http://gateway"),
        cookieHeader: "t3gw_user=bob; t3_session__alice=a",
        authorization,
        users,
        pendingUsers: new Map([["bob", { expiresAt: EXPIRES }]]),
        fetch: { site: undefined, mode: undefined, dest: undefined },
      });
    expect(byToken("Bearer t3gw~alice~payload.sig")).toEqual({
      _tag: "Routed",
      user: "alice",
      via: "token",
    });
    expect(byToken("bearer t3gw~alice~payload.sig")).toMatchObject({ user: "alice" });
    // A tag naming nobody enrolled must not fall back to whoever the cookie names.
    expect(byToken("Bearer t3gw~mallory~payload.sig")).toEqual({
      _tag: "Unrouted",
      reason: "none",
    });
    expect(byToken("Bearer t3gw~constructor~payload.sig")).toMatchObject({ _tag: "Unrouted" });
    // A backend cannot mint a token that routes to someone else: issuance tags it again.
    expect(
      tagIssuedBearerToken('{"access_token":"t3gw~alice~x","token_type":"Bearer"}', "bob"),
    ).toBe('{"access_token":"t3gw~bob~t3gw~alice~x","token_type":"Bearer"}');
    expect(byToken("Bearer t3gw~bob~t3gw~alice~x")).toMatchObject({ user: "bob", via: "token" });
    // Untagged and DPoP credentials route as before.
    expect(byToken("Bearer payload.sig")).toMatchObject({ user: "bob", via: "tag" });
    expect(byToken("DPoP t3gw~alice~payload.sig", "/api/x")).toMatchObject({
      user: "bob",
      via: "cookie",
    });
  });

  it("lets a pending route cookie last only as long as its marker", () => {
    const now = EXPIRES - 1_500;
    const pending = route("/", undefined, ["bob"]);
    if (pending._tag !== "Routed") throw new Error("expected a route");
    expect(routeCookie(pending, now)).toBe(
      "t3gw_user=bob; Path=/; HttpOnly; SameSite=Lax; Max-Age=2",
    );
    expect(routeCookie({ _tag: "Routed", user: "bob", via: "cookie" }, now)).toBe(
      "t3gw_user=bob; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
    );
  });

  it("refuses to guess between two pairing users", () => {
    expect(route("/", undefined, ["alice", "bob"])).toEqual({
      _tag: "Unrouted",
      reason: "ambiguous",
    });
    expect(route("/", undefined)).toEqual({ _tag: "Unrouted", reason: "none" });
  });

  it("names nobody from a pairing scan it could not finish, but still honors tags and cookies", () => {
    expect(route("/", undefined, "unknown")).toEqual({ _tag: "Unrouted", reason: "ambiguous" });
    expect(route("/", "t3gw_user=alice", "unknown")).toEqual({
      _tag: "Routed",
      user: "alice",
      via: "cookie",
    });
  });
});

describe("cookie rewriting", () => {
  it("forwards only the routed user's cookies under their backend names", () => {
    const header =
      "t3gw_user=alice; t3_session__alice=a1; t3_session__bob=b1; stray=x; t3gw_user__alice=y";
    expect(backendCookieHeader(header, "alice", ["alice", "bob"])).toBe(
      "t3_session=a1; t3gw_user=y",
    );
    expect(backendCookieHeader(header, "bob", ["alice", "bob"])).toBe("t3_session=b1");
    expect(backendCookieHeader("t3gw_user=alice; stray=x", "alice", ["alice"])).toBeUndefined();
  });

  it("gives a cookie to the longest matching username", () => {
    const header = "s__a__bob=theirs; s__bob=mine";
    expect(backendCookieHeader(header, "bob", ["bob", "a__bob"])).toBe("s=mine");
    expect(backendCookieHeader(header, "a__bob", ["bob", "a__bob"])).toBe("s=theirs");
  });

  it("suffixes backend Set-Cookie names and keeps their attributes", () => {
    expect(
      renameSetCookies(["t3_session=abc; Path=/; HttpOnly", "=bad", "noequals"], "alice"),
    ).toEqual(["t3_session__alice=abc; Path=/; HttpOnly"]);
  });
});

describe("backendRequestHeaders", () => {
  it("replaces client-supplied forwarding headers and keeps Host", () => {
    const headers = backendRequestHeaders({
      headers: {
        host: "192.168.1.20:3773",
        cookie: "t3gw_user=alice; t3_session__alice=a1",
        forwarded: "for=1.2.3.4",
        "x-forwarded-for": "1.2.3.4",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        "x-real-ip": "1.2.3.4",
        accept: "*/*",
        authorization: "Bearer t3gw~alice~payload.sig",
      },
      user: "alice",
      users: ["alice"],
      peerAddress: "::ffff:192.168.1.50",
    });
    expect(headers).toEqual({
      host: "192.168.1.20:3773",
      accept: "*/*",
      authorization: "Bearer payload.sig",
      cookie: "t3_session=a1",
      "x-forwarded-for": "192.168.1.50",
      "x-forwarded-proto": "http",
    });
  });
});

describe("withoutHopByHop", () => {
  it("drops hop-by-hop headers and the ones Connection names", () => {
    expect(
      withoutHopByHop({
        connection: "keep-alive, X-Secret",
        "keep-alive": "timeout=5",
        "x-secret": "1",
        te: "trailers",
        trailer: "x-checksum",
        upgrade: "websocket",
        "proxy-connection": "keep-alive",
        "proxy-authenticate": "Basic",
        "proxy-authorization": "Basic eA==",
        "transfer-encoding": "chunked",
        accept: "*/*",
      }),
    ).toEqual({ "transfer-encoding": "chunked", accept: "*/*" });
  });
});

describe("hardenBackendResponseHeaders", () => {
  const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
  it.each([
    ["html without a policy", "text/html; charset=utf-8", undefined, [SANDBOX]],
    ["svg", "image/svg+xml", undefined, [SANDBOX]],
    ["xml subtype", "application/atom+xml", undefined, [SANDBOX]],
    ["missing content type", undefined, undefined, [SANDBOX]],
    ["xslt stylesheet", "text/xsl", undefined, [SANDBOX]],
    ["multipart", "multipart/x-mixed-replace; boundary=x", undefined, [SANDBOX]],
    ["unknown type", "application/x-unknown", undefined, [SANDBOX]],
    ["policy without sandbox", "text/html", "default-src 'self'", ["default-src 'self'", SANDBOX]],
    [
      "backend sandbox is kept and ours added regardless",
      "text/html",
      "sandbox allow-scripts",
      ["sandbox allow-scripts", SANDBOX],
    ],
    ["json is inert", "application/json", undefined, undefined],
    ["problem json is inert", "application/problem+json", undefined, undefined],
    ["raster image is inert", "image/png", undefined, undefined],
    ["plain text is inert", "text/plain; charset=utf-8", undefined, undefined],
    ["event stream is inert", "text/event-stream", undefined, undefined],
    ["font is inert", "font/woff2", undefined, undefined],
  ] as const)("%s", (_name, contentType, policy, expected) => {
    const headers = hardenBackendResponseHeaders({
      ...(contentType === undefined ? {} : { "content-type": contentType }),
      ...(policy === undefined ? {} : { "content-security-policy": policy }),
    });
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toEqual(expected);
  });

  it("strips origin-wide headers and varies on Cookie", () => {
    expect(
      hardenBackendResponseHeaders({
        "content-type": "application/json",
        "clear-site-data": '"*"',
        "service-worker-allowed": "/",
        vary: "Accept-Encoding",
      }),
    ).toEqual({
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      vary: "Accept-Encoding, Cookie",
    });
    expect(hardenBackendResponseHeaders({ "content-type": "image/png" }).vary).toBe("Cookie");
    expect(hardenBackendResponseHeaders({ "content-type": "image/png", vary: "cookie" }).vary).toBe(
      "cookie",
    );
  });
});
