// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

// Every child process the stack starts, as `command args`. Recorded at the
// spawner, so VcsProcess and the Git driver's direct spawns are both seen.
const spawned: Array<string> = [];

const layerRecordingSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (command._tag === "StandardCommand") {
          spawned.push(`${command.command} ${command.args.join(" ")}`);
        }
      }).pipe(Effect.andThen(real.spawn(command))),
    );
  }),
).pipe(Layer.provide(NodeServices.layer));
const layerServices = Layer.provideMerge(layerRecordingSpawner, NodeServices.layer);

const layerTest = CheckpointService.layer.pipe(
  Layer.provideMerge(
    CheckpointStore.layer.pipe(
      Layer.provideMerge(VcsDriverRegistry.layer),
      Layer.provideMerge(VcsProcess.layer),
    ),
  ),
  Layer.provide(IdAllocator.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-non-git-workspace-" }),
  ),
  Layer.provideMerge(layerServices),
);

const scopeFor = (cwd: string): OrchestrationV2CheckpointScope => ({
  id: CheckpointScopeId.make("checkpoint-scope:non-git"),
  threadId: ThreadId.make("thread:non-git"),
  runId: RunId.make("run:non-git:2"),
  nodeId: NodeId.make("node:non-git:2"),
  parentScopeId: null,
  providerThreadId: ProviderThreadId.make("provider-thread:non-git"),
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd,
  createdAt: DateTime.makeUnsafe("2026-10-15T00:00:00.000Z"),
});

// One turn's checkpoint work, as RunExecutionService and CheckpointCaptureService run it.
const runTurnCheckpointWork = (cwd: string) =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const scope = scopeFor(cwd);
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1 });
    yield* checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 0 });
    yield* checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 1 });
    return yield* checkpoints.capture({
      scope,
      runId: scope.runId,
      nodeId: scope.nodeId,
      ordinalWithinScope: 2,
      appRunOrdinal: 2,
      capturedAt: yield* DateTime.now,
    });
  });

it.layer(layerTest)("non-Git workspaces", (it) => {
  it.effect("spawn no VCS process across a turn's checkpoint work", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // The OS temp folder is outside any repository on a normal host.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-non-git-" });
      yield* fileSystem.writeFileString(NodePath.join(cwd, "notes.txt"), "plain folder\n");
      spawned.length = 0;

      for (let turn = 0; turn < 3; turn += 1) {
        const checkpoint = yield* runTurnCheckpointWork(cwd);
        assert.equal(checkpoint.status, "missing");
        assert.deepEqual(checkpoint.files, []);
      }

      // Status polls, reviews, and git workflows all detect through the registry.
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      for (const requestedKind of ["auto", "git"] as const) {
        assert.isNull(yield* registry.detect({ cwd, requestedKind }));
      }

      assert.deepEqual(spawned, []);
    }),
  );

  it.effect("still reach git for a worktree whose .git is a file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const primary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-primary-" });
      for (const args of [
        ["init"],
        ["config", "user.email", "test@test.com"],
        ["config", "user.name", "Test"],
        ["commit", "--allow-empty", "-m", "initial"],
      ]) {
        yield* vcsProcess.run({ operation: "test.git", command: "git", cwd: primary, args });
      }
      const linkedRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-linked-" });
      const linked = NodePath.join(linkedRoot, "worktree");
      yield* vcsProcess.run({
        operation: "test.git",
        command: "git",
        cwd: primary,
        args: ["worktree", "add", "-b", "linked", linked],
      });
      assert.isTrue((yield* fileSystem.stat(NodePath.join(linked, ".git"))).type === "File");
      spawned.length = 0;

      const checkpoint = yield* runTurnCheckpointWork(linked);

      assert.equal(checkpoint.status, "ready");
      assert.isTrue(spawned.some((command) => command.startsWith("git ")));
    }),
  );

  it.effect("still reach git for a repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-" });
      for (const args of [
        ["init"],
        ["config", "user.email", "test@test.com"],
        ["config", "user.name", "Test"],
        ["commit", "--allow-empty", "-m", "initial"],
      ]) {
        yield* vcsProcess.run({ operation: "test.git", command: "git", cwd, args });
      }
      spawned.length = 0;

      const checkpoint = yield* runTurnCheckpointWork(cwd);

      assert.equal(checkpoint.status, "ready");
      assert.isTrue(spawned.some((command) => command.startsWith("git ")));
    }),
  );

  it.effect("follow a symlinked workspace to its repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      const repository = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-target-" });
      yield* vcsProcess.run({
        operation: "test.git",
        command: "git",
        cwd: repository,
        args: ["init"],
      });
      yield* fileSystem.makeDirectory(NodePath.join(repository, "src"));
      // The link lives outside the repository, so only its real path has `.git` above it.
      const links = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-link-" });
      const cwd = NodePath.join(links, "workspace");
      yield* fileSystem.symlink(NodePath.join(repository, "src"), cwd);
      spawned.length = 0;

      assert.isTrue(yield* checkpointStore.isGitRepository(cwd));
      assert.isTrue(spawned.some((command) => command.startsWith("git ")));
    }),
  );
});
