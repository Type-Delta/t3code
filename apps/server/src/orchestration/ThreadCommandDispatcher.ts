import {
  CommandId,
  EventId,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function setupScriptFailureDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError": {
      const cause = error.cause;
      return typeof cause === "object" &&
        cause !== null &&
        "message" in cause &&
        typeof cause.message === "string"
        ? cause.message
        : String(cause);
    }
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
  }
}

const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
  isOrchestrationDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });

export class ThreadCommandDispatcher extends Context.Service<
  ThreadCommandDispatcher,
  {
    readonly dispatch: (
      command: OrchestrationCommand,
      options?: { readonly origin?: OrchestrationClientOrigin },
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration/ThreadCommandDispatcher") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

  const dispatch: ThreadCommandDispatcher["Service"]["dispatch"] = Effect.fn(
    "ThreadCommandDispatcher.dispatch",
  )(function* (command, options) {
    const clientOrigin = options?.origin ?? {};
    const hasClientOrigin =
      clientOrigin.surface !== undefined || clientOrigin.appVersion !== undefined;
    const dispatchFromClient: OrchestrationEngine.OrchestrationEngineShape["dispatch"] = (
      command,
    ) =>
      orchestrationEngine.dispatch(command, hasClientOrigin ? { origin: clientOrigin } : undefined);
    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
      ),
    );
    const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
    const serverCommandId = (tag: string) =>
      randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
    const appendSetupScriptActivity = (input: {
      readonly threadId: ThreadId;
      readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
      readonly summary: string;
      readonly createdAt: string;
      readonly payload: Record<string, unknown>;
      readonly tone: "info" | "error";
    }) =>
      Effect.all({
        commandId: serverCommandId("setup-script-activity"),
        activityId: serverEventId,
      }).pipe(
        Effect.flatMap(({ commandId, activityId }) =>
          dispatchFromClient({
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: activityId,
              tone: input.tone,
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          }),
        ),
      );
    const refreshGitStatus = (cwd: string) =>
      vcsStatusBroadcaster
        .refreshStatus(cwd)
        .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);
    const dispatchBootstrapTurnStart = (
      command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
      Effect.gen(function* () {
        const bootstrap = command.bootstrap;
        const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
        let createdThread = false;
        let createdWorktreePath: string | null = null;
        let createdWorktreeBranch: string | null = null;
        let startedSetupTerminalId: string | null = null;
        let targetProjectId = bootstrap?.createThread?.projectId;
        let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
        let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

        const cleanupCreatedThread = () =>
          createdThread
            ? serverCommandId("bootstrap-thread-delete").pipe(
                Effect.flatMap((commandId) =>
                  dispatchFromClient({
                    type: "thread.delete",
                    commandId,
                    threadId: command.threadId,
                  }),
                ),
                Effect.as(true),
              )
            : Effect.succeed(true);

        const cleanupStartedSetupTerminal = () =>
          startedSetupTerminalId !== null
            ? terminalManager
                .close({
                  threadId: command.threadId,
                  terminalId: startedSetupTerminalId,
                  deleteHistory: true,
                })
                .pipe(Effect.as(true))
            : Effect.succeed(true);

        const cleanupCreatedWorktree = () =>
          targetProjectCwd !== undefined && createdWorktreePath !== null
            ? gitWorkflow
                .removeWorktree({
                  cwd: targetProjectCwd,
                  path: createdWorktreePath,
                  force: true,
                })
                .pipe(Effect.as(true))
            : Effect.succeed(true);

        const cleanupCreatedWorktreeBranch = () =>
          targetProjectCwd !== undefined && createdWorktreeBranch !== null
            ? gitWorkflow
                .deleteRef({
                  cwd: targetProjectCwd,
                  refName: createdWorktreeBranch,
                  force: true,
                })
                .pipe(Effect.as(true))
            : Effect.succeed(false);

        const attemptCleanup = <A, E>(
          name: string,
          effect: Effect.Effect<A, E>,
        ): Effect.Effect<A | false> =>
          effect.pipe(
            Effect.catchCause((cleanupCause) =>
              Effect.logWarning(`bootstrap ${name} cleanup failed`, {
                threadId: command.threadId,
                detail: Cause.pretty(cleanupCause),
              }).pipe(Effect.as(false as const)),
            ),
          );

        const cleanupBootstrap = () =>
          Effect.gen(function* () {
            const terminalClosed = yield* attemptCleanup(
              "setup terminal",
              cleanupStartedSetupTerminal(),
            );
            const threadDeleted = yield* attemptCleanup("thread", cleanupCreatedThread());
            const worktreeRemoved =
              terminalClosed && threadDeleted
                ? yield* attemptCleanup("worktree", cleanupCreatedWorktree())
                : false;
            if (worktreeRemoved) {
              yield* attemptCleanup("worktree branch", cleanupCreatedWorktreeBranch());
            }
            return createdThread && threadDeleted;
          });

        const recordSetupScriptLaunchFailure = (input: {
          readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
          readonly requestedAt: string;
          readonly worktreePath: string;
        }) => {
          const detail = setupScriptFailureDetail(input.error);
          return appendSetupScriptActivity({
            threadId: command.threadId,
            kind: "setup-script.failed",
            summary: "Setup script failed to start",
            createdAt: input.requestedAt,
            payload: {
              detail,
              worktreePath: input.worktreePath,
            },
            tone: "error",
          }).pipe(
            Effect.ignoreCause({ log: false }),
            Effect.flatMap(() =>
              Effect.logWarning("bootstrap turn start failed to launch setup script", {
                threadId: command.threadId,
                worktreePath: input.worktreePath,
                detail,
              }),
            ),
          );
        };

        const recordSetupScriptStarted = (input: {
          readonly requestedAt: string;
          readonly worktreePath: string;
          readonly scriptId: string;
          readonly scriptName: string;
          readonly terminalId: string;
        }) =>
          Effect.gen(function* () {
            const startedAt = yield* nowIso;
            const payload = {
              scriptId: input.scriptId,
              scriptName: input.scriptName,
              terminalId: input.terminalId,
              worktreePath: input.worktreePath,
            };
            yield* Effect.all([
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              }),
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: startedAt,
                payload,
                tone: "info",
              }),
            ]).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(
                  "bootstrap turn start launched setup script but failed to record setup activity",
                  {
                    threadId: command.threadId,
                    worktreePath: input.worktreePath,
                    scriptId: input.scriptId,
                    terminalId: input.terminalId,
                    detail: error.message,
                  },
                ),
              ),
            );
          });

        const runSetupProgram = () =>
          Effect.gen(function* () {
            if (!bootstrap?.runSetupScript || !targetWorktreePath) {
              return;
            }
            const worktreePath = targetWorktreePath;
            const requestedAt = yield* nowIso;
            yield* projectSetupScriptRunner
              .runForThread({
                threadId: command.threadId,
                ...(targetProjectId ? { projectId: targetProjectId } : {}),
                ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                worktreePath,
              })
              .pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    recordSetupScriptLaunchFailure({
                      error,
                      requestedAt,
                      worktreePath,
                    }),
                  onSuccess: (setupResult) => {
                    if (setupResult.status !== "started") {
                      return Effect.void;
                    }
                    startedSetupTerminalId = setupResult.terminalId;
                    return recordSetupScriptStarted({
                      requestedAt,
                      worktreePath,
                      scriptId: setupResult.scriptId,
                      scriptName: setupResult.scriptName,
                      terminalId: setupResult.terminalId,
                    });
                  },
                }),
              );
          });

        const bootstrapProgram = Effect.gen(function* () {
          if (bootstrap?.createThread) {
            const created = yield* dispatchFromClient({
              type: "thread.create",
              commandId: yield* serverCommandId("bootstrap-thread-create"),
              threadId: command.threadId,
              projectId: bootstrap.createThread.projectId,
              title: bootstrap.createThread.title,
              modelSelection: bootstrap.createThread.modelSelection,
              runtimeMode: bootstrap.createThread.runtimeMode,
              interactionMode: bootstrap.createThread.interactionMode,
              branch: bootstrap.createThread.branch,
              worktreePath: bootstrap.createThread.worktreePath,
              createdAt: bootstrap.createThread.createdAt,
            });
            // The create event fences every deletion from the prior incarnation.
            // Wait for that cleanup before setup scripts or the provider can own
            // resources under the reused thread id.
            yield* threadDeletionReactor.drainThrough(created.sequence);
            createdThread = true;
          }

          if (bootstrap?.prepareWorktree) {
            let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
            // Repositories without an origin remote use their local base ref.
            const startFromOrigin =
              bootstrap.prepareWorktree.startFromOrigin === true &&
              (yield* gitWorkflow.remoteExists({
                cwd: bootstrap.prepareWorktree.projectCwd,
                remoteName: "origin",
              }));
            if (startFromOrigin) {
              yield* gitWorkflow.fetchRemote({
                cwd: bootstrap.prepareWorktree.projectCwd,
                remoteName: "origin",
              });
              const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: bootstrap.prepareWorktree.baseBranch,
                fallbackRemoteName: "origin",
              });
              worktreeBaseRef = resolvedRemoteBase.commitSha;
            }
            const worktree = yield* gitWorkflow.createWorktree({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: worktreeBaseRef,
              newRefName: bootstrap.prepareWorktree.branch,
              baseRefName: bootstrap.prepareWorktree.baseBranch,
              path: null,
            });
            targetWorktreePath = worktree.worktree.path;
            createdWorktreePath = targetWorktreePath;
            createdWorktreeBranch =
              worktree.worktree.refName === bootstrap.prepareWorktree.branch &&
              isTemporaryWorktreeBranch(worktree.worktree.refName)
                ? worktree.worktree.refName
                : null;
            yield* dispatchFromClient({
              type: "thread.meta.update",
              commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
              threadId: command.threadId,
              branch: worktree.worktree.refName,
              worktreePath: targetWorktreePath,
            });
            yield* refreshGitStatus(targetWorktreePath);
          }

          yield* runSetupProgram();

          return yield* dispatchFromClient(finalTurnStartCommand);
        });

        return yield* bootstrapProgram.pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            const dispatchError = isOrchestrationDispatchCommandError(error)
              ? error
              : new OrchestrationDispatchCommandError({
                  message:
                    error instanceof Error
                      ? error.message
                      : "Failed to bootstrap thread turn start.",
                  cause,
                });
            return Effect.uninterruptible(cleanupBootstrap()).pipe(
              Effect.flatMap((threadDeleted) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.fail(
                      threadDeleted
                        ? new OrchestrationDispatchCommandError({
                            message: dispatchError.message,
                            ...(dispatchError.cause !== undefined
                              ? { cause: dispatchError.cause }
                              : {}),
                            bootstrapThreadDisposition: "deleted",
                          })
                        : dispatchError,
                    ),
              ),
            );
          }),
        );
      });

    const dispatchEffect =
      command.type === "thread.turn.start" && command.bootstrap
        ? dispatchBootstrapTurnStart(command)
        : dispatchFromClient(command).pipe(
            Effect.tap(({ sequence }) =>
              command.type === "thread.create"
                ? threadDeletionReactor.drainThrough(sequence)
                : Effect.void,
            ),
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );

    return yield* startup
      .enqueueCommand(dispatchEffect)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );
  });

  return ThreadCommandDispatcher.of({ dispatch });
});

export const ThreadCommandDispatcherLive = Layer.effect(ThreadCommandDispatcher, make);
