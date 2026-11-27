import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import {
  CheckpointId,
  CheckpointScopeId,
  type CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2AppThread,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ServerConfig from "../config.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  assessCheckpointRestore,
  checkpointRestoreCheckoutRoots,
  repositoryCheckpointsForRestore,
  repositoryRestoreTargets,
  resolveCheckpointRestorePath,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointRestoreError, CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { GIT_INDEX_LOCKED_DETAIL } from "../vcs/VcsProcess.ts";
import {
  CheckpointObjectsUnavailableError,
  CheckpointSnapshotUnavailableError,
} from "../checkpointing/Errors.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyAboveCeilingError, RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { RunFinalizationObserver } from "./RunFinalizationService.ts";
import { TurnItemPositionStoreV2 } from "./TurnItemPositionStore.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "files-restored",
      "shared-workspace",
      "background-work-active",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    /** Why a shared workspace blocks file restore. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return this.detail ?? "File restore is blocked by another thread in this Git checkout.";
      case "background-work-active":
        return "Stop this thread's background work before navigating checkpoints.";
      case "files-restored":
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);
const isCheckpointContentUnavailableError = Schema.is(
  Schema.Union([CheckpointObjectsUnavailableError, CheckpointSnapshotUnavailableError]),
);
const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

/**
 * The message clients see when a rollback fails. Only a held Git index lock,
 * a removed snapshot, and file versions that could not be downloaded get their
 * own explanation; other reasons carry internal ids or raw Git output, so they
 * fall back to the generic message.
 */
export function rollbackFailureClientMessage(error: CheckpointRollbackExecutionError): string {
  if (error.reason === "background-work-active" || error.reason === "shared-workspace")
    return error.message;
  if (isRuntimePolicyAboveCeilingError(error.cause)) return error.cause.message;
  const restoreCause = isCheckpointRestoreError(error.cause) ? error.cause.cause : undefined;
  if (isCheckpointContentUnavailableError(restoreCause)) return restoreCause.message;
  return isVcsProcessExitError(restoreCause) && restoreCause.detail === GIT_INDEX_LOCKED_DETAIL
    ? GIT_INDEX_LOCKED_DETAIL
    : ROLLBACK_FAILED_MESSAGE;
}

/** The checkpoint's files are gone or cannot be downloaded; retrying will not change that. */
export const isCheckpointContentUnavailable = (error: unknown): boolean =>
  isCheckpointRollbackExecutionError(error) &&
  isCheckpointRestoreError(error.cause) &&
  isCheckpointContentUnavailableError(error.cause.cause);

/** A retry would restore files after the user saw the failure, or fail the same way. */
export const isFinalRollbackFailure = (error: unknown): boolean =>
  isCheckpointContentUnavailable(error) ||
  (isCheckpointRollbackExecutionError(error) &&
    (error.reason === "shared-workspace" || error.reason === "files-restored"));

const RESTORE_NOTICE_PREFIX = "workspace-restore:";
const RUN_POSITION_SPAN = 1_000_000;

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
    /** The rewind command: names the request when repositories are reported as left unrestored. */
    readonly requestId?: CommandId;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | VcsDriverRegistry.VcsDriverRegistry
  | GitWorkflowService.GitWorkflowService
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | TaskFolders.TaskFolders
  | ThreadCommandExecutor.ThreadCommandExecutor
  | TurnItemPositionStoreV2
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
    const observer = yield* RunFinalizationObserver;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const taskFolders = yield* TaskFolders.TaskFolders;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const positions = yield* TurnItemPositionStoreV2;
    const restoreDependencies = {
      fileSystem,
      projections,
      projects,
      path,
      vcs,
      otherWorkspacePaths: (thread: Pick<OrchestrationV2AppThread, "worktreePath">) =>
        thread.worktreePath === null
          ? Effect.succeed([])
          : taskFolders
              .find(thread.worktreePath)
              .pipe(
                Effect.map((folder) => folder?.repositories.map((repo) => repo.worktreePath) ?? []),
              ),
    };
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
    const restoreDependenciesFor = Effect.fn("orchestrationV2.restoreDependenciesFor")(function* (
      thread: Pick<OrchestrationV2AppThread, "worktreePath" | "branch">,
    ) {
      const worktreePath = thread.worktreePath;
      return worktreePath !== null &&
        thread.branch !== null &&
        !(yield* fileSystem.exists(path.join(worktreePath, ".git"))) &&
        (yield* isManagedWorktreePath(worktreePath))
        ? { ...restoreDependencies, recreatingWorktreePath: path.resolve(worktreePath) }
        : restoreDependencies;
    });

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (
      input: Parameters<CheckpointRollbackServiceV2Shape["execute"]>[0],
      restoration: { filesRestored: boolean },
      leasedPaths: ReadonlyArray<string>,
    ) {
      const context = yield* projections.getCheckpointRollbackContext(input.threadId, input);
      if (context.thread.deletedAt != null) return;
      const { providerThread, checkpoint, scope, targetAttempt, runsToRollback } = context;
      const restoreFiles = input.restoreFiles !== false;
      const { worktreePath, branch } = context.thread;
      const taskFolder = worktreePath === null ? null : yield* taskFolders.find(worktreePath);
      // A linked project folder is not a repository: it has no snapshot, by design.
      const linkedProjectFolder = taskFolder !== null && !taskFolder.projectIsWorktree;
      const invalidTarget = () =>
        new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        // A repository's checkpoints follow the thread's; they are not a place to rewind to.
        typeof scope.repositoryPath === "string" ||
        checkpoint.scopeId !== scope.id ||
        // Missing or failed snapshots support conversation rewind; missing ones also restoring a
        // task folder's repositories.
        (checkpoint.status !== "ready" &&
          !(checkpoint.status === "error" && !restoreFiles) &&
          !(
            checkpoint.status === "missing" &&
            (!restoreFiles || linkedProjectFolder || worktreePath === null)
          ))
      ) {
        return yield* invalidTarget();
      }
      if (
        providerThread.id !== context.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== context.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      if (
        restoreFiles &&
        checkpoint.status === "missing" &&
        !linkedProjectFolder &&
        (yield* vcs.detect({ cwd: scope.cwd, requestedKind: "git" })) !== null
      ) {
        return yield* invalidTarget();
      }

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      const rollbackTarget: ProviderAdapter.ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0
          ? {
              type: "thread_start",
              checkpointId: checkpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetTurn =
                latestProviderTurnForAttempt(context.providerTurns, targetAttempt?.id) ??
                context.providerTurns.find((turn) => turn.id === targetAttempt?.providerTurnId);
              if (
                targetAttempt === undefined ||
                targetTurn === undefined ||
                targetTurn.providerThreadId !== providerThread.id
              ) {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              const { attempt } = yield* projections.getProviderControlContext(input.threadId, {
                providerThreadId: providerThread.id,
                providerTurnId: targetTurn.id,
                attemptId: targetAttempt.id,
              });
              const message =
                attempt === undefined
                  ? undefined
                  : yield* projections.getRunMessage(input.threadId, attempt.runId);
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
                ...(message === undefined ? {} : { message }),
              };
            });

      const sharedWorkspace = (detail?: string) =>
        new CheckpointRollbackExecutionError({
          reason: "shared-workspace",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          ...(detail === undefined ? {} : { detail }),
        });
      const dependencies = yield* restoreDependenciesFor(context.thread);
      if (
        restoreFiles &&
        worktreePath !== null &&
        !leasedPaths.includes(
          (yield* resolveCheckpointRestorePath(worktreePath, dependencies)).canonical,
        )
      ) {
        return yield* sharedWorkspace();
      }
      if (
        restoreFiles &&
        worktreePath !== null &&
        !(yield* fileSystem.exists(path.join(worktreePath, ".git")))
      ) {
        const safety = yield* assessCheckpointRestore(context.thread, scope, {
          ...dependencies,
          repositoryPaths:
            taskFolder?.repositories.map((repository) => repository.worktreePath) ?? [],
        });
        if (safety.blockedMessage !== null) return yield* sharedWorkspace(safety.blockedMessage);
      }

      if (taskFolder !== null && branch != null) {
        // Cleanup can remove any of the folder's checkouts; the linked project folder has none.
        yield* taskFolders.restore({
          taskFolder,
          branch,
          projectCommands: TaskFolders.projectCommandsForLink(context.thread.linkOrigin),
          recreate: (checkout) =>
            gitWorkflow.pruneWorktrees({ cwd: checkout.repositoryPath }).pipe(
              Effect.andThen(
                gitWorkflow.createWorktree({
                  cwd: checkout.repositoryPath,
                  refName: branch,
                  path: checkout.worktreePath,
                }),
              ),
            ),
        });
      } else if (worktreePath != null && branch != null) {
        // Recreated only where the server would have made it, as turn start does.
        // A failed removal can leave the folder without its checkout; only a file restore replaces it.
        const leftover =
          restoreFiles &&
          (yield* fileSystem.exists(worktreePath)) &&
          !(yield* fileSystem.exists(path.join(worktreePath, ".git")));
        if (
          (leftover || !(yield* fileSystem.exists(worktreePath))) &&
          (yield* isManagedWorktreePath(worktreePath))
        ) {
          const project = yield* projects.get(context.thread.projectId);
          if (Option.isSome(project)) {
            const recreate = gitWorkflow.pruneWorktrees({ cwd: project.value.workspaceRoot }).pipe(
              Effect.andThen(
                gitWorkflow.createWorktree({
                  cwd: project.value.workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                }),
              ),
            );
            if (leftover) {
              // Keep the original folder until the entire rollback succeeds; later failures may need it.
              yield* Effect.acquireRelease(
                Effect.gen(function* () {
                  const aside = yield* fileSystem.makeTempDirectory({
                    directory: path.dirname(worktreePath),
                    prefix: ".t3-replaced-",
                  });
                  yield* fileSystem.rename(worktreePath, path.join(aside, "folder"));
                  return aside;
                }),
                (aside, exit) =>
                  Effect.gen(function* () {
                    if (Exit.isFailure(exit) && restoration.filesRestored) {
                      yield* Effect.logWarning(
                        "Checkpoint files were restored; original worktree files remain available for recovery",
                        {
                          worktreePath,
                          setAside: path.join(aside, "folder"),
                        },
                      );
                      return;
                    }
                    if (Exit.isFailure(exit)) {
                      yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
                      yield* fileSystem.rename(path.join(aside, "folder"), worktreePath);
                    }
                    yield* fileSystem.remove(aside, { recursive: true, force: true });
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Edit from here left a worktree folder set aside", {
                        worktreePath,
                        setAside: path.join(aside, "folder"),
                        cause,
                      }),
                    ),
                  ),
              );
            }
            yield* recreate;
          }
        }
      }

      // Before the provider conversation changes: a rewind with nothing to restore is refused.
      const readable = restoreFiles
        ? yield* checkpoints.repositoryScopesIfReadable({
            rootScope: scope,
            projectId: context.thread.projectId,
            worktreePath,
          })
        : [];
      // Unknown repositories are not "none": the rewind would leave their changes unmentioned.
      if (readable === null) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "unexpected-failure",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          cause: new Error("The thread's repositories could not be read."),
        });
      }
      const repositories = readable;
      const history =
        repositories.length === 0
          ? undefined
          : yield* projections.getCheckpointContext(input.threadId);
      const rolledBackRunIds =
        history?.runs.filter((run) => run.status === "rolled_back").map((run) => run.id) ?? [];
      const rolledBackRuns =
        rolledBackRunIds.length === 0
          ? []
          : (yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: rolledBackRunIds,
            })).runs;
      const recorded = repositoryCheckpointsForRestore(history?.checkpoints ?? [], rolledBackRuns);
      const currentOrdinal = providerThread.lastRunOrdinal ?? 0;
      const repositoryTargets = repositoryRestoreTargets(
        repositories,
        recorded,
        targetOrdinal,
        currentOrdinal,
      );
      // Changed by a discarded run, with no snapshot of how it was before: left as it is.
      const unrestorable = repositories.filter(
        (repository) =>
          !repositoryTargets.some((target) => target.scope.id === repository.id) &&
          recorded.some(
            (candidate) =>
              candidate.scopeId === repository.id &&
              candidate.ordinalWithinScope > targetOrdinal &&
              (candidate.status === "ready" || candidate.runId !== null),
          ),
      );
      if (unrestorable.length > 0) {
        yield* Effect.logWarning("Edit from here cannot restore repositories without a snapshot", {
          threadId: input.threadId,
          repositories: unrestorable.map((repository) => repository.cwd),
        });
      }
      const restoreTargets = [
        ...(checkpoint.status === "ready" ? [{ scope, checkpoint }] : []),
        ...repositoryTargets,
      ];
      if (restoreFiles && restoreTargets.length === 0) return yield* invalidTarget();
      const restoreInput = { targets: restoreTargets, scopes: [scope, ...repositories] };
      const safety = restoreFiles
        ? yield* Effect.gen(function* () {
            const restoreDependencies = {
              ...dependencies,
              repositoryPaths: repositoryTargets.map((target) => target.scope.cwd),
            };
            const roots = yield* checkpointRestoreCheckoutRoots(
              context.thread,
              restoreDependencies,
            );
            if (
              roots.some(
                (root) =>
                  !leasedPaths.some((cwd) => {
                    const relative = path.relative(cwd, root);
                    return (
                      relative === "" ||
                      (!path.isAbsolute(relative) &&
                        relative !== ".." &&
                        !relative.startsWith(`..${path.sep}`))
                    );
                  }),
              )
            )
              return yield* sharedWorkspace();
            return yield* assessCheckpointRestore(context.thread, scope, restoreDependencies);
          })
        : { blockedMessage: null, noticeThreadIds: [] };
      if (safety.blockedMessage !== null) return yield* sharedWorkspace(safety.blockedMessage);
      // Each target stays hydrated until rollback releases its scope.
      if (restoreFiles) yield* checkpoints.prepareRestore(restoreInput);

      const modelSelection = context.thread.modelSelection;
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: context.thread,
        modelSelection,
      });
      const existingSession = context.providerSession;
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId: providerThread.providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        ...(providerThread.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      });

      // Rolled-back turns remain in audit history but no longer exist in the provider
      // conversation, unless the target itself is a rolled-back (forward) checkpoint:
      // then they stay available so the provider can reactivate that redo branch.
      const rolledBackAttemptIds = new Set(context.rolledBackAttemptIds);
      const targetRolledBack =
        targetOrdinal !== 0 &&
        targetAttempt !== undefined &&
        rolledBackAttemptIds.has(targetAttempt.id);
      const providerThreadTurns = context.providerTurns.filter(
        (turn) =>
          turn.providerThreadId === providerThread.id &&
          (targetRolledBack ||
            turn.runAttemptId === null ||
            !rolledBackAttemptIds.has(turn.runAttemptId)),
      );
      const nativeSource = checkpoint.nativeThreadRef ?? providerThread.nativeThreadRef;
      const nativeBaselineRef =
        checkpoint.nativeBaselineRef !== undefined
          ? checkpoint.nativeBaselineRef
          : providerThread.nativeMetadata?.forkHeadMessageId === undefined
            ? null
            : {
                driver: providerThread.driver,
                nativeId: providerThread.nativeMetadata.forkHeadMessageId,
                strength: "strong" as const,
              };
      const preserveNativeSource =
        (providerThread.driver === "codex" || providerThread.driver === "claudeAgent") &&
        nativeSource?.driver === providerThread.driver &&
        nativeSource?.strength === "strong";
      const historicalSources =
        preserveNativeSource && checkpoint.nativeThreadRef === undefined
          ? (yield* projections.getThreadRecords(input.threadId, [
              "checkpoints",
            ])).checkpoints.filter(
              (candidate) =>
                candidate.scopeId === scope.id && candidate.nativeThreadRef === undefined,
            )
          : [];
      if (preserveNativeSource && (runsToRollback.length > 0 || currentOrdinal !== targetOrdinal)) {
        if (
          yield* (
            session.hasPendingBackgroundWorkForThread?.(providerThread) ?? Effect.succeed(false)
          )
        ) {
          return yield* new CheckpointRollbackExecutionError({
            reason: "background-work-active",
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            checkpointId: input.checkpointId,
          });
        }
        if (providerThread.driver === "claudeAgent" && session.unloadThread !== undefined) {
          yield* session.unloadThread({ providerThread });
        }
      }
      const snapshot =
        runsToRollback.length === 0 && currentOrdinal === targetOrdinal
          ? { providerThread }
          : preserveNativeSource
            ? yield* Effect.gen(function* () {
                // Forking retains the complete source for redo; native revert truncates it.
                const forked =
                  rollbackTarget.type === "thread_start" &&
                  providerThread.driver === "claudeAgent" &&
                  nativeBaselineRef === null
                    ? yield* session.ensureThread({
                        threadId: input.threadId,
                        modelSelection,
                        runtimePolicy: resolvedRuntimePolicy,
                      })
                    : yield* session.forkThread({
                        sourceProviderThread:
                          rollbackTarget.type === "thread_start" &&
                          providerThread.driver === "codex"
                            ? providerThread
                            : { ...providerThread, nativeThreadRef: nativeSource },
                        sourceProviderTurns: context.providerTurns,
                        ...(rollbackTarget.type === "provider_turn"
                          ? { providerTurnId: rollbackTarget.providerTurn.id }
                          : nativeBaselineRef === null || providerThread.driver !== "claudeAgent"
                            ? {}
                            : { nativeBoundaryRef: nativeBaselineRef }),
                        targetThreadId: input.threadId,
                        ...(providerThread.ownerNodeId === null
                          ? {}
                          : { ownerNodeId: providerThread.ownerNodeId }),
                        modelSelection,
                        runtimePolicy: resolvedRuntimePolicy,
                      });
                const navigated =
                  rollbackTarget.type === "thread_start" && providerThread.driver === "codex"
                    ? (yield* session.rollbackThread({
                        providerThread: {
                          ...providerThread,
                          nativeThreadRef: forked.nativeThreadRef,
                        },
                        target: rollbackTarget,
                        providerThreadTurns,
                      })).providerThread
                    : forked;
                const forkHead = navigated.nativeMetadata?.forkHeadMessageId;
                return {
                  providerThread: {
                    ...providerThread,
                    nativeThreadRef: navigated.nativeThreadRef,
                    nativeConversationHeadRef:
                      navigated.nativeConversationHeadRef ??
                      (providerThread.driver === "claudeAgent" && forkHead !== undefined
                        ? {
                            driver: providerThread.driver,
                            nativeId: forkHead,
                            strength: "weak" as const,
                          }
                        : null),
                    nativeMetadata: {
                      ...providerThread.nativeMetadata,
                      forkHeadMessageId: undefined,
                      ...navigated.nativeMetadata,
                    },
                    pendingBackgroundTasks: [],
                    contextUsage: navigated.contextUsage,
                    status: "idle" as const,
                  },
                };
              })
            : yield* session.rollbackThread({
                providerThread,
                target: rollbackTarget,
                providerThreadTurns,
              });

      // Lock against full-row thread writes that could restore the old native session after rollback.
      yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* projections.getThread(input.threadId);
          if (current.deletedAt != null) return;
          if (
            current.activeProviderThreadId !== providerThread.id ||
            current.modelSelection.instanceId !== providerThread.providerInstanceId
          ) {
            return yield* new CheckpointRollbackExecutionError({
              reason: "active-provider-changed",
              threadId: input.threadId,
              providerThreadId: input.providerThreadId,
              checkpointId: input.checkpointId,
            });
          }
          const now = yield* DateTime.now;
          const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
            Effect.map(
              ids.allocate.event({ threadId: event.threadId }),
              (id) =>
                ({
                  ...event,
                  id,
                }) as Event,
            );
          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const historical of historicalSources) {
            events.push(
              yield* makeEvent({
                type: "checkpoint.captured",
                threadId: input.threadId,
                occurredAt: now,
                payload: {
                  ...historical,
                  nativeThreadRef: nativeSource,
                  ...(historical.ordinalWithinScope === 0 ? { nativeBaselineRef } : {}),
                },
              }),
            );
          }
          // First, so a client that sees the runs rolled back already knows what was left.
          if (input.requestId !== undefined && unrestorable.length > 0) {
            const thread = current;
            events.push(
              yield* makeEvent({
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...thread,
                  rollbackUnrestored: {
                    requestId: input.requestId,
                    repositories: unrestorable.map(
                      (repository) => repository.label ?? path.basename(repository.cwd),
                    ),
                  },
                  updatedAt: now,
                },
              }),
            );
          }
          events.push(
            yield* makeEvent({
              type: "provider-thread.updated",
              threadId: input.threadId,
              driver: providerThread.driver,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: now,
              payload: {
                ...snapshot.providerThread,
                lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
                updatedAt: now,
              },
            }),
          );
          for (const run of runsToRollback) {
            const rootNode = context.rootNodes.find((candidate) => candidate.id === run.rootNodeId);
            events.push(
              yield* makeEvent({
                type: "run.updated",
                threadId: input.threadId,
                runId: run.id,
                ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...run,
                  checkpointRollbackState: { status: run.status, completedAt: run.completedAt },
                  status: "rolled_back",
                  completedAt: now,
                },
              }),
            );
            if (rootNode !== undefined) {
              events.push(
                yield* makeEvent({
                  type: "node.updated",
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    ...rootNode,
                    checkpointRollbackState: {
                      status: rootNode.status,
                      completedAt: rootNode.completedAt,
                    },
                    status: "rolled_back",
                    completedAt: now,
                  },
                }),
              );
            }
          }
          for (const run of context.runsToRestore ?? []) {
            const rootNode = context.rootNodes.find((candidate) => candidate.id === run.rootNodeId);
            const terminal = latestProviderTurnForAttempt(
              context.providerTurns,
              run.activeAttemptId ?? undefined,
            );
            const legacyStatus =
              terminal?.status === "failed" ||
              terminal?.status === "interrupted" ||
              terminal?.status === "cancelled"
                ? terminal.status
                : "completed";
            const { checkpointRollbackState, ...restoredRun } = run;
            events.push(
              yield* makeEvent({
                type: "run.updated",
                historyRestoration: true,
                threadId: input.threadId,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...restoredRun,
                  status: checkpointRollbackState?.status ?? legacyStatus,
                  completedAt:
                    checkpointRollbackState === undefined
                      ? (terminal?.completedAt ?? run.completedAt)
                      : checkpointRollbackState.completedAt,
                },
              }),
            );
            if (rootNode !== undefined) {
              const { checkpointRollbackState: nodeState, ...restoredNode } = rootNode;
              events.push(
                yield* makeEvent({
                  type: "node.updated",
                  historyRestoration: true,
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    ...restoredNode,
                    status: nodeState?.status ?? legacyStatus,
                    completedAt:
                      nodeState === undefined
                        ? (terminal?.completedAt ?? rootNode.completedAt)
                        : nodeState.completedAt,
                  },
                }),
              );
            }
          }
          for (const recipientId of safety.noticeThreadIds) {
            const recipient = yield* projections.getThread(recipientId).pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
              }),
            );
            if (recipient === null || recipient.deletedAt !== null) continue;
            const latestOrdinal = (yield* projections.getNextTurnItemOrdinal(recipientId)) - 1;
            const { turnItems: notices } = yield* projections.getThreadRecords(
              recipientId,
              ["turnItems"],
              { turnItemTypes: ["system_notice"] },
            );
            // Repeated restores refresh the latest notice instead of stacking copies.
            const latest = notices.find(
              (item) => item.ordinal === latestOrdinal && item.id.startsWith(RESTORE_NOTICE_PREFIX),
            );
            const eventId = yield* ids.allocate.event({ threadId: recipientId });
            const id = latest?.id ?? TurnItemId.make(`${RESTORE_NOTICE_PREFIX}${eventId}`);
            // Runless items otherwise sort before every run; append after the latest item instead.
            const ordinal =
              latest?.ordinal ??
              (yield* positions.allocate({
                threadId: recipientId,
                turnItemId: id,
                runId: null,
                runOrdinal: Math.floor(Math.max(latestOrdinal, 0) / RUN_POSITION_SPAN),
              }));
            events.push({
              id: eventId,
              type: "turn-item.updated",
              threadId: recipientId,
              occurredAt: now,
              payload: {
                id,
                type: "system_notice",
                threadId: recipientId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                message: `Files in this workspace were restored to an earlier checkpoint by another thread: "${context.thread.title}".`,
              },
            });
          }
          if (input.restoreFiles !== false) {
            yield* checkpoints.restore(restoreInput);
            restoration.filesRestored = true;
            yield* Effect.forEach(
              new Set([scope.cwd, ...restoreTargets.map((target) => target.scope.cwd)]),
              (cwd) =>
                observer
                  .refresh({
                    cwd,
                    threadId: input.threadId,
                    ...(cwd === scope.cwd && checkpoint.status !== "ready" ? { vcs: false } : {}),
                  })
                  .pipe(
                    Effect.catchTags({
                      RunFinalizationRefreshError: (cause) =>
                        Effect.logWarning("Failed to refresh workspace after checkpoint restore", {
                          ...input,
                          cause,
                        }),
                    }),
                  ),
              { discard: true },
            );
          }
          yield* eventSink.write({ events });
        }),
      );
    }, Effect.scoped);

    return CheckpointRollbackServiceV2.of({
      // The inner execute owns the rollback span; this wrapper selects the workspace lease.
      execute: Effect.fnUntraced(
        function* (input) {
          const restoration = { filesRestored: false };
          // Storage cleanup removes worktrees under the same lease. A file restore also excludes
          // turn starts and Git mutations anywhere in or above its checkout.
          const { thread, scope } = yield* projections.getCheckpointRollbackContext(
            input.threadId,
            input,
          );
          if (thread.deletedAt != null) return;
          const worktree = thread.worktreePath == null ? [] : [path.resolve(thread.worktreePath)];
          const restoreFiles = input.restoreFiles !== false;
          const taskFolder =
            worktree[0] === undefined ? null : yield* taskFolders.find(worktree[0]);
          const repositories =
            !restoreFiles || scope === undefined
              ? []
              : yield* checkpoints.repositoryScopesIfReadable({ rootScope: scope, ...thread });
          const repositoryPaths = [
            ...(repositories ?? []).map((repository) => repository.cwd),
            ...(taskFolder?.repositories.map((repository) => repository.worktreePath) ?? []),
          ];
          const checkoutRoots = restoreFiles
            ? yield* checkpointRestoreCheckoutRoots(thread, {
                ...(yield* restoreDependenciesFor(thread)),
                repositoryPaths,
              })
            : [];
          const workspacePaths = yield* Effect.forEach(
            [...new Set([...worktree, ...repositoryPaths])],
            (cwd) => resolveCheckpointRestorePath(cwd, restoreDependencies),
          );
          const leased = [
            ...new Set([...checkoutRoots, ...workspacePaths.map((entry) => entry.canonical)]),
          ];
          yield* (
            leased.length === 0
              ? execute(input, restoration, leased)
              : withWorkspaceLease(
                  leased,
                  execute(input, restoration, leased),
                  restoreFiles ? "checkout" : "exclusive",
                )
          ).pipe(
            Effect.catchCause((cause) =>
              restoration.filesRestored
                ? Effect.fail(
                    new CheckpointRollbackExecutionError({
                      reason: "files-restored",
                      threadId: input.threadId,
                      providerThreadId: input.providerThreadId,
                      checkpointId: input.checkpointId,
                      cause,
                    }),
                  )
                : Effect.failCause(cause),
            ),
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isCheckpointRollbackExecutionError(cause)
                ? cause
                : new CheckpointRollbackExecutionError({
                    reason: "unexpected-failure",
                    threadId: input.threadId,
                    providerThreadId: input.providerThreadId,
                    checkpointId: input.checkpointId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
