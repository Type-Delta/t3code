import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution, type SpawnExecutableResolver } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as Zrok from "./ZrokShare.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

function makeHandle(input: {
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly onKill?: (signal: ChildProcess.Signal | undefined) => void;
  readonly kill?: (
    options?: ChildProcess.KillOptions,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.succeed(true),
    kill:
      input.kill ??
      ((options) =>
        Effect.sync(() => {
          input.onKill?.(options?.killSignal);
        })),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: input.stdout ?? Stream.empty,
    stderr: input.stderr ?? Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const buildRuntime = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  resolveExecutable: SpawnExecutableResolver = (command) =>
    command === "zrok2" ? "zrok2" : undefined,
) =>
  Effect.gen(function* () {
    const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "zrok-share-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    );
    const context = yield* Layer.build(
      Zrok.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            configLayer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      ),
    );
    return yield* Effect.service(Zrok.ZrokShare).pipe(Effect.provide(context));
  }).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(SpawnExecutableResolution, resolveExecutable),
  );

describe("ZrokShare", () => {
  it.each([
    ["0.0.0.0", "http://127.0.0.1:3773"],
    ["::", "http://[::1]:3773"],
    ["192.168.1.24", "http://192.168.1.24:3773"],
    ["fd7a:115c:a1e0::42", "http://[fd7a:115c:a1e0::42]:3773"],
  ] as const)("resolves the zrok backend target for %s", (host, expected) => {
    expect(Zrok.resolveZrokTarget({ host, port: 3773 })).toBe(expected);
  });

  it("parses only the headless endpoint announcement and strips ANSI", () => {
    expect(
      Zrok.parseZrokHeadlessEndpoint(
        "\u001b[32mINFO\u001b[0m access your zrok share at the following endpoints:\n https://share.example.test",
      ),
    ).toBe("https://share.example.test/");
    expect(Zrok.parseZrokHeadlessEndpoint("diagnostic: https://secret.example.test")).toBeNull();
    expect(
      Zrok.parseZrokHeadlessEndpoint(
        JSON.stringify({
          level: "info",
          msg: "access your zrok share at the following endpoints:\n https://json.share.example.test",
        }),
      ),
    ).toBe("https://json.share.example.test/");
    expect(
      Zrok.parseZrokHeadlessEndpoint(
        "access your zrok share at the following endpoints:\n file:///tmp/not-public",
      ),
    ).toBeNull();
  });

  it.effect("reports an unavailable executable without exposing the spawn error", () =>
    Effect.gen(function* () {
      const resolutions: string[] = [];
      const runtime = yield* buildRuntime(
        ChildProcessSpawner.make(() =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "sensitive raw zrok output",
            }),
          ),
        ),
        (command) => {
          resolutions.push(command);
          return command === "zrok2" ? "zrok2" : undefined;
        },
      );
      expect(yield* runtime.start).toEqual({
        state: "unavailable",
        publicUrl: null,
        message: "zrok is not installed or unavailable.",
        endpoint: null,
      });
      expect(resolutions).toEqual(["zrok2"]);
    }),
  );

  it.effect("falls back to the legacy zrok executable only when zrok2 is unavailable", () =>
    Effect.gen(function* () {
      const resolutions: string[] = [];
      const commands: ChildProcess.StandardCommand[] = [];
      const runtime = yield* buildRuntime(
        ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) return Effect.die("expected command");
          commands.push(command);
          return Effect.succeed(
            makeHandle({
              stderr: Stream.make(
                bytes(
                  "access your zrok share at the following endpoints:\nhttps://share.example.test\n",
                ),
              ),
            }),
          );
        }),
        (command) => {
          resolutions.push(command);
          return command === "zrok" ? "zrok" : undefined;
        },
      );

      expect((yield* runtime.start).state).toBe("running");
      expect(resolutions).toEqual(["zrok2", "zrok"]);
      expect(commands[0]?.command).toBe("zrok");
    }),
  );

  it.effect("single-flights starts, builds the advertised endpoint, and stops idempotently", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.StandardCommand[] = [];
      const resolutions: string[] = [];
      const signals: Array<ChildProcess.Signal | undefined> = [];
      let stdoutDrained = false;
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) return Effect.die("expected command");
        commands.push(command);
        return Effect.succeed(
          makeHandle({
            stderr: Stream.make(
              bytes(
                "INFO access your zrok share at the following endpoints:\nhttps://share.example.test\n",
              ),
            ),
            stdout: Stream.make(bytes("ignored request log\n")).pipe(
              Stream.tap(() => Effect.sync(() => (stdoutDrained = true))),
            ),
            onKill: (signal) => signals.push(signal),
          }),
        );
      });
      const runtime = yield* buildRuntime(spawner, (command) => {
        resolutions.push(command);
        return command;
      });
      const [first, second] = yield* Effect.all([runtime.start, runtime.start], {
        concurrency: "unbounded",
      });

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        state: "running",
        publicUrl: "https://share.example.test/",
        endpoint: {
          id: "zrok",
          reachability: "public",
          source: "server",
          status: "available",
          provider: { kind: "tunnel" },
          compatibility: { hostedHttpsApp: "compatible" },
        },
      });
      expect(commands).toHaveLength(1);
      expect(resolutions).toEqual(["zrok2"]);
      expect(commands[0]?.command.toLowerCase()).toMatch(/(?:^|[\\/])zrok2(?:\.exe)?$/u);
      expect(commands[0]?.args).toEqual([
        "share",
        "public",
        "--headless",
        "--force-local",
        "http://127.0.0.1:0",
      ]);
      expect(stdoutDrained).toBe(true);

      expect((yield* runtime.stop).state).toBe("stopped");
      expect((yield* runtime.stop).state).toBe("stopped");
      expect(signals).toEqual(["SIGTERM"]);
    }),
  );

  it.effect("marks a running share failed when zrok exits", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode, never>();
      const runtime = yield* buildRuntime(
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              exitCode: Deferred.await(exited),
              stderr: Stream.make(
                bytes(
                  "access your zrok share at the following endpoints:\nhttps://share.example.test\n",
                ),
              ),
            }),
          ),
        ),
      );

      expect((yield* runtime.start).state).toBe("running");
      yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(yield* runtime.getStatus).toEqual({
        state: "failed",
        publicUrl: null,
        message: "The zrok share stopped unexpectedly.",
        endpoint: null,
      });
    }),
  );

  it.effect("cleans up when waiting for exit fails with a signal error", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<never, PlatformError.PlatformError>();
      const runtime = yield* buildRuntime(
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              exitCode: Deferred.await(exited),
              stderr: Stream.make(
                bytes(
                  "access your zrok share at the following endpoints:\nhttps://share.example.test\n",
                ),
              ),
            }),
          ),
        ),
      );
      expect((yield* runtime.start).state).toBe("running");
      yield* Deferred.fail(
        exited,
        PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "exitCode",
          description: "terminated by signal",
        }),
      );
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect((yield* runtime.getStatus).state).toBe("failed");
    }),
  );

  it.effect("keeps a service-owned launch alive when the requesting fiber is interrupted", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<void, never>();
      const announcement = yield* Deferred.make<string, never>();
      let spawnCount = 0;
      const runtime = yield* buildRuntime(
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Deferred.succeed(spawned, undefined).pipe(
            Effect.as(
              makeHandle({
                stderr: Stream.fromEffect(Deferred.await(announcement)).pipe(Stream.map(bytes)),
              }),
            ),
          );
        }),
      );

      const requester = yield* Effect.forkChild(runtime.start);
      yield* Deferred.await(spawned);
      yield* Fiber.interrupt(requester);
      expect((yield* runtime.getStatus).state).toBe("starting");

      yield* Deferred.succeed(
        announcement,
        "access your zrok share at the following endpoints:\nhttps://share.example.test\n",
      );
      expect((yield* runtime.start).state).toBe("running");
      expect(spawnCount).toBe(1);
    }),
  );

  it.effect("queues a concurrent start until the previous child finishes stopping", () =>
    Effect.gen(function* () {
      const killStarted = yield* Deferred.make<void, never>();
      const allowKill = yield* Deferred.make<void, never>();
      const events: string[] = [];
      let spawnCount = 0;
      const runtime = yield* buildRuntime(
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          events.push(`spawn:${spawnCount}`);
          return Effect.succeed(
            makeHandle({
              stderr: Stream.make(
                bytes(
                  `access your zrok share at the following endpoints:\nhttps://share-${spawnCount}.example.test\n`,
                ),
              ),
              ...(spawnCount === 1
                ? {
                    kill: () =>
                      Deferred.succeed(killStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(allowKill)),
                        Effect.tap(() => Effect.sync(() => events.push("kill:done"))),
                      ),
                  }
                : {}),
            }),
          );
        }),
      );

      expect((yield* runtime.start).state).toBe("running");
      const stopping = yield* Effect.forkChild(runtime.stop);
      yield* Deferred.await(killStarted);
      const restarting = yield* Effect.forkChild(runtime.start);
      yield* Effect.yieldNow;
      expect(spawnCount).toBe(1);

      yield* Deferred.succeed(allowKill, undefined);
      expect(yield* Fiber.join(stopping)).toEqual({
        state: "stopped",
        publicUrl: null,
        message: null,
        endpoint: null,
      });
      expect((yield* Fiber.join(restarting)).state).toBe("running");
      expect(events).toEqual(["spawn:1", "kill:done", "spawn:2"]);
    }),
  );

  it.effect("preserves stop, queued start, final stop call order", () =>
    Effect.gen(function* () {
      const firstKillStarted = yield* Deferred.make<void, never>();
      const allowFirstKill = yield* Deferred.make<void, never>();
      const events: string[] = [];
      let spawnCount = 0;
      const runtime = yield* buildRuntime(
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          const childNumber = spawnCount;
          events.push(`spawn:${childNumber}`);
          return Effect.succeed(
            makeHandle({
              stderr: Stream.make(
                bytes(
                  `access your zrok share at the following endpoints:\nhttps://share-${childNumber}.example.test\n`,
                ),
              ),
              kill:
                childNumber === 1
                  ? () =>
                      Deferred.succeed(firstKillStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(allowFirstKill)),
                        Effect.tap(() => Effect.sync(() => events.push("kill:1"))),
                      )
                  : () => Effect.sync(() => events.push(`kill:${childNumber}`)),
            }),
          );
        }),
      );

      yield* runtime.start;
      const stopA = yield* Effect.forkChild(runtime.stop);
      yield* Deferred.await(firstKillStarted);
      const startB = yield* Effect.forkChild(runtime.start);
      yield* Effect.yieldNow;
      expect((yield* runtime.getStatus).state).toBe("starting");
      const stopC = yield* Effect.forkChild(runtime.stop);

      yield* Deferred.succeed(allowFirstKill, undefined);
      expect((yield* Fiber.join(stopA)).state).toBe("stopped");
      yield* Fiber.join(startB);
      expect((yield* Fiber.join(stopC)).state).toBe("stopped");
      expect((yield* runtime.getStatus).state).toBe("stopped");
      expect(events).toEqual(["spawn:1", "kill:1", "spawn:2", "kill:2"]);
    }),
  );

  it.effect("fails startup when zrok exits before announcing an endpoint", () =>
    Effect.gen(function* () {
      const runtime = yield* buildRuntime(
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              stderr: Stream.make(bytes("startup failed: sensitive detail\n")),
            }),
          ),
        ),
      );
      expect(yield* runtime.start).toEqual({
        state: "failed",
        publicUrl: null,
        message: "The zrok share stopped before it became ready.",
        endpoint: null,
      });
    }),
  );

  it.effect("stops the child when the owning scope closes", () =>
    Effect.gen(function* () {
      const signals: Array<ChildProcess.Signal | undefined> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* buildRuntime(
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeHandle({
                  stderr: Stream.make(
                    bytes(
                      "access your zrok share at the following endpoints:\nhttps://share.example.test\n",
                    ),
                  ),
                  onKill: (signal) => signals.push(signal),
                }),
              ),
            ),
          );
          yield* runtime.start;
        }),
      );
      expect(signals).toEqual(["SIGTERM"]);
    }),
  );
});
