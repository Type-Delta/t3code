import {
  CheckpointId,
  CheckpointScopeId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  ProviderThreadId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ServerConfig from "../config.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
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
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { RunFinalizationObserver } from "./RunFinalizationService.ts";

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
      "shared-workspace",
      "background-work-active",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
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
        return SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "background-work-active":
        return "Stop this thread's background work before navigating checkpoints.";
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

/**
 * The message clients see when a rollback fails. Only a held Git index lock,
 * a removed snapshot, and file versions that could not be downloaded get their
 * own explanation; other reasons carry internal ids or raw Git output, so they
 * fall back to the generic message.
 */
export function rollbackFailureClientMessage(error: CheckpointRollbackExecutionError): string {
  if (error.reason === "background-work-active") return error.message;
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

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
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
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
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
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
    }) {
      const context = yield* projections.getCheckpointRollbackContext(input.threadId, input);
      // Forward checkpoints stay ready after a rollback so the user can redo back to them.
      const { providerThread, checkpoint, scope, targetAttempt, runsToRollback } = context;
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        checkpoint.status !== "ready"
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
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
              if (targetTurn === undefined || targetTurn.providerThreadId !== providerThread.id) {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
              };
            });

      const { worktreePath, branch } = context.thread;
      // Recreated only where the server would have made it, as turn start does.
      if (
        worktreePath != null &&
        branch != null &&
        !(yield* fileSystem.exists(worktreePath)) &&
        (yield* isManagedWorktreePath(worktreePath))
      ) {
        const project = yield* projects.get(context.thread.projectId);
        if (Option.isSome(project)) {
          yield* gitWorkflow.pruneWorktrees({ cwd: project.value.workspaceRoot });
          yield* gitWorkflow.createWorktree({
            cwd: project.value.workspaceRoot,
            refName: branch,
            path: worktreePath,
          });
        }
      }

      if (
        input.restoreFiles !== false &&
        !(yield* isCheckpointRestoreIsolated(context.thread, scope, {
          fileSystem,
          projections,
          projects,
          path,
        }))
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "shared-workspace",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      // Evicted file versions are downloaded before the provider conversation
      // changes, so a failed download leaves the thread as it was. They stay
      // pinned until this rollback's scope closes.
      if (input.restoreFiles !== false) {
        yield* checkpoints.prepareRestore({ scope, checkpoint });
      }

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
      const currentOrdinal = providerThread.lastRunOrdinal ?? 0;
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
      if (input.restoreFiles !== false) {
        yield* checkpoints.restore({ scope, checkpoint });
        yield* observer.refresh({ cwd: scope.cwd, threadId: input.threadId }).pipe(
          Effect.catchTags({
            RunFinalizationRefreshError: (cause) =>
              Effect.logWarning("Failed to refresh workspace after checkpoint restore", {
                ...input,
                cause,
              }),
          }),
        );
      }

      // Lock against full-row thread writes that could restore the old native session after rollback.
      yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
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
          yield* eventSink.write({ events });
        }),
      );
    }, Effect.scoped);

    return CheckpointRollbackServiceV2.of({
      // The inner execute owns the rollback span; this wrapper selects the workspace lease.
      execute: Effect.fnUntraced(
        function* (input) {
          // Storage cleanup removes worktrees under the same lease.
          const thread = yield* projections.getThread(input.threadId);
          yield* thread.worktreePath === null
            ? execute(input)
            : withWorkspaceLease(path.resolve(thread.worktreePath), execute(input));
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
