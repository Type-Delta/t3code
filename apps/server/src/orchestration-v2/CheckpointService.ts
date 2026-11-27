import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  type OrchestrationV2AppThread,
  type ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";
// The provider turn waits on the baseline, so a workspace too slow for this starts without one.
// It bounds only the snapshot: waiting on the lock lets an in-flight capture finish the same ref.
const BASELINE_CAPTURE_BUDGET = "5 seconds";
// Git processes are already capped server-wide; this keeps one thread from taking every slot.
const REPOSITORY_SCOPE_CONCURRENCY = 6;

export class CheckpointRootScopePrepareError extends Schema.TaggedError<CheckpointRootScopePrepareError>()(
  "CheckpointRootScopePrepareError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare root checkpoint scope for run ${this.runId}.`;
  }
}

export class CheckpointBaselineCaptureError extends Schema.TaggedError<CheckpointBaselineCaptureError>()(
  "CheckpointBaselineCaptureError",
  {
    scopeId: CheckpointScopeId,
    ordinalWithinScope: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint baseline ${this.ordinalWithinScope} for scope ${this.scopeId}.`;
  }
}

export class CheckpointCaptureError extends Schema.TaggedError<CheckpointCaptureError>()(
  "CheckpointCaptureError",
  {
    scopeId: CheckpointScopeId,
    parentCheckpointId: Schema.optional(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint for scope ${this.scopeId}.`;
  }
}

export class CheckpointRestoreError extends Schema.TaggedError<CheckpointRestoreError>()(
  "CheckpointRestoreError",
  {
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore checkpoint ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export const CheckpointServiceV2Error = Schema.Union([
  CheckpointRootScopePrepareError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

/** Per scope, the other scopes' folders inside its own: relative, `/`-separated. */
type NestedScopePaths = ReadonlyMap<CheckpointScopeId, ReadonlyArray<string>>;

/**
 * A scope leaves a folder that has its own scope to that scope, so a clone inside another checkout
 * is not also recorded as that checkout's gitlink. A submodule stays: its gitlink is the commit
 * its repository pins, which belongs to that repository's changes. Real paths, since a folder can
 * be reached through a symlink.
 */
export const nestedScopePaths = Effect.fn("CheckpointService.nestedScopePaths")(function* (
  scopes: ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "id" | "cwd">>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* Effect.forEach(
    scopes,
    (scope) =>
      fileSystem.realPath(scope.cwd).pipe(
        Effect.orElseSucceed(() => path.resolve(scope.cwd)),
        Effect.map((cwd) => ({ id: scope.id, cwd })),
      ),
    { concurrency: REPOSITORY_SCOPE_CONCURRENCY },
  );
  const nested = new Map<CheckpointScopeId, ReadonlyArray<string>>();
  for (const outer of resolved) {
    const inside = resolved.flatMap((inner) => {
      const relative = path.relative(outer.cwd, inner.cwd);
      return relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
        ? []
        : [relative.split(path.sep).join("/")];
    });
    if (inside.length === 0) continue;
    const submodules = new Set(
      WorkspaceFolders.parseGitmodulesPaths(
        yield* fileSystem
          .readFileString(path.join(outer.cwd, ".gitmodules"))
          .pipe(Effect.orElseSucceed(() => "")),
      ),
    );
    const excluded = [...new Set(inside)].filter((relative) => !submodules.has(relative));
    if (excluded.length > 0) nested.set(outer.id, excluded);
  }
  return nested as NestedScopePaths;
});

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  /**
   * One scope per tracked Git folder the thread reaches now, under its root scope. Ids depend only
   * on the thread and the tracked path, so every run names the same scope. Empty when the folders
   * cannot be read: the thread then runs with its root scope alone.
   */
  readonly repositoryScopes: (input: {
    readonly rootScope: OrchestrationV2CheckpointScope;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2CheckpointScope>>;
  /** As `repositoryScopes`, but null when the folders cannot be read: a rewind must not guess. */
  readonly repositoryScopesIfReadable: (input: {
    readonly rootScope: OrchestrationV2CheckpointScope;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2CheckpointScope> | null>;
  readonly nestedScopePaths: (
    scopes: ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "id" | "cwd">>,
  ) => Effect.Effect<NestedScopePaths>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /**
     * Also baselines the tracked repositories this thread reaches, a few at a time and all within
     * one budget, so many repositories delay a turn no longer than one. A repository that misses
     * the budget has no baseline this turn.
     */
    readonly thread?: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath">;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /** The run materializing the baseline: its root node, and when it was requested. */
    readonly nodeId: NodeId;
    readonly capturedAt: DateTime.Utc;
    /** Records a missing checkpoint without touching git, for side chats sharing a parent's worktree. */
    readonly forceMissing?: boolean;
    readonly boundaryRef?: CheckpointRef | null;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly baselineOrdinalWithinScope?: number;
    readonly capturedAt: DateTime.Utc;
    readonly forceMissing?: boolean;
    readonly excludePaths?: ReadonlyArray<string>;
    /** `capturesSoFar` from before an earlier wait on the folder's lock, when there was one. */
    readonly capturesBeforeLock?: number;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  /** How many captures have finished in a folder, for a caller that waits on it before `capture`. */
  readonly capturesSoFar: (cwd: string) => Effect.Effect<number>;
  /**
   * A tracked repository's checkpoint for a run, with the baseline before it unless that is
   * already recorded. None when the run left the repository as it found it, which costs one
   * status and writes nothing: a project can track dozens of repositories a turn never touches.
   */
  readonly captureRepository: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly capturedAt: DateTime.Utc;
    readonly baselineCapturedAt: DateTime.Utc;
    readonly baselineRecorded: boolean;
    readonly excludePaths?: ReadonlyArray<string>;
  }) => Effect.Effect<
    Option.Option<{
      readonly baseline: OrchestrationV2Checkpoint | null;
      readonly checkpoint: OrchestrationV2Checkpoint;
    }>,
    CheckpointServiceV2Error
  >;
  /**
   * Restores a thread's folders together. Every snapshot is checked before a folder changes and
   * each folder is snapshotted first, so a restore that fails puts back the ones already
   * restored: a rewind changes all of them or none.
   */
  readonly restore: (input: {
    readonly targets: ReadonlyArray<{
      readonly scope: Pick<OrchestrationV2CheckpointScope, "id" | "cwd">;
      readonly checkpoint: Pick<
        OrchestrationV2Checkpoint,
        "id" | "ordinalWithinScope" | "ref" | "status"
      >;
    }>;
    /** Every folder of the thread with checkpoints of its own; a restore leaves the others' alone. */
    readonly scopes: ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "id" | "cwd">>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /**
   * Fails like `restore` when evicted file versions cannot be downloaded,
   * without changing files. They stay local until the scope closes.
   */
  readonly prepareRestore: (
    input: Parameters<CheckpointServiceV2Shape["restore"]>[0],
  ) => Effect.Effect<void, CheckpointServiceV2Error, Scope.Scope>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

const scopeRef = Effect.fnUntraced(function* (scopeId: CheckpointScopeId, name: string) {
  const crypto = yield* Digest.Digest;
  const digest = yield* crypto
    .digest(Digest.sha256, new TextEncoder().encode(scopeId))
    .pipe(Effect.orDie);
  const scopeKey = Hex.encode(digest).slice(0, 32);
  return CheckpointRef.make(`${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}/${name}`);
});

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) =>
    scopeRef(input.scopeId, `ordinal/${input.ordinalWithinScope}`),
);

/**
 * Snapshot id of a scope boundary in the private sidecar repository. Keeps the
 * readable form the sidecar used before, and hashes a scope id too long for a
 * snapshot id.
 */
export const sidecarSnapshotIdForScopeOrdinal = Effect.fn("sidecarSnapshotIdForScopeOrdinal")(
  function* (input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
    readonly purpose?: "baseline" | "pre-rewind";
  }) {
    const prefix = input.purpose === undefined ? "" : `${input.purpose}-`;
    const readable = `${prefix}orchestration-v2-${Base64Url.encode(String(input.scopeId))}-${input.ordinalWithinScope}`;
    if (readable.length <= 256) return readable;
    const crypto = yield* Digest.Digest;
    const digest = yield* crypto
      .digest(Digest.sha256, new TextEncoder().encode(input.scopeId))
      .pipe(Effect.orDie);
    return `${prefix}orchestration-v2-h${Hex.encode(digest)}-${input.ordinalWithinScope}`;
  },
);

function checkpointIdForScopeOrdinal(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
  },
) {
  return idAllocator.allocate.checkpoint({
    checkpointScopeId: input.scopeId,
    name: String(input.ordinalWithinScope),
  });
}

const makeRootRunScope = Effect.fn("CheckpointService.makeRootRunScope")(function* (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly createdAt: DateTime.Utc;
}) {
  const scopeId = yield* input.idAllocator.allocate.checkpointScope({
    threadId: input.threadId,
    name: ROOT_CHECKPOINT_SCOPE_NAME,
  });
  return {
    id: scopeId,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.rootNodeId,
    parentScopeId: null,
    providerThreadId: input.providerThreadId,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: input.cwd,
    createdAt: input.createdAt,
  } satisfies OrchestrationV2CheckpointScope;
});

function makeCheckpoint(input: {
  readonly id: CheckpointId;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly parentCheckpointId: CheckpointId | null;
  readonly ordinalWithinScope: number;
  readonly appRunOrdinal: number | null;
  readonly ref: CheckpointRef;
  readonly status: OrchestrationV2Checkpoint["status"];
  readonly files: OrchestrationV2Checkpoint["files"];
  readonly capturedAt: DateTime.Utc;
}): OrchestrationV2Checkpoint {
  return {
    id: input.id,
    threadId: input.scope.threadId,
    scopeId: input.scope.id,
    runId: input.runId,
    nodeId: input.nodeId,
    parentCheckpointId: input.parentCheckpointId,
    ordinalWithinScope: input.ordinalWithinScope,
    appRunOrdinal: input.appRunOrdinal,
    ref: input.ref,
    status: input.status,
    files: input.files,
    capturedAt: input.capturedAt,
  };
}

export const layer: Layer.Layer<
  CheckpointServiceV2,
  never,
  | CheckpointStore.CheckpointStore
  | Digest.Digest
  | IdAllocator.IdAllocatorV2
  | WorkspaceFolders.WorkspaceFolders
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Digest.Digest;
    const legacyRefFor = (scope: OrchestrationV2CheckpointScope, ordinalWithinScope: number) =>
      checkpointRefForScopeOrdinal({ scopeId: scope.id, ordinalWithinScope }).pipe(
        Effect.provideService(Digest.Digest, crypto),
      );
    // New boundaries live in T3's private sidecar repository, so capture never
    // writes refs or objects into the project repository.
    const sidecarRefFor = (
      scope: OrchestrationV2CheckpointScope,
      ordinalWithinScope: number,
      purpose?: "baseline",
    ) =>
      sidecarSnapshotIdForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope,
        ...(purpose === undefined ? {} : { purpose }),
      }).pipe(
        Effect.provideService(Digest.Digest, crypto),
        Effect.flatMap((snapshotId) =>
          checkpointStore.allocateCheckpointRef({
            cwd: scope.cwd,
            snapshotId,
          }),
        ),
      );
    // The stored ref for a boundary: its sidecar snapshot, or an in-repo ref
    // captured while V2 wrote checkpoints into the project repository.
    const findBoundaryRef = Effect.fn("CheckpointService.findBoundaryRef")(function* (
      scope: OrchestrationV2CheckpointScope,
      ordinalWithinScope: number,
    ) {
      const sidecarRef = yield* sidecarRefFor(scope, ordinalWithinScope);
      if (yield* checkpointStore.hasCheckpointRef({ cwd: scope.cwd, checkpointRef: sidecarRef })) {
        return sidecarRef;
      }
      const legacyRef = yield* legacyRefFor(scope, ordinalWithinScope);
      return (yield* checkpointStore.hasCheckpointRef({
        cwd: scope.cwd,
        checkpointRef: legacyRef,
      }))
        ? legacyRef
        : null;
    });
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const workspaceLocks = yield* KeyedLock.make<string>();
    const withWorkspaceLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      workspaceLocks.withLock(cwd, effect);

    const captureTimeouts = yield* Cache.make<string, number>({
      capacity: 128,
      lookup: () => Effect.succeed(0),
    });
    // Unlike the streak, a success never rewinds the count, so a waiter can order outcomes. A
    // baseline running out of its short budget is not a post-turn capture timing out.
    const lastCaptures = new Map<string, { readonly count: number; readonly timedOut: boolean }>();
    const noteCapture = (cwd: string, timedOut: boolean) =>
      Effect.sync(() => {
        lastCaptures.set(cwd, { count: (lastCaptures.get(cwd)?.count ?? 0) + 1, timedOut });
      });
    const capturesSoFar = (cwd: string) => lastCaptures.get(cwd)?.count ?? 0;
    const withCaptureLock = Effect.fn("CheckpointService.withCaptureLock")(function* <A, E, R>(
      cwd: string,
      capturesBeforeLock: number | undefined,
      effect: (capturesBeforeLock: number) => Effect.Effect<A, E, R>,
    ) {
      return yield* withWorkspaceLock(cwd, effect(capturesBeforeLock ?? capturesSoFar(cwd)));
    });
    // Both callers hold the workspace lock; post-turn captures always probe for recovery.
    const captureWorkspaceCheckpoint = Effect.fn("CheckpointService.captureWorkspaceCheckpoint")(
      function* (input: CheckpointStore.CaptureCheckpointInput, baseline = false) {
        return yield* checkpointStore.captureCheckpoint(input).pipe(
          Effect.tap(() =>
            Effect.andThen(
              Cache.invalidate(captureTimeouts, input.cwd),
              noteCapture(input.cwd, false),
            ),
          ),
          Effect.tapError((error) =>
            error._tag === "VcsProcessTimeoutError"
              ? Effect.gen(function* () {
                  const previous = yield* Cache.get(captureTimeouts, input.cwd);
                  yield* Cache.set(captureTimeouts, input.cwd, previous + 1);
                  yield* noteCapture(input.cwd, !baseline);
                })
              : Effect.andThen(
                  Cache.invalidate(captureTimeouts, input.cwd),
                  noteCapture(input.cwd, false),
                ),
          ),
        );
      },
    );

    // A failed probe is an operational error, not proof that the workspace has no repository.
    const probeRepository = (scope: OrchestrationV2CheckpointScope) =>
      checkpointStore.isGitRepository(scope.cwd).pipe(
        Effect.map((isRepository) =>
          isRepository ? ("repository" as const) : ("missing" as const),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("orchestration V2 checkpoint repository probe failed", {
            scopeId: scope.id,
            cause: String(cause),
          }).pipe(Effect.as("error" as const)),
        ),
      );

    const capturesInFlight = new Set<string>();
    const boundaryKey = (scope: OrchestrationV2CheckpointScope, ordinal: number) =>
      `${scope.cwd}\0${scope.id}\0${ordinal}`;

    // What this process knows of each repository scope's folder as of a run ordinal. With
    // `cleanHead` the folder matched that commit exactly, and no snapshot ref need exist until a
    // turn changes it; null means the ordinal's ref holds its state. Unknown after a restart.
    const repositoryStates = new Map<
      CheckpointScopeId,
      {
        readonly ordinal: number;
        readonly cleanHead: string | null;
        readonly ref: CheckpointRef | null;
        /** Epoch seconds. */
        readonly seenAt: number;
      }
    >();
    const noteRepositoryState = Effect.fnUntraced(function* (
      scopeId: CheckpointScopeId,
      state: Omit<NonNullable<ReturnType<typeof repositoryStates.get>>, "seenAt">,
    ) {
      const seenAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      repositoryStates.set(scopeId, { ...state, seenAt });
    });

    const captureScopeBaseline = Effect.fn("CheckpointService.captureScopeBaseline")(
      function* (input: {
        readonly scope: OrchestrationV2CheckpointScope;
        readonly ordinalWithinScope: number;
        readonly excludePaths: ReadonlyArray<string> | undefined;
      }) {
        const { scope, ordinalWithinScope, excludePaths } = input;
        const baselineExists = Effect.gen(function* () {
          return (
            capturesInFlight.has(boundaryKey(scope, ordinalWithinScope)) ||
            (yield* findBoundaryRef(scope, ordinalWithinScope)) !== null
          );
        });
        if (!(yield* checkpointStore.isGitRepository(scope.cwd)) || (yield* baselineExists)) return;
        yield* withWorkspaceLock(
          scope.cwd,
          Effect.gen(function* () {
            if (yield* baselineExists) return;
            const timeouts = yield* Cache.getOption(captureTimeouts, scope.cwd);
            if (Option.isSome(timeouts) && timeouts.value >= 2) return;
            yield* captureWorkspaceCheckpoint(
              {
                cwd: scope.cwd,
                checkpointRef: yield* sidecarRefFor(scope, ordinalWithinScope),
                ...(excludePaths === undefined ? {} : { excludePaths }),
              },
              true,
            ).pipe(Effect.catchTags({ VcsUnsupportedOperationError: () => Effect.void }));
          }),
        ).pipe(
          Effect.timeout(BASELINE_CAPTURE_BUDGET),
          Effect.tapError((error) =>
            error._tag === "TimeoutError"
              ? Effect.gen(function* () {
                  const previous = yield* Cache.get(captureTimeouts, scope.cwd);
                  yield* Cache.set(captureTimeouts, scope.cwd, previous + 1);
                  yield* noteCapture(scope.cwd, false);
                })
              : Effect.void,
          ),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointBaselineCaptureError({
                scopeId: input.scope.id,
                ordinalWithinScope: input.ordinalWithinScope,
                cause,
              }),
          ),
        ),
    );

    // A clean repository is only noted, which costs one status. One with uncommitted work is
    // snapshotted now, before the turn can change it.
    const noteRepositoryBaseline = (input: {
      readonly scope: OrchestrationV2CheckpointScope;
      readonly ordinalWithinScope: number;
      readonly excludePaths: ReadonlyArray<string> | undefined;
    }) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          const { cwd, id } = input.scope;
          // Usually the state its last run ended with, so most turns start without asking Git.
          if (repositoryStates.get(id)?.ordinal === input.ordinalWithinScope) return;
          const cleanHead = yield* checkpointStore.resolveCleanHead(cwd);
          const ref =
            cleanHead === null
              ? yield* sidecarRefFor(input.scope, input.ordinalWithinScope, "baseline")
              : null;
          if (ref !== null) {
            yield* captureWorkspaceCheckpoint(
              {
                cwd,
                checkpointRef: ref,
                ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
              },
              true,
            );
          }
          yield* noteRepositoryState(id, { ordinal: input.ordinalWithinScope, cleanHead, ref });
        }),
      );

    const materializeBaselineCheckpoint: CheckpointServiceV2Shape["materializeBaselineCheckpoint"] =
      (input) =>
        withWorkspaceLock(
          input.scope.cwd,
          Effect.gen(function* () {
            const legacyRef = yield* legacyRefFor(input.scope, input.ordinalWithinScope);
            const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const repository =
              input.forceMissing === true ? "missing" : yield* probeRepository(input.scope);
            const stored =
              repository === "repository"
                ? yield* (
                    input.boundaryRef === undefined
                      ? findBoundaryRef(input.scope, input.ordinalWithinScope)
                      : Effect.succeed(input.boundaryRef)
                  ).pipe(
                    Effect.map((ref) => ({
                      ref,
                      status: ref === null ? ("missing" as const) : ("ready" as const),
                    })),
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                        scopeId: input.scope.id,
                        ordinalWithinScope: input.ordinalWithinScope,
                        cause: String(cause),
                      }).pipe(Effect.as({ ref: null, status: "error" as const })),
                    ),
                  )
                : { ref: null, status: repository };
            const checkpointRef = stored.ref ?? legacyRef;
            const status = stored.status;
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status,
              files: [],
              capturedAt: input.capturedAt,
            });
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        );

    const captureSummarized = (
      input: Parameters<CheckpointServiceV2Shape["capture"]>[0] & {
        /** The commit a clean folder matches, which then needs no staging to snapshot. */
        readonly cleanHead?: string;
        readonly previousCheckpointRef?: CheckpointRef | null;
      },
    ) =>
      withCaptureLock(input.scope.cwd, input.capturesBeforeLock, (capturesBeforeLock) =>
        Effect.gen(function* () {
          const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const baselineOrdinal =
            input.baselineOrdinalWithinScope ?? Math.max(0, input.ordinalWithinScope - 1);
          const parentCheckpointId =
            input.ordinalWithinScope > 0
              ? yield* checkpointIdForScopeOrdinal(idAllocator, {
                  scopeId: input.scope.id,
                  ordinalWithinScope: baselineOrdinal,
                })
              : null;
          const repository =
            input.forceMissing === true ? "missing" : yield* probeRepository(input.scope);
          if (repository !== "repository") {
            return {
              checkpoint: makeCheckpoint({
                id: checkpointId,
                scope: input.scope,
                runId: input.runId,
                nodeId: input.nodeId,
                parentCheckpointId,
                ordinalWithinScope: input.ordinalWithinScope,
                appRunOrdinal: input.appRunOrdinal,
                ref: yield* legacyRefFor(input.scope, input.ordinalWithinScope),
                status: repository,
                files: [],
                capturedAt: input.capturedAt,
              }),
              summaryFailed: false,
            };
          }

          const checkpointRef = yield* sidecarRefFor(input.scope, input.ordinalWithinScope);
          const previousCheckpointRef =
            input.previousCheckpointRef !== undefined
              ? input.previousCheckpointRef
              : yield* findBoundaryRef(input.scope, baselineOrdinal).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                      scopeId: input.scope.id,
                      ordinalWithinScope: baselineOrdinal,
                      cause: String(cause),
                    }).pipe(Effect.as(null)),
                  ),
                );
          const captureInput = {
            cwd: input.scope.cwd,
            checkpointRef,
            ...(input.ordinalWithinScope > 0 && previousCheckpointRef !== null
              ? { previousCheckpointRef }
              : {}),
            ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
          };

          // Threads sharing a folder queue on its lock. One that waited out another's timeout
          // would only time out again while its own queued messages wait behind it.
          const lastCapture = lastCaptures.get(input.scope.cwd);
          const timedOutWhileWaiting =
            input.cleanHead === undefined &&
            lastCapture !== undefined &&
            lastCapture.timedOut &&
            lastCapture.count > capturesBeforeLock;
          type Captured = { readonly status: "ready" | "missing" | "error" };
          const snapshot: Effect.Effect<Captured, CheckpointStoreError> = (
            input.cleanHead === undefined
              ? captureWorkspaceCheckpoint(captureInput)
              : checkpointStore.captureHeadCheckpoint({ ...captureInput, head: input.cleanHead })
          ).pipe(Effect.as({ status: "ready" as const }));
          const captured: Captured = timedOutWhileWaiting
            ? yield* Effect.logWarning(
                "orchestration V2 checkpoint capture skipped after a capture timed out in its folder",
                { scopeId: input.scope.id, checkpointRef },
              ).pipe(Effect.as({ status: "error" as const }))
            : yield* snapshot.pipe(
                Effect.catchTags({
                  VcsUnsupportedOperationError: () =>
                    Effect.succeed({ status: "missing" as const }),
                }),
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration V2 checkpoint capture failed", {
                    scopeId: input.scope.id,
                    checkpointRef,
                    cause: String(cause),
                  }).pipe(Effect.as({ status: "error" as const })),
                ),
              );

          if (captured.status !== "ready") {
            return {
              checkpoint: makeCheckpoint({
                id: checkpointId,
                scope: input.scope,
                runId: input.runId,
                nodeId: input.nodeId,
                parentCheckpointId,
                ordinalWithinScope: input.ordinalWithinScope,
                appRunOrdinal: input.appRunOrdinal,
                ref: checkpointRef,
                status: captured.status,
                files: [],
                capturedAt: input.capturedAt,
              }),
              summaryFailed: false,
            };
          }

          const refs = {
            cwd: input.scope.cwd,
            fromCheckpointRef: previousCheckpointRef ?? checkpointRef,
            toCheckpointRef: checkpointRef,
          };
          // A pull or rebase can change thousands of files the turn did not write.
          const files =
            previousCheckpointRef === null
              ? []
              : yield* Effect.all([
                  checkpointStore.diffCheckpoints({
                    ...refs,
                    fallbackFromToHead: false,
                    ignoreWhitespace: false,
                    format: "numstat",
                    allowNetwork: false,
                    // An earlier checkpoint can predate a nested folder getting its own scope.
                    ...(input.excludePaths === undefined
                      ? {}
                      : { excludePaths: input.excludePaths }),
                  }),
                  checkpointStore.listAuthoredPaths(refs).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
                        scopeId: input.scope.id,
                        checkpointRef,
                        cause: String(cause),
                      }).pipe(Effect.as(null)),
                    ),
                  ),
                ]).pipe(
                  Effect.map(([diff, authoredPaths]) =>
                    parseTurnDiffFilesFromNumstat(diff)
                      .filter((file) => !isGitImport(file, authoredPaths))
                      .map((file) => ({
                        path: file.path,
                        kind: "modified",
                        additions: file.additions,
                        deletions: file.deletions,
                      })),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
                      scopeId: input.scope.id,
                      checkpointRef,
                      cause: String(cause),
                    }).pipe(Effect.as(null)),
                  ),
                );

          return {
            checkpoint: makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: "ready",
              files: files ?? [],
              capturedAt: input.capturedAt,
            }),
            summaryFailed: files === null,
          };
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointCaptureError({
              scopeId: input.scope.id,
              cause,
            }),
        ),
      );

    const capture = (input: Parameters<typeof captureSummarized>[0]) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const key = boundaryKey(input.scope, input.ordinalWithinScope);
          capturesInFlight.add(key);
          return key;
        }),
        () => captureSummarized(input).pipe(Effect.map((captured) => captured.checkpoint)),
        (key) => Effect.sync(() => capturesInFlight.delete(key)),
      );

    const resolveNestedScopePaths: CheckpointServiceV2Shape["nestedScopePaths"] = (scopes) =>
      nestedScopePaths(scopes).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

    type RestoreInput = Parameters<CheckpointServiceV2Shape["restore"]>[0];
    type RestoreTarget = RestoreInput["targets"][number];
    const restoreFailure = (target: RestoreTarget, cause: unknown) =>
      Effect.fail(
        new CheckpointRestoreError({
          scopeId: target.scope.id,
          checkpointId: target.checkpoint.id,
          cause,
        }),
      );
    const restoreFolder = (target: RestoreTarget, nested: NestedScopePaths) => {
      const excludePaths = nested.get(target.scope.id);
      return { cwd: target.scope.cwd, ...(excludePaths === undefined ? {} : { excludePaths }) };
    };
    const prepareRestore: CheckpointServiceV2Shape["prepareRestore"] = Effect.fn(
      "CheckpointService.prepareRestore",
    )(function* (input) {
      const nested = yield* resolveNestedScopePaths(input.scopes);
      for (const target of input.targets) {
        if (target.checkpoint.status !== "ready") {
          return yield* restoreFailure(target, `Checkpoint status is ${target.checkpoint.status}.`);
        }
        yield* checkpointStore
          .prepareRestoreCheckpoint({
            ...restoreFolder(target, nested),
            checkpointRef: target.checkpoint.ref,
          })
          .pipe(Effect.catch((cause) => restoreFailure(target, cause)));
      }
    });

    const restore: CheckpointServiceV2Shape["restore"] = Effect.fn("CheckpointService.restore")(
      function* (input) {
        const nested = yield* resolveNestedScopePaths(input.scopes);
        const snapshots: Array<{
          readonly folder: Omit<CheckpointStore.RestoreCheckpointInput, "fallbackToHead">;
          readonly target: RestoreTarget;
          readonly reused: boolean;
          applied: boolean;
        }> = [];
        const unrecovered = new Set<CheckpointRef>();
        const restoreSnapshots = Effect.gen(function* () {
          yield* prepareRestore(input);
          for (const target of input.targets) {
            const folder = restoreFolder(target, nested);
            const snapshotId = yield* sidecarSnapshotIdForScopeOrdinal({
              scopeId: target.scope.id,
              ordinalWithinScope: 0,
              purpose: "pre-rewind",
            }).pipe(Effect.provideService(Digest.Digest, crypto));
            const snapshot = yield* Effect.gen(function* () {
              const checkpointRef = yield* checkpointStore.allocateCheckpointRef({
                cwd: folder.cwd,
                snapshotId,
              });
              const snapshot = { ...folder, checkpointRef };
              const reused = yield* checkpointStore.hasCheckpointRef(snapshot);
              if (!reused) yield* checkpointStore.captureCheckpoint(snapshot);
              return { folder: snapshot, reused };
            }).pipe(Effect.catch((cause) => restoreFailure(target, cause)));
            snapshots.push({ ...snapshot, target, applied: false });
            yield* checkpointStore
              .prepareRestoreCheckpoint(snapshot.folder)
              .pipe(Effect.catch((cause) => restoreFailure(target, cause)));
          }
          for (const snapshot of snapshots) {
            const { target } = snapshot;
            snapshot.applied = true;
            const restored = yield* checkpointStore
              .restoreCheckpoint({
                ...restoreFolder(target, nested),
                checkpointRef: target.checkpoint.ref,
                fallbackToHead: false,
              })
              .pipe(Effect.catch((cause) => restoreFailure(target, cause)));
            if (!restored) return yield* restoreFailure(target, "Checkpoint ref is unavailable.");
            repositoryStates.delete(target.scope.id);
          }
        }).pipe(
          Effect.onError(() =>
            Effect.forEach(
              snapshots.toReversed().filter((snapshot) => snapshot.applied),
              ({ folder }) =>
                checkpointStore.restoreCheckpoint(folder).pipe(
                  Effect.filterOrFail(Boolean, () => "Pre-restore snapshot is unavailable."),
                  Effect.catchCause((cause) => {
                    unrecovered.add(folder.checkpointRef);
                    return Effect.logWarning("A failed rewind left a folder partly restored", {
                      cwd: folder.cwd,
                      preRewindRef: folder.checkpointRef,
                      cause,
                    });
                  }),
                ),
              { discard: true },
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.forEach(
                snapshots.filter(
                  ({ folder, applied, reused }) =>
                    (applied || !reused) && !unrecovered.has(folder.checkpointRef),
                ),
                ({ folder }) =>
                  checkpointStore
                    .deleteCheckpointRefs({
                      cwd: folder.cwd,
                      checkpointRefs: [folder.checkpointRef],
                    })
                    .pipe(Effect.ignore),
                { discard: true },
              ),
            ),
          ),
          Effect.scoped,
        );
        const workspaces = [...new Set(input.targets.map((target) => target.scope.cwd))].sort();
        yield* workspaces.reduceRight(
          (effect, cwd) => withWorkspaceLock(cwd, effect),
          restoreSnapshots,
        );
      },
    );

    const repositoryScopesIfReadable: CheckpointServiceV2Shape["repositoryScopesIfReadable"] =
      Effect.fn("CheckpointService.repositoryScopes")(
        function* (input) {
          const workspace = yield* workspaceFolders.forThread(input);
          const submodules = yield* workspaceFolders.submodules({
            ...input,
            folders: workspace.folders,
          });
          return yield* Effect.forEach(
            [...workspace.folders.filter((folder) => folder.isGitRepository), ...submodules],
            (folder) =>
              idAllocator.allocate
                .checkpointScope({
                  threadId: input.rootScope.threadId,
                  name: `repository:${folder.repositoryPath ?? folder.path}`,
                })
                .pipe(
                  Effect.map(
                    (id) =>
                      ({
                        id,
                        threadId: input.rootScope.threadId,
                        runId: input.rootScope.runId,
                        nodeId: input.rootScope.nodeId,
                        parentScopeId: input.rootScope.id,
                        providerThreadId: input.rootScope.providerThreadId,
                        kind: "manual",
                        ordinalWithinParent: 1,
                        advancesAppRunCount: false,
                        cwd: folder.path,
                        label: folder.name,
                        repositoryPath: folder.repositoryPath ?? folder.path,
                        createdAt: input.rootScope.createdAt,
                      }) satisfies OrchestrationV2CheckpointScope,
                  ),
                ),
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 repository checkpoint scopes unavailable", {
                threadId: input.rootScope.threadId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          ),
      );
    const repositoryScopes: CheckpointServiceV2Shape["repositoryScopes"] = (input) =>
      repositoryScopesIfReadable(input).pipe(Effect.map((scopes) => scopes ?? []));

    const captureRepositoryBaselines = Effect.fn("CheckpointService.captureRepositoryBaselines")(
      function* (input: {
        readonly scopes: ReadonlyArray<OrchestrationV2CheckpointScope>;
        readonly ordinalWithinScope: number;
        readonly nested: NestedScopePaths;
      }) {
        const captured = yield* Effect.forEach(
          input.scopes,
          (scope) =>
            noteRepositoryBaseline({
              scope,
              ordinalWithinScope: input.ordinalWithinScope,
              excludePaths: input.nested.get(scope.id),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 repository baseline capture failed", {
                  scopeId: scope.id,
                  cause,
                }),
              ),
            ),
          { concurrency: REPOSITORY_SCOPE_CONCURRENCY, discard: true },
        ).pipe(Effect.timeoutOption(BASELINE_CAPTURE_BUDGET));
        if (Option.isNone(captured)) {
          yield* Effect.logWarning(
            "orchestration V2 repository baselines ran out of time; the rest start without one",
            { scopeCount: input.scopes.length },
          );
        }
      },
    );

    const captureRepository: CheckpointServiceV2Shape["captureRepository"] = Effect.fn(
      "CheckpointService.captureRepository",
    )(function* (input) {
      const { cwd, id } = input.scope;
      const baselineOrdinal = input.ordinalWithinScope - 1;
      const capturesBeforeLock = capturesSoFar(cwd);
      const start = yield* withWorkspaceLock(
        cwd,
        Effect.gen(function* () {
          const cleanHead = yield* checkpointStore
            .resolveCleanHead(cwd)
            .pipe(Effect.orElseSucceed(() => null));
          const stored = repositoryStates.get(id);
          const known = stored?.ordinal === baselineOrdinal ? stored : undefined;
          const cleanAtStart = known?.cleanHead ?? null;
          const unchanged = { changed: false as const, cleanHead };
          if (cleanHead !== null && cleanAtStart === cleanHead) return unchanged;
          let ref = known?.ref ?? null;
          if (known === undefined) {
            const prepared = yield* sidecarRefFor(input.scope, baselineOrdinal, "baseline");
            ref = (yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef: prepared }))
              ? prepared
              : yield* findBoundaryRef(input.scope, baselineOrdinal);
          } else if (ref === null && cleanAtStart !== null) {
            // Use a distinct ref if the ordinal already names a branch the user rewound.
            const prepared = yield* sidecarRefFor(input.scope, baselineOrdinal, "baseline");
            ref = yield* checkpointStore
              .captureHeadCheckpoint({
                cwd,
                checkpointRef: prepared,
                head: cleanAtStart,
                seenAt: known.seenAt,
                ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
              })
              .pipe(
                Effect.as(prepared),
                Effect.orElseSucceed(() => null),
              );
          }
          if (ref === null && known === undefined && cleanHead !== null) return unchanged;
          return { changed: true as const, cleanHead, ref };
        }).pipe(Effect.mapError((cause) => new CheckpointCaptureError({ scopeId: id, cause }))),
      );
      const settled = { ordinal: input.ordinalWithinScope, cleanHead: start.cleanHead };
      if (!start.changed) {
        yield* noteRepositoryState(id, { ...settled, ref: null });
        return Option.none();
      }
      const baseline = input.baselineRecorded
        ? null
        : yield* materializeBaselineCheckpoint({
            scope: input.scope,
            ordinalWithinScope: baselineOrdinal,
            nodeId: input.nodeId,
            capturedAt: input.baselineCapturedAt,
            boundaryRef: start.ref,
          });
      const { checkpoint, summaryFailed } = yield* captureSummarized({
        scope: input.scope,
        runId: input.runId,
        nodeId: input.nodeId,
        ordinalWithinScope: input.ordinalWithinScope,
        appRunOrdinal: null,
        capturedAt: input.capturedAt,
        capturesBeforeLock,
        previousCheckpointRef: start.ref,
        ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
        ...(start.cleanHead === null ? {} : { cleanHead: start.cleanHead }),
      });
      if (checkpoint.status !== "ready") {
        repositoryStates.delete(id);
        return Option.some({ baseline, checkpoint });
      }
      yield* noteRepositoryState(id, { ...settled, ref: checkpoint.ref });
      // A pull or a commit of what was already there moves the snapshot and lists no file.
      return !summaryFailed &&
        checkpoint.files.length === 0 &&
        (baseline === null || baseline.status === "ready")
        ? Option.none()
        : Option.some({ baseline, checkpoint });
    });

    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = Effect.fn(
      "CheckpointService.captureBaseline",
    )(function* (input) {
      const repositories =
        input.thread === undefined
          ? []
          : yield* repositoryScopes({ rootScope: input.scope, ...input.thread });
      if (repositories.length === 0) {
        return yield* captureScopeBaseline({ ...input, excludePaths: undefined });
      }
      const nested = yield* resolveNestedScopePaths([input.scope, ...repositories]);
      // Side by side, so the repositories add no wait of their own; the thread folder's failure
      // is still the caller's to report once they have had their turn.
      const [root] = yield* Effect.all(
        [
          Effect.exit(captureScopeBaseline({ ...input, excludePaths: nested.get(input.scope.id) })),
          captureRepositoryBaselines({
            scopes: repositories,
            ordinalWithinScope: input.ordinalWithinScope,
            nested,
          }),
        ],
        { concurrency: 2 },
      );
      if (Exit.isFailure(root)) return yield* Effect.failCause(root.cause);
    });

    return CheckpointServiceV2.of({
      prepareRootRunScope: (input) =>
        makeRootRunScope({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointRootScopePrepareError({
                threadId: input.threadId,
                runId: input.runId,
                cause,
              }),
          ),
        ),
      repositoryScopes,
      repositoryScopesIfReadable,
      nestedScopePaths: resolveNestedScopePaths,
      captureBaseline,
      materializeBaselineCheckpoint,
      capture,
      capturesSoFar: (cwd: string) => Effect.sync(() => capturesSoFar(cwd)),
      captureRepository,
      restore,
      prepareRestore,
    } satisfies CheckpointServiceV2Shape);
  }),
);
