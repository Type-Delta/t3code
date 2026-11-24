// @effect-diagnostics nodeBuiltinImport:off -- holds the T3 home's real SQLite ownership lock.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { GatewayHelperStatus } from "@t3tools/contracts";
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
  readonly hostTrusted?: boolean;
}) =>
  DesktopGateway.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, HttpClient.make(input.respond)),
        Layer.succeed(DesktopGateway.DesktopGatewayHost, {
          trusted: Effect.succeed(input.hostTrusted ?? true),
          runtimeExecutable: "/opt/t3code/current/t3",
          encryptPassword: (password) => Effect.succeed(`sealed(${password})`),
        }),
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
      // Without an administrator's gateway, whoever listens on the port is never asked.
      const asked: Array<string> = [];
      const untrusted = yield* Effect.flatMap(DesktopGateway.DesktopGateway, (g) => g.status).pipe(
        Effect.provide(
          layerGateway({
            hostTrusted: false,
            respond: (request) =>
              Effect.sync(() => {
                asked.push(request.url);
                return json(request, 200, status());
              }),
          }),
        ),
      );
      assert.isTrue(Option.isNone(untrusted));
      assert.deepStrictEqual(asked, []);
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

  it.effect("sends the Windows password only encrypted to the gateway's key", () =>
    Effect.gen(function* () {
      const bodies: Array<unknown> = [];
      yield* Effect.flatMap(DesktopGateway.DesktopGateway, (g) => g.join("hunter2")).pipe(
        Effect.provide(
          layerGateway({
            respond: (request) =>
              Effect.sync(() => {
                if (request.body._tag === "Uint8Array") {
                  bodies.push(JSON.parse(new TextDecoder().decode(request.body.body)));
                }
                return json(request, 200, status());
              }),
          }),
        ),
      );
      assert.deepStrictEqual(bodies, [{ encryptedPassword: "sealed(hunter2)" }]);
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

  it.effect("waits for the backends to restart after the runtime switches", () =>
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
                    // The new runtime answers at once; its claim clears once backends restarted.
                    Effect.map((count) =>
                      json(
                        request,
                        200,
                        status({
                          runtimeVersion: "0.1.9",
                          ...(count < 3 ? { update: running } : {}),
                        }),
                      ),
                    ),
                  ),
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(3));
      assert.strictEqual((yield* Fiber.join(fiber)).runtimeVersion, "0.1.9");
      assert.strictEqual(yield* Ref.get(polls), 3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "mints a token with the shared runtime's CLI only for the server holding this T3 home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-gateway-" });
        yield* fs.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          JSON.stringify({ pid: process.pid, port: 41001 }),
        );
        const lock = new NodeSqlite.DatabaseSync(path.join(stateDir, "server-owner.sqlite"));
        yield* Effect.addFinalizer(() => Effect.sync(() => lock.close()));
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
        // A runtime file alone, as a crashed server leaves it, is not an owner.
        assert.strictEqual(
          (yield* Effect.flip(mint(41001))).reason,
          "The server holding this T3 home is not on the shared port.",
        );
        assert.lengthOf(spawned, 0);
        lock.exec("BEGIN EXCLUSIVE");
        assert.strictEqual(yield* mint(41001), "ABCD-1234");
        // Whoever answered on the helper port named a port this home's server does not listen on.
        const refused = yield* Effect.flip(mint(41002));
        assert.strictEqual(
          refused.reason,
          "The server holding this T3 home is not on the shared port.",
        );
        const [command] = spawned;
        assert.isDefined(command);
        // The shared runtime's own CLI, which matches the server whatever this app's version.
        assert.strictEqual(command?.command, "/opt/t3code/current/t3");
        assert.deepStrictEqual(command?.args.slice(0, 5), [
          "pair",
          "--base-dir",
          "/home/alice/.t3",
          "--label",
          "T3 Code desktop",
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("canAttachShared", () => {
  it("attaches only a packaged app on the default T3 home with its local environment", () => {
    const environment = {
      isDevelopment: false,
      baseDir: "/home/alice/.t3",
      homeDirectory: "/home/alice",
      path: { join: (...parts: Array<string>) => parts.join("/") },
    } as unknown as Parameters<typeof DesktopGateway.canAttachShared>[0];
    const settings = { localEnvironmentEnabled: true, wslOnly: false, wslBackendEnabled: false };
    const cases: ReadonlyArray<readonly [object, object, boolean]> = [
      [{}, {}, true],
      [{ isDevelopment: true }, {}, false],
      // The gateway runs the backend on the account's default home, not a T3CODE_HOME.
      [{ baseDir: "/srv/t3" }, {}, false],
      [{}, { localEnvironmentEnabled: false }, false],
      [{}, { wslOnly: true, wslBackendEnabled: true }, false],
      [{}, { wslOnly: true }, true],
    ];
    for (const [env, set, expected] of cases) {
      assert.strictEqual(
        DesktopGateway.canAttachShared({ ...environment, ...env }, { ...settings, ...set }),
        expected,
        JSON.stringify([env, set]),
      );
    }
  });
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
  it("leaves scopes to the shared runtime, which may predate this app's", () => {
    assert.notInclude(DesktopGateway.pairCommandArgs("/home"), "--scope");
  });

  it("reads the token line from t3 pair output", () => {
    assert.deepStrictEqual(
      DesktopGateway.parsePairToken("Token: abc-123\nExpires: x"),
      Option.some("abc-123"),
    );
    assert.isTrue(Option.isNone(DesktopGateway.parsePairToken("No running T3 Code server found.")));
  });
});
