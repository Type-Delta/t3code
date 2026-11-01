import {
  isListedThreadLineage,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ThreadShell,
  type ThreadId,
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
}

type RestoringThread = Pick<OrchestrationV2AppThread, "id" | "projectId" | "worktreePath">;

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
    const resolved = path.resolve(cwd);
    let existing = resolved;
    while (!(yield* fileSystem.exists(existing))) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const canonical = path.join(yield* realPath(existing), path.relative(existing, resolved));
    const recreated =
      own &&
      existing !== resolved &&
      thread.worktreePath !== null &&
      resolved === path.resolve(thread.worktreePath);
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

/** The Git checkout a file restore rewrites, or null when the thread has none. */
export const checkpointRestoreCheckoutRoot = Effect.fn(
  "orchestrationV2.checkpointRestoreCheckoutRoot",
)(function* (thread: RestoringThread, dependencies: CheckpointRestoreDependencies) {
  return yield* makeCheckoutResolver(thread, dependencies).checkoutRoot();
});

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
    if (root === null || !scopeLocation.git || scopeLocation.path !== root)
      return { blockedMessage: RESTORE_OUTSIDE_CHECKOUT_MESSAGE, noticeThreadIds: [] };
    const overlaps = Effect.fnUntraced(function* (cwd: string) {
      const location = yield* resolver.locate(cwd, false);
      // A plain folder only counts inside the checkout; a home-rooted project never does.
      return contains(root, location.path) || (location.git && contains(location.path, root));
    });

    const shell = yield* projections.getShellSnapshot();
    const noticeThreadIds: ThreadId[] = [];
    for (const other of [...shell.threads, ...shell.archivedThreads]) {
      if (other.id === thread.id || other.deletedAt !== null) continue;
      const listed = isListedThreadLineage(other.lineage);
      const { providerSessions } = yield* projections.getThreadProviderContext(other.id);
      // Multiplexed sessions report other threads' turns and opening cwd.
      const sessions = providerSessions.filter(
        (session) =>
          session.status !== "stopped" &&
          !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
      );
      const working =
        other.activeRunId !== null ||
        (other.pendingBackgroundTasks?.length ?? 0) > 0 ||
        sessions.some((session) => session.status === "running" || session.status === "waiting");
      if (!listed && !working) continue;
      const { checkpointScopes } = yield* projections.getCheckpointContext(other.id);
      if (working || (other.archivedAt === null && other.settledAt === null)) {
        const workspace = yield* resolver.workspaceOf(other);
        for (const cwd of new Set([
          ...(workspace === null ? [] : [workspace]),
          ...checkpointScopes.map((candidate) => candidate.cwd),
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
