import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  CheckpointObjectsUnavailableError,
  CheckpointSnapshotUnavailableError,
} from "../checkpointing/Errors.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assessCheckpointRestore } from "./CheckpointRestoreSafety.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import { resolveCodexRollbackTurnCount } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerVcs = VcsDriverRegistry.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerUnusedPositions = Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({});
const makeGitRepo = Effect.fn("RollbackTest.makeGitRepo")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped({ prefix }));
  yield* (yield* VcsProcess.VcsProcess).run({
    operation: "test.init",
    command: "git",
    args: ["init", "--quiet"],
    cwd,
  });
  return cwd;
});
const layerRollbackServiceFor = (workspaceRoot?: string) =>
  CheckpointRollbackService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        layerVcs,
        Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
        ServerSettings.layerTest(),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              workspaceRoot === undefined ? Option.none() : Option.some({ workspaceRoot } as never),
            ),
        }),
      ),
    ),
  );
const layerCheckpointRollbackService = layerRollbackServiceFor();

it.effect.each(["initial", "waiting"])(
  "rejects a non-ready checkpoint from %s before opening a session or restoring files",
  (state) => {
    const threadId = ThreadId.make("thread:rollback-non-ready");
    const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
    const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
    const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
    const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
    const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
    const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
    const open = vi.fn(() => Effect.die("provider session open must not run"));
    const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
    const readEntered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let projection = {
      thread: {
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThread: { id: providerThreadId, providerSessionId, providerInstanceId },
      checkpoint: {
        id: checkpointId,
        scopeId,
        status: state === "waiting" ? "ready" : "stale",
        appRunOrdinal: 0,
      },
      scope: { id: scopeId, cwd: process.cwd() },
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const getThread = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThread"]>(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(projection.thread)),
    );
    const getCheckpointRollbackContext = vi.fn(() => Effect.succeed(projection));
    const testLayer = layerCheckpointRollbackService.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            restore,
            prepareRestore: () => Effect.void,
          }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          layerUnusedPositions,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread,
            getCheckpointRollbackContext,
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const holder =
        state === "waiting"
          ? yield* withWorkspaceLease(process.cwd(), Deferred.await(release)).pipe(
              Effect.forkChild({ startImmediately: true }),
            )
          : undefined;
      const rollback = yield* service
        .execute({
          threadId,
          providerThreadId,
          checkpointId,
          scopeId,
        })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      if (state === "waiting") {
        yield* Deferred.await(readEntered);
        projection = {
          ...projection,
          checkpoint: { ...projection.checkpoint!, status: "stale" },
        };
        yield* Deferred.succeed(release, undefined);
        if (holder !== undefined) yield* Fiber.join(holder);
      }
      const error = yield* Fiber.join(rollback);

      assert.deepEqual(getThread.mock.calls, [[threadId]]);
      assert.deepEqual(getCheckpointRollbackContext.mock.calls, [
        [
          threadId,
          {
            threadId,
            providerThreadId,
            checkpointId,
            scopeId,
          },
        ],
      ]);
      assert.equal(error.reason, "rollback-target-invalid");
      assert.equal(
        error.message,
        `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
      );
      assert.equal(error.cause, undefined);
      assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
      assert.equal(open.mock.calls.length, 0);
      assert.equal(restore.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect.each([
  new CheckpointObjectsUnavailableError({
    operation: "restore",
    reason: "network",
    remote: "origin (github.com/acme/app)",
    objectCount: 12,
  }),
  new CheckpointSnapshotUnavailableError(),
])(
  "stops before the provider session when the checkpoint's files are unavailable ($_tag)",
  (unavailable) => {
    const threadId = ThreadId.make("thread:rollback-objects-unavailable");
    const providerThreadId = ProviderThreadId.make("provider-thread:rollback-objects-unavailable");
    const providerSessionId = ProviderSessionId.make(
      "provider-session:rollback-objects-unavailable",
    );
    const checkpointId = CheckpointId.make("checkpoint:rollback-objects-unavailable");
    const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-objects-unavailable");
    const providerInstanceId = ProviderInstanceId.make("provider_rollback_objects_unavailable");
    const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
    const open = vi.fn(() => Effect.die("provider session open must not run"));
    const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
    const projection = {
      thread: {
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThread: { id: providerThreadId, providerSessionId, providerInstanceId },
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: 0 },
      scope: { id: scopeId, cwd: process.cwd() },
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const layerTest = layerCheckpointRollbackService.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            restore,
            prepareRestore: () =>
              Effect.fail(
                new CheckpointService.CheckpointRestoreError({
                  scopeId,
                  checkpointId,
                  cause: unavailable,
                }),
              ),
          }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          layerUnusedPositions,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getProviderControlContext: () => Effect.succeed({ attempt: undefined } as never),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId })
        .pipe(Effect.flip);

      assert.equal(
        CheckpointRollbackService.rollbackFailureClientMessage(error),
        unavailable.message,
      );
      assert.isTrue(CheckpointRollbackService.isCheckpointContentUnavailable(error));
      assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
      assert.equal(open.mock.calls.length, 0);
      assert.equal(restore.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("rejects a rollback when another provider thread became active", () => {
  const threadId = ThreadId.make("thread:rollback-inactive-provider-thread");
  const requestedProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:requested",
  );
  const activeProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:active",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-inactive-provider-thread",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-inactive-provider-thread");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-inactive-provider-thread");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_inactive_provider_thread");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      worktreePath: null,
      activeProviderThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThread: {
      id: requestedProviderThreadId,
      providerSessionId,
      providerInstanceId,
    },
    checkpoint: { id: checkpointId, scopeId, status: "ready" },
    scope: { id: scopeId, cwd: process.cwd() },
  } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          restore,
          prepareRestore: () => Effect.void,
        }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        layerUnusedPositions,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(projection.thread),
          getCheckpointRollbackContext: () => Effect.succeed(projection),
          getProviderControlContext: () => Effect.succeed({ attempt: undefined } as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId: requestedProviderThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect("rejects a rollback when provider selection changed before execution", () => {
  const threadId = ThreadId.make("thread:rollback-provider-selection-changed");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-selection-changed",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-selection-changed",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-selection-changed");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-selection-changed");
  const originalProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_original",
  );
  const selectedProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_selected",
  );
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: selectedProviderInstanceId, model: "test-model" },
    },
    providerThread: {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: originalProviderInstanceId,
    },
    checkpoint: { id: checkpointId, scopeId, status: "ready" },
    scope: { id: scopeId, cwd: process.cwd() },
  } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          restore,
          prepareRestore: () => Effect.void,
        }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        layerUnusedPositions,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(projection.thread),
          getCheckpointRollbackContext: () => Effect.succeed(projection),
          getProviderControlContext: () => Effect.succeed({ attempt: undefined } as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect("rejects an unavailable rollback target before opening a session", () => {
  const threadId = ThreadId.make("thread:rollback-provider-turn-unavailable");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-turn-unavailable",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-turn-unavailable",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-turn-unavailable");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-turn-unavailable");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_provider_turn_unavailable");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const projection = {
    thread: {
      worktreePath: "/tmp/missing-invalid-rollback-worktree",
      branch: "feature/rollback",
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThread: { id: providerThreadId, providerSessionId, providerInstanceId },
    providerSession: undefined,
    checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 },
    scope: { id: scopeId, cwd: process.cwd() },
    runsToRollback: [],
    targetAttempt: undefined,
    rolledBackAttemptIds: [],
    providerTurns: [],
  } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          restore,
          prepareRestore: () => Effect.void,
        }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        layerUnusedPositions,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(projection.thread),
          getCheckpointRollbackContext: () => Effect.succeed(projection),
          getProviderControlContext: () => Effect.succeed({ attempt: undefined } as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open,
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles: false })
      .pipe(Effect.flip);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(error.reason, "provider-turn-unavailable");
    assert.equal(
      error.message,
      `Provider turn for rollback target ${checkpointId} is unavailable on provider thread ${providerThreadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect.each([
  { order: "cleanup-first", restoreFiles: true },
  { order: "rollback-first", restoreFiles: true },
  { order: "cleanup-first", restoreFiles: false, unmanaged: true },
])("locks rollback with %s", ({ order, restoreFiles, unmanaged = false }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rollback-" }),
    );
    const worktreesDir = path.join(workspaceRoot, "worktrees");
    const worktreePath = unmanaged
      ? path.join(workspaceRoot, "elsewhere", "feature")
      : path.join(worktreesDir, "repo", "feature");
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    const vcsProcess = yield* VcsProcess.VcsProcess;
    yield* vcsProcess.run({
      operation: "test.init",
      command: "git",
      args: ["init", "--quiet"],
      cwd: worktreePath,
    });
    const threadId = ThreadId.make("rollback-worktree");
    const projectId = ProjectId.make("rollback-worktree-project");
    const providerThreadId = ProviderThreadId.make("rollback-worktree-provider-thread");
    const providerSessionId = ProviderSessionId.make("rollback-worktree-provider-session");
    const providerInstanceId = ProviderInstanceId.make("rollback-worktree-provider-instance");
    const checkpointId = CheckpointId.make("rollback-worktree-checkpoint");
    const scopeId = CheckpointScopeId.make("rollback-worktree-scope");
    const branch = "feature/rollback";
    const release = Deferred.makeUnsafe<void>();
    const openEntered = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    let cleanupEntered = false;
    const providerThread = { id: providerThreadId, providerSessionId, providerInstanceId };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath,
        branch,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThread,
      providerSession: undefined,
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: 0 },
      scope: { id: scopeId, cwd: worktreePath },
      runsToRollback: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      rootNodes: [],
      providerTurns: [],
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const testLayer = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          layerVcs,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as never),
          ServerSettings.layerTest(),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => {
              assert.equal(id, projectId);
              return Effect.succeedSome({ workspaceRoot } as never);
            },
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            pruneWorktrees: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, { cwd: workspaceRoot });
                calls.push("prune");
              }),
            createWorktree: (input) =>
              Effect.gen(function* () {
                assert.deepEqual(input, {
                  cwd: workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                });
                calls.push("create");
                yield* fileSystem.makeDirectory(worktreePath);
                yield* vcsProcess.run({
                  operation: "test.init",
                  command: "git",
                  args: ["init", "--quiet"],
                  cwd: worktreePath,
                });
                return {} as never;
              }).pipe(Effect.orDie),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            prepareRestore: () => Effect.void,
            restore: () =>
              Effect.gen(function* () {
                assert.isTrue(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie));
                calls.push("files");
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () =>
              Effect.sync(() => {
                calls.push("projection");
                return [];
              }),
          }),
          IdAllocator.layer,
          layerUnusedPositions,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getProviderControlContext: () => Effect.succeed({ attempt: undefined } as never),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: (input) =>
              Effect.gen(function* () {
                assert.equal(input.runtimePolicy.cwd, worktreePath);
                if (!(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie))) {
                  return yield* new ProviderWorkspaceMissingError({ threadId, cwd: worktreePath });
                }
                calls.push("session");
                yield* Deferred.succeed(openEntered, undefined);
                if (order === "rollback-first") yield* Deferred.await(release);
                return {} as never;
              }),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: ({ thread }) => {
              assert.equal(thread.worktreePath, worktreePath);
              return Effect.succeed({ cwd: thread.worktreePath } as never);
            },
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
          calls.push("cleanup");
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const rollback = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") assert.deepEqual(calls, []);
      if (order === "rollback-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "rollback-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "rollback-first") assert.isFalse(cleanupEntered);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      if (unmanaged) {
        const error = yield* Fiber.join(rollback).pipe(Effect.flip);
        assert.equal(error._tag, "CheckpointRollbackExecutionError");
        assert.deepEqual(calls, ["cleanup"]);
        return;
      }
      yield* Fiber.join(rollback);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      const rollbackCalls = restoreFiles
        ? ["session", "files", "projection"]
        : ["session", "projection"];
      assert.deepEqual(
        calls,
        order === "cleanup-first"
          ? ["cleanup", "prune", "create", ...rollbackCalls]
          : [...rollbackCalls, "cleanup"],
      );
    }).pipe(Effect.provide(testLayer));
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(layerVcs, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
);

it.effect.each([
  { restoreFiles: true, shared: "none" },
  { restoreFiles: true, shared: "none", refreshFails: true },
  { restoreFiles: true, shared: "settled" },
  { restoreFiles: true, shared: "archived" },
  { restoreFiles: true, shared: "settled", noticeFailure: "read" },
  { restoreFiles: true, shared: "settled", noticeFailure: "position" },
  { restoreFiles: true, shared: "settled", noticeFailure: "commit" },
  { restoreFiles: false, shared: "settled" },
  { restoreFiles: false, shared: "root" },
  { restoreFiles: true, shared: "root" },
  { restoreFiles: true, shared: "worktree" },
  { restoreFiles: false, shared: "worktree" },
  { restoreFiles: true, shared: "historical" },
  { restoreFiles: false, shared: "none", targetOrdinal: 1 },
  { restoreFiles: false, shared: "none", targetOrdinal: 1, multipleTurns: true },
])(
  "rewinds safely with $shared, restoreFiles=$restoreFiles, noticeFailure=$noticeFailure",
  ({
    restoreFiles,
    shared,
    targetOrdinal = 0,
    multipleTurns = false,
    refreshFails = false,
    noticeFailure,
  }) =>
    Effect.gen(function* () {
      const repo = yield* makeGitRepo("t3-rewind-");
      const threadId = ThreadId.make("rewind-files");
      const providerThreadId = ProviderThreadId.make("rewind-provider");
      const providerSessionId = ProviderSessionId.make("rewind-session");
      const instanceId = ProviderInstanceId.make("rewind-instance");
      const checkpointId = CheckpointId.make("rewind-start");
      const scopeId = CheckpointScopeId.make("rewind-scope");
      const calls: string[] = [];
      let lockedThreads = Effect.succeed<ReadonlyArray<ThreadId>>([]);
      const layerThreadCommands = Layer.effect(
        ThreadCommandExecutor.ThreadCommandExecutor,
        Effect.tap(KeyedLock.make<ThreadId>(), (lock) =>
          Effect.sync(() => {
            lockedThreads = lock.activeKeys;
          }),
        ),
      );
      const providerThread = {
        id: providerThreadId,
        providerSessionId,
        providerInstanceId: instanceId,
      };
      const projection = {
        thread: {
          id: threadId,
          projectId: ProjectId.make("rewind-project"),
          title: "Rewind work",
          worktreePath: shared === "root" ? null : repo,
          activeProviderThreadId: providerThreadId,
          modelSelection: { instanceId, model: "test" },
        },
        providerThread,
        providerSession: undefined,
        providerTurns: [
          ...(multipleTurns
            ? [
                {
                  id: "turn-0",
                  providerThreadId,
                  runAttemptId: "attempt-1",
                  ordinal: 0,
                  status: "completed",
                },
              ]
            : []),
          ...[1, 2, 3].map((ordinal) => ({
            id: `turn-${ordinal}`,
            providerThreadId,
            runAttemptId: `attempt-${ordinal}`,
            ordinal,
            status: "completed",
          })),
        ],
        rootNodes: [],
        targetAttempt:
          targetOrdinal === 0 ? undefined : { id: "attempt-1", providerTurnId: "turn-1" },
        rolledBackAttemptIds: ["attempt-3"],
        checkpoint: {
          id: checkpointId,
          scopeId,
          status: "ready",
          appRunOrdinal: targetOrdinal || null,
        },
        scope: { id: scopeId, cwd: repo },
        runsToRollback: [1, 2]
          .filter((ordinal) => ordinal > targetOrdinal)
          .map((ordinal) => ({
            id: `run-${ordinal}`,
            ordinal,
            status: "completed",
            rootNodeId: null,
            activeAttemptId: `attempt-${ordinal}`,
          })),
      } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
      const written: OrchestrationV2DomainEvent[] = [];
      const layerTest = layerRollbackServiceFor(repo).pipe(
        Layer.provide(
          Layer.mergeAll(
            layerThreadCommands,
            Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
              allocate: () =>
                noticeFailure === "position"
                  ? Effect.fail("notice position" as never)
                  : Effect.succeed(7),
            }),
            Layer.succeed(RunFinalization.RunFinalizationObserver, {
              refreshAfterTurn: () => Effect.void,
              refresh: ({ cwd }) =>
                Effect.gen(function* () {
                  assert.equal(cwd, repo);
                  calls.push("refresh");
                  if (refreshFails) {
                    return yield* new RunFinalization.RunFinalizationRefreshError({
                      cwd,
                      cause: "test",
                    });
                  }
                }),
            }),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              prepareRestore: () => Effect.void,
              restore: () =>
                Effect.sync(() => {
                  calls.push("files");
                }),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: ({ events }) =>
                Effect.flatMap(lockedThreads, (locked) => {
                  assert.include(locked, threadId);
                  assert.ok(
                    events.some(
                      (event) =>
                        event.type === "run.updated" && event.payload.status === "rolled_back",
                    ),
                  );
                  calls.push("projection");
                  written.push(...events);
                  return noticeFailure === "commit"
                    ? Effect.fail("notice commit" as never)
                    : Effect.succeed([]);
                }),
            }),
            IdAllocator.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: (id) =>
                Effect.succeed(
                  id === threadId ? projection.thread : ({ id, deletedAt: null } as never),
                ),
              getNextTurnItemOrdinal: () =>
                noticeFailure === "read" ? Effect.fail("notice read" as never) : Effect.succeed(1),
              getThreadRecords: (_id, _fields, options) =>
                Effect.succeed({
                  turnItems: options?.turnItemTypes?.includes("file_change")
                    ? [{ type: "file_change" }]
                    : [],
                } as never),
              getCheckpointRollbackContext: () => Effect.succeed(projection),
              getProviderControlContext: () => Effect.succeed({ attempt: undefined } as never),
              getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
              getCheckpointContext: () =>
                Effect.succeed({
                  checkpointScopes: [{ cwd: repo }],
                  runs: [],
                  checkpoints: [],
                } as never),
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  archivedThreads: [],
                  threads:
                    shared === "worktree" ||
                    shared === "historical" ||
                    shared === "settled" ||
                    shared === "archived"
                      ? [
                          {
                            id: ThreadId.make("other-thread"),
                            title: "Other work",
                            lineage: {},
                            deletedAt: null,
                            activeRunId: null,
                            settledAt: shared === "settled" ? "2026-01-01" : null,
                            archivedAt: shared === "archived" ? "2026-01-01" : null,
                            worktreePath: shared === "historical" ? `${repo}-elsewhere` : repo,
                          } as never,
                        ]
                      : [],
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              open: () =>
                Effect.succeed({
                  rollbackThread: (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
                    Effect.gen(function* () {
                      const count = yield* resolveCodexRollbackTurnCount(input);
                      assert.equal(count, 2 - targetOrdinal);
                      calls.push("provider");
                      return { providerThread };
                    }),
                } as never),
            }),
            Layer.mock(RuntimePolicy.RuntimePolicyV2)({
              resolve: () => Effect.succeed({} as never),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
        if (restoreFiles && ["worktree", "historical"].includes(shared)) {
          const error = yield* Effect.flip(
            service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles }),
          );
          assert.equal(error.reason, "shared-workspace");
          assert.match(error.message, /"Other work" is active/);
          assert.equal(
            CheckpointRollbackService.rollbackFailureClientMessage(error),
            error.message,
          );
          assert.isTrue(CheckpointRollbackService.isFinalRollbackFailure(error));
          assert.deepEqual(calls, []);
          return;
        }
        if (noticeFailure !== undefined) {
          const attempt = service.execute({
            threadId,
            providerThreadId,
            checkpointId,
            scopeId,
            restoreFiles,
          });
          const error = yield* attempt.pipe(Effect.flip);
          if (!CheckpointRollbackService.isFinalRollbackFailure(error)) {
            yield* attempt.pipe(Effect.flip);
          }
          assert.equal(
            calls.filter((call) => call === "files").length,
            noticeFailure === "commit" ? 1 : 0,
          );
          assert.equal(
            CheckpointRollbackService.isFinalRollbackFailure(error),
            noticeFailure === "commit",
          );
          return;
        }
        yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
        assert.deepEqual(
          written.flatMap((event) =>
            event.type === "turn-item.updated" && event.payload.type === "system_notice"
              ? [[event.threadId, event.payload.ordinal, event.payload.message]]
              : [],
          ),
          restoreFiles && ["settled", "archived"].includes(shared)
            ? [
                [
                  "other-thread",
                  7,
                  'Files in this workspace were restored to an earlier checkpoint by another thread: "Rewind work".',
                ],
              ]
            : [],
        );
        assert.deepEqual(
          calls,
          restoreFiles
            ? ["provider", "files", "refresh", "projection"]
            : ["provider", "projection"],
        );
      }).pipe(Effect.provide(layerTest));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(layerVcs, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
);

it.effect.each([false, ...(symlinksSupported ? [true] : [])])(
  "keeps turn starts out during restore, symlink=%s",
  (alias) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repo = yield* makeGitRepo("t3-restore-race-");
      const fs = yield* FileSystem.FileSystem;
      const aliasPath = `${repo}-alias`;
      if (alias) {
        yield* fs.symlink(repo, aliasPath);
        yield* Effect.addFinalizer(() => fs.remove(aliasPath).pipe(Effect.orDie));
      }
      const threadId = ThreadId.make("restore-race");
      const providerThreadId = ProviderThreadId.make("restore-race-provider");
      const checkpointId = CheckpointId.make("restore-race-checkpoint");
      const scopeId = CheckpointScopeId.make("restore-race-scope");
      const instanceId = ProviderInstanceId.make("restore-race-instance");
      const restoreEntered = yield* Deferred.make<void>();
      const releaseRestore = yield* Deferred.make<void>();
      const order: string[] = [];
      const projection = {
        thread: {
          id: threadId,
          projectId: ProjectId.make("restore-race-project"),
          title: "Race work",
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          modelSelection: { instanceId, model: "test" },
        },
        providerThread: {
          id: providerThreadId,
          providerSessionId: ProviderSessionId.make("restore-race-session"),
          providerInstanceId: instanceId,
        },
        providerSession: undefined,
        providerTurns: [],
        rootNodes: [],
        targetAttempt: undefined,
        rolledBackAttemptIds: [],
        checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: null },
        scope: { id: scopeId, cwd: repo },
        runsToRollback: [],
      } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
      const layerTest = layerRollbackServiceFor(repo).pipe(
        Layer.provide(
          Layer.mergeAll(
            ThreadCommandExecutor.layer,
            IdAllocator.layer,
            layerUnusedPositions,
            Layer.succeed(RunFinalization.RunFinalizationObserver, {
              refreshAfterTurn: () => Effect.void,
              refresh: () => Effect.void,
            }),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              prepareRestore: () => Effect.void,
              restore: () =>
                Deferred.succeed(restoreEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRestore)),
                  Effect.andThen(Effect.sync(() => order.push("restore"))),
                ),
            }),
            Layer.mock(EventSink.EventSinkV2)({ write: () => Effect.succeed([]) }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () => Effect.succeed(projection.thread),
              getCheckpointRollbackContext: () => Effect.succeed(projection),
              getProviderControlContext: () => Effect.succeed({ attempt: undefined } as never),
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  threads: [],
                  archivedThreads: [],
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              open: () => Effect.succeed({} as never),
            }),
            Layer.mock(RuntimePolicy.RuntimePolicyV2)({
              resolve: () => Effect.succeed({} as never),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
        const rollback = yield* service
          .execute({ threadId, providerThreadId, checkpointId, scopeId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(restoreEntered);
        // The lease ProviderTurnStartService takes for another project-root thread in this checkout.
        const turnStart = yield* withWorkspaceLease(
          path.join(alias ? aliasPath : repo, "nested-project"),
          Effect.sync(() => order.push("turn start")),
          "shared",
        ).pipe(Effect.forkChild({ startImmediately: true }));
        assert.deepEqual(order, []);
        yield* Deferred.succeed(releaseRestore, undefined);
        yield* Fiber.join(rollback);
        yield* Fiber.join(turnStart);
        assert.deepEqual(order, ["restore", "turn start"]);
      }).pipe(Effect.provide(layerTest));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(layerVcs, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
);

it.effect.skipIf(!symlinksSupported)(
  "rejects an active thread sharing a worktree through a symlink",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-isolation-" });
      const path = yield* Path.Path;
      const alias = path.join(cwd, "alias");
      yield* (yield* VcsProcess.VcsProcess).run({
        operation: "test.init",
        command: "git",
        args: ["init", "--quiet"],
        cwd,
      });
      yield* fileSystem.symlink(cwd, alias);
      const threadId = ThreadId.make("restore-alias-current");
      const otherId = ThreadId.make("restore-alias-archived");
      const projections = ProjectionStore.ProjectionStoreV2.of({
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [
              {
                id: otherId,
                title: "Alias work",
                lineage: {},
                deletedAt: null,
                activeRunId: null,
                settledAt: null,
                archivedAt: null,
                worktreePath: alias,
              } as never,
            ],
            archivedThreads: [],
          }),
        getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
        getCheckpointContext: () =>
          Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
      } as never);
      const { blockedMessage } = yield* assessCheckpointRestore(
        { id: threadId, projectId: ProjectId.make("restore-project"), worktreePath: cwd },
        { cwd },
        {
          fileSystem,
          path,
          vcs: yield* VcsDriverRegistry.VcsDriverRegistry,
          projections,
          projects: ProjectStore.ProjectStoreV2.of({
            get: () => Effect.succeedNone,
          } as never),
        },
      );
      assert.match(blockedMessage ?? "", /"Alias work" is active/);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(layerVcs, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
);

const seedRollbackHistory = Effect.fn("RollbackTest.seedHistory")(function* (
  driverKind: "codex" | "claudeAgent" = "codex",
  nativeSource = false,
  nativeBackground = false,
  inherited = false,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("rollback-history");
  const providerThreadId = ProviderThreadId.make("rollback-history-provider");
  const providerSessionId = ProviderSessionId.make("rollback-history-session");
  const providerInstanceId = ProviderInstanceId.make(driverKind);
  const driver = ProviderDriverKind.make(driverKind);
  const modelSelection = { instanceId: providerInstanceId, model: "test" };
  const scopeId = CheckpointScopeId.make("rollback-history-root");
  const otherScopeId = CheckpointScopeId.make("rollback-history-child");
  const runId = (ordinal: number) => RunId.make(`rollback-history-run-${ordinal}`);
  const nodeId = (ordinal: number) => NodeId.make(`rollback-history-node-${ordinal}`);
  const attemptId = (ordinal: number) => RunAttemptId.make(`rollback-history-attempt-${ordinal}`);
  const turnId = (ordinal: number) => ProviderTurnId.make(`rollback-history-turn-${ordinal}`);
  const checkpointId = (ordinal: number) =>
    CheckpointId.make(`rollback-history-checkpoint-${ordinal}`);
  type EventInput<Event = OrchestrationV2DomainEvent> = Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id" | "occurredAt" | "threadId">
    : never;
  let sequence = 0;
  const apply = (event: EventInput) =>
    store.apply({
      ...event,
      id: EventId.make(`rollback-history-event-${sequence++}`),
      threadId,
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  yield* apply({
    type: "thread.created",
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("rollback-history-project"),
      title: "Rollback history",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const providerThread = {
    id: providerThreadId,
    driver,
    providerInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: nativeSource
      ? { driver, nativeId: "original", strength: "strong" as const }
      : null,
    nativeConversationHeadRef: null,
    ...(inherited ? { nativeMetadata: { forkHeadMessageId: "inherited-base" } } : {}),
    status: "idle" as const,
    firstRunOrdinal: 1,
    lastRunOrdinal: 6,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  yield* apply({ type: "provider-thread.updated", payload: providerThread });
  for (const id of [scopeId, otherScopeId]) {
    yield* apply({
      type: "checkpoint-scope.created",
      payload: {
        id,
        threadId,
        runId: runId(1),
        nodeId: nodeId(1),
        parentScopeId: id === scopeId ? null : scopeId,
        providerThreadId,
        kind: id === scopeId ? "root_run" : "subagent",
        ordinalWithinParent: 0,
        advancesAppRunCount: id === scopeId,
        cwd: process.cwd(),
        createdAt: now,
      },
    });
  }
  const statuses = [
    "completed",
    "completed",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "rolled_back",
  ] as const;
  for (const [index, status] of statuses.entries()) {
    const ordinal = index + 1;
    yield* apply({
      type: "run.created",
      payload: {
        id: runId(ordinal),
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`rollback-history-message-${ordinal}`),
        rootNodeId: nodeId(ordinal),
        activeAttemptId: attemptId(ordinal),
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: checkpointId(ordinal),
        contextHandoffId: null,
      },
    });
    yield* apply({
      type: "node.updated",
      payload: {
        id: nodeId(ordinal),
        threadId,
        runId: runId(ordinal),
        parentNodeId: null,
        rootNodeId: nodeId(ordinal),
        kind: "root_turn",
        status,
        countsForRun: true,
        providerThreadId,
        providerTurnId: turnId(ordinal),
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: scopeId,
        startedAt: now,
        completedAt: now,
      },
    });
    // Rollback must exclude every attempt of discarded runs, including an inactive retry.
    for (const attemptOrdinal of ordinal === 7 ? [6.5, 7] : [ordinal]) {
      yield* apply({
        type: "run-attempt.created",
        runId: runId(ordinal),
        payload: {
          id: attemptId(attemptOrdinal),
          runId: runId(ordinal),
          attemptOrdinal: attemptOrdinal === ordinal ? 2 : 1,
          rootNodeId: nodeId(ordinal),
          providerInstanceId,
          providerThreadId,
          providerTurnId: turnId(attemptOrdinal),
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* apply({
        type: "provider-turn.updated",
        payload: {
          id: turnId(attemptOrdinal),
          providerThreadId,
          nodeId: nodeId(ordinal),
          runAttemptId: attemptId(attemptOrdinal),
          nativeTurnRef: { driver, nativeId: `native-turn-${attemptOrdinal}`, strength: "strong" },
          ordinal: attemptOrdinal * 2,
          status: status === "rolled_back" ? "completed" : status,
          startedAt: now,
          completedAt: now,
        },
      });
    }
  }
  // A continuation shares the target attempt; its first provider turn is no longer the boundary.
  yield* apply({
    type: "provider-turn.updated",
    payload: {
      id: turnId(2.5),
      providerThreadId,
      nodeId: nodeId(2),
      runAttemptId: attemptId(2),
      nativeTurnRef: { driver, nativeId: "native-turn-2-continuation", strength: "strong" },
      ordinal: 5,
      status: "completed",
      startedAt: now,
      completedAt: now,
    },
  });
  for (let ordinal = 0; ordinal <= 8; ordinal++) {
    yield* apply({
      type: "checkpoint.captured",
      payload: {
        id: checkpointId(ordinal),
        threadId,
        scopeId: ordinal === 8 ? otherScopeId : scopeId,
        runId: ordinal === 0 ? null : runId(Math.min(ordinal, 7)),
        nodeId: nodeId(Math.max(1, Math.min(ordinal, 7))),
        parentCheckpointId: null,
        ordinalWithinScope: ordinal,
        appRunOrdinal: ordinal === 0 ? null : ordinal,
        ref: CheckpointRef.make(`refs/t3/rollback-history/${ordinal}`),
        status: ordinal === 7 ? "stale" : "ready",
        files: [],
        capturedAt: now,
      },
    });
  }

  const rollbackCounts: number[] = [];
  const restored: CheckpointId[] = [];
  const committed: OrchestrationV2DomainEvent[] = [];
  const nativeHistories = new Map<string, ReadonlyArray<string>>([
    [
      "original",
      [
        ...(inherited ? ["inherited-base"] : []),
        "native-turn-1",
        "native-turn-2",
        "native-turn-2-continuation",
        "native-turn-3",
        "native-turn-4",
        "native-turn-5",
        "native-turn-6",
      ],
    ],
  ]);
  let forks = 0;
  const closedNativeIds: Array<string | null | undefined> = [];
  const serviceLayer = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        IdAllocator.layer,
        TurnItemPositionStore.layer,
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          prepareRestore: () => Effect.void,
          restore: ({ checkpoint }) =>
            Effect.sync(() => {
              restored.push(checkpoint.id);
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.gen(function* () {
              for (const event of events) yield* store.apply(event);
              committed.push(...events);
              return [];
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EventSink.EventSinkWriteError({
                    eventCount: events.length,
                    cause,
                  }),
              ),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              hasPendingBackgroundWorkForThread: () => Effect.succeed(nativeBackground),
              unloadThread: ({
                providerThread,
              }: {
                providerThread: { nativeThreadRef: { nativeId: string | null } | null };
              }) =>
                Effect.sync(() => {
                  closedNativeIds.push(providerThread.nativeThreadRef?.nativeId);
                }),
              ensureThread: () =>
                Effect.sync(() => {
                  const nativeId = `empty-${++forks}`;
                  nativeHistories.set(nativeId, []);
                  return {
                    ...providerThread,
                    nativeThreadRef: { driver, nativeId, strength: "strong" as const },
                  };
                }),
              forkThread: (input: ProviderAdapter.ProviderAdapterV2ForkThreadInput) =>
                Effect.sync(() => {
                  const sourceId = input.sourceProviderThread.nativeThreadRef?.nativeId;
                  const source = nativeHistories.get(sourceId ?? "");
                  const boundary =
                    input.nativeBoundaryRef?.nativeId ??
                    input.sourceProviderTurns?.find((turn) => turn.id === input.providerTurnId)
                      ?.nativeTurnRef?.nativeId;
                  const index =
                    boundary == null && input.providerTurnId === undefined
                      ? (source?.length ?? 0) - 1
                      : (source?.indexOf(boundary ?? "") ?? -1);
                  if (source === undefined || index < 0)
                    throw new Error("Native fork source lost its selected boundary.");
                  const nativeId = `fork-${++forks}`;
                  nativeHistories.set(nativeId, source.slice(0, index + 1));
                  return {
                    ...input.sourceProviderThread,
                    nativeThreadRef: { driver, nativeId, strength: "strong" as const },
                    ...(driverKind === "claudeAgent"
                      ? { nativeMetadata: { forkHeadMessageId: `head-${nativeId}` } }
                      : {}),
                  };
                }),
              rollbackThread: (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
                Effect.gen(function* () {
                  const count = yield* resolveCodexRollbackTurnCount(input);
                  rollbackCounts.push(count);
                  const sourceId = input.providerThread.nativeThreadRef?.nativeId;
                  if (sourceId != null && nativeHistories.has(sourceId)) {
                    const source = nativeHistories.get(sourceId)!;
                    nativeHistories.set(
                      sourceId,
                      source.slice(0, Math.max(0, source.length - count)),
                    );
                  }
                  return { providerThread: input.providerThread };
                }),
            } as never),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );
  const rollback = (ordinal: number) =>
    Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      yield* service.execute({
        threadId,
        providerThreadId,
        scopeId,
        checkpointId: checkpointId(ordinal),
      });
    }).pipe(Effect.provide(serviceLayer));

  return {
    store,
    now,
    threadId,
    runId,
    nodeId,
    checkpointId,
    rollback,
    rollbackCounts,
    restored,
    committed,
    nativeHistories,
    closedNativeIds,
    apply,
    providerThreadId,
    attemptId,
    turnId,
    scopeId,
  };
});

it.layer(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "rollback history reads",
  (it) => {
    it.effect("rolls back later terminal runs despite obsolete unrelated SQLite payloads", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory();
        const sql = yield* SqlClient.SqlClient;
        const { threadId, runId, nodeId, checkpointId } = history;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES ('rollback-obsolete-transcript', ${threadId}, ${runId(1)}, ${nodeId(1)},
            NULL, NULL, NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(history.now)},
            '{"obsolete":"transcript"}')`;
        yield* Effect.addFinalizer(() =>
          sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'rollback-obsolete-transcript'`.pipe(
            Effect.orDie,
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_runs
          SET payload_json = '{"obsolete":"run"}' WHERE run_id = ${runId(1)}`;
        yield* sql`UPDATE orchestration_v2_projection_nodes
          SET payload_json = '{"obsolete":"node"}' WHERE node_id = ${nodeId(1)}`;
        yield* sql`UPDATE orchestration_v2_projection_checkpoints
          SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
          WHERE checkpoint_id IN (${checkpointId(0)}, ${checkpointId(1)}, ${checkpointId(7)}, ${checkpointId(8)})`;
        assert.equal(
          (yield* Effect.exit(history.store.getThreadProjection(threadId)))._tag,
          "Failure",
        );

        yield* history.rollback(2);

        assert.deepEqual(history.rollbackCounts, [4]);
        assert.deepEqual(history.restored, [checkpointId(2)]);
        const runs = yield* sql<{ ordinal: number; status: string }>`
          SELECT ordinal, status FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} ORDER BY ordinal`;
        assert.deepEqual(
          runs.map((run) => run.status),
          [
            "completed",
            "completed",
            "rolled_back",
            "rolled_back",
            "rolled_back",
            "rolled_back",
            "rolled_back",
          ],
        );
        const nodes = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} ORDER BY node_id`;
        assert.deepEqual(
          nodes.map((node) => node.status),
          runs.map((run) => run.status),
        );
        const checkpoints = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} ORDER BY ordinal_within_scope`;
        assert.deepEqual(
          checkpoints.map((checkpoint) => checkpoint.status),
          ["ready", "ready", "ready", "ready", "ready", "ready", "ready", "stale", "ready"],
        );
      }),
    );

    it.effect(
      "rewinds stopped runs repeatedly without counting discarded provider turns again",
      () =>
        Effect.gen(function* () {
          const history = yield* seedRollbackHistory();
          yield* history.rollback(5);
          yield* history.rollback(2);
          yield* history.rollback(0);
          yield* history.rollback(0);

          assert.deepEqual(history.rollbackCounts, [1, 3, 3]);
          assert.sameMembers(
            history.committed
              .filter((event) => event.type === "run.updated")
              .map((event) => event.payload.id),
            [1, 2, 3, 4, 5, 6].map(history.runId),
          );
          const records = yield* history.store.getThreadRecords(history.threadId, [
            "runs",
            "nodes",
            "checkpoints",
          ]);
          assert.isTrue(records.runs.every((run) => run.status === "rolled_back"));
          assert.isTrue(records.nodes.every((node) => node.status === "rolled_back"));
          assert.sameMembers(
            records.checkpoints
              .filter((checkpoint) => checkpoint.status === "ready")
              .map((checkpoint) => checkpoint.id),
            [0, 1, 2, 3, 4, 5, 6, 8].map(history.checkpointId),
          );
        }),
    );

    it.effect.each([
      { driver: "codex", inherited: false },
      { driver: "codex", inherited: true },
      { driver: "claudeAgent", inherited: false },
      { driver: "claudeAgent", inherited: true },
    ] as const)(
      "keeps $driver native history and terminal states through navigation, inherited=$inherited",
      ({ driver, inherited }) =>
        Effect.gen(function* () {
          const history = yield* seedRollbackHistory(driver, true, false, inherited);
          const original = history.nativeHistories.get("original");
          yield* history.rollback(1);
          let records = yield* history.store.getThreadRecords(history.threadId, [
            "providerThreads",
            "checkpoints",
            "runs",
            "nodes",
          ]);
          assert.deepEqual(history.nativeHistories.get("original"), original);
          assert.deepEqual(
            history.nativeHistories.get(records.providerThreads[0]!.nativeThreadRef!.nativeId!),
            [...(inherited ? ["inherited-base"] : []), "native-turn-1"],
          );
          const firstFork = records.providerThreads[0]!.nativeThreadRef!.nativeId;
          if (driver === "claudeAgent") {
            assert.deepEqual(history.closedNativeIds, ["original"]);
            assert.equal(
              records.providerThreads[0]!.nativeConversationHeadRef?.nativeId,
              `head-${firstFork}`,
            );
          }
          assert.equal(
            records.checkpoints.find((checkpoint) => checkpoint.id === history.checkpointId(6))
              ?.nativeThreadRef?.nativeId,
            "original",
          );

          yield* history.rollback(6);
          records = yield* history.store.getThreadRecords(history.threadId, [
            "providerThreads",
            "checkpoints",
            "runs",
            "nodes",
          ]);
          assert.deepEqual(
            history.nativeHistories.get(records.providerThreads[0]!.nativeThreadRef!.nativeId!),
            original,
          );
          if (driver === "claudeAgent") assert.equal(history.closedNativeIds[1], firstFork);
          assert.deepEqual(
            records.runs.filter((run) => run.ordinal <= 6).map((run) => run.status),
            ["completed", "completed", "completed", "interrupted", "failed", "cancelled"],
          );
          assert.deepEqual(
            records.nodes
              .filter((node) => [4, 5, 6].some((ordinal) => node.id === history.nodeId(ordinal)))
              .map((node) => node.status),
            ["interrupted", "failed", "cancelled"],
          );

          yield* history.rollback(0);
          records = yield* history.store.getThreadRecords(history.threadId, [
            "providerThreads",
            "checkpoints",
            "runs",
            "nodes",
          ]);
          assert.deepEqual(
            history.nativeHistories.get(records.providerThreads[0]!.nativeThreadRef!.nativeId!),
            inherited ? ["inherited-base"] : [],
          );
          yield* history.rollback(3);
          records = yield* history.store.getThreadRecords(history.threadId, [
            "providerThreads",
            "checkpoints",
            "runs",
            "nodes",
          ]);
          assert.deepEqual(
            history.nativeHistories.get(records.providerThreads[0]!.nativeThreadRef!.nativeId!),
            original?.slice(0, inherited ? 5 : 4),
          );
          assert.deepEqual(history.nativeHistories.get("original"), original);
          if (driver === "codex") assert.isAbove(history.rollbackCounts[0]!, 0);
          else assert.deepEqual(history.rollbackCounts, []);

          yield* history.rollback(1);
          const branch = yield* history.store.getThreadProjection(history.threadId);
          const current = branch.providerThreads[0]!;
          const branchSource = current.nativeThreadRef!.nativeId!;
          const branchHistory = [
            ...(inherited ? ["inherited-base"] : []),
            "native-turn-1",
            "native-turn-8",
          ];
          history.nativeHistories.set(branchSource, branchHistory);
          for (const run of branch.runs.filter(
            (run) => run.status === "rolled_back" && run.ordinal > 1,
          )) {
            yield* history.apply({
              type: "run.updated",
              payload: { ...run, checkpointAbandoned: true },
            });
          }
          for (const checkpoint of branch.checkpoints.filter(
            (checkpoint) =>
              checkpoint.scopeId === history.scopeId && (checkpoint.appRunOrdinal ?? 0) > 1,
          )) {
            yield* history.apply({
              type: "checkpoint.captured",
              payload: { ...checkpoint, status: "stale" },
            });
          }
          const originalRun = branch.runs.find((run) => run.ordinal === 1)!;
          const originalNode = branch.nodes.find((node) => node.id === originalRun.rootNodeId)!;
          const originalAttempt = branch.attempts.find(
            (attempt) => attempt.id === originalRun.activeAttemptId,
          )!;
          const originalTurn = branch.providerTurns.find(
            (turn) => turn.runAttemptId === originalAttempt.id,
          )!;
          yield* history.apply({
            type: "run.created",
            payload: {
              ...originalRun,
              id: history.runId(8),
              ordinal: 8,
              rootNodeId: history.nodeId(8),
              activeAttemptId: history.attemptId(8),
              checkpointId: history.checkpointId(8),
            },
          });
          yield* history.apply({
            type: "node.updated",
            payload: {
              ...originalNode,
              id: history.nodeId(8),
              rootNodeId: history.nodeId(8),
              runId: history.runId(8),
              providerTurnId: history.turnId(8),
            },
          });
          yield* history.apply({
            type: "run-attempt.created",
            payload: {
              ...originalAttempt,
              id: history.attemptId(8),
              runId: history.runId(8),
              rootNodeId: history.nodeId(8),
              providerTurnId: history.turnId(8),
              nativeThreadId: branchSource,
            },
          });
          yield* history.apply({
            type: "provider-turn.updated",
            payload: {
              ...originalTurn,
              id: history.turnId(8),
              nodeId: history.nodeId(8),
              runAttemptId: history.attemptId(8),
              ordinal: 16,
              nativeTurnRef: {
                driver: current.driver,
                nativeId: "native-turn-8",
                strength: "strong",
              },
            },
          });
          yield* history.apply({
            type: "provider-thread.updated",
            payload: { ...current, lastRunOrdinal: 8 },
          });
          const baseline = branch.checkpoints.find(
            (checkpoint) => checkpoint.id === history.checkpointId(1),
          )!;
          yield* history.apply({
            type: "checkpoint.captured",
            payload: {
              ...baseline,
              id: history.checkpointId(8),
              runId: history.runId(8),
              nodeId: history.nodeId(8),
              ordinalWithinScope: 8,
              appRunOrdinal: 8,
              parentCheckpointId: baseline.id,
              nativeThreadRef: current.nativeThreadRef,
            },
          });
          yield* history.rollback(0);
          yield* history.rollback(8);
          const redoneBranch = yield* history.store.getThreadProjection(history.threadId);
          assert.deepEqual(
            redoneBranch.runs
              .filter((run) => run.status !== "rolled_back")
              .map((run) => run.ordinal),
            [1, 8],
          );
          assert.deepEqual(
            history.nativeHistories.get(
              redoneBranch.providerThreads[0]!.nativeThreadRef!.nativeId!,
            ),
            branchHistory,
          );
        }),
    );
    it.effect("refuses native navigation while this thread has background work", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory("claudeAgent", true, true);
        const error = yield* history.rollback(1).pipe(Effect.flip);
        assert.isTrue("reason" in error && error.reason === "background-work-active");
        assert.deepEqual(history.closedNativeIds, []);
        assert.deepEqual(history.restored, []);
      }),
    );

    // Fork DL006: a rollback keeps forward checkpoints ready, so jumping back
    // to one reactivates its rolled-back turns instead of discarding them.
    it.effect("redoes to a forward checkpoint after a rollback", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory();
        yield* history.rollback(1);
        yield* history.rollback(3);

        assert.deepEqual(history.restored, [1, 3].map(history.checkpointId));
        // The redo target's rolled-back turns stay in the provider history, so
        // Codex rolls back from the full conversation rather than from turn 1.
        assert.equal(history.rollbackCounts.length, 2);
        assert.isAbove(history.rollbackCounts[1]!, 0);
        const records = yield* history.store.getThreadRecords(history.threadId, [
          "providerThreads",
          "checkpoints",
          "runs",
          "nodes",
        ]);
        assert.equal(records.providerThreads[0]?.lastRunOrdinal, 3);
        assert.equal(
          records.checkpoints.find((checkpoint) => checkpoint.id === history.checkpointId(3))
            ?.status,
          "ready",
        );
        assert.deepEqual(
          records.runs.filter((run) => run.ordinal <= 3).map((run) => run.status),
          ["completed", "completed", "completed"],
        );
        assert.isTrue(
          records.nodes
            .filter((node) => [1, 2, 3].some((ordinal) => node.id === history.nodeId(ordinal)))
            .every((node) => node.status === "completed"),
        );
      }),
    );
  },
);

it.layer(
  Layer.mergeAll(ProjectionStore.layer, TurnItemPositionStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
)("workspace restore notices", (it) => {
  it.effect("appends one notice after a settled recipient's latest item", () =>
    Effect.gen(function* () {
      const history = yield* seedRollbackHistory();
      const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
      const recipientId = ThreadId.make("restore-notice-recipient");
      const runId = RunId.make("restore-notice-run");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId: providerInstanceId, model: "test" };
      let sequence = 0;
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "occurredAt" | "threadId">) =>
        history.store.apply({
          ...event,
          id: EventId.make(`restore-notice-event-${sequence++}`),
          threadId: recipientId,
          occurredAt: history.now,
        } as OrchestrationV2DomainEvent);
      yield* apply({
        type: "thread.created",
        payload: {
          id: recipientId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("restore-notice-project"),
          title: "Settled work",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: recipientId },
          forkedFrom: null,
          createdAt: history.now,
          updatedAt: history.now,
          archivedAt: null,
          settledOverride: "settled",
          settledAt: history.now,
          lastVisitedAt: null,
          deletedAt: null,
        },
      } as never);
      yield* apply({
        type: "checkpoint-scope.created",
        payload: {
          id: CheckpointScopeId.make("restore-notice-scope"),
          threadId: recipientId,
          runId,
          nodeId: NodeId.make("restore-notice-node"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: process.cwd(),
          createdAt: history.now,
        },
      } as never);
      yield* apply({
        type: "run.created",
        payload: {
          id: runId,
          threadId: recipientId,
          ordinal: 4,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("restore-notice-message"),
          rootNodeId: NodeId.make("restore-notice-node"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: history.now,
          startedAt: history.now,
          completedAt: history.now,
          checkpointId: null,
          contextHandoffId: null,
        },
      } as never);
      const runItem = yield* positions.normalize(
        {
          id: TurnItemId.make("restore-notice-run-item"),
          type: "file_change",
          threadId: recipientId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: history.now,
          completedAt: history.now,
          updatedAt: history.now,
          fileName: "changed.ts",
        },
        4,
      );
      yield* apply({ type: "turn-item.updated", payload: runItem } as never);

      const notices = history.store.getThreadRecords(recipientId, ["turnItems"]).pipe(
        Effect.map(({ thread, turnItems }) => ({
          thread,
          notices: turnItems.filter((item) => item.id !== runItem.id),
        })),
      );
      yield* history.rollback(5);
      const first = yield* notices;
      assert.equal(first.notices.length, 1);
      assert.isAbove(first.notices[0]!.ordinal, runItem.ordinal);
      assert.isNull(first.notices[0]!.runId);

      yield* history.rollback(2);
      const { thread, notices: second } = yield* notices;
      assert.deepEqual(
        second.map((item) => [item.id, item.type === "system_notice" && item.message]),
        [
          [
            first.notices[0]!.id,
            'Files in this workspace were restored to an earlier checkpoint by another thread: "Rollback history".',
          ],
        ],
      );
      assert.deepEqual(thread.settledAt, history.now);
    }),
  );
});
