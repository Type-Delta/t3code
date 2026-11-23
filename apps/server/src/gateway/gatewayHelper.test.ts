// @effect-diagnostics nodeBuiltinImport:off -- real loopback HTTP is the protocol under test.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { GATEWAY_HELPER_HEADER } from "@t3tools/contracts";
import { makeGatewayHelperHandler } from "./gatewayHelper.ts";
import {
  makeTestGatewayPlatform,
  makeTestGatewayRoot,
  testGatewayServices,
} from "./platform/testing.ts";

const request = (
  port: number,
  headers: NodeHttp.OutgoingHttpHeaders,
  path: string,
  body?: string,
) =>
  new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const call = NodeHttp.request(
      { host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    call.once("error", reject);
    if (body !== undefined) call.end(body);
    else call.end();
  });

it.live("gateway helper rejects untrusted requests and serves status", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* makeTestGatewayRoot("t3-gateway-helper-");
    const { platform } = makeTestGatewayPlatform(root);
    const configPath = NodePath.join(root, "config", "gateway.json");
    yield* fs.makeDirectory(NodePath.dirname(configPath), { recursive: true });
    yield* fs.writeFileString(
      configPath,
      JSON.stringify({
        version: 1,
        listen: { host: "0.0.0.0", port: 3773 },
        users: { alice: { uid: 1001, port: 3801 } },
        selfService: true,
      }),
    );
    const ownedPlatform = {
      ...platform,
      makeConnectionOwner: Effect.succeed(async () => 1001),
    };
    assert.isFalse(ownedPlatform.joinNeedsPassword);
    const handler = makeGatewayHelperHandler({
      platform: ownedPlatform,
      configPath,
      context: yield* Effect.context<never>(),
    });
    const server = NodeHttp.createServer(handler);
    yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () =>
              resolve((server.address() as NodeNet.AddressInfo).port),
            );
          }),
      ),
      () =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
    );
    const port = (server.address() as NodeNet.AddressInfo).port;
    const denied = yield* Effect.promise(() =>
      request(port, { host: "example.test", [GATEWAY_HELPER_HEADER]: "1" }, "/v1/status"),
    );
    assert.equal(denied.status, 403);
    const status = yield* Effect.promise(() =>
      request(port, { host: "127.0.0.1:3774", [GATEWAY_HELPER_HEADER]: "1" }, "/v1/status"),
    );
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).backendPort, 3801);
  }).pipe(Effect.provide(Layer.mergeAll(testGatewayServices))),
);
