import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { assessCheckpointRestore } from "./CheckpointRestoreSafety.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2, type ProjectionCheckpointRollbackContext } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import { TurnItemPositionStoreV2 } from "./TurnItemPositionStore.ts";

const layerVcs = VcsDriverRegistry.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect.each([
  "nested",
  "ancestor",
  "provider",
  "sibling",
  "shared-provider",
  "conversation",
] as const)("preserves overlapping workspace files, owner=%s", (owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-" });
    const cwd = path.join(parent, "worktree");
    const nested = path.join(cwd, "nested");
    const sibling = path.join(parent, "worktree2");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.makeDirectory(sibling);
    yield* (yield* VcsProcess.VcsProcess).run({
      operation: "test.init",
      command: "git",
      args: ["init", "--quiet"],
      cwd: owner === "ancestor" ? parent : cwd,
    });
    yield* (yield* VcsProcess.VcsProcess).run({
      operation: "test.init",
      command: "git",
      args: ["init", "--quiet"],
      cwd: sibling,
    });
    if (owner === "nested")
      yield* (yield* VcsProcess.VcsProcess).run({
        operation: "test.init",
        command: "git",
        args: ["init", "--quiet"],
        cwd: nested,
      });
    const otherFile = path.join(nested, "other-thread.txt");
    yield* fs.writeFileString(otherFile, "other thread's uncommitted work");
    const threadId = ThreadId.make("restore-current");
    const otherId = ThreadId.make("restore-other");
    const projectId = ProjectId.make("restore-project");
    const providerThreadId = ProviderThreadId.make("restore-provider");
    const providerSessionId = ProviderSessionId.make("restore-session");
    const instanceId = ProviderInstanceId.make("restore-instance");
    const checkpointId = CheckpointId.make("restore-checkpoint");
    const scopeId = CheckpointScopeId.make("restore-scope");
    const calls: string[] = [];
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: instanceId,
    };
    const otherThread = {
      id: otherId,
      projectId,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: otherId },
      worktreePath:
        owner === "ancestor" || owner === "conversation"
          ? parent
          : owner === "nested"
            ? nested
            : sibling,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: cwd,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThread,
      providerSession: undefined,
      providerTurns: [],
      rootNodes: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: null },
      scope: { id: scopeId, cwd },
      runsToRollback: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as ProjectionCheckpointRollbackContext;
    const layerTest = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          layerVcs,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
          ServerSettings.layerTest(),
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({ workspaceRoot: parent } as never),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [otherThread] as never,
                archivedThreads: [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: [],
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions:
                  owner === "provider" || owner === "shared-provider"
                    ? ([
                        {
                          cwd: owner === "shared-provider" ? cwd : nested,
                          status: "running",
                          capabilities: {
                            sessions: {
                              supportsMultipleProviderThreadsPerSession:
                                owner === "shared-provider",
                            },
                          },
                        },
                      ] as never)
                    : [],
              }),
          }),
          Layer.mock(CheckpointServiceV2)({
            prepareRestore: () => Effect.void,
            restore: () =>
              Effect.gen(function* () {
                calls.push("files");
                yield* fs.remove(otherFile).pipe(Effect.orDie);
              }),
          }),
          Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
          Layer.mock(TurnItemPositionStoreV2)({}),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: () =>
                  Effect.sync(() => {
                    calls.push("provider");
                    return { providerThread };
                  }),
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    );
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
      Effect.provide(layerTest),
    );
    const restoreFiles = owner !== "conversation";
    const rejected = !["sibling", "shared-provider", "conversation"].includes(owner);
    if (rejected) {
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.flip);
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(otherFile), "other thread's uncommitted work");
    } else {
      yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
      assert.deepEqual(calls, restoreFiles ? ["provider", "files"] : ["provider"]);
      assert.equal(yield* fs.exists(otherFile), !restoreFiles);
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(layerVcs, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
);

interface Scene {
  readonly parent: string;
  readonly repo: string;
  readonly nested: string;
  readonly sibling: string;
  readonly removed: string;
}

interface Case {
  readonly name: string;
  readonly restoring?: "worktree" | "project-root" | "removed-worktree";
  readonly other?: {
    readonly worktreePath: (scene: Scene) => string | null;
    readonly projectRoot?: (scene: Scene) => string;
    readonly hidden?: "subagent" | "sideChat";
    readonly state?: "settled" | "archived";
    readonly running?: boolean;
    readonly background?: boolean;
    readonly session?: {
      readonly cwd: (scene: Scene) => string;
      readonly status: "ready" | "running";
      readonly multiplexed?: boolean;
    };
    readonly qaOnly?: boolean;
    readonly scopes?: (scene: Scene) => ReadonlyArray<string>;
  };
  readonly nestedRepo?: boolean;
  readonly undetected?: (scene: Scene) => string;
  readonly blocked?: RegExp;
  readonly notified?: boolean;
}

const settledHere = { worktreePath: (s: Scene) => s.repo, state: "settled" } as const;

it.effect.each<Case>([
  {
    name: "an active thread in the same checkout",
    other: { worktreePath: (s) => s.repo },
    blocked: /"Other work" is active/,
  },
  {
    name: "an active thread in a subdirectory",
    other: { worktreePath: (s) => s.nested },
    blocked: /is active/,
  },
  {
    name: "an active thread in a nested checkout",
    other: { worktreePath: (s) => s.nested },
    nestedRepo: true,
    blocked: /is active/,
  },
  {
    name: "an active thread in a missing subdirectory",
    other: { worktreePath: (s) => `${s.repo}/missing/deeper` },
    blocked: /is active/,
  },
  {
    name: "an active thread in an undetected folder inside the checkout",
    other: { worktreePath: (s) => s.nested },
    undetected: (s) => s.nested,
    blocked: /is active/,
  },
  {
    name: "an active thread in a plain parent folder",
    other: { worktreePath: () => null, projectRoot: (s) => s.parent },
  },
  { name: "an active thread in another checkout", other: { worktreePath: (s) => s.sibling } },
  {
    name: "a project-root restore beside an active thread",
    restoring: "project-root",
    other: { worktreePath: (s) => s.nested },
    blocked: /is active/,
  },
  { name: "a project-root restore alone", restoring: "project-root" },
  { name: "a recreated worktree", restoring: "removed-worktree" },
  {
    name: "an active thread sharing a removed worktree",
    restoring: "removed-worktree",
    other: { worktreePath: (s) => s.removed },
    blocked: /is active/,
  },
  {
    name: "a settled thread that changed files here",
    other: { ...settledHere, scopes: (s) => [s.nested] },
    notified: true,
  },
  {
    name: "an archived thread that changed files here",
    other: { ...settledHere, state: "archived", scopes: (s) => [s.repo] },
    notified: true,
  },
  {
    name: "a settled Q&A thread with a checkpoint scope",
    other: { ...settledHere, scopes: (s) => [s.repo], qaOnly: true },
  },
  {
    name: "a settled thread that changed no files here",
    other: { ...settledHere, scopes: (s) => [s.sibling] },
  },
  {
    name: "a settled thread with an idle open session",
    other: { ...settledHere, session: { cwd: (s) => s.repo, status: "ready" } },
  },
  {
    name: "a settled thread running a turn",
    other: { ...settledHere, session: { cwd: (s) => s.repo, status: "running" } },
    blocked: /"Other work" is still running/,
  },
  {
    name: "a settled thread whose multiplexed session runs its turn",
    other: {
      ...settledHere,
      running: true,
      session: { cwd: (s) => s.sibling, status: "running", multiplexed: true },
    },
    blocked: /is still running/,
  },
  {
    name: "a settled thread running elsewhere",
    other: { ...settledHere, worktreePath: (s) => s.sibling, running: true },
  },
  {
    name: "an archived thread with background work",
    other: { ...settledHere, state: "archived", background: true },
    blocked: /is still running/,
  },
  {
    name: "an idle subagent",
    other: { worktreePath: (s) => s.repo, hidden: "subagent", scopes: (s) => [s.repo] },
  },
  {
    name: "a running subagent",
    other: { worktreePath: (s) => s.repo, hidden: "subagent", running: true },
    blocked: /a subagent of "Parent work" is still running/,
  },
  {
    name: "an idle side chat on a shared running session",
    other: {
      worktreePath: (s) => s.repo,
      hidden: "sideChat",
      session: { cwd: (s) => s.repo, status: "running", multiplexed: true },
    },
  },
  {
    name: "a running side chat",
    other: {
      worktreePath: (s) => s.repo,
      hidden: "sideChat",
      session: { cwd: (s) => s.repo, status: "running" },
    },
    blocked: /a side chat of "Parent work" is still running/,
  },
])(
  "checks file restore against $name",
  ({ restoring = "worktree", other, nestedRepo, undetected, blocked, notified = false }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const parent = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-git-" }),
      );
      const scene: Scene = {
        parent,
        repo: path.join(parent, "repo"),
        nested: path.join(parent, "repo", "nested"),
        sibling: path.join(parent, "sibling"),
        removed: path.join(parent, "removed"),
      };
      yield* fileSystem.makeDirectory(scene.nested, { recursive: true });
      yield* fileSystem.makeDirectory(scene.sibling);
      for (const cwd of [scene.repo, scene.sibling, ...(nestedRepo ? [scene.nested] : [])]) {
        yield* vcsProcess.run({
          operation: "test.init",
          command: "git",
          args: ["init", "--quiet"],
          cwd,
        });
      }
      const restoringPath = restoring === "removed-worktree" ? scene.removed : scene.repo;
      const parentId = ThreadId.make("restore-parent");
      const otherId = ThreadId.make("restore-other");
      const otherThread =
        other === undefined
          ? undefined
          : {
              id: otherId,
              projectId: ProjectId.make("other-project"),
              title: "Other work",
              worktreePath: other.worktreePath(scene),
              lineage: {
                parentThreadId: other.hidden === undefined ? null : parentId,
                relationshipToParent: other.hidden === "subagent" ? "subagent" : null,
                rootThreadId: parentId,
                ...(other.hidden === "sideChat" ? { sideChat: true } : {}),
              },
              deletedAt: null,
              settledAt: other.state === undefined ? null : "2026-01-01",
              archivedAt: other.state === "archived" ? "2026-01-01" : null,
              activeRunId: other.running ? "run" : null,
              pendingBackgroundTasks: other.background ? [{}] : [],
            };
      const result = yield* assessCheckpointRestore(
        {
          id: ThreadId.make("restore-current"),
          projectId: ProjectId.make("restore-project"),
          worktreePath: restoring === "project-root" ? null : restoringPath,
        },
        { cwd: restoringPath },
        {
          fileSystem,
          path,
          vcs: {
            ...registry,
            detect: (input) =>
              input.cwd === undetected?.(scene) ? Effect.succeed(null) : registry.detect(input),
          },
          projects: {
            get: (projectId: ProjectId) =>
              Effect.succeedSome({
                workspaceRoot:
                  projectId === "restore-project"
                    ? scene.repo
                    : (other?.projectRoot?.(scene) ?? scene.sibling),
              }),
          } as never,
          projections: {
            getThread: () => Effect.succeed({ title: "Parent work" }),
            getThreadRecords: (
              _id: ThreadId,
              _fields: unknown,
              options: { turnItemTypes: string[] },
            ) =>
              Effect.succeed({
                turnItems:
                  options.turnItemTypes.includes("file_change") && !other?.qaOnly
                    ? [{ type: "file_change" }]
                    : [],
              }),
            getShellSnapshot: () =>
              Effect.succeed({
                threads:
                  otherThread === undefined || other?.state === "archived" ? [] : [otherThread],
                archivedThreads: other?.state === "archived" ? [otherThread] : [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                checkpointScopes: (other?.scopes?.(scene) ?? []).map((cwd) => ({ cwd })),
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                providerSessions:
                  other?.session === undefined
                    ? []
                    : [
                        {
                          cwd: other.session.cwd(scene),
                          status: other.session.status,
                          capabilities: {
                            sessions: {
                              supportsMultipleProviderThreadsPerSession:
                                other.session.multiplexed === true,
                            },
                          },
                        },
                      ],
              }),
          } as never,
        },
      );
      if (blocked === undefined) assert.isNull(result.blockedMessage);
      else assert.match(result.blockedMessage ?? "", blocked);
      assert.deepEqual(result.noticeThreadIds, notified ? [otherId] : []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(layerVcs, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
);
