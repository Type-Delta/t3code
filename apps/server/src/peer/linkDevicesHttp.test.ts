// @effect-diagnostics nodeBuiltinImport:off - The fake hub and daemon are Node HTTP servers.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  type DeviceHostId,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { Toolkit } from "effect/ai";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";

import * as DeviceHost from "../device/DeviceHost.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as LinkedDeviceHost from "../device/LinkedDeviceHost.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as LinkDevicesHttp from "./linkDevicesHttp.ts";
import * as PeerLinks from "./PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  type ServedPeer,
  servePeer,
} from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const mac = descriptorOf("environment-mac", "Mac", { linkDevices: true });
const NoTools = Toolkit.make();
const DAEMON_TOKEN = "daemon-secret";
const simulator = {
  id: "SIM-1",
  platform: "ios" as const,
  name: "iPhone 17",
  version: "iOS 26.0",
  booted: false,
  physical: false,
};

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/** A loopback HTTP server that records each request and answers with `respond`. */
const serveFake = (respond: (seen: Seen) => HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<Seen>>([]);
    const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
    });
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
        const entry = { method: request.method, url: request.url, headers: request.headers, body };
        yield* Ref.update(seen, (all) => [...all, entry]);
        return respond(entry);
      }),
    );
    if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die("no TCP address");
    return { origin: `http://127.0.0.1:${server.address.port}`, seen };
  });

/** The Mac: its own device service, with a hub and an agent-device daemon on its loopback. */
const serveMac = Effect.gen(function* () {
  const hub = yield* serveFake(() => HttpServerResponse.text("frame"));
  const daemon = yield* serveFake((request) =>
    request.url.startsWith("/upload/preflight")
      ? HttpServerResponse.jsonUnsafe({
          ok: true,
          uploadId: "up-1",
          upload: {
            url: `http://127.0.0.1:1/upload/direct/up-1`,
            headers: { authorization: `Bearer ${DAEMON_TOKEN}`, "content-type": "application/zip" },
          },
        })
      : HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
  );
  const booted = yield* Ref.make<ReadonlyArray<string>>([]);
  const ready: DeviceService.DeviceReadiness = {
    hostId: LOCAL_DEVICE_HOST_ID,
    nodePath: "node",
    hub: { origin: hub.origin },
    devices: {
      list: Effect.succeed({ devices: [simulator], detail: undefined }),
      boot: (device) => Ref.update(booted, (ids) => [...ids, device.id]).pipe(Effect.as(device.id)),
      attach: () => Effect.void,
      shutdown: () => Effect.void,
      screenshot: () => Effect.succeed(new Uint8Array()),
    },
    run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  const devices = Layer.mock(DeviceService.DeviceService)({
    readiness: () => Effect.succeed(ready),
    currentReadiness: () => Effect.succeed(ready),
    agentReadinessIfSupported: () =>
      Effect.succeed({
        ...ready,
        agentDevice: { baseUrl: daemon.origin, token: DAEMON_TOKEN, entryPath: "" },
      }),
    state: Effect.succeed({
      hosts: [
        {
          id: LOCAL_DEVICE_HOST_ID,
          label: "This machine",
          kind: "local" as const,
          platforms: [{ platform: "ios" as const, available: true }],
          hubInstalled: true,
          agentDeviceInstalled: true,
        },
      ],
      hostStatus: "ready" as const,
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: true,
      agentAccessEnabled: true,
      hubBasePath: "/api/device-hub",
      revision: 0,
    }),
  });
  const peer = yield* servePeer(
    mac as ExecutionEnvironmentDescriptor,
    McpHttpServer.toolkitRegistration(NoTools, McpToolAccess.toLayer(NoTools, {})),
    LinkDevicesHttp.layer.pipe(Layer.provide(devices), Layer.provide(FetchHttpClient.layer)),
  );
  return { peer, hub, daemon, booted };
});

const makeLaptop = Effect.gen(function* () {
  const linking = yield* Layer.build(layerLinkingEnvironment(laptop));
  const links = Context.get(linking, PeerLinks.PeerLinks);
  const host = yield* LinkedDeviceHost.make({
    kind: "linked",
    id: "mac" as DeviceHostId,
    label: "Mac",
    environmentId: EnvironmentId.make(mac.environmentId),
  }).pipe(Effect.provide(Layer.succeedContext(linking)), Effect.provide(FetchHttpClient.layer));
  return { links, host };
});

const noPhase = () => Effect.void;

const fetch = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(Effect.map((body) => ({ status: response.status, body }))),
    ),
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
  );

const linkToken = (links: PeerLinks.PeerLinks["Service"]) =>
  links.resolve(EnvironmentId.make(mac.environmentId)).pipe(Effect.map((peer) => peer.token));

it.effect("a full-access link lists, boots and streams the linked machine's devices", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, hub, booted } = yield* serveMac;
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "full-access");

      const ready = yield* laptopSide.host.ensureReady(noPhase);
      const listed = yield* ready.devices.list;
      expect(listed.devices).toEqual([simulator]);
      expect(yield* laptopSide.host.platformAvailability("ios")).toMatchObject({ available: true });
      expect(yield* ready.devices.boot(simulator)).toBe("SIM-1");
      expect(yield* Ref.get(booted)).toEqual(["SIM-1"]);

      // The Device panel's proxy sends hub requests where the host routes them.
      const routed = yield* ready.upstream!(
        "/vendor/serve-sim/helper/SIM-1/stream.mjpeg",
        new URLSearchParams({ device: "SIM-1" }),
      );
      if (routed === null) return yield* Effect.die("no upstream");
      const frame = yield* fetch(
        HttpClientRequest.get(routed.url).pipe(HttpClientRequest.setHeaders(routed.headers)),
      );
      expect(frame).toEqual({ status: 200, body: "frame" });
      const [hubRequest] = yield* Ref.get(hub.seen);
      expect(hubRequest?.url).toBe("/vendor/serve-sim/helper/SIM-1/stream.mjpeg?device=SIM-1");
      // The link's token stops at the linked environment.
      expect(hubRequest?.headers.authorization).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("agents reach the linked daemon only through a loopback token of their own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, daemon } = yield* serveMac;
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "full-access");
      const token = yield* linkToken(laptopSide.links);

      yield* laptopSide.host.ensureAgentReady(noPhase);
      const ready = yield* laptopSide.host.current;
      const endpoint = yield* ready!.devices.agentEndpoint!("SIM-1");
      expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(endpoint.token).not.toBe(token);

      const rpc = (bearer: string) =>
        fetch(
          HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
            HttpClientRequest.bearerToken(bearer),
            HttpClientRequest.setBody(
              HttpBody.text(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "agent_device.command",
                  params: { command: "snapshot", token: bearer },
                }),
                "application/json",
              ),
            ),
          ),
        );
      expect((yield* rpc("wrong")).status).toBe(401);
      expect((yield* rpc(endpoint.token)).status).toBe(200);
      const [command] = yield* Ref.get(daemon.seen);
      expect(command?.headers.authorization).toBe(`Bearer ${DAEMON_TOKEN}`);
      expect(JSON.parse(command!.body).params).toEqual({
        command: "snapshot",
        token: DAEMON_TOKEN,
      });

      // An upload ticket names the loopback forwarder, never the daemon's address or token.
      const ticket = yield* fetch(
        HttpClientRequest.post(`${endpoint.baseUrl}/upload/preflight`).pipe(
          HttpClientRequest.bearerToken(endpoint.token),
          HttpClientRequest.setBody(HttpBody.text("{}", "application/json")),
        ),
      );
      expect(ticket.body).not.toContain(DAEMON_TOKEN);
      expect(JSON.parse(ticket.body).upload).toEqual({
        url: `${endpoint.baseUrl}/upload/direct/up-1`,
        headers: {
          "content-type": "application/zip",
          authorization: `Bearer ${endpoint.token}`,
          "x-agent-device-token": endpoint.token,
        },
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const askMac = (peer: ServedPeer, bearer: string, headers: Record<string, string> = {}) =>
  fetch(
    HttpClientRequest.get(`${peer.url}/api/links/devices`).pipe(
      HttpClientRequest.setHeaders({ authorization: `Bearer ${bearer}`, ...headers }),
    ),
  );

it.effect("only a full-access link's session may use the linked machine's devices", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer } = yield* serveMac;
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "auto");
      const token = yield* linkToken(laptopSide.links);

      const refused = yield* askMac(peer, token);
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.body).error).toBe("not_a_full_access_link");
      // This side says why before asking.
      const error = yield* laptopSide.host.ensureReady(noPhase).pipe(Effect.flip);
      expect(error).toBeInstanceOf(DeviceHost.DeviceHostError);
      expect(LinkedDeviceHost.isLinkedDeviceHostFailure(error.cause)).toBe(true);
      expect((error.cause as LinkedDeviceHost.LinkedDeviceHostFailure).message).toContain(
        "full access",
      );

      // A client's own session is no link's.
      const issued = yield* peer.auth.issueSession({ label: "Phone" });
      expect((yield* askMac(peer, issued.token)).status).toBe(401);
      expect((yield* askMac(peer, "not-a-token")).status).toBe(401);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a browser origin is refused and unlinking ends the host's access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer } = yield* serveMac;
      const laptopSide = yield* makeLaptop;
      yield* linkTo(laptopSide.links, peer, "full-access");
      const token = yield* linkToken(laptopSide.links);
      expect((yield* askMac(peer, token)).status).toBe(200);
      expect((yield* askMac(peer, token, { origin: "https://evil.example" })).status).toBe(403);

      yield* laptopSide.links.unlink(EnvironmentId.make(mac.environmentId));
      // The linked environment revoked the session, so the old token no longer works there.
      expect((yield* askMac(peer, token)).status).toBe(401);
      yield* laptopSide.host.stop;
      const error = yield* laptopSide.host.ensureReady(noPhase).pipe(Effect.flip);
      expect((error.cause as LinkedDeviceHost.LinkedDeviceHostFailure).message).toContain(
        "no longer linked",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
