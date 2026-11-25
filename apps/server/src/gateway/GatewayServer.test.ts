// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";

import type { GatewayConfig } from "./GatewayConfig.ts";
import { connectVerified, serveGateway } from "./GatewayServer.ts";
import type { ConnectionOwner } from "./platform/GatewayPlatform.ts";
import { testGatewayServices } from "./platform/testing.ts";

const uid = NodeOS.userInfo().uid;

// Every fake backend runs as this process's account. macOS netstat lists no TCP sockets under the
// Vite+ CLI, so the adapters' own tests cover real attribution.
vi.mock("./platform/GatewayPlatform.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform/GatewayPlatform.ts")>();
  return {
    ...actual,
    currentGatewayPlatform: () =>
      Effect.map(actual.currentGatewayPlatform(), (platform) => ({
        ...platform,
        makeConnectionOwner: Effect.succeed(async () => uid),
        // The helper has its own tests; on Windows it would bind the real helper port.
        helperHost: "service" as const,
      })),
  };
});

// Echoes what it received; answers upgrades with raw bytes, since the gateway only splices sockets.
// Upgrades to /ws-hang are never answered; their sockets go to `hung`.
const fakeBackend = (
  name: string,
  hung?: Queue.Queue<NodeNet.Socket>,
  uploads?: Queue.Queue<void>,
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/api/attachments/upload/slow" && uploads !== undefined) {
          request.once("data", () => Queue.offerUnsafe(uploads, undefined));
          request.on("end", () => Queue.offerUnsafe(uploads, undefined));
          return;
        }
        const badStatus = request.url?.match(/^\/api\/status-(\d+)/)?.[1];
        if (badStatus !== undefined) {
          request.socket.end(`HTTP/1.1 ${badStatus} Odd\r\ncontent-length: 0\r\n\r\n`);
          return;
        }
        if (request.url?.startsWith("/api/switch")) {
          request.socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
          );
          return;
        }
        if (request.url?.startsWith("/api/abort")) {
          response.writeHead(200, { "content-type": "text/plain" });
          response.write("partial", () => response.socket?.destroy());
          return;
        }
        if (request.url === "/oauth/token" || request.url === "/api/auth/browser-session") {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            const issued = new URLSearchParams(body).get("issue");
            if (issued === "cut") {
              response.writeHead(200, { "content-type": "application/json" });
              response.write('{"access_token":"', () => response.socket?.destroy());
              return;
            }
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify(
                issued === null
                  ? { name, body }
                  : {
                      access_token: `${name}-token.sig`,
                      token_type: issued,
                      expires_in: 60,
                      acceptEncoding: request.headers["accept-encoding"] ?? null,
                    },
              ),
            );
          });
          return;
        }
        if (request.url === "/api/auth/session") {
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ name, authorization: request.headers.authorization ?? null }));
          return;
        }
        if (request.url?.startsWith("/api/named-away.html")) {
          request.socket.end(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n" +
              "Connection: content-security-policy, x-content-type-options, vary\r\n" +
              "Content-Security-Policy: default-src *\r\nContent-Length: 2\r\n\r\nhi",
          );
          return;
        }
        if (request.url?.startsWith("/api/doc.html")) {
          response
            .writeHead(200, {
              "content-type": "text/html",
              "content-security-policy": "sandbox allow-scripts",
              "clear-site-data": '"*"',
            })
            .end("<script>steal()</script>");
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": [`t3_session=${name}-session; Path=/; HttpOnly`],
        });
        response.end(
          JSON.stringify({
            name,
            cookie: request.headers.cookie ?? null,
            forwardedFor: request.headers["x-forwarded-for"],
            forwardedHost: request.headers["x-forwarded-host"] ?? null,
            host: request.headers.host,
          }),
        );
      });
      server.on("upgrade", (request, socket: NodeNet.Socket) => {
        if (request.url === "/ws-hang" && hung !== undefined) {
          Queue.offerUnsafe(hung, socket);
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: ws=1\r\n\r\n",
        );
        socket.on("data", (data) => socket.write(`${name}:${data.toString()}`));
        socket.on("end", () => socket.end());
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
    (server) =>
      Effect.promise(() => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

const fetchText = async (
  url: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
) => {
  const response = await fetch(url, { headers, method, ...(body === undefined ? {} : { body }) });
  return { response, body: await response.text() };
};

// For requests fetch would rewrite, such as a POST without Content-Type.
const rawRequest = (
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
  method = "GET",
) =>
  new Promise<{
    readonly status: number;
    readonly body: string;
    readonly setCookie: Array<string>;
  }>((resolve, reject) => {
    const request = NodeHttp.request(
      { host: "127.0.0.1", port, path, headers, method },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            setCookie: response.headers["set-cookie"] ?? [],
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });

const bodyOutcome = (url: string, headers: Record<string, string>) =>
  fetch(url, { headers })
    .then((response) => response.text())
    .then(
      () => "completed",
      () => "aborted",
    );

// A raw client, so the test controls exactly when it half-closes or hangs up.
const rawUpgrade = async (port: number, path: string, cookie: string) => {
  const socket = NodeNet.connect({ host: "127.0.0.1", port });
  await NodeEvents.EventEmitter.once(socket, "connect");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
  );
  return socket;
};

const upgrade = (port: number, cookie: string, path = "/ws") =>
  new Promise<{
    readonly status: string;
    readonly setCookie: Array<string>;
    readonly echo: string;
  }>((resolve, reject) => {
    const request = NodeHttp.request({
      host: "127.0.0.1",
      port,
      path,
      headers: { connection: "Upgrade", upgrade: "websocket", cookie },
    });
    request.on("upgrade", (response, socket) => {
      socket.once("data", (data) => {
        socket.destroy();
        resolve({
          status: String(response.statusCode),
          setCookie: response.headers["set-cookie"] ?? [],
          echo: data.toString(),
        });
      });
      socket.write("ping");
    });
    request.on("response", (response) => {
      response.resume();
      resolve({ status: String(response.statusCode), setCookie: [], echo: "" });
    });
    request.on("error", reject);
    request.end();
  });

describe("serveGateway", () => {
  it.live("routes by tag and cookie, rewrites cookies, proxies upgrades, and reloads config", () =>
    Effect.gen(function* () {
      const hung = yield* Queue.unbounded<NodeNet.Socket>();
      const uploads = yield* Queue.unbounded<void>();
      const alicePort = yield* fakeBackend("alice", hung, uploads);
      const bobPort = yield* fakeBackend("bob");
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3gw-server-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const staticDir = NodePath.join(dir, "client");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(staticDir, "assets"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(staticDir, "index.html"),
          "<!doctype html><title>gateway client</title>",
        );
        await NodeFSP.writeFile(
          NodePath.join(staticDir, "assets", "app-abcd1234.js"),
          "console.log(1)",
        );
      });
      const configPath = NodePath.join(dir, "gateway.json");
      const writeConfig = (users: GatewayConfig["users"]) =>
        Effect.promise(() =>
          NodeFSP.writeFile(
            configPath,
            JSON.stringify({
              version: 1,
              listen: { host: "127.0.0.1", port: 0 },
              users,
            } satisfies GatewayConfig),
          ),
        );
      yield* writeConfig({
        alice: { uid, port: alicePort },
        bob: { uid, port: bobPort },
        // Someone else's uid on alice's port: a squatted backend.
        carol: { uid: uid + 1, port: alicePort },
      });

      const pairingDir = NodePath.join(dir, "pairing");
      const { port } = yield* serveGateway({ configPath, pairingDir, staticDir });
      const origin = `http://127.0.0.1:${port}`;
      const get = (
        path: string,
        headers: Record<string, string> = {},
        method = "GET",
        body?: string,
      ) => Effect.promise(() => fetchText(`${origin}${path}`, headers, method, body));

      const unrouted = yield* get("/api/whoami");
      expect(unrouted.response.status).toBe(421);

      const tagged = yield* get("/api/whoami?u=alice");
      expect(JSON.parse(tagged.body)).toMatchObject({ name: "alice", cookie: null });
      expect(tagged.response.headers.getSetCookie()).toEqual([
        "t3_session__alice=alice-session; Path=/; HttpOnly",
        "t3gw_user=alice; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
      ]);

      const byCookie = yield* get("/api/whoami", {
        cookie: "t3gw_user=bob; t3_session__alice=a; t3_session__bob=b",
        "x-forwarded-for": "8.8.8.8",
        "x-forwarded-host": "evil.example",
      });
      // A client cannot name the gateway's own forwarding headers away.
      const namedAway = yield* Effect.promise(() =>
        rawRequest(port, "/api/whoami", {
          cookie: "t3gw_user=bob",
          connection: "x-forwarded-for, x-forwarded-proto",
        }),
      );
      expect(JSON.parse(namedAway.body)).toMatchObject({ name: "bob", forwardedFor: "127.0.0.1" });
      expect(JSON.parse(byCookie.body)).toEqual({
        name: "bob",
        cookie: "t3_session=b",
        forwardedFor: "127.0.0.1",
        forwardedHost: null,
        host: `127.0.0.1:${port}`,
      });
      expect(byCookie.response.headers.getSetCookie()).toEqual([
        "t3_session__bob=bob-session; Path=/; HttpOnly",
      ]);

      const squatted = yield* get("/api/whoami?u=carol");
      expect(squatted.response.status).toBe(503);

      const switched = yield* get("/api/switch", { cookie: "t3gw_user=alice" });
      expect(switched.response.status).toBe(502);

      for (const status of [600, 99]) {
        const odd = yield* get(`/api/status-${status}`, { cookie: "t3gw_user=alice" });
        expect(odd.response.status).toBe(502);
      }

      const aborted = yield* Effect.promise(() =>
        bodyOutcome(`${origin}/api/abort`, { cookie: "t3gw_user=alice" }),
      );
      expect(aborted).toBe("aborted");

      const backendHtml = yield* get("/api/doc.html", { cookie: "t3gw_user=alice" });
      expect(backendHtml.response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts, sandbox allow-scripts allow-forms allow-popups allow-downloads",
      );
      expect(backendHtml.response.headers.get("clear-site-data")).toBeNull();
      expect(backendHtml.response.headers.get("vary")).toBe("Cookie");
      expect(backendHtml.response.headers.get("x-content-type-options")).toBe("nosniff");
      // A cookie-routed page load renews the route; the JSON above did not.
      expect(backendHtml.response.headers.getSetCookie()).toEqual([
        "t3gw_user=alice; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
      ]);
      // A backend cannot name the gateway's sandbox away through `Connection`.
      const sandboxKept = yield* get("/api/named-away.html", { cookie: "t3gw_user=alice" });
      expect(sandboxKept.response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts allow-forms allow-popups allow-downloads",
      );
      expect(sandboxKept.response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(sandboxKept.response.headers.get("vary")).toBe("Cookie");

      // The gateway's document renews a route to a year only for a user signed in there.
      const notRefreshed = yield* get("/", { cookie: "t3gw_user=bob" });
      expect(notRefreshed.response.headers.getSetCookie()).toEqual([]);
      const refreshed = yield* get("/", { cookie: "t3gw_user=bob; t3_session__bob=b" });
      expect(refreshed.response.headers.getSetCookie()).toEqual([
        "t3gw_user=bob; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
      ]);

      const spa = yield* get("/pair?u=bob");
      expect(spa.body).toContain("gateway client");
      expect(spa.response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(spa.response.headers.getSetCookie()).toEqual([
        "t3gw_user=bob; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
      ]);
      const asset = yield* get("/assets/app-abcd1234.js", { "accept-encoding": "identity" });
      expect(asset.body).toBe("console.log(1)");
      expect(asset.response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      const taggedAsset = yield* get("/assets/app-abcd1234.js?u=bob", {
        "accept-encoding": "gzip",
      });
      expect(taggedAsset.response.headers.getSetCookie()).toEqual([]);
      expect(taggedAsset.response.headers.get("content-encoding")).toBe("gzip");
      const refusedGzip = yield* get("/assets/app-abcd1234.js", {
        "accept-encoding": "gzip;q=0, identity",
      });
      expect(refusedGzip.response.headers.get("content-encoding")).toBeNull();

      const crossSite = yield* get("/api/whoami?u=alice", {
        cookie: "t3gw_user=bob",
        "sec-fetch-site": "cross-site",
      });
      expect(JSON.parse(crossSite.body)).toMatchObject({ name: "bob" });
      expect(crossSite.response.headers.getSetCookie()).not.toContain(
        "t3gw_user=alice; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
      );
      // Without Fetch Metadata (plain-http LAN), a tag moves a route only to a user this browser
      // already has a session with.
      const repinned = yield* get("/api/whoami?u=alice", { cookie: "t3gw_user=bob" });
      expect(JSON.parse(repinned.body)).toMatchObject({ name: "bob" });
      const switchedUser = yield* get("/api/whoami?u=alice", {
        cookie: "t3gw_user=bob; t3_session__alice=a",
      });
      expect(JSON.parse(switchedUser.body)).toMatchObject({ name: "alice" });

      const socket = yield* Effect.promise(() =>
        upgrade(port, "t3gw_user=alice; t3_session__alice=a"),
      );
      expect(socket).toEqual({
        status: "101",
        setCookie: [
          "ws__alice=1",
          "t3gw_user=alice; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
        ],
        echo: "alice:ping",
      });
      const refused = yield* Effect.promise(() => upgrade(port, ""));
      expect(refused.status).toBe("421");
      const squattedUpgrade = yield* Effect.promise(() => upgrade(port, "t3gw_user=carol"));
      expect(squattedUpgrade.status).toBe("503");

      // A client that hangs up, or half-closes, before the 101 takes the backend socket with it.
      for (const leave of ["destroy", "end"] as const) {
        const client = yield* Effect.promise(() => rawUpgrade(port, "/ws-hang", "t3gw_user=alice"));
        const backendSocket = yield* Queue.take(hung);
        // Reading is what lets the backend see the gateway hang up.
        const backendEnded = NodeEvents.EventEmitter.once(backendSocket.resume(), "end");
        client[leave]();
        yield* Effect.promise(() => backendEnded);
        backendSocket.destroy();
      }

      // Only an enrolled user's own folder counts, only for credential-free discovery (the
      // descriptor and the gateway's document), and its route lasts only as long as the marker.
      const now = yield* Clock.currentTimeMillis;
      const marker = NodePath.join(
        pairingDir,
        "alice",
        "00000000-0000-4000-8000-000000000001.json",
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(marker), { recursive: true });
        await NodeFSP.writeFile(
          marker,
          JSON.stringify({ version: 1, expiresAt: now + 60_000, tokenSha256: "0".repeat(64) }),
        );
      });
      const expectShortLived = (setCookies: Array<string>, user = "alice") => {
        expect(setCookies).toHaveLength(1);
        const shortLived = new RegExp(
          `^t3gw_user=${user}; Path=/; HttpOnly; SameSite=Lax; Max-Age=(\\d+)$`,
        );
        const maxAge = Number(setCookies[0]!.match(shortLived)?.[1]);
        expect(maxAge).toBeGreaterThan(0);
        expect(maxAge).toBeLessThanOrEqual(60);
      };
      const descriptor = yield* get("/.well-known/t3/environment");
      expect(JSON.parse(descriptor.body)).toMatchObject({ name: "alice" });
      expectShortLived(
        descriptor.response.headers
          .getSetCookie()
          .filter((cookie) => cookie.startsWith("t3gw_user=")),
      );
      const pendingDocument = yield* get("/");
      expectShortLived(pendingDocument.response.headers.getSetCookie());
      // The document gets the same guard as discovery: a bare, bodiless GET.
      const queriedDocument = yield* get("/?ticket=x");
      expect(queriedDocument.response.headers.getSetCookie()).toEqual([]);
      const documentWithBody = yield* Effect.promise(() =>
        rawRequest(port, "/", { "content-length": "1" }, "x"),
      );
      expect(documentWithBody.setCookie).toEqual([]);
      for (const [path, method] of [
        ["/.well-known/t3/environment", "HEAD"],
        ["/api/whoami", "GET"],
        ["/.well-known/t3/environment?ticket=x", "GET"],
        ["/api/attachments/a.png?ticket=x", "GET"],
        ["/oauth/token", "POST"],
      ] as const) {
        const unpaired = yield* get(path, {}, method);
        expect(unpaired.response.status, path).toBe(421);
      }
      const descriptorWithBody = yield* Effect.promise(() =>
        rawRequest(port, "/.well-known/t3/environment", { "content-length": "1" }, "x"),
      );
      expect(descriptorWithBody.status).toBe(421);
      const ticketedSocket = yield* Effect.promise(() => upgrade(port, "", "/ws?wsTicket=x"));
      expect(ticketedSocket.status).toBe("421");
      for (const credential of ["authorization", "dpop"]) {
        const withCredential = yield* get("/.well-known/t3/environment", {
          [credential]: "token",
        });
        expect(withCredential.response.status).toBe(421);
      }
      yield* Effect.promise(() => NodeFSP.rm(marker));

      // A pairing code exchange goes to the one user whose live marker names the code's hash; under
      // another user's route it is refused unspent. Any other code routes by cookie alone.
      const bobMarker = NodePath.join(
        pairingDir,
        "bob",
        "00000000-0000-4000-8000-000000000002.json",
      );
      const bobToken = "ABCD2345WXYZ";
      const groupedBobToken = " abcd-2345-wxyz ";
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(bobMarker), { recursive: true });
        await NodeFSP.writeFile(
          bobMarker,
          JSON.stringify({
            version: 1,
            expiresAt: now + 60_000,
            tokenSha256: NodeCrypto.createHash("sha256").update(bobToken).digest("hex"),
          }),
        );
      });
      const exchanges = [
        {
          path: "/oauth/token",
          contentType: "application/x-www-form-urlencoded",
          encode: (token: string) =>
            new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token: token,
            }).toString(),
        },
        {
          path: "/api/auth/browser-session",
          contentType: "application/json",
          encode: (credential: string) => JSON.stringify({ credential }),
        },
      ];
      const aliceCookie = "t3gw_user=alice; t3_session__alice=a";
      const yearLong = "t3gw_user=bob; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000";
      const copiedMarker = NodePath.join(
        pairingDir,
        "alice",
        "00000000-0000-4000-8000-000000000003.json",
      );
      for (const { path, contentType, encode } of exchanges) {
        const exchange = (token: string, cookie?: string) =>
          get(
            path,
            { "content-type": contentType, ...(cookie === undefined ? {} : { cookie }) },
            "POST",
            encode(token),
          );
        const otherAccount = yield* exchange(bobToken, aliceCookie);
        expect(otherAccount.response.status, path).toBe(409);
        expect(otherAccount.body).toMatch(/different account/);
        expectShortLived(otherAccount.response.headers.getSetCookie(), "bob");
        const sameAccount = yield* exchange(bobToken, "t3gw_user=bob");
        expect(JSON.parse(sameAccount.body)).toEqual({ name: "bob", body: encode(bobToken) });
        expect(sameAccount.response.headers.getSetCookie()).toEqual([yearLong]);
        const byCookieExchange = yield* exchange("someone-else", aliceCookie);
        expect(JSON.parse(byCookieExchange.body)).toEqual({
          name: "alice",
          body: encode("someone-else"),
        });
        const cookieless = yield* exchange(groupedBobToken);
        expect.soft(cookieless.response.status, path).toBe(200);
        expect
          .soft(cookieless.body, path)
          .toBe(JSON.stringify({ name: "bob", body: encode(groupedBobToken) }));
        expect.soft(cookieless.response.headers.getSetCookie(), path).toEqual([yearLong]);
        const noContentType = yield* Effect.promise(() => {
          const body = encode(bobToken);
          return rawRequest(port, path, { "content-length": String(body.length) }, body, "POST");
        });
        if (path === "/api/auth/browser-session") {
          expect.soft(noContentType.status).toBe(200);
          expect
            .soft(noContentType.body)
            .toBe(JSON.stringify({ name: "bob", body: encode(bobToken) }));
          expect.soft(noContentType.setCookie).toEqual([yearLong]);
        } else {
          expect(noContentType.status).toBe(421);
        }
        const unmatched = yield* exchange("someone-else");
        expect(unmatched.response.status, path).toBe(421);
        const oversized = yield* exchange("x".repeat(20_000), aliceCookie);
        expect(oversized.response.status, path).toBe(413);
        // Markers are world-readable, so a co-user can copy a hash; a hash two users claim names
        // nobody, and neither does any code while a pairing folder cannot be read.
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(copiedMarker), { recursive: true });
          await NodeFSP.copyFile(bobMarker, copiedMarker);
        });
        const contested = [yield* exchange(bobToken, "t3gw_user=bob"), yield* exchange(bobToken)];
        yield* Effect.promise(async () => {
          await NodeFSP.rm(NodePath.dirname(copiedMarker), { recursive: true });
          await NodeFSP.writeFile(NodePath.dirname(copiedMarker), "not a folder");
        });
        const unreadable = [
          yield* exchange(bobToken, "t3gw_user=bob"),
          yield* exchange("someone-else", aliceCookie),
        ];
        yield* Effect.promise(() => NodeFSP.rm(NodePath.dirname(copiedMarker)));
        for (const ambiguous of [...contested, ...unreadable]) {
          expect(ambiguous.response.status, path).toBe(409);
          expect(ambiguous.body).toMatch(/Could not tell which account/);
          expect(ambiguous.response.headers.getSetCookie()).toEqual([]);
        }
      }
      yield* Effect.promise(() => NodeFSP.rm(bobMarker));

      yield* Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const request = NodeHttp.request({
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/attachments/upload/slow",
          headers: { cookie: "t3gw_user=alice", "content-length": "2" },
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => request.destroy()));
        const status = new Promise<number | undefined>((resolve, reject) => {
          request.once("error", reject);
          request.once("response", (response) => {
            response.resume();
            resolve(response.statusCode);
          });
        });
        request.write("a");
        yield* Queue.take(uploads);
        vi.advanceTimersByTime(120_000);
        request.end("b");
        const completed = yield* Effect.raceFirst(
          Queue.take(uploads).pipe(Effect.as("uploaded" as const)),
          Effect.promise(() => status),
        );
        expect(completed).toBe("uploaded");
        vi.advanceTimersByTime(120_000);
        expect(yield* Effect.promise(() => status)).toBe(504);
      }).pipe(Effect.scoped);

      // Removing a user cuts off their open sockets, whatever traffic triggers the reload.
      const bobSocket = yield* Effect.promise(() => rawUpgrade(port, "/ws", "t3gw_user=bob"));
      const [bobHandshake] = yield* Effect.promise(() =>
        NodeEvents.EventEmitter.once(bobSocket, "data"),
      );
      expect(String(bobHandshake)).toMatch(/^HTTP\/1\.1 101 /);
      const bobClosed = NodeEvents.EventEmitter.once(bobSocket, "close");

      yield* writeConfig({ alice: { uid, port: alicePort } });
      const removed = yield* get("/api/whoami", { cookie: "t3gw_user=bob" });
      expect(removed.response.status).toBe(421);
      yield* Effect.promise(() => bobClosed);
    }).pipe(Effect.scoped, Effect.provide(testGatewayServices)),
  );

  // Android's React Native networking drops cookies from requests sent with `credentials: "omit"`,
  // which is how clients send bearer-authenticated requests, so the token itself names its user.
  it.live("tags the bearer tokens it hands out and routes them back without cookies", () =>
    Effect.gen(function* () {
      const alicePort = yield* fakeBackend("alice");
      const bobPort = yield* fakeBackend("bob");
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3gw-token-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const configPath = NodePath.join(dir, "gateway.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          configPath,
          JSON.stringify({
            version: 1,
            listen: { host: "127.0.0.1", port: 0 },
            users: { alice: { uid, port: alicePort }, bob: { uid, port: bobPort } },
          } satisfies GatewayConfig),
        ),
      );
      const { port } = yield* serveGateway({
        configPath,
        pairingDir: NodePath.join(dir, "pairing"),
        staticDir: NodePath.join(dir, "client"),
      });
      const origin = `http://127.0.0.1:${port}`;
      const issue = (tokenType: string) =>
        Effect.promise(() =>
          fetchText(
            `${origin}/oauth/token`,
            {
              cookie: "t3gw_user=alice",
              "content-type": "application/x-www-form-urlencoded",
              "accept-encoding": "gzip, br",
            },
            "POST",
            new URLSearchParams({ issue: tokenType }).toString(),
          ),
        );
      const bearer = yield* issue("Bearer");
      // Gzip would hide the token from the gateway, so the exchange asks for an identity body.
      expect(JSON.parse(bearer.body)).toEqual({
        access_token: "t3gw~alice~alice-token.sig",
        token_type: "Bearer",
        expires_in: 60,
        acceptEncoding: null,
      });
      expect(bearer.response.headers.get("content-length")).toBe(String(bearer.body.length));
      // A DPoP proof hashes the exact token, so those are passed through untouched.
      const dpop = yield* issue("DPoP");
      expect(JSON.parse(dpop.body)).toMatchObject({ access_token: "alice-token.sig" });
      // A token response cut off mid-body fails that request, not the gateway.
      const cut = yield* issue("cut");
      expect(cut.response.status).toBe(502);
      const afterCut = yield* issue("Bearer");
      expect(JSON.parse(afterCut.body)).toMatchObject({
        access_token: "t3gw~alice~alice-token.sig",
      });

      const session = (authorization: string, cookie = "t3gw_user=bob") =>
        Effect.promise(() => fetchText(`${origin}/api/auth/session`, { authorization, cookie }));
      const tagged = yield* session("Bearer t3gw~alice~alice-token.sig");
      expect(JSON.parse(tagged.body)).toEqual({
        name: "alice",
        authorization: "Bearer alice-token.sig",
      });
      // The token's route is not the browser's, so it leaves the route cookie alone.
      expect(tagged.response.headers.getSetCookie()).toEqual([]);
      const noCookie = yield* session("Bearer t3gw~alice~alice-token.sig", "");
      expect(JSON.parse(noCookie.body)).toMatchObject({ name: "alice" });
      const unenrolled = yield* session("Bearer t3gw~mallory~alice-token.sig");
      expect(unenrolled.response.status).toBe(421);
    }).pipe(Effect.scoped, Effect.provide(testGatewayServices)),
  );

  it.live("asks again without a cache before refusing a backend owned by another account", () =>
    Effect.gen(function* () {
      const port = yield* fakeBackend("alice");
      const asked: Array<boolean> = [];
      // A cache that still names the account a reused name used to belong to.
      const owner: ConnectionOwner = async (_backendPort, _clientPort, options) => {
        asked.push(options?.fresh === true);
        return options?.fresh === true ? uid : "S-1-5-21-1-1-1-1999";
      };
      const result = yield* Effect.callback<Error | null>((resume) => {
        connectVerified(
          { user: "alice", uid, port },
          () => {},
          owner,
        )({}, (error, socket) => {
          socket?.destroy();
          resume(Effect.succeed(error ?? null));
        });
      });
      expect(result).toBeNull();
      expect(asked).toEqual([false, true]);
    }).pipe(Effect.scoped),
  );

  it.live("fails a verifying connection that is closed before it connects", () =>
    Effect.gen(function* () {
      const port = yield* fakeBackend("alice");
      const sockets = new Set<NodeNet.Socket>();
      const track = (socket: NodeNet.Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      };
      const result = yield* Effect.callback<Error | null>((resume) => {
        connectVerified(
          { user: "alice", uid, port },
          track,
          async () => uid,
        )({}, (error) => resume(Effect.succeed(error)));
        // What a config reload does to a removed user's sockets.
        for (const socket of sockets) socket.destroy();
      });
      expect(result).toBeInstanceOf(Error);
      expect(sockets.size).toBe(0);
    }).pipe(Effect.scoped),
  );
});
