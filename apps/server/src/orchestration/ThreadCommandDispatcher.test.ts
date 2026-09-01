import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

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
          terminalId: "setup-setup",
          cwd: "/repo/.worktrees/thread-1",
        });
      };

    return Effect.gen(function* () {
      const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
      const result = yield* dispatcher.dispatch(bootstrapCommand, { origin: clientOrigin });
      const commands = dispatchCalls.map(({ command }) => command);

      expect(result).toEqual({ sequence: 5 });
      expect(drainCalls).toEqual([1]);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.meta.update",
        "thread.activity.append",
        "thread.activity.append",
        "thread.turn.start",
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
        },
      ]);
      const { bootstrap: _bootstrap, ...expectedTurnStart } = bootstrapCommand;
      expect(commands.at(-1)).toEqual(expectedTurnStart);
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
        "thread.meta.update",
        "thread.turn.start",
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
