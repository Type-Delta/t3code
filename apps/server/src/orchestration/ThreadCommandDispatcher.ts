import {
  CommandId,
  EventId,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
  type ProjectId,
  type WorktreeSetupSnapshot,
  WORKTREE_SETUP_ACTIVITY_KIND,
  worktreeSetupActivityId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
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
  const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const resolveBootstrapWorktreeSubmodules = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | null;
  }) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings) return null;
    const projectId =
      input.projectId ??
      (yield* projectionSnapshotQuery.getThreadShellById(input.threadId).pipe(
        Effect.map((thread) => Option.getOrNull(thread)?.projectId ?? null),
        Effect.orElseSucceed(() => null),
      ));
    const project =
      projectId === null
        ? null
        : yield* projectionSnapshotQuery.getProjectShellById(projectId).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          );
    return resolveProjectSettings(settings, projectId, project).settings.worktreeSubmodules;
  });

  const dispatch: ThreadCommandDispatcher["Service"]["dispatch"] = Effect.fn(
    "ThreadCommandDispatcher.dispatch",
  )(function* (command, options) {
    const clientOrigin = options?.origin ?? {};
    const hasClientOrigin =
      clientOrigin.surface !== undefined ||
      clientOrigin.appVersion !== undefined ||
      clientOrigin.managementKey !== undefined;
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
    const recordWorktreeSetup = (snapshot: WorktreeSetupSnapshot) =>
      serverCommandId("worktree-setup-activity").pipe(
        Effect.flatMap((commandId) =>
          dispatchFromClient({
            type: "thread.activity.append",
            commandId,
            threadId: snapshot.threadId,
            activity: {
              id: EventId.make(worktreeSetupActivityId(snapshot.threadId)),
              tone:
                snapshot.phase === "failed" ||
                snapshot.stages.some((stage) => stage.status === "failed")
                  ? "error"
                  : "info",
              kind: WORKTREE_SETUP_ACTIVITY_KIND,
              summary:
                snapshot.phase === "running"
                  ? "Setting up worktree"
                  : snapshot.phase === "done"
                    ? "Worktree ready"
                    : snapshot.phase === "cancelled"
                      ? "Worktree setup cancelled"
                      : "Worktree setup failed",
              payload: snapshot,
              turnId: null,
              createdAt: snapshot.startedAt,
            },
            createdAt: snapshot.endedAt ?? snapshot.startedAt,
          }),
        ),
        Effect.ignoreCause({ log: true }),
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

        let preparingSessionSet = false;
        const markPreparingSessionFailed = (detail: string) =>
          Effect.gen(function* () {
            const failedAt = yield* nowIso;
            yield* dispatchFromClient({
              type: "thread.session.set",
              commandId: yield* serverCommandId("bootstrap-thread-preparing-failed"),
              threadId,
              session: {
                threadId,
                status: "error",
                providerName: null,
                providerInstanceId:
                  bootstrap?.createThread?.modelSelection.instanceId ??
                  command.modelSelection?.instanceId,
                runtimeMode: command.runtimeMode,
                activeTurnId: null,
                lastError: detail.trim().length > 0 ? detail : "Worktree setup failed.",
                updatedAt: failedAt,
              },
              createdAt: failedAt,
            });
          });
        let handoffStarted = false;
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

        const tracked = bootstrap?.prepareWorktree !== undefined;
        const threadId = command.threadId;
        const track = (effect: Effect.Effect<void>) => (tracked ? effect : Effect.void);

        const runSetupProgram = () =>
          Effect.gen(function* () {
            if (!bootstrap?.runSetupScript || !targetWorktreePath) {
              yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "skipped"));
              return null;
            }
            const worktreePath = targetWorktreePath;
            const requestedAt = yield* nowIso;
            yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "running"));
            const setupResult = yield* projectSetupScriptRunner
              .runForThread({
                threadId,
                ...(targetProjectId ? { projectId: targetProjectId } : {}),
                ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                worktreePath,
                ...(tracked
                  ? {
                      observeCompletion: {
                        onOutputLine: (line) =>
                          worktreeSetupTracker.appendTail(threadId, "setup-script", line),
                      },
                    }
                  : {}),
              })
              .pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    recordSetupScriptLaunchFailure({
                      error,
                      requestedAt,
                      worktreePath,
                    }).pipe(
                      Effect.andThen(
                        track(
                          worktreeSetupTracker.stageStatus(
                            threadId,
                            "setup-script",
                            "failed",
                            "failed to start",
                          ),
                        ),
                      ),
                      Effect.as(null),
                    ),
                  onSuccess: (setupResult) => {
                    if (setupResult.status !== "started") {
                      return track(
                        worktreeSetupTracker.stageStatus(
                          threadId,
                          "setup-script",
                          "skipped",
                          "no setup script",
                        ),
                      ).pipe(Effect.as(null));
                    }
                    startedSetupTerminalId = setupResult.terminalId;
                    return recordSetupScriptStarted({
                      requestedAt,
                      worktreePath,
                      scriptId: setupResult.scriptId,
                      scriptName: setupResult.scriptName,
                      terminalId: setupResult.terminalId,
                    }).pipe(
                      Effect.andThen(
                        track(
                          worktreeSetupTracker.update(threadId, (snapshot) => ({
                            ...snapshot,
                            setupScript: {
                              name: setupResult.scriptName,
                              command: setupResult.scriptCommand,
                              terminalId: setupResult.terminalId,
                            },
                          })),
                        ),
                      ),
                      Effect.as(setupResult),
                    );
                  },
                }),
              );
            if (!tracked || !setupResult?.completion) {
              return null;
            }
            // The setup script is best effort, like the untracked path: a
            // failed install must not throw away the worktree the user just
            // waited for. The card keeps the failed stage and its terminal.
            // Forked right away so the terminal listener behind `completion`
            // is always consumed, even when the turn dispatch fails before
            // anyone would otherwise wait on it. The tracker update is a
            // no-op once the snapshot has been dropped.
            const completionFiber = yield* setupResult.completion.pipe(
              Effect.flatMap((completion) => {
                if (completion.exitCode === 0) {
                  return worktreeSetupTracker.stageStatus(threadId, "setup-script", "done");
                }
                const detail =
                  completion.exitCode === null
                    ? "terminal closed before the script finished"
                    : `exit ${completion.exitCode}`;
                return worktreeSetupTracker.stageStatus(threadId, "setup-script", "failed", detail);
              }),
              Effect.forkDetach,
            );
            if (!setupResult.async) {
              yield* Fiber.join(completionFiber);
              return null;
            }
            return completionFiber;
          });

        const bootstrapProgram = Effect.gen(function* () {
          const prepareWorktree = bootstrap?.prepareWorktree;
          let shouldPrepareWorktree = prepareWorktree
            ? yield* gitWorkflow.isRepository(prepareWorktree.projectCwd)
            : false;
          let worktreeBaseRef = prepareWorktree?.baseBranch ?? null;

          if (prepareWorktree && shouldPrepareWorktree) {
            // "Start from origin" is a stored default; repos without the
            // requested remote branch fall back to the local base branch.
            const startFromOrigin =
              prepareWorktree.startFromOrigin === true &&
              (yield* gitWorkflow.remoteExists({
                cwd: prepareWorktree.projectCwd,
                remoteName: "origin",
              }));
            if (startFromOrigin) {
              yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "running"));
              yield* gitWorkflow.fetchRemote({
                cwd: prepareWorktree.projectCwd,
                remoteName: "origin",
                refName: prepareWorktree.baseBranch,
              });
              const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
                cwd: prepareWorktree.projectCwd,
                refName: prepareWorktree.baseBranch,
                remoteName: "origin",
              });
              if (remoteBaseExists) {
                const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                  cwd: prepareWorktree.projectCwd,
                  refName: prepareWorktree.baseBranch,
                  fallbackRemoteName: "origin",
                });
                worktreeBaseRef = resolvedRemoteBase.commitSha;
                yield* track(
                  worktreeSetupTracker.stageStatus(
                    threadId,
                    "fetch",
                    "done",
                    `origin/${prepareWorktree.baseBranch} at ${resolvedRemoteBase.commitSha.slice(0, 7)}`,
                  ),
                );
              } else {
                yield* track(
                  worktreeSetupTracker.stageStatus(
                    threadId,
                    "fetch",
                    "warning",
                    `origin/${prepareWorktree.baseBranch} not found, using local branch`,
                  ),
                );
              }
            } else {
              yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "skipped"));
            }

            const resolvedWorktreeBaseRef = worktreeBaseRef ?? prepareWorktree.baseBranch;
            shouldPrepareWorktree = yield* gitWorkflow.hasCommit({
              cwd: prepareWorktree.projectCwd,
              refName: resolvedWorktreeBaseRef,
            });
            worktreeBaseRef = resolvedWorktreeBaseRef;
            yield* track(
              worktreeSetupTracker.update(threadId, (snapshot) => ({
                ...snapshot,
                baseRef: resolvedWorktreeBaseRef,
              })),
            );
          }

          if (prepareWorktree && !shouldPrepareWorktree) {
            if (prepareWorktree.requireWorktree) {
              return yield* new OrchestrationDispatchCommandError({
                message:
                  "A separate worktree requires a Git repository and a base branch with a commit.",
              });
            }
            // Not a git repo, or the base has no commit: the thread runs in
            // the project checkout instead. The card says so and moves on.
            yield* track(
              worktreeSetupTracker.update(threadId, (snapshot) => ({
                ...snapshot,
                stages: snapshot.stages.map((stage) =>
                  stage.id === "fetch" || stage.id === "checkout" || stage.id === "submodules"
                    ? { ...stage, status: "skipped", detail: "using project checkout" }
                    : stage,
                ),
              })),
            );
          }

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
            // The successful create is a fence in the engine command queue:
            // every delete for the prior incarnation committed before it.
            // Drain through that event before setup or turn start can own
            // terminals and provider sessions under the reused thread id.
            createdThread = true;
            yield* threadDeletionReactor.drainThrough(created.sequence);
            // Persist the send now rather than with the turn: the thread is
            // real from here on, so any client (or a reload) sees the message
            // while the worktree is still being prepared. The turn start
            // later references this id instead of re-sending the text.
            yield* dispatchFromClient({
              type: "thread.message.user.append",
              commandId: yield* serverCommandId("bootstrap-thread-message"),
              threadId: command.threadId,
              message: {
                messageId: command.message.messageId,
                text: command.message.text,
                attachments: command.message.attachments,
                ...(command.message.context !== undefined
                  ? { context: command.message.context }
                  : {}),
              },
              createdAt: command.createdAt,
            });
            if (tracked) {
              const running = yield* worktreeSetupTracker.get(threadId);
              if (running) yield* recordWorktreeSetup(running);
            }
          }

          if (prepareWorktree && shouldPrepareWorktree && worktreeBaseRef) {
            if (bootstrap?.createThread && createdThread) {
              // The checkout and setup script can run for minutes before the
              // turn starts, and the created thread carries no message or
              // turn until then. Project a starting session now so every
              // client lists the thread as working and a reopened thread
              // knows to follow the setup stream. A failed or cancelled setup
              // deletes the thread, so nothing lingers.
              const preparingAt = yield* nowIso;
              yield* dispatchFromClient({
                type: "thread.session.set",
                commandId: yield* serverCommandId("bootstrap-thread-preparing"),
                threadId,
                session: {
                  threadId,
                  status: "starting",
                  providerName: null,
                  providerInstanceId: bootstrap.createThread.modelSelection.instanceId,
                  runtimeMode: command.runtimeMode,
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: preparingAt,
                },
                createdAt: preparingAt,
              });
              preparingSessionSet = true;
            }
            yield* worktreeSetupTracker.stageStatus(threadId, "checkout", "running");
            let checkoutTotal: number | null = null;
            const submodules = yield* resolveBootstrapWorktreeSubmodules({
              threadId,
              projectId: targetProjectId ?? null,
            });
            const worktree = yield* gitWorkflow.createWorktree(
              {
                cwd: prepareWorktree.projectCwd,
                refName: worktreeBaseRef,
                newRefName: prepareWorktree.branch,
                baseRefName: prepareWorktree.baseBranch,
                path: null,
              },
              {
                submodules,
                progress: {
                  // Git has registered the directory at this point, so a
                  // cancel during the submodule step can still remove it.
                  onWorktreeClaimed: (path) =>
                    Effect.sync(() => {
                      targetWorktreePath = path;
                      createdWorktreePath = path;
                      createdWorktreeBranch =
                        prepareWorktree.branch !== undefined &&
                        isTemporaryWorktreeBranch(prepareWorktree.branch)
                          ? prepareWorktree.branch
                          : null;
                    }),
                  onCheckoutProgress: ({ percent, completed, total }) => {
                    checkoutTotal = total;
                    return worktreeSetupTracker.stage(threadId, "checkout", {
                      percent,
                      detail: `${completed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`,
                    });
                  },
                  onSubmodulesStarted: () =>
                    worktreeSetupTracker
                      .stageStatus(
                        threadId,
                        "checkout",
                        "done",
                        checkoutTotal === null
                          ? null
                          : `${checkoutTotal.toLocaleString("en-US")} files`,
                      )
                      .pipe(
                        Effect.andThen(
                          worktreeSetupTracker.stageStatus(threadId, "submodules", "running"),
                        ),
                      ),
                  onSubmodulesDisabled: ({ source }) =>
                    worktreeSetupTracker.stageStatus(
                      threadId,
                      "submodules",
                      "skipped",
                      `disabled in ${source}`,
                    ),
                  onSubmoduleLine: (line) => {
                    const submodulePath = /Submodule path '([^']+)'/.exec(line)?.[1];
                    return submodulePath === undefined
                      ? Effect.void
                      : worktreeSetupTracker.stage(threadId, "submodules", {
                          detail: submodulePath,
                        });
                  },
                  onSubmodulesFinished: ({ ok, detail }) =>
                    worktreeSetupTracker.stageStatus(
                      threadId,
                      "submodules",
                      ok ? "done" : "warning",
                      ok ? undefined : (detail ?? "submodule checkout failed"),
                    ),
                },
              },
            );
            const checkoutEndedAt = yield* nowIso;
            yield* worktreeSetupTracker.update(threadId, (snapshot) => ({
              ...snapshot,
              worktreePath: worktree.worktree.path,
              stages: snapshot.stages.map((stage) => {
                if (stage.id === "checkout" && stage.status === "running") {
                  return {
                    ...stage,
                    status: "done",
                    percent: 100,
                    endedAt: checkoutEndedAt,
                    detail:
                      checkoutTotal === null
                        ? stage.detail
                        : `${checkoutTotal.toLocaleString("en-US")} files`,
                  };
                }
                if (stage.id === "submodules" && stage.status === "pending") {
                  return { ...stage, status: "skipped", detail: "none" };
                }
                return stage;
              }),
            }));
            targetWorktreePath = worktree.worktree.path;
            createdWorktreePath = targetWorktreePath;
            createdWorktreeBranch =
              worktree.worktree.refName === prepareWorktree.branch &&
              isTemporaryWorktreeBranch(worktree.worktree.refName)
                ? worktree.worktree.refName
                : null;
            yield* dispatchFromClient({
              type: "thread.meta.update",
              commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
              threadId,
              branch: worktree.worktree.refName,
              worktreePath: targetWorktreePath,
            });
            yield* refreshGitStatus(targetWorktreePath);
          }

          const pendingSetupScript = yield* runSetupProgram();

          yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "running"));
          // Past this point a cancel would roll back a thread whose turn has
          // started. Drop the cancel handle and make the handoff atomic.
          yield* track(worktreeSetupTracker.markUncancellable(threadId));
          handoffStarted = true;
          const started = yield* Effect.uninterruptible(dispatchFromClient(finalTurnStartCommand));
          yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "done"));
          // An async setup script outlives the handoff: the snapshot stays
          // running so the client keeps its row next to the agent's work,
          // and settles when the script exits. The turn already started, so
          // the wait cannot fail the dispatch.
          const settle = tracked
            ? worktreeSetupTracker
                .finish(threadId, "done")
                .pipe(
                  Effect.flatMap((snapshot) =>
                    snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                  ),
                )
            : Effect.void;
          if (pendingSetupScript) {
            yield* Fiber.join(pendingSetupScript).pipe(
              Effect.ignoreCause({ log: true }),
              Effect.andThen(settle),
              Effect.forkDetach,
            );
          } else {
            yield* settle;
          }
          return started;
        });

        const settledBootstrapProgram = bootstrapProgram.pipe(
          Effect.interruptible,
          Effect.catchCause((cause) => {
            const interrupted = Cause.hasInterruptsOnly(cause);
            const error = Cause.squash(cause);
            const dispatchError =
              interrupted && tracked && !handoffStarted
                ? new OrchestrationDispatchCommandError({ message: "Worktree setup cancelled." })
                : isOrchestrationDispatchCommandError(error)
                  ? error
                  : new OrchestrationDispatchCommandError({
                      message:
                        error instanceof Error
                          ? error.message
                          : "Failed to bootstrap thread turn start.",
                      cause,
                    });
            return Effect.gen(function* () {
              if (tracked) {
                const snapshot = yield* worktreeSetupTracker.finish(
                  threadId,
                  interrupted ? "cancelled" : "failed",
                  interrupted ? null : dispatchError.message,
                );
                if (snapshot && (createdThread || !bootstrap?.createThread)) {
                  yield* recordWorktreeSetup(snapshot);
                }
              }
              const threadDeleted = yield* cleanupBootstrap();
              if (preparingSessionSet && !threadDeleted) {
                yield* markPreparingSessionFailed(dispatchError.message).pipe(
                  Effect.ignoreCause({ log: true }),
                );
              }
              if (interrupted && (!tracked || handoffStarted)) return yield* Effect.interrupt;
              const notCreated =
                bootstrap?.createThread !== undefined &&
                bootstrap.prepareWorktree?.requireWorktree === true &&
                !createdThread;
              return yield* Effect.fail(
                threadDeleted || notCreated
                  ? new OrchestrationDispatchCommandError({
                      message: dispatchError.message,
                      ...(dispatchError.cause !== undefined ? { cause: dispatchError.cause } : {}),
                      bootstrapThreadDisposition: threadDeleted ? "deleted" : "not-created",
                    })
                  : dispatchError,
              );
            });
          }),
          Effect.uninterruptible,
        );
        if (!tracked) return yield* settledBootstrapProgram;
        // Registration and fork are atomic so a dropped connection cannot
        // leave work running without the tracker handle used to cancel it.
        const fiber = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkDetach(settledBootstrapProgram);
            yield* worktreeSetupTracker.begin({
              threadId,
              branch: bootstrap?.prepareWorktree?.branch ?? null,
              baseRef: bootstrap?.prepareWorktree?.baseBranch ?? null,
              stages: ["fetch", "checkout", "submodules", "setup-script", "agent"],
              fiber,
            });
            return fiber;
          }),
        );
        return yield* Fiber.join(fiber);
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
