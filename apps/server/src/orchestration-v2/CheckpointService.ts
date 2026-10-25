import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";

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

export class CheckpointScopeEnsureError extends Schema.TaggedError<CheckpointScopeEnsureError>()(
  "CheckpointScopeEnsureError",
  {
    scopeId: CheckpointScopeId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ensure checkpoint scope ${this.scopeId}.`;
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
  CheckpointScopeEnsureError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly ensureScope: (
    scope: OrchestrationV2CheckpointScope,
  ) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly baselineOrdinalWithinScope?: number;
    readonly capturedAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly restore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  function* (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(input.scopeId))
      .pipe(Effect.orDie);
    const scopeKey = Hex.encode(digest).slice(0, 32);
    return CheckpointRef.make(
      `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}/ordinal/${input.ordinalWithinScope}`,
    );
  },
);

/**
 * Snapshot id of a scope boundary in the private sidecar repository. Keeps the
 * readable form the sidecar used before, and hashes a scope id too long for a
 * snapshot id.
 */
export const sidecarSnapshotIdForScopeOrdinal = Effect.fn("sidecarSnapshotIdForScopeOrdinal")(
  function* (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) {
    const readable = `orchestration-v2-${Base64Url.encode(String(input.scopeId))}-${input.ordinalWithinScope}`;
    if (readable.length <= 256) return readable;
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(input.scopeId))
      .pipe(Effect.orDie);
    return `orchestration-v2-h${Hex.encode(digest)}-${input.ordinalWithinScope}`;
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
  CheckpointStore.CheckpointStore | Crypto.Crypto | IdAllocator.IdAllocatorV2
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const crypto = yield* Crypto.Crypto;
    const legacyRefFor = (scope: OrchestrationV2CheckpointScope, ordinalWithinScope: number) =>
      checkpointRefForScopeOrdinal({ scopeId: scope.id, ordinalWithinScope }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
    // New boundaries live in T3's private sidecar repository, so capture never
    // writes refs or objects into the project repository.
    const sidecarRefFor = (scope: OrchestrationV2CheckpointScope, ordinalWithinScope: number) =>
      sidecarSnapshotIdForScopeOrdinal({ scopeId: scope.id, ordinalWithinScope }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.flatMap((snapshotId) =>
          checkpointStore.allocateCheckpointRef({ cwd: scope.cwd, snapshotId }),
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

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));

    // Boundaries a capture is writing right now, waiting on the workspace lock
    // included. A run's baseline is its previous run's capture boundary.
    const capturesInFlight = new Set<string>();
    const boundaryKey = (scope: OrchestrationV2CheckpointScope, ordinalWithinScope: number) =>
      `${scope.cwd}\0${scope.id}\0${ordinalWithinScope}`;

    const ensureScope: CheckpointServiceV2Shape["ensureScope"] = (scope) => Effect.succeed(scope);

    // The next run starts after its baseline. A capture writing the same
    // boundary already is that baseline, so the run never waits behind it.
    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = Effect.fn(
      "CheckpointService.captureBaseline",
    )(
      function* (input) {
        const key = boundaryKey(input.scope, input.ordinalWithinScope);
        const baselineExists = Effect.gen(function* () {
          return (
            capturesInFlight.has(key) ||
            (yield* findBoundaryRef(input.scope, input.ordinalWithinScope)) !== null
          );
        });
        if (!(yield* isGitCheckpointable(input.scope.cwd)) || (yield* baselineExists)) {
          return;
        }
        yield* withWorkspaceLock(
          input.scope.cwd,
          Effect.gen(function* () {
            if (yield* baselineExists) return;
            yield* checkpointStore
              .captureCheckpoint({
                cwd: input.scope.cwd,
                checkpointRef: yield* sidecarRefFor(input.scope, input.ordinalWithinScope),
              })
              .pipe(Effect.catchTags({ VcsUnsupportedOperationError: () => Effect.void }));
          }),
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
            const checkpointable = yield* isGitCheckpointable(input.scope.cwd);
            const storedRef = checkpointable
              ? yield* findBoundaryRef(input.scope, input.ordinalWithinScope).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                      scopeId: input.scope.id,
                      ordinalWithinScope: input.ordinalWithinScope,
                      cause: String(cause),
                    }).pipe(Effect.as(null)),
                  ),
                )
              : null;
            const available = storedRef !== null;
            const checkpointRef = storedRef ?? legacyRef;
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status: available ? "ready" : "missing",
              files: [],
              capturedAt: input.scope.createdAt,
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

    const captureBoundary: CheckpointServiceV2Shape["capture"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
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
          if (!(yield* isGitCheckpointable(input.scope.cwd))) {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: yield* legacyRefFor(input.scope, input.ordinalWithinScope),
              status: "missing",
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          // A workspace its parent repository ignores cannot be captured and
          // records a missing checkpoint instead of an error.
          const captured = yield* sidecarRefFor(input.scope, input.ordinalWithinScope).pipe(
            Effect.tap((checkpointRef) =>
              checkpointStore.captureCheckpoint({ cwd: input.scope.cwd, checkpointRef }),
            ),
            Effect.map((checkpointRef) => ({ status: "ready" as const, checkpointRef })),
            Effect.catchTags({
              VcsUnsupportedOperationError: () => Effect.succeed({ status: "missing" as const }),
            }),
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 checkpoint capture failed", {
                scopeId: input.scope.id,
                ordinalWithinScope: input.ordinalWithinScope,
                cause: String(cause),
              }).pipe(Effect.as({ status: "error" as const })),
            ),
          );

          if (captured.status !== "ready") {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: yield* legacyRefFor(input.scope, input.ordinalWithinScope),
              status: captured.status,
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const checkpointRef = captured.checkpointRef;
          const previousCheckpointRef = yield* findBoundaryRef(input.scope, baselineOrdinal).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                scopeId: input.scope.id,
                ordinalWithinScope: input.ordinalWithinScope - 1,
                cause: String(cause),
              }).pipe(Effect.as(null)),
            ),
          );
          const previousExists = previousCheckpointRef !== null;
          const refs = {
            cwd: input.scope.cwd,
            fromCheckpointRef: previousCheckpointRef ?? checkpointRef,
            toCheckpointRef: checkpointRef,
          };
          // A pull or rebase can change thousands of files the turn did not write.
          const files = previousExists
            ? yield* Effect.all([
                checkpointStore.diffCheckpoints({
                  ...refs,
                  fallbackFromToHead: false,
                  ignoreWhitespace: false,
                  format: "numstat",
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
                  }).pipe(Effect.as([])),
                ),
              )
            : [];

          return makeCheckpoint({
            id: checkpointId,
            scope: input.scope,
            runId: input.runId,
            nodeId: input.nodeId,
            parentCheckpointId,
            ordinalWithinScope: input.ordinalWithinScope,
            appRunOrdinal: input.appRunOrdinal,
            ref: checkpointRef,
            status: "ready",
            files,
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

    const capture: CheckpointServiceV2Shape["capture"] = (input) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const key = boundaryKey(input.scope, input.ordinalWithinScope);
          capturesInFlight.add(key);
          return key;
        }),
        () => captureBoundary(input),
        (key) => Effect.sync(() => capturesInFlight.delete(key)),
      );

    const restore: CheckpointServiceV2Shape["restore"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (input.checkpoint.status !== "ready") {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: `Checkpoint status is ${input.checkpoint.status}.`,
            });
          }

          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd: input.scope.cwd,
            checkpointRef: input.checkpoint.ref,
            fallbackToHead: false,
          });
          if (!restored) {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: "Checkpoint ref is unavailable.",
            });
          }
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isCheckpointRestoreError(cause)
            ? cause
            : new CheckpointRestoreError({
                scopeId: input.scope.id,
                checkpointId: input.checkpoint.id,
                cause,
              }),
        ),
      );

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
      ensureScope,
      captureBaseline,
      materializeBaselineCheckpoint,
      capture,
      restore,
    } satisfies CheckpointServiceV2Shape);
  }),
);
