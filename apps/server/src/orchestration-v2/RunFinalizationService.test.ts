import { vi } from "@effect/vitest";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () => {
  const threadId = ThreadId.make("thread_refresh_failure");
  const runId = RunId.make("run_refresh_failure");
  const scopeId = CheckpointScopeId.make("scope_refresh_failure");
  const captured: string[] = [];
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.sync(() => {
              captured.push("checkpoint");
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
              checkpoints: [],
            }),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: () =>
            Effect.gen(function* () {
              captured.push("refresh");
              return yield* new RunFinalization.RunFinalizationRefreshError({
                cwd: "/repo",
                cause: new Error("Git command timed out"),
              });
            }),
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.deepEqual(captured, ["checkpoint", "refresh"]);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves checkpoint failures without refreshing the workspace", () => {
  const threadId = ThreadId.make("thread_capture_failure");
  const runId = RunId.make("run_capture_failure");
  const scopeId = CheckpointScopeId.make("scope_capture_failure");
  const captureError = new CheckpointCapture.CheckpointCaptureExecutionError({
    threadId,
    runId,
    scopeId,
    cause: new Error("Checkpoint capture failed"),
  });
  const refresh = vi.fn(() => Effect.void);
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () => Effect.fail(captureError),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () => Effect.die("capture failed before context lookup"),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    const error = yield* service.finalize({ threadId, runId, scopeId }).pipe(Effect.flip);
    assert.equal(error.operation, "capture-checkpoint");
    assert.strictEqual(error.cause, captureError);
    assert.equal(refresh.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves checkpoint context read failures without refreshing the workspace", () => {
  const threadId = ThreadId.make("thread_context_failure");
  const runId = RunId.make("run_context_failure");
  const scopeId = CheckpointScopeId.make("scope_context_failure");
  const contextError = new ProjectionStore.ProjectionStoreReadError({
    threadId,
    cause: new Error("Checkpoint context read failed"),
  });
  const refresh = vi.fn(() => Effect.void);
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: () => Effect.void }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () => Effect.fail(contextError),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    const error = yield* service.finalize({ threadId, runId, scopeId }).pipe(Effect.flip);
    assert.equal(error.operation, "refresh-workspace");
    assert.strictEqual(error.cause, contextError);
    assert.equal(refresh.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("skips only the VCS refresh when the turn's workspace has no repository", () => {
  const threadId = ThreadId.make("thread_finalize_non_git");
  const runId = RunId.make("run_finalize_non_git");
  const scopeId = CheckpointScopeId.make("scope_finalize_non_git");
  const refresh = vi.fn(() => Effect.void);
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: () => Effect.void }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/plain" }],
              checkpoints: [
                {
                  scopeId,
                  runId,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  status: "missing" as const,
                  ref: CheckpointRef.make("checkpoint-ref:non-git"),
                },
              ],
            }),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.deepEqual(refresh.mock.calls, [[{ cwd: "/plain", threadId, runId, vcs: false }]]);
  }).pipe(Effect.provide(layer));
});

it.effect("refreshes only the file search index when VCS refresh is skipped", () => {
  const refreshedEntries: string[] = [];
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({
          refresh: (cwd) => Effect.sync(() => void refreshedEntries.push(cwd)),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () => Effect.die("a non-repository must not refresh VCS status"),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({
      cwd: "/plain",
      threadId: ThreadId.make("thread-non-git-entries"),
      runId: RunId.make("run-non-git-entries"),
      vcs: false,
    });
    assert.deepEqual(refreshedEntries, ["/plain"]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});
