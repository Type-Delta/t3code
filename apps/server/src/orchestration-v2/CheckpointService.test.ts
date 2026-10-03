import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const testLayer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            allocateCheckpointRef: ({ cwd, snapshotId }) =>
              Effect.succeed(CheckpointRef.make(`t3-sidecar:${cwd}:${snapshotId}`)),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.isTrue(String(baseline.ref).startsWith(`t3-sidecar:${scope.cwd}:orchestration-v2-`));
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect("captures non-Git workspace checkpoints in the sidecar store", () => {
  const scope: OrchestrationV2CheckpointScope = {
    id: CheckpointScopeId.make("checkpoint-scope:non-git-sidecar"),
    threadId: ThreadId.make("thread:non-git-sidecar"),
    runId: RunId.make("run:non-git-sidecar:1"),
    nodeId: NodeId.make("node:non-git-sidecar:1"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:non-git-sidecar"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/non-git-workspace",
    createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
  };
  const allocatedRefs: Array<CheckpointRef> = [];
  const capturedRefs: Array<CheckpointRef> = [];
  const testLayer = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(false),
          allocateCheckpointRef: ({ cwd, snapshotId }) => {
            const ref = CheckpointRef.make(`t3-sidecar:${cwd}:${snapshotId}`);
            allocatedRefs.push(ref);
            return Effect.succeed(ref);
          },
          hasCheckpointRef: () => Effect.succeed(false),
          captureCheckpoint: ({ checkpointRef }) =>
            Effect.sync(() => {
              capturedRefs.push(checkpointRef);
            }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const checkpoint = yield* checkpoints.capture({
      scope,
      ordinalWithinScope: 2,
      runId: scope.runId!,
      nodeId: scope.nodeId!,
      appRunOrdinal: 1,
      capturedAt: scope.createdAt,
    });

    assert.equal(checkpoint.status, "ready");
    assert.equal(allocatedRefs.length, 2);
    assert.equal(capturedRefs.length, 1);
    assert.isTrue(String(checkpoint.ref).startsWith("t3-sidecar:/non-git-workspace:"));
    assert.isTrue(capturedRefs.every((ref) => String(ref).startsWith("t3-sidecar:")));
  }).pipe(Effect.provide(testLayer));
});
