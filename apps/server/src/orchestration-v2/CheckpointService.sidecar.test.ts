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
import * as PlatformError from "effect/PlatformError";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { isSidecarCheckpointRef } from "../checkpointing/SidecarCheckpointRepository.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerTest = CheckpointService.layer.pipe(
  Layer.provideMerge(
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
      Layer.provideMerge(layerVcsProcess),
    ),
  ),
  Layer.provide(IdAllocator.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-sidecar-v2-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({ operation: "test.git", command: "git", cwd, args });
    return result.stdout.trim();
  });

const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sidecar-v2-repo-" });
  yield* git(cwd, ["init"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "# start\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial"]);
  return cwd;
});

const scopeFor = (cwd: string, name: string): OrchestrationV2CheckpointScope => ({
  id: CheckpointScopeId.make(`checkpoint-scope:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
  runId: RunId.make(`run:${name}:1`),
  nodeId: NodeId.make(`node:${name}:1`),
  parentScopeId: null,
  providerThreadId: ProviderThreadId.make(`provider-thread:${name}`),
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd,
  createdAt: DateTime.makeUnsafe("2026-10-15T00:00:00.000Z"),
});

// One turn as RunExecutionService and CheckpointCaptureService run it.
const runTurn = (
  scope: OrchestrationV2CheckpointScope,
  ordinal: number,
  edit: Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: ordinal - 1 });
    yield* edit;
    const baseline = yield* checkpoints.materializeBaselineCheckpoint({
      scope,
      ordinalWithinScope: ordinal - 1,
    });
    const checkpoint = yield* checkpoints.capture({
      scope,
      runId: scope.runId,
      nodeId: scope.nodeId,
      ordinalWithinScope: ordinal,
      appRunOrdinal: ordinal,
      capturedAt: yield* DateTime.now,
    });
    return { baseline, checkpoint };
  });

it.layer(layerTest)("V2 sidecar checkpoints", (it) => {
  it.effect("keep turn snapshots out of the project repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const cwd = yield* makeRepository;
      const scope = scopeFor(cwd, "sidecar");
      const objectsBefore = yield* git(cwd, ["count-objects", "-v"]);

      const { baseline, checkpoint } = yield* runTurn(
        scope,
        1,
        fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "# start\nturn one\n"),
      );

      assert.equal(baseline.status, "ready");
      assert.equal(checkpoint.status, "ready");
      assert.isTrue(isSidecarCheckpointRef(baseline.ref));
      assert.isTrue(isSidecarCheckpointRef(checkpoint.ref));
      assert.deepEqual(checkpoint.files, [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
      ]);
      assert.equal(yield* git(cwd, ["for-each-ref", "refs/t3"]), "");
      assert.equal(yield* git(cwd, ["count-objects", "-v"]), objectsBefore);

      yield* checkpoints.restore({ scope, checkpoint: baseline });
      assert.equal(yield* fileSystem.readFileString(NodePath.join(cwd, "README.md")), "# start\n");
      yield* checkpoints.restore({ scope, checkpoint });
      assert.equal(
        yield* fileSystem.readFileString(NodePath.join(cwd, "README.md")),
        "# start\nturn one\n",
      );
      assert.equal(yield* git(cwd, ["for-each-ref", "refs/t3"]), "");
    }),
  );

  it.effect("capture boundaries of a scope whose id exceeds the snapshot id limit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeRepository;
      // Allocated scope ids embed the thread id, so long thread ids are common.
      const scope = scopeFor(cwd, `long-${"x".repeat(240)}`);

      const { baseline, checkpoint } = yield* runTurn(
        scope,
        1,
        fileSystem.writeFileString(NodePath.join(cwd, "notes.txt"), "long scope\n"),
      );

      assert.equal(baseline.status, "ready");
      assert.equal(checkpoint.status, "ready");
      assert.isTrue(isSidecarCheckpointRef(checkpoint.ref));
      assert.notEqual(baseline.ref, checkpoint.ref);
    }),
  );

  it.effect("still load and restore checkpoints stored in the project repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      const cwd = yield* makeRepository;
      const scope = scopeFor(cwd, "legacy");
      // A thread from before the sidecar re-port: its first boundary is an in-repo ref.
      const legacyRef = yield* CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 1,
      });
      yield* fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "# legacy turn\n");
      yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: legacyRef });

      const { baseline, checkpoint } = yield* runTurn(
        scope,
        2,
        fileSystem.writeFileString(NodePath.join(cwd, "notes.txt"), "turn two\n"),
      );

      assert.equal(baseline.ref, legacyRef);
      assert.equal(baseline.status, "ready");
      assert.isTrue(isSidecarCheckpointRef(checkpoint.ref));
      assert.deepEqual(checkpoint.files, [
        { path: "notes.txt", kind: "modified", additions: 1, deletions: 0 },
      ]);
      // Only the old ref is in the project; the new turn added none.
      assert.equal(
        (yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/t3"])).split("\n").length,
        1,
      );

      yield* checkpoints.restore({ scope, checkpoint: baseline });
      assert.isFalse(yield* fileSystem.exists(NodePath.join(cwd, "notes.txt")));
      assert.equal(
        yield* fileSystem.readFileString(NodePath.join(cwd, "README.md")),
        "# legacy turn\n",
      );
    }),
  );
});
