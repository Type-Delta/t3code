import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";

it.effect("forces an app-server that ignores EOF only after three seconds", () =>
  Effect.gen(function* () {
    const inputClosed = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    let running = true;
    let kills = 0;
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(123),
      stdin: Sink.fromEffect(Deferred.succeed(inputClosed, undefined).pipe(Effect.asVoid)),
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      exitCode: Deferred.await(exited),
      isRunning: Effect.sync(() => running),
      kill: (options) =>
        Effect.gen(function* () {
          assert.equal(options?.killSignal, "SIGKILL");
          kills += 1;
          running = false;
          yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1));
        }),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
    const shutdown = yield* CodexClient.shutdownChildProcess(handle).pipe(Effect.forkChild);
    yield* Deferred.await(inputClosed);
    yield* TestClock.adjust("2999 millis");
    assert.equal(kills, 0);
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(shutdown);
    assert.equal(kills, 1);
  }),
);

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("lets the child finish stdin cleanup before closing its process scope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-stdin-shutdown-" });
      const marker = path.join(root, "closed");
      const scope = yield* Scope.make("sequential");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            `
          const fs = require("node:fs");
          const readline = require("node:readline");
          const input = readline.createInterface({ input: process.stdin });
          input.on("line", line => {
            const request = JSON.parse(line);
            process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
          });
          input.on("close", () => {
            process.stderr.write("x".repeat(512 * 1024), () => {
              fs.writeFileSync(process.argv[1], "closed");
              process.exit(0);
            });
          });
        `,
            marker,
          ]),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      const context = yield* Layer.buildWithScope(CodexClient.layerChildProcess(handle), scope);
      yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        yield* client.raw.request("initialize", {});
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
      assert.equal(yield* fs.readFileString(marker), "closed");
      assert.equal(yield* handle.exitCode, 0);
    }),
  );

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const layerClient = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerClient, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          isBlocking: true,
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const layerClient = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerClient, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );
});
