import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ManagementApiKeyId,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import * as ThreadCommandDispatcher from "./ThreadCommandDispatcher.ts";

const clientOrigin: OrchestrationClientOrigin = { surface: "web", appVersion: "1.2.3" };
const managementOrigin: OrchestrationClientOrigin = {
  managementKey: {
    id: ManagementApiKeyId.make("management-key-1"),
    name: "External automation",
  },
};

const threadId = ThreadId.make("thread-1");

const worktreeStatus = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/thread-1",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
} as const;

const bootstrapCommand: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
  type: "thread.turn.start",
  commandId: CommandId.make("turn-start"),
  threadId,
  message: {
    messageId: MessageId.make("message-1"),
    role: "user",
    text: "Start work",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId: ProjectId.make("project-1"),
      title: "Thread one",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    prepareWorktree: {
      projectCwd: "/repo",
      baseBranch: "main",
      branch: "feature/thread-1",
      startFromOrigin: true,
    },
    runSetupScript: true,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

const makeLayer = (input: {
  readonly dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"];
  readonly isRepository?: GitWorkflowService.GitWorkflowService["Service"]["isRepository"];
  readonly hasCommit?: GitWorkflowService.GitWorkflowService["Service"]["hasCommit"];
  readonly remoteBranchExists?: GitWorkflowService.GitWorkflowService["Service"]["remoteBranchExists"];
  readonly getSettings?: ServerSettings.ServerSettingsService["Service"]["getSettings"];
  readonly getProjectShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]["getProjectShellById"];
  readonly remoteExists?: GitWorkflowService.GitWorkflowService["Service"]["remoteExists"];
  readonly fetchRemote?: GitWorkflowService.GitWorkflowService["Service"]["fetchRemote"];
  readonly resolveRemoteTrackingCommit?: GitWorkflowService.GitWorkflowService["Service"]["resolveRemoteTrackingCommit"];
  readonly createWorktree?: GitWorkflowService.GitWorkflowService["Service"]["createWorktree"];
  readonly removeWorktree?: GitWorkflowService.GitWorkflowService["Service"]["removeWorktree"];
  readonly deleteRef?: GitWorkflowService.GitWorkflowService["Service"]["deleteRef"];
  readonly refreshStatus?: VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]["refreshStatus"];
  readonly runForThread?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly drainThrough?: (sequence: number) => Effect.Effect<void>;
}) => {
  return ThreadCommandDispatcher.ThreadCommandDispatcherLive.pipe(
    Layer.provideMerge(WorktreeSetupTracker.layer),
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: input.getSettings ?? Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.none()),
        getProjectShellById: input.getProjectShellById ?? (() => Effect.succeed(Option.none())),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngine.OrchestrationEngineService)({ dispatch: input.dispatch }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        isRepository: input.isRepository ?? (() => Effect.succeed(true)),
        hasCommit: input.hasCommit ?? (() => Effect.succeed(true)),
        remoteBranchExists: input.remoteBranchExists ?? (() => Effect.succeed(true)),
        remoteExists: input.remoteExists ?? (() => Effect.succeed(false)),
        fetchRemote: input.fetchRemote ?? (() => Effect.void),
        resolveRemoteTrackingCommit:
          input.resolveRemoteTrackingCommit ??
          (() => Effect.succeed({ commitSha: "remote-main", remoteRefName: "origin/main" })),
        createWorktree:
          input.createWorktree ??
          (() =>
            Effect.succeed({
              worktree: { path: "/repo/.worktrees/thread-1", refName: "feature/thread-1" },
            })),
        removeWorktree: input.removeWorktree ?? (() => Effect.void),
        deleteRef: input.deleteRef ?? (() => Effect.void),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshStatus: input.refreshStatus ?? (() => Effect.succeed(worktreeStatus)),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread:
          input.runForThread ?? (() => Effect.succeed({ status: "no-script" as const })),
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager.TerminalManager)({
        close: input.closeTerminal ?? (() => Effect.void),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        awaitCommandReady: Effect.void,
        markHttpListening: Effect.void,
        enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadDeletionReactor, {
        start: () => Effect.void,
        drainThrough: input.drainThrough ?? (() => Effect.void),
      }),
    ),
  );
};

const temporaryBootstrapCommand: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
  ...bootstrapCommand,
  bootstrap: {
    ...bootstrapCommand.bootstrap!,
    prepareWorktree: {
      ...bootstrapCommand.bootstrap!.prepareWorktree!,
      branch: "t3code/deadbeef",
    },
  },
};

describe("ThreadCommandDispatcher", () => {
  it.effect("waits for synchronous setup completion before starting the turn", () =>
    Effect.gen(function* () {
      const awaitingCompletion = yield* Deferred.make<void>();
      const completed =
        yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
      const turnStarted = yield* Deferred.make<void>();
      const layer = makeLayer({
        dispatch: (command) =>
          (command.type === "thread.turn.start"
            ? Deferred.succeed(turnStarted, undefined)
            : Effect.void
          ).pipe(Effect.as({ sequence: 1 })),
        runForThread: () =>
          Effect.succeed({
            status: "started",
            scriptId: "setup",
            scriptName: "Setup",
            scriptCommand: "install",
            terminalId: "setup-terminal",
            cwd: "/repo/.worktrees/thread-1",
            async: false,
            completion: Deferred.succeed(awaitingCompletion, undefined).pipe(
              Effect.andThen(Deferred.await(completed)),
            ),
          }),
      });
      yield* Effect.gen(function* () {
        const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
        const fiber = yield* dispatcher.dispatch(bootstrapCommand).pipe(Effect.forkChild);
        const startedBeforeCompletion = yield* Effect.raceFirst(
          Deferred.await(awaitingCompletion).pipe(Effect.as(false)),
          Deferred.await(turnStarted).pipe(Effect.as(true)),
        );
        expect(startedBeforeCompletion).toBe(false);
        yield* Deferred.succeed(completed, { exitCode: 0, durationMs: 30 });
        yield* Fiber.join(fiber);
        expect(yield* Deferred.isDone(turnStarted)).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("starts the turn while asynchronous setup is still running", () =>
    Effect.gen(function* () {
      const completed =
        yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
      const turnStarted = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
        yield* dispatcher.dispatch(bootstrapCommand);
        expect(yield* Deferred.isDone(turnStarted)).toBe(true);
        expect(yield* Deferred.isDone(completed)).toBe(false);
        yield* Deferred.succeed(completed, { exitCode: 0, durationMs: 30 });
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatch: (command) =>
              (command.type === "thread.turn.start"
                ? Deferred.succeed(turnStarted, undefined)
                : Effect.void
              ).pipe(Effect.as({ sequence: 1 })),
            runForThread: () =>
              Effect.succeed({
                status: "started",
                scriptId: "setup",
                scriptName: "Setup",
                scriptCommand: "install",
                terminalId: "setup-terminal",
                cwd: "/repo/.worktrees/thread-1",
                async: true,
                completion: Deferred.await(completed),
              }),
          }),
        ),
      );
    }),
  );

  it.effect("settles asynchronous progress after the script exits", () =>
    Effect.gen(function* () {
      const completed =
        yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
      const settled = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        yield* dispatcher.dispatch(bootstrapCommand);
        expect((yield* tracker.get(threadId))?.phase).toBe("running");
        expect(yield* tracker.cancel(threadId)).toBe(false);
        yield* Deferred.succeed(completed, { exitCode: 7, durationMs: 30 });
        yield* Deferred.await(settled);
        const snapshot = yield* tracker.get(threadId);
        expect(snapshot?.phase).toBe("done");
        expect(snapshot?.stages.find((stage) => stage.id === "setup-script")).toMatchObject({
          status: "failed",
          detail: "exit 7",
          tail: ["Installing packages"],
        });
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatch: (command) =>
              (command.type === "thread.activity.append" &&
              command.activity.summary === "Worktree ready"
                ? Deferred.succeed(settled, undefined)
                : Effect.void
              ).pipe(Effect.as({ sequence: 1 })),
            runForThread: (input) =>
              (input.observeCompletion?.onOutputLine?.("Installing packages") ?? Effect.void).pipe(
                Effect.as({
                  status: "started",
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "install",
                  terminalId: "setup-terminal",
                  cwd: "/repo/.worktrees/thread-1",
                  async: true,
                  completion: Deferred.await(completed),
                }),
              ),
          }),
        ),
      );
    }),
  );

  it.effect("cancels synchronous setup and rolls back owned resources", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const completed =
        yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
      const cleanup: string[] = [];
      let turnStarted = false;
      yield* Effect.gen(function* () {
        const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const caller = yield* dispatcher
          .dispatch(temporaryBootstrapCommand)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(waiting);
        expect(yield* tracker.cancel(threadId)).toBe(true);
        const exit = yield* Fiber.join(caller);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            message: "Worktree setup cancelled.",
            bootstrapThreadDisposition: "deleted",
          });
        expect(turnStarted).toBe(false);
        expect(cleanup).toEqual(["terminal", "thread", "worktree", "branch"]);
        expect((yield* tracker.get(threadId))?.phase).toBe("cancelled");
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "thread.delete") cleanup.push("thread");
                if (command.type === "thread.turn.start") turnStarted = true;
                return { sequence: 1 };
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/repo/.worktrees/thread-1", refName: "t3code/deadbeef" },
              }),
            runForThread: () =>
              Effect.succeed({
                status: "started",
                scriptId: "setup",
                scriptName: "Setup",
                scriptCommand: "install",
                terminalId: "setup-terminal",
                cwd: "/repo/.worktrees/thread-1",
                async: false,
                completion: Deferred.succeed(waiting, undefined).pipe(
                  Effect.andThen(Deferred.await(completed)),
                ),
              }),
            closeTerminal: () =>
              Effect.sync(() => cleanup.push("terminal")).pipe(
                Effect.andThen(Deferred.succeed(completed, { exitCode: null, durationMs: 20 })),
                Effect.asVoid,
              ),
            removeWorktree: () => Effect.sync(() => cleanup.push("worktree")).pipe(Effect.asVoid),
            deleteRef: () => Effect.sync(() => cleanup.push("branch")).pipe(Effect.asVoid),
          }),
        ),
      );
    }),
  );

  it.effect("cancels during submodules after the worktree has been claimed", () =>
    Effect.gen(function* () {
      const claimed = yield* Deferred.make<void>();
      const cleanup: string[] = [];
      yield* Effect.gen(function* () {
        const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const caller = yield* dispatcher
          .dispatch(temporaryBootstrapCommand)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(claimed);
        const snapshot = yield* tracker.get(threadId);
        expect(snapshot?.stages.find((stage) => stage.id === "checkout")).toMatchObject({
          status: "done",
          percent: 100,
        });
        expect(snapshot?.stages.find((stage) => stage.id === "submodules")?.status).toBe("running");
        expect(yield* tracker.cancel(threadId)).toBe(true);
        expect(Exit.isFailure(yield* Fiber.join(caller))).toBe(true);
        expect(cleanup).toEqual(["thread", "worktree", "branch"]);
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "thread.delete") cleanup.push("thread");
                return { sequence: 1 };
              }),
            createWorktree: (_input, options) =>
              Effect.gen(function* () {
                yield* (
                  options?.progress?.onWorktreeClaimed?.("/repo/.worktrees/thread-1") ?? Effect.void
                );
                yield* (
                  options?.progress?.onCheckoutProgress?.({
                    percent: 100,
                    completed: 8,
                    total: 8,
                  }) ?? Effect.void
                );
                yield* options?.progress?.onSubmodulesStarted?.() ?? Effect.void;
                yield* Deferred.succeed(claimed, undefined);
                return yield* Effect.never;
              }),
            removeWorktree: (input) =>
              Effect.sync(() => {
                expect(input.path).toBe("/repo/.worktrees/thread-1");
                cleanup.push("worktree");
              }),
            deleteRef: () =>
              Effect.sync(() => {
                cleanup.push("branch");
              }),
          }),
        ),
      );
    }),
  );

  it.effect("continues tracked bootstrap after the caller disconnects", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const commands: string[] = [];
      yield* Effect.gen(function* () {
        const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const caller = yield* dispatcher.dispatch(bootstrapCommand).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(caller);
        expect((yield* tracker.get(threadId))?.phase).toBe("running");
        yield* Deferred.succeed(released, undefined);
        yield* Deferred.await(settled);
        expect(commands).toContain("thread.turn.start");
        expect(commands).not.toContain("thread.delete");
        expect((yield* tracker.get(threadId))?.phase).toBe("done");
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatch: (command) =>
              Effect.sync(() => commands.push(command.type)).pipe(
                Effect.andThen(
                  command.type === "thread.activity.append" &&
                    command.activity.summary === "Worktree ready"
                    ? Deferred.succeed(settled, undefined)
                    : Effect.void,
                ),
                Effect.as({ sequence: 1 }),
              ),
            createWorktree: () =>
              Deferred.succeed(waiting, undefined).pipe(
                Effect.andThen(Deferred.await(released)),
                Effect.as({
                  worktree: { path: "/repo/.worktrees/thread-1", refName: "feature/thread-1" },
                }),
              ),
          }),
        ),
      );
    }),
  );

  for (const guard of ["repository", "base commit"] as const) {
    it.effect(`rejects required worktrees without a ${guard} before creating a thread`, () => {
      const commands: OrchestrationCommand[] = [];
      return Effect.gen(function* () {
        const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
        const error = yield* dispatcher
          .dispatch({
            ...bootstrapCommand,
            bootstrap: {
              ...bootstrapCommand.bootstrap!,
              prepareWorktree: {
                ...bootstrapCommand.bootstrap!.prepareWorktree!,
                requireWorktree: true,
              },
            },
          })
          .pipe(Effect.flip);
        expect(error.bootstrapThreadDisposition).toBe("not-created");
        expect(commands).toEqual([]);
      }).pipe(
        Effect.provide(
          makeLayer({
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({ sequence: 1 });
            },
            isRepository: () => Effect.succeed(guard !== "repository"),
            hasCommit: () => Effect.succeed(guard !== "base commit"),
          }),
        ),
      );
    });
  }

  it.effect("uses the project checkout when an optional worktree has no repository", () => {
    let turnStarted = false;
    let worktreeCreated = false;
    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      yield* dispatcher.dispatch(bootstrapCommand);
      expect(turnStarted).toBe(true);
      expect(worktreeCreated).toBe(false);
      const snapshot = yield* tracker.get(threadId);
      expect(
        snapshot?.stages
          .filter((stage) => ["fetch", "checkout", "submodules"].includes(stage.id))
          .every((stage) => stage.status === "skipped"),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.turn.start") turnStarted = true;
              return { sequence: 1 };
            }),
          isRepository: () => Effect.succeed(false),
          createWorktree: () =>
            Effect.sync(() => {
              worktreeCreated = true;
              return { worktree: { path: "/unexpected", refName: "unexpected" } };
            }),
        }),
      ),
    );
  });

  it.effect("fetches only the requested branch and falls back to its local ref", () => {
    const fetches: unknown[] = [];
    let selectedRef: string | undefined;
    let submodules: unknown;
    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      yield* dispatcher.dispatch(bootstrapCommand);
      expect(fetches).toEqual([{ cwd: "/repo", remoteName: "origin", refName: "main" }]);
      expect(selectedRef).toBe("main");
      expect(submodules).toBe("none");
      expect(
        (yield* tracker.get(threadId))?.stages.find((stage) => stage.id === "fetch")?.status,
      ).toBe("warning");
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch: () => Effect.succeed({ sequence: 1 }),
          remoteExists: () => Effect.succeed(true),
          remoteBranchExists: () => Effect.succeed(false),
          fetchRemote: (input) =>
            Effect.sync(() => {
              fetches.push(input);
            }),
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            worktreeSubmodules: "recursive",
            projectSettingsOverrides: { "project-1": { worktreeSubmodules: "none" } },
          }),
          createWorktree: (input, options) =>
            Effect.sync(() => {
              selectedRef = input.refName;
              submodules = options?.submodules;
              return {
                worktree: { path: "/repo/.worktrees/thread-1", refName: "feature/thread-1" },
              };
            }),
        }),
      ),
    );
  });

  it.effect("checks out the fetched origin commit when the remote branch exists", () => {
    let selectedRef: string | undefined;
    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      yield* dispatcher.dispatch(bootstrapCommand);
      expect(selectedRef).toBe("abc123456789");
      expect((yield* tracker.get(threadId))?.baseRef).toBe("abc123456789");
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch: () => Effect.succeed({ sequence: 1 }),
          remoteExists: () => Effect.succeed(true),
          resolveRemoteTrackingCommit: () =>
            Effect.succeed({ commitSha: "abc123456789", remoteRefName: "origin/main" }),
          hasCommit: (input) =>
            Effect.sync(() => {
              expect(input.refName).toBe("abc123456789");
              return true;
            }),
          createWorktree: (input) =>
            Effect.sync(() => {
              selectedRef = input.refName;
              return {
                worktree: { path: "/repo/.worktrees/thread-1", refName: "feature/thread-1" },
              };
            }),
        }),
      ),
    );
  });

  it.effect("marks the preparing session failed when thread cleanup cannot delete it", () => {
    const commands: OrchestrationCommand[] = [];
    let worktreeRemoved = false;
    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const error = yield* dispatcher.dispatch(bootstrapCommand).pipe(Effect.flip);
      expect(error.bootstrapThreadDisposition).toBeUndefined();
      expect(worktreeRemoved).toBe(false);
      expect(commands.at(-1)).toMatchObject({
        type: "thread.session.set",
        session: { status: "error", lastError: expect.stringContaining("turn rejected") },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch: (command) => {
            commands.push(command);
            return command.type === "thread.turn.start" || command.type === "thread.delete"
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "turn rejected",
                  }),
                )
              : Effect.succeed({ sequence: 1 });
          },
          removeWorktree: () =>
            Effect.sync(() => {
              worktreeRemoved = true;
            }),
        }),
      ),
    );
  });

  for (const failure of ["exit", "launch"] as const) {
    it.effect(
      `starts the agent and preserves the failed setup stage after a script ${failure} failure`,
      () => {
        let turnStarted = false;
        return Effect.gen(function* () {
          const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          yield* dispatcher.dispatch(bootstrapCommand);
          expect(turnStarted).toBe(true);
          expect(
            (yield* tracker.get(threadId))?.stages.find((stage) => stage.id === "setup-script")
              ?.status,
          ).toBe("failed");
        }).pipe(
          Effect.provide(
            makeLayer({
              dispatch: (command) =>
                Effect.sync(() => {
                  if (command.type === "thread.turn.start") turnStarted = true;
                  return { sequence: 1 };
                }),
              runForThread: () =>
                failure === "launch"
                  ? Effect.fail(
                      new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
                        threadId,
                        worktreePath: "/repo/.worktrees/thread-1",
                        operation: "openTerminal",
                        cause: new Error("terminal unavailable"),
                      }),
                    )
                  : Effect.succeed({
                      status: "started",
                      scriptId: "setup",
                      scriptName: "Setup",
                      scriptCommand: "install",
                      terminalId: "setup-terminal",
                      cwd: "/repo/.worktrees/thread-1",
                      async: false,
                      completion: Effect.succeed({ exitCode: 2, durationMs: 20 }),
                    }),
            }),
          ),
        );
      },
    );
  }

  it.effect("dispatches ordinary commands through the startup gate with the client origin", () => {
    const dispatchCalls: Array<{
      readonly command: OrchestrationCommand;
      readonly options: { readonly origin?: OrchestrationClientOrigin } | undefined;
    }> = [];
    const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
      dispatched,
      options,
    ) => {
      dispatchCalls.push({ command: dispatched, options });
      return Effect.succeed({ sequence: 7 });
    };
    const command: OrchestrationCommand = {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("interrupt"),
      threadId,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const result = yield* dispatcher.dispatch(command, { origin: clientOrigin });

      expect(result).toEqual({ sequence: 7 });
      expect(dispatchCalls).toEqual([{ command, options: { origin: clientOrigin } }]);
    }).pipe(Effect.provide(makeLayer({ dispatch })));
  });

  it.effect("preserves management-only origins", () => {
    const dispatchCalls: Array<{
      readonly command: OrchestrationCommand;
      readonly options: { readonly origin?: OrchestrationClientOrigin } | undefined;
    }> = [];
    const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
      command,
      options,
    ) => {
      dispatchCalls.push({ command, options });
      return Effect.succeed({ sequence: 9 });
    };
    const command: OrchestrationCommand = {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("management-interrupt"),
      threadId,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      yield* dispatcher.dispatch(command, { origin: managementOrigin });

      expect(dispatchCalls).toEqual([{ command, options: { origin: managementOrigin } }]);
    }).pipe(Effect.provide(makeLayer({ dispatch })));
  });

  it.effect("creates, prepares, records setup work, and starts a bootstrapped turn", () => {
    let sequence = 0;
    const drainCalls: number[] = [];
    const dispatchCalls: Array<{
      readonly command: OrchestrationCommand;
      readonly options: { readonly origin?: OrchestrationClientOrigin } | undefined;
    }> = [];
    const worktreeCalls: Array<
      Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0]
    > = [];
    const refreshCalls: Array<string> = [];
    const setupCalls: Array<
      Parameters<ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]>[0]
    > = [];
    const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
      command,
      options,
    ) => {
      dispatchCalls.push({ command, options });
      return Effect.succeed({ sequence: ++sequence });
    };
    const createWorktree: GitWorkflowService.GitWorkflowService["Service"]["createWorktree"] = (
      input,
    ) => {
      worktreeCalls.push(input);
      return Effect.succeed({
        worktree: { path: "/repo/.worktrees/thread-1", refName: "feature/thread-1" },
      });
    };
    const refreshStatus: VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]["refreshStatus"] = (
      cwd,
    ) => {
      refreshCalls.push(cwd);
      return Effect.succeed(worktreeStatus);
    };
    const runForThread: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"] =
      (input) => {
        setupCalls.push(input);
        return Effect.succeed({
          status: "started" as const,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "echo setup",
          async: false,
          terminalId: "setup-setup",
          cwd: "/repo/.worktrees/thread-1",
        });
      };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const result = yield* dispatcher.dispatch(bootstrapCommand, { origin: clientOrigin });
      const commands = dispatchCalls.map(({ command }) => command);

      expect(result).toEqual({ sequence: 8 });
      expect(drainCalls).toEqual([1]);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.message.user.append",
        "thread.activity.append",
        "thread.session.set",
        "thread.meta.update",
        "thread.activity.append",
        "thread.activity.append",
        "thread.turn.start",
        "thread.activity.append",
      ]);
      expect(dispatchCalls.every(({ options }) => options?.origin === clientOrigin)).toBe(true);
      expect(worktreeCalls).toEqual([
        {
          cwd: "/repo",
          refName: "main",
          newRefName: "feature/thread-1",
          baseRefName: "main",
          path: null,
        },
      ]);
      expect(refreshCalls).toEqual(["/repo/.worktrees/thread-1"]);
      expect(setupCalls).toEqual([
        {
          threadId,
          projectId: ProjectId.make("project-1"),
          projectCwd: "/repo",
          worktreePath: "/repo/.worktrees/thread-1",
          observeCompletion: { onOutputLine: expect.any(Function) },
        },
      ]);
      const { bootstrap: _bootstrap, ...expectedTurnStart } = bootstrapCommand;
      expect(commands.find((command) => command.type === "thread.turn.start")).toEqual(
        expectedTurnStart,
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch,
          createWorktree,
          refreshStatus,
          runForThread,
          drainThrough: (drainedSequence) => {
            drainCalls.push(drainedSequence);
            return Effect.void;
          },
        }),
      ),
    );
  });

  it.effect("waits for prior deletion cleanup after creating a thread", () => {
    const drainCalls: number[] = [];
    const command: OrchestrationCommand = {
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project-1"),
      title: "Thread one",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const result = yield* dispatcher.dispatch(command);

      expect(result).toEqual({ sequence: 12 });
      expect(drainCalls).toEqual([12]);
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch: () => Effect.succeed({ sequence: 12 }),
          drainThrough: (sequence) => {
            drainCalls.push(sequence);
            return Effect.void;
          },
        }),
      ),
    );
  });

  it.effect("deletes a newly created thread when bootstrap dispatch fails", () => {
    const turnError = new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "turn rejected",
    });
    const dispatchCalls: Array<{
      readonly command: OrchestrationCommand;
      readonly options: { readonly origin?: OrchestrationClientOrigin } | undefined;
    }> = [];
    const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
      dispatched,
      options,
    ) => {
      dispatchCalls.push({ command: dispatched, options });
      return dispatched.type === "thread.turn.start"
        ? Effect.fail(turnError)
        : Effect.succeed({ sequence: 1 });
    };
    const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
      ...bootstrapCommand,
      bootstrap: { createThread: bootstrapCommand.bootstrap!.createThread },
    };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const error = yield* dispatcher.dispatch(command, { origin: clientOrigin }).pipe(Effect.flip);
      const commands = dispatchCalls.map(({ command }) => command);

      expect(error.message).toContain("turn rejected");
      expect(error.bootstrapThreadDisposition).toBe("deleted");
      expect(commands.map((dispatched) => dispatched.type)).toEqual([
        "thread.create",
        "thread.message.user.append",
        "thread.turn.start",
        "thread.delete",
      ]);
      expect(dispatchCalls[2]?.options).toEqual({ origin: clientOrigin });
    }).pipe(Effect.provide(makeLayer({ dispatch })));
  });

  it.effect("removes a newly created worktree when bootstrap dispatch fails", () => {
    const turnError = new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "turn rejected",
    });
    const dispatchCalls: OrchestrationCommand[] = [];
    const removeCalls: Array<
      Parameters<GitWorkflowService.GitWorkflowService["Service"]["removeWorktree"]>[0]
    > = [];
    const deleteRefCalls: Array<
      Parameters<GitWorkflowService.GitWorkflowService["Service"]["deleteRef"]>[0]
    > = [];
    const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
      dispatched,
    ) => {
      dispatchCalls.push(dispatched);
      return dispatched.type === "thread.turn.start"
        ? Effect.fail(turnError)
        : Effect.succeed({ sequence: 1 });
    };
    const removeWorktree: GitWorkflowService.GitWorkflowService["Service"]["removeWorktree"] = (
      input,
    ) => {
      removeCalls.push(input);
      return Effect.void;
    };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const error = yield* dispatcher
        .dispatch(bootstrapCommand, { origin: clientOrigin })
        .pipe(Effect.flip);

      expect(error.message).toContain("turn rejected");
      expect(error.bootstrapThreadDisposition).toBe("deleted");
      expect(removeCalls).toEqual([
        { cwd: "/repo", path: "/repo/.worktrees/thread-1", force: true },
      ]);
      expect(deleteRefCalls).toEqual([]);
      expect(dispatchCalls.map((dispatched) => dispatched.type)).toEqual([
        "thread.create",
        "thread.message.user.append",
        "thread.activity.append",
        "thread.session.set",
        "thread.meta.update",
        "thread.turn.start",
        "thread.activity.append",
        "thread.delete",
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch,
          removeWorktree,
          deleteRef: (input) => {
            deleteRefCalls.push(input);
            return Effect.void;
          },
        }),
      ),
    );
  });

  it.effect("closes setup terminal before deleting a failed temporary worktree and branch", () => {
    const cleanupOrder: string[] = [];
    const deleteRefs: Array<
      Parameters<GitWorkflowService.GitWorkflowService["Service"]["deleteRef"]>[0]
    > = [];
    const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
      dispatched,
    ) => {
      if (dispatched.type === "thread.delete") cleanupOrder.push("thread");
      return dispatched.type === "thread.turn.start"
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.turn.start",
              detail: "turn rejected",
            }),
          )
        : Effect.succeed({ sequence: 1 });
    };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      yield* dispatcher.dispatch(temporaryBootstrapCommand).pipe(Effect.flip);

      expect(cleanupOrder).toEqual(["terminal", "thread", "worktree", "branch"]);
      expect(deleteRefs).toEqual([{ cwd: "/repo", refName: "t3code/deadbeef", force: true }]);
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch,
          createWorktree: () =>
            Effect.succeed({
              worktree: { path: "/repo/.worktrees/thread-1", refName: "t3code/deadbeef" },
            }),
          runForThread: () =>
            Effect.succeed({
              status: "started",
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "echo setup",
              async: false,
              terminalId: "setup-setup",
              cwd: "/repo/.worktrees/thread-1",
            }),
          closeTerminal: () => {
            cleanupOrder.push("terminal");
            return Effect.void;
          },
          removeWorktree: () => {
            cleanupOrder.push("worktree");
            return Effect.void;
          },
          deleteRef: (input) => {
            cleanupOrder.push("branch");
            deleteRefs.push(input);
            return Effect.void;
          },
        }),
      ),
    );
  });

  it.effect("keeps the worktree when setup terminal cleanup fails", () => {
    const cleanupOrder: string[] = [];
    const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
      dispatched,
    ) => {
      if (dispatched.type === "thread.delete") cleanupOrder.push("thread");
      return dispatched.type === "thread.turn.start"
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.turn.start",
              detail: "turn rejected",
            }),
          )
        : Effect.succeed({ sequence: 1 });
    };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const error = yield* dispatcher.dispatch(temporaryBootstrapCommand).pipe(Effect.flip);

      expect(error.message).toContain("turn rejected");
      expect(cleanupOrder).toEqual(["terminal", "thread"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch,
          createWorktree: () =>
            Effect.succeed({
              worktree: { path: "/repo/.worktrees/thread-1", refName: "t3code/deadbeef" },
            }),
          runForThread: () =>
            Effect.succeed({
              status: "started",
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "echo setup",
              async: false,
              terminalId: "setup-setup",
              cwd: "/repo/.worktrees/thread-1",
            }),
          closeTerminal: () => {
            cleanupOrder.push("terminal");
            return Effect.die("terminal close failed");
          },
          removeWorktree: () => {
            cleanupOrder.push("worktree");
            return Effect.void;
          },
        }),
      ),
    );
  });

  it.effect("rolls back tracked bootstrap resources after interruption", () => {
    const cleanupOrder: string[] = [];
    const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
      dispatched,
    ) => {
      if (dispatched.type === "thread.delete") cleanupOrder.push("thread");
      return dispatched.type === "thread.turn.start"
        ? Effect.interrupt
        : Effect.succeed({ sequence: 1 });
    };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const exit = yield* Effect.exit(dispatcher.dispatch(temporaryBootstrapCommand));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }
      expect(cleanupOrder).toEqual(["terminal", "thread", "worktree", "branch"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          dispatch,
          createWorktree: () =>
            Effect.succeed({
              worktree: { path: "/repo/.worktrees/thread-1", refName: "t3code/deadbeef" },
            }),
          runForThread: () =>
            Effect.succeed({
              status: "started",
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "echo setup",
              async: false,
              terminalId: "setup-setup",
              cwd: "/repo/.worktrees/thread-1",
            }),
          closeTerminal: () => {
            cleanupOrder.push("terminal");
            return Effect.void;
          },
          removeWorktree: () => {
            cleanupOrder.push("worktree");
            return Effect.void;
          },
          deleteRef: () => {
            cleanupOrder.push("branch");
            return Effect.void;
          },
        }),
      ),
    );
  });
});
