import {
  isListedThreadLineage,
  isLiveSubagentShell,
  isProviderNativeSubagentThread,
  repositoryRewindCheckpoint,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type TaskFolderError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

const RESTORE_OUTSIDE_CHECKOUT_MESSAGE =
  "File restore only works for checkpoints taken in this thread's current Git checkout. Rewind the conversation without restoring files instead.";

interface CheckpointRestoreDependencies {
  readonly fileSystem: FileSystem.FileSystem;
  readonly projections: ProjectionStoreV2["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly path: Path.Path;
  readonly vcs: VcsDriverRegistry.VcsDriverRegistry["Service"];
  readonly recreatingWorktreePath?: string;
  readonly repositoryPaths?: ReadonlyArray<string>;
  readonly otherWorkspacePaths?: (
    thread: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath">,
  ) => Effect.Effect<ReadonlyArray<string>, TaskFolderError>;
}

type RestoringThread = Pick<OrchestrationV2AppThread, "id" | "projectId" | "worktreePath">;

export const resolveCheckpointRestorePath = Effect.fn(
  "orchestrationV2.resolveCheckpointRestorePath",
)(function* (
  cwd: string,
  { fileSystem, path }: Pick<CheckpointRestoreDependencies, "fileSystem" | "path">,
) {
  const resolved = path.resolve(cwd);
  let existing = resolved;
  while (!(yield* fileSystem.exists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const root = yield* fileSystem.realPath(existing).pipe(Effect.orElseSucceed(() => existing));
  return { resolved, existing, canonical: path.join(root, path.relative(existing, resolved)) };
});

const makeCheckoutResolver = (
  thread: RestoringThread,
  dependencies: CheckpointRestoreDependencies,
) => {
  const { fileSystem, projects, path, vcs } = dependencies;
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  // `own` lookups belong to the restoring thread: only they may treat its removed worktree,
  // which rollback recreates, as a checkout.
  const cache = new Map<string, { readonly git: boolean; readonly path: string }>();
  // Per-path and per-thread helpers; the exported callers own the span.
  const locate = Effect.fnUntraced(function* (cwd: string, own: boolean) {
    const key = `${own}\0${cwd}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const { resolved, existing, canonical } = yield* resolveCheckpointRestorePath(
      cwd,
      dependencies,
    );
    const recreated =
      own &&
      ((thread.worktreePath !== null &&
        resolved === path.resolve(thread.worktreePath) &&
        (existing !== resolved || dependencies.recreatingWorktreePath === resolved)) ||
        (existing !== resolved &&
          dependencies.repositoryPaths?.some((folder) => path.resolve(folder) === resolved) ===
            true));
    const detected = recreated ? null : yield* vcs.detect({ cwd: existing, requestedKind: "git" });
    const location =
      detected !== null
        ? { git: true, path: yield* realPath(detected.repository.rootPath) }
        : { git: recreated, path: canonical };
    cache.set(key, location);
    return location;
  });
  const workspaceOf = Effect.fnUntraced(function* (
    candidate: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath">,
  ) {
    if (candidate.worktreePath !== null) return candidate.worktreePath;
    const project = yield* projects.get(candidate.projectId, { includeDeleted: true });
    return Option.isSome(project) ? project.value.workspaceRoot : null;
  });
  const checkoutRoot = Effect.fnUntraced(function* () {
    const workspace = yield* workspaceOf(thread);
    if (workspace === null) return null;
    const location = yield* locate(workspace, true);
    return location.git ? location.path : null;
  });
  return { locate, workspaceOf, checkoutRoot };
};

export const checkpointRestoreCheckoutRoots = Effect.fn(
  "orchestrationV2.checkpointRestoreCheckoutRoots",
)(function* (thread: RestoringThread, dependencies: CheckpointRestoreDependencies) {
  const resolver = makeCheckoutResolver(thread, dependencies);
  const root = yield* resolver.checkoutRoot();
  const repositories = yield* Effect.forEach(dependencies.repositoryPaths ?? [], (cwd) =>
    resolver.locate(cwd, true),
  );
  return [
    ...new Set([
      ...(root === null ? [] : [root]),
      ...repositories.filter((location) => location.git).map((location) => location.path),
    ]),
  ];
});

export function repositoryCheckpointsForRestore<
  Checkpoint extends Pick<OrchestrationV2Checkpoint, "runId" | "ordinalWithinScope">,
>(
  checkpoints: ReadonlyArray<Checkpoint>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "checkpointAbandoned">>,
) {
  const abandoned = runs.filter((run) => run.checkpointAbandoned === true);
  const ids = new Set(abandoned.map((run) => run.id));
  const ordinals = new Set(abandoned.map((run) => run.ordinal));
  return checkpoints.filter((checkpoint) =>
    checkpoint.runId === null
      ? !ordinals.has(checkpoint.ordinalWithinScope + 1)
      : !ids.has(checkpoint.runId),
  );
}

export function repositoryRestoreTargets<
  Repository extends Pick<OrchestrationV2CheckpointScope, "id">,
  Checkpoint extends Pick<
    OrchestrationV2Checkpoint,
    "scopeId" | "runId" | "ordinalWithinScope" | "status"
  >,
>(
  repositories: ReadonlyArray<Repository>,
  checkpoints: ReadonlyArray<Checkpoint>,
  targetOrdinal: number,
  currentOrdinal: number,
) {
  return repositories.flatMap((scope) => {
    const history = checkpoints.filter((checkpoint) => checkpoint.scopeId === scope.id);
    const checkpoint =
      repositoryRewindCheckpoint(history, targetOrdinal) ??
      (targetOrdinal > currentOrdinal
        ? (history
            .filter(
              (candidate) =>
                candidate.status === "ready" &&
                candidate.ordinalWithinScope <= targetOrdinal &&
                candidate.ordinalWithinScope > currentOrdinal,
            )
            .toSorted((left, right) => right.ordinalWithinScope - left.ordinalWithinScope)[0] ??
          null)
        : null);
    return checkpoint === null ? [] : [{ scope, checkpoint }];
  });
}

const blockMessage = (
  thread: OrchestrationV2ThreadShell,
  working: boolean,
  parentTitle: string | null,
) => {
  if (!working)
    return `File restore is blocked while "${thread.title}" is active in the same or an overlapping Git checkout. Settle or archive it, or rewind the conversation without restoring files.`;
  const name = isListedThreadLineage(thread.lineage)
    ? `"${thread.title}"`
    : `a ${thread.lineage.sideChat === true ? "side chat" : "subagent"} of ${parentTitle === null ? "another thread" : `"${parentTitle}"`}`;
  return `File restore is blocked while ${name} is still running in the same or an overlapping Git checkout. Wait for it to finish, or rewind the conversation without restoring files.`;
};

/**
 * Restoring rewrites the whole checkout. Listed threads that are not settled or archived block
 * it, as does any thread doing work there. Settled or archived listed threads that changed
 * files there are returned as notice recipients.
 */
export const assessCheckpointRestore = Effect.fn("orchestrationV2.assessCheckpointRestore")(
  function* (
    thread: RestoringThread,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: CheckpointRestoreDependencies,
  ) {
    const { projections, path } = dependencies;
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    const resolver = makeCheckoutResolver(thread, dependencies);
    const root = yield* resolver.checkoutRoot();
    const scopeLocation = yield* resolver.locate(scope.cwd, true);
    const repositories = yield* Effect.forEach(dependencies.repositoryPaths ?? [], (cwd) =>
      resolver.locate(cwd, true),
    );
    const roots = [
      ...new Set([
        ...(root === null ? [] : [root]),
        ...repositories.filter((location) => location.git).map((location) => location.path),
      ]),
    ];
    if (
      roots.length === 0 ||
      (root !== null && (!scopeLocation.git || scopeLocation.path !== root))
    ) {
      return { blockedMessage: RESTORE_OUTSIDE_CHECKOUT_MESSAGE, noticeThreadIds: [] };
    }
    const overlaps = Effect.fnUntraced(function* (cwd: string) {
      const location = yield* resolver.locate(cwd, false);
      // A plain folder only counts inside the checkout; a home-rooted project never does.
      return roots.some(
        (root) => contains(root, location.path) || (location.git && contains(location.path, root)),
      );
    });

    const shell = yield* projections.getShellSnapshot();
    const threads = [...shell.threads, ...shell.archivedThreads];
    const threadsById = new Map(threads.map((other) => [other.id, other]));
    const noticeThreadIds: ThreadId[] = [];
    for (const other of threads) {
      if (other.id === thread.id || other.deletedAt !== null) continue;
      const listed = isListedThreadLineage(other.lineage);
      const { providerSessions } = yield* projections.getThreadProviderContext(other.id);
      // Multiplexed sessions report other threads' turns and opening cwd.
      const sessions = providerSessions.filter(
        (session) =>
          session.status !== "stopped" &&
          !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
      );
      let working =
        other.activeRunId !== null ||
        (other.pendingBackgroundTasks?.length ?? 0) > 0 ||
        (other.lineage.relationshipToParent === "subagent" &&
          isLiveSubagentShell({
            ...other,
            pendingRuntimeRequest: other.pendingRuntimeRequest ?? null,
          })) ||
        sessions.some((session) => session.status === "running" || session.status === "waiting");
      if (!working && isProviderNativeSubagentThread(other)) {
        // Runless native children can leave work on their raw records or an ancestor's provider.
        const { providerThreads, turnItems } = yield* projections.getThreadRecords(
          other.id,
          ["providerThreads", "turnItems"],
          {
            turnItemTypes: ["command_execution", "file_change", "dynamic_tool", "subagent"],
            turnItemStatuses: ["pending", "running", "waiting"],
          },
        );
        working =
          turnItems.length > 0 ||
          providerThreads.some(
            (provider) =>
              provider.status === "active" || (provider.pendingBackgroundTasks?.length ?? 0) > 0,
          );
      }
      if (
        !working &&
        other.lineage.relationshipToParent === "subagent" &&
        other.lineage.parentThreadId !== null &&
        other.forkedFrom?.type === "node"
      ) {
        const taskId = other.forkedFrom.nodeId;
        const { subagents } = yield* projections.getThreadRecords(
          other.lineage.parentThreadId,
          ["subagents"],
          { subagentIds: [taskId] },
        );
        const task = subagents.find(
          (candidate) =>
            candidate.id === taskId &&
            candidate.childThreadId === other.id &&
            candidate.origin ===
              (isProviderNativeSubagentThread(other) ? "provider_native" : "app_owned"),
        );
        working = task?.status === "pending" || task?.status === "running";
        if (task?.origin === "provider_native") {
          const seen = new Set<ThreadId>();
          let parentId: ThreadId | null = other.lineage.parentThreadId;
          while (!working && parentId !== null && !seen.has(parentId)) {
            seen.add(parentId);
            const { providerThreads: providers } = yield* projections.getThreadRecords(parentId, [
              "providerThreads",
            ]);
            if (
              providers.some(
                (provider) =>
                  provider.providerInstanceId === task.providerInstanceId &&
                  (provider.pendingBackgroundTasks?.length ?? 0) > 0,
              )
            ) {
              working = true;
              break;
            }
            const parent = threadsById.get(parentId);
            parentId =
              parent?.lineage.relationshipToParent === "subagent"
                ? parent.lineage.parentThreadId
                : null;
          }
        }
      }
      if (!listed && !working) continue;
      const { checkpointScopes } = yield* projections.getCheckpointContext(other.id);
      if (working || (other.archivedAt === null && other.settledAt === null)) {
        const workspace = yield* resolver.workspaceOf(other);
        for (const cwd of new Set([
          ...(workspace === null ? [] : [workspace]),
          ...checkpointScopes.map((candidate) => candidate.cwd),
          ...(yield* dependencies.otherWorkspacePaths?.(other) ?? Effect.succeed([])),
          ...sessions.map((session) => session.cwd),
        ])) {
          if (!(yield* overlaps(cwd))) continue;
          const parentId = other.lineage.parentThreadId;
          const parentTitle =
            listed || parentId === null
              ? null
              : yield* projections.getThread(parentId).pipe(
                  Effect.map((parent) => parent.title),
                  Effect.orElseSucceed(() => null),
                );
          return {
            blockedMessage: blockMessage(other, working, parentTitle),
            noticeThreadIds: [],
          };
        }
        continue;
      }
      for (const candidate of new Set(checkpointScopes.map((item) => item.cwd))) {
        if (!(yield* overlaps(candidate))) continue;
        const { turnItems } = yield* projections.getThreadRecords(other.id, ["turnItems"], {
          turnItemTypes: ["file_change", "command_execution"],
        });
        if (turnItems.length > 0) noticeThreadIds.push(other.id);
        break;
      }
    }
    return { blockedMessage: null, noticeThreadIds };
  },
);
