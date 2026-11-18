import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exercises real filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Builds native fixture paths.
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as StorageUsage from "./StorageUsage.ts";

it.live("classifies disk usage and excludes nested worktrees from their parent", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const nested = NodePath.join(config.stateDir, "browser-artifacts", "managed-worktrees");
    const fixture = async (name: string) => {
      const file = NodePath.join(config.stateDir, name);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, Buffer.alloc(4096, 1));
    };
    yield* Effect.promise(() =>
      Promise.all([
        fixture("statev2.sqlite"),
        fixture("statev2.sqlite-wal"),
        fixture("checkpoints/data"),
        fixture("logs/data"),
        fixture("attachments/data"),
        fixture("browser-artifacts/other"),
        fixture("browser-artifacts/managed-worktrees/data"),
        fixture("settings.json"),
        NodeFSP.mkdir(config.worktreesDir, { recursive: true }).then(() =>
          NodeFSP.writeFile(
            NodePath.join(config.worktreesDir, "data\n123\tbogus"),
            Buffer.alloc(4096),
          ),
        ),
        NodeFSP.mkdir(NodePath.join(config.baseDir, "scratch"), { recursive: true }).then(() =>
          NodeFSP.writeFile(NodePath.join(config.baseDir, "scratch", "data"), Buffer.alloc(4096)),
        ),
        NodeFSP.mkdir(config.providerStatusCacheDir, { recursive: true }).then(() =>
          NodeFSP.writeFile(
            NodePath.join(config.providerStatusCacheDir, "data"),
            Buffer.alloc(4096, 1),
          ),
        ),
      ]),
    );
    const storage = yield* StorageUsage.StorageUsage;
    const result = yield* storage.measure();
    assert.deepEqual(
      result.categories.map((category) => category.id),
      ["database", "worktrees", "checkpoints", "logs", "attachments", "other"],
    );
    for (const category of result.categories) assert.isAbove(category.bytes, 0);
    assert.equal(
      result.totalBytes,
      result.categories.reduce((sum, category) => sum + category.bytes, 0),
    );
    assert.isAbove(result.diskFreeBytes ?? 0, 0);
    assert.isAbove(result.diskTotalBytes ?? 0, result.diskFreeBytes ?? 0);
    yield* Effect.promise(() => NodeFSP.rm(nested, { recursive: true }));
    const withoutWorktrees = yield* storage.measure();
    assert.isAbove(withoutWorktrees.categories[1]?.bytes ?? 0, 0);
    assert.isBelow(withoutWorktrees.categories[1]?.bytes ?? 0, result.categories[1]?.bytes ?? 0);
    assert.equal(withoutWorktrees.categories[5]?.bytes, result.categories[5]?.bytes);
  }).pipe(
    Effect.provide(
      StorageUsage.layer.pipe(
        Layer.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              return Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  worktreesDirectory: NodePath.join(
                    config.stateDir,
                    "browser-artifacts",
                    "managed-worktrees",
                  ),
                }),
              });
            }),
          ),
        ),
        Layer.provide(ProcessRunner.layer),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-usage-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

const mockLayer = (runner: ProcessRunner.ProcessRunner["Service"]) =>
  StorageUsage.layer.pipe(
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    ),
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-usage-mock-" })),
    Layer.provide(NodeServices.layer),
  );

it.live("fails when du cannot run or its grand total is invalid", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.promise(() =>
      NodeFSP.mkdir(config.stateDir, { recursive: true }).then(() =>
        NodeFSP.writeFile(NodePath.join(config.stateDir, "state.sqlite"), "data"),
      ),
    );
    const storage = yield* StorageUsage.StorageUsage;
    assert.isTrue(Result.isFailure(yield* storage.measure().pipe(Effect.result)));
  }).pipe(
    Effect.provide(
      mockLayer({
        run: () =>
          Effect.succeed({
            stdout: "4\tfile\n123\tfake\n",
            stderr: "",
            code: null,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
  ),
);

it.live("shares a measurement and starts a fresh one after it completes", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const layer = mockLayer({
      run: () =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(gate);
          return {
            stdout: "4\tfile\n123\tinjected\n7\ttotal\n",
            stderr: "",
            code: null,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.promise(() =>
        NodeFSP.mkdir(config.stateDir, { recursive: true }).then(() =>
          NodeFSP.writeFile(NodePath.join(config.stateDir, "state.sqlite"), "data"),
        ),
      );
      const storage = yield* StorageUsage.StorageUsage;
      const both = yield* Effect.forEach([1, 2], () => storage.measure(), {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(gate, undefined);
      const results = yield* Fiber.join(both);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0]?.categories[0]?.bytes, 7 * 1024);
      const firstCalls = calls;
      yield* storage.measure();
      assert.equal(calls, firstCalls * 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.live(
  "deduplicates worktree roots and reserves state, cache, and scratch under the base directory",
  () => {
    let configured = "";
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const custom = NodePath.join(config.baseDir, "custom");
      const scratch = NodePath.join(config.baseDir, "scratch");
      yield* Effect.promise(async () => {
        for (const directory of [
          config.stateDir,
          config.worktreesDir,
          custom,
          scratch,
          config.providerStatusCacheDir,
        ]) {
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(directory, directory === config.stateDir ? "state.sqlite" : "data"),
            Buffer.alloc(4096),
          );
        }
      });
      const storage = yield* StorageUsage.StorageUsage;
      configured = config.worktreesDir;
      const defaultOnly = yield* storage.measure();
      configured = custom;
      const both = yield* storage.measure();
      assert.isAbove(both.categories[1]?.bytes ?? 0, defaultOnly.categories[1]?.bytes ?? 0);
      configured = config.baseDir;
      const base = yield* storage.measure();
      assert.equal(base.categories[0]?.bytes, both.categories[0]?.bytes);
      assert.equal(base.categories[1]?.bytes, both.categories[1]?.bytes);
      assert.equal(base.categories[5]?.bytes, both.categories[5]?.bytes);
      assert.isAbove(base.categories[5]?.bytes ?? 0, 0);
    }).pipe(
      Effect.provide(
        StorageUsage.layer.pipe(
          Layer.provide(
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.sync(() => ({
                ...DEFAULT_SERVER_SETTINGS,
                worktreesDirectory: configured,
              })),
            }),
          ),
          Layer.provide(ProcessRunner.layer),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-roots-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);

it.live("fails when du is missing", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.promise(() =>
      NodeFSP.mkdir(config.stateDir, { recursive: true }).then(() =>
        NodeFSP.writeFile(NodePath.join(config.stateDir, "state.sqlite"), "data"),
      ),
    );
    const storage = yield* StorageUsage.StorageUsage;
    assert.isTrue(Result.isFailure(yield* storage.measure().pipe(Effect.result)));
  }).pipe(
    Effect.provide(
      mockLayer({
        run: () =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: "du",
              argumentCount: 1,
              cause: "missing",
            }),
          ),
      }),
    ),
  ),
);
