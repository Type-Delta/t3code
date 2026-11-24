import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthStandardClientScopes, type GatewayHelperStatus } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopGateway from "./DesktopGateway.ts";

const status = (overrides: Partial<GatewayHelperStatus> = {}): GatewayHelperStatus => ({
  version: 1,
  runtimeVersion: "0.1.8",
  selfService: true,
  joinNeedsPassword: false,
  user: "alice",
  enrolled: true,
  backendPort: 41001,
  ...overrides,
});

const json = (request: HttpClientRequest.HttpClientRequest, code: number, body: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: code,
      headers: { "content-type": "application/json" },
    }),
  );

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly env?: Record<string, string>; readonly extendEnv?: boolean };
}

const layerGateway = (input: {
  readonly respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly pairOutput?: string;
  readonly spawned?: Array<SpawnedCommand>;
  readonly stateDir?: string;
}) =>
  DesktopGateway.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, HttpClient.make(input.respond)),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            input.spawned?.push(command as unknown as SpawnedCommand);
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.make(new TextEncoder().encode(input.pairOutput ?? "")),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          }),
        ),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          backendEntryPath: "/app/server/bin.mjs",
          baseDir: "/home/alice/.t3",
          stateDir: input.stateDir ?? "/home/alice/.t3/userdata",
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
    ),
    // Real files for the home-owner check, provided after the fake spawner so it stays in use.
    Layer.provide(NodeServices.layer),
  );

describe("DesktopGateway", () => {
  it.effect("reads a valid status and treats anything else as no gateway", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [number, unknown, boolean]> = [
        [200, status(), true],
        [200, { ...status(), version: 2 }, false],
        [200, { error: "nope" }, false],
        [500, status(), false],
      ];
      for (const [code, body, found] of cases) {
        const headers: Array<string | undefined> = [];
        const result = yield* Effect.flatMap(DesktopGateway.DesktopGateway, (g) => g.status).pipe(
          Effect.provide(
            layerGateway({
              respond: (request) =>
                Effect.sync(() => {
                  headers.push(request.headers["x-t3-gateway-helper"]);
                  return json(request, code, body);
                }),
            }),
          ),
        );
        assert.strictEqual(Option.isSome(result), found);
        assert.deepStrictEqual(headers, ["1"]);
      }
    }),
  );

  it.effect("gives up on a helper that does not answer within the status timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.flatMap(DesktopGateway.DesktopGateway, (g) => g.status).pipe(
        Effect.provide(layerGateway({ respond: () => Effect.never })),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(10));
      assert.isTrue(Option.isNone(yield* Fiber.join(fiber)));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("surfaces the helper's own refusal text", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flatMap(DesktopGateway.DesktopGateway, (g) => g.join()).pipe(
        Effect.provide(
          layerGateway({
            respond: (request) =>
              Effect.succeed(json(request, 403, { error: "Self-service is turned off." })),
          }),
        ),
        Effect.flip,
      );
      assert.strictEqual(error.reason, "Self-service is turned off.");
    }),
  );

  it.effect("waits for a requested update until the helper reports it failed", () =>
    Effect.gen(function* () {
      const polls = yield* Ref.make(0);
      const running = { state: "running", version: "0.1.9", updatedAt: 1 } as const;
      const fiber = yield* Effect.flatMap(DesktopGateway.DesktopGateway, (g) =>
        g.updateRuntime("0.1.9"),
      ).pipe(
        Effect.provide(
          layerGateway({
            respond: (request) =>
              request.method === "POST"
                ? Effect.succeed(json(request, 202, status({ update: running })))
                : Ref.updateAndGet(polls, (count) => count + 1).pipe(
                    Effect.map((count) =>
                      json(
                        request,
                        200,
                        status({
                          update:
                            count < 3
                              ? running
                              : { ...running, state: "failed", message: "Checksum mismatch." },
                        }),
                      ),
                    ),
                  ),
          }),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(3));
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "Checksum mismatch.");
      assert.strictEqual(yield* Ref.get(polls), 3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("mints a token with the bundled CLI only for the server holding this T3 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-gateway-" });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        JSON.stringify({ pid: process.pid, port: 41001 }),
      );
      const spawned: Array<SpawnedCommand> = [];
      const mint = (port: number) =>
        Effect.flatMap(DesktopGateway.DesktopGateway, (g) => g.mintPairingToken(port)).pipe(
          Effect.provide(
            layerGateway({
              respond: () => Effect.never,
              spawned,
              stateDir,
              pairOutput:
                "Pair with Alice's Mac\nToken: ABCD-1234\nExpires: 2026-11-23T10:00:00Z\n",
            }),
          ),
        );
      assert.strictEqual(yield* mint(41001), "ABCD-1234");
      // Whoever answered on the helper port named a port this home's server does not listen on.
      const refused = yield* Effect.flip(mint(41002));
      assert.strictEqual(
        refused.reason,
        "The server holding this T3 home is not on the shared port.",
      );
      const [command] = spawned;
      assert.isDefined(command);
      assert.strictEqual(command?.command, process.execPath);
      assert.deepStrictEqual(command?.args.slice(0, 6), [
        "/app/server/bin.mjs",
        "pair",
        "--base-dir",
        "/home/alice/.t3",
        "--label",
        "T3 Code desktop",
      ]);
      assert.strictEqual(command?.options.env?.ELECTRON_RUN_AS_NODE, "1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("shouldUpdateSharedRuntime", () => {
  it("updates only an enrolled self-service runtime older than the app", () => {
    const cases: ReadonlyArray<readonly [Partial<GatewayHelperStatus>, string, boolean]> = [
      [{}, "0.1.9", true],
      [{}, "0.1.8", false],
      [{}, "0.1.7", false],
      [{ runtimeVersion: "0.1.9-gwtest.1" }, "0.1.9", true],
      [{ runtimeVersion: "0.1.9" }, "0.1.9-gwtest.1", false],
      [{ selfService: false }, "0.1.9", false],
      [{ enrolled: false }, "0.1.9", false],
      [{ runtimeVersion: "dev" }, "0.1.9", false],
    ];
    for (const [overrides, appVersion, expected] of cases) {
      assert.strictEqual(
        DesktopGateway.shouldUpdateSharedRuntime(status(overrides), appVersion),
        expected,
        `${JSON.stringify(overrides)} app ${appVersion}`,
      );
    }
  });
});

describe("pairing helpers", () => {
  it("grants every scope of the desktop's own session", () => {
    const args = DesktopGateway.pairCommandArgs("/entry", "/home");
    const scopes = args.flatMap((arg, index) => (args[index - 1] === "--scope" ? [arg] : []));
    assert.deepStrictEqual(scopes, [...AuthStandardClientScopes]);
  });

  it("reads the token line from t3 pair output", () => {
    assert.deepStrictEqual(
      DesktopGateway.parsePairToken("Token: abc-123\nExpires: x"),
      Option.some("abc-123"),
    );
    assert.isTrue(Option.isNone(DesktopGateway.parsePairToken("No running T3 Code server found.")));
  });
});
