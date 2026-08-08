import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointNavigationRepository } from "../persistence/Services/CheckpointNavigation.ts";
import type {
  CheckpointNavigationOperation,
  CheckpointNavigationPhase,
} from "../persistence/Services/CheckpointNavigation.ts";
import { CheckpointRetentionRepository } from "../persistence/Services/CheckpointRetention.ts";
import { CheckpointTimelineRepository } from "../persistence/Services/CheckpointTimeline.ts";
import type {
  ThreadCheckpointCursor,
  ThreadCheckpointEntry,
} from "../persistence/Services/CheckpointTimeline.ts";
import { ProviderConversationNavigation } from "../provider/Services/ProviderConversationNavigation.ts";
import type {
  ProviderConversationBinding,
  ProviderConversationCursor,
} from "../provider/Services/ProviderConversationNavigation.ts";
import { CheckpointRepositoryIdentityResolver } from "./CheckpointRepositoryIdentity.ts";
import { CheckpointStore } from "./CheckpointStore.ts";
import { SidecarCheckpointRepository } from "./SidecarCheckpointRepository.ts";
import { WorkspaceMutationCoordinator } from "./WorkspaceMutationCoordinator.ts";

export type CheckpointNavigationKind = "undo" | "redo" | "jump";

export class CheckpointNavigationError extends Schema.TaggedErrorClass<CheckpointNavigationError>()(
  "CheckpointNavigationError",
  {
    code: Schema.String,
    detail: Schema.String,
    operationId: Schema.NullOr(Schema.String),
  },
) {}

export interface CaptureNavigationRescueResult {
  readonly snapshotId: string;
  readonly repositoryKey: string;
  readonly worktreeKey: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly commitOid: string;
  readonly treeOid: string;
}

/** Filesystem adapter kept independent from every provider harness. */
export class CheckpointNavigationWorkspace extends Context.Service<
  CheckpointNavigationWorkspace,
  {
    readonly captureRescue: (input: {
      readonly cwd: string;
      readonly snapshotId: string;
    }) => Effect.Effect<CaptureNavigationRescueResult, CheckpointNavigationError>;
    readonly restoreSnapshot: (input: {
      readonly cwd: string;
      readonly snapshotId: string;
    }) => Effect.Effect<void, CheckpointNavigationError>;
  }
>()("t3/checkpointing/CheckpointNavigationService/CheckpointNavigationWorkspace") {}

export type CheckpointNavigationResult =
  | {
      readonly status: "completed";
      readonly operationId: string;
      readonly kind: CheckpointNavigationKind;
      readonly targetEntryId: string;
      readonly cursorVersion: number;
    }
  | {
      /** The workspace changed, while the conversation cursor and provider binding did not. */
      readonly status: "files-restored";
      readonly operationId: string;
      readonly kind: Exclude<CheckpointNavigationKind, "redo">;
      readonly targetEntryId: string;
      readonly cursorVersion: number;
    }
  | {
      readonly status: "noop";
      readonly operationId: string;
      readonly kind: CheckpointNavigationKind;
      readonly reason: "baseline" | "tip" | "already-current";
      readonly targetEntryId: string | null;
      readonly cursorVersion: number;
    };

export interface CheckpointNavigationInput {
  readonly commandId: string;
  readonly threadId: ThreadId;
  readonly kind: CheckpointNavigationKind;
  readonly targetTurnCount?: number;
  readonly filesOnlyConfirmed?: boolean;
}

export interface CheckpointForwardAbandonResult {
  readonly abandoned: boolean;
  readonly abandonedGeneration: number;
  readonly activeGeneration: number;
  readonly cursorVersion: number;
}

export class CheckpointNavigationService extends Context.Service<
  CheckpointNavigationService,
  {
    readonly navigate: (
      input: CheckpointNavigationInput,
    ) => Effect.Effect<CheckpointNavigationResult, CheckpointNavigationError>;
    /** Compensates every incomplete durable operation before accepting more mutation. */
    readonly recover: () => Effect.Effect<ReadonlyArray<string>, CheckpointNavigationError>;
    /** Must run before dispatching a new turn while the cursor is behind its tip. */
    readonly abandonForwardHistory: (
      threadId: ThreadId,
    ) => Effect.Effect<CheckpointForwardAbandonResult, CheckpointNavigationError>;
  }
>()("t3/checkpointing/CheckpointNavigationService") {}

const navigationError = (code: string, detail: string, operationId: string | null = null) =>
  new CheckpointNavigationError({ code, detail, operationId });

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeOpaqueJson = Schema.encodeUnknownEffect(UnknownFromJsonString);
const decodeOpaqueJson = Schema.decodeUnknownEffect(UnknownFromJsonString);

const stringifyOpaque = (value: unknown, operationId: string | null) =>
  encodeOpaqueJson(value).pipe(
    Effect.mapError(() =>
      navigationError(
        "provider-payload-encode",
        "Provider cursor payload was not serializable.",
        operationId,
      ),
    ),
  );

const parseOpaque = <A>(value: string, code: string, operationId: string | null) =>
  decodeOpaqueJson(value).pipe(
    Effect.map((decoded) => decoded as A),
    Effect.mapError(() =>
      navigationError(code, "Persisted provider navigation payload was invalid.", operationId),
    ),
  );

const isCheckpointNavigationError = Schema.is(CheckpointNavigationError);
const mapUnknownError = (code: string, operationId: string | null) => (error: unknown) =>
  isCheckpointNavigationError(error)
    ? error
    : navigationError(code, "Checkpoint navigation phase failed.", operationId);

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

const makeWorkspace = Effect.gen(function* () {
  const store = yield* CheckpointStore;
  const sidecars = yield* SidecarCheckpointRepository;
  const identities = yield* CheckpointRepositoryIdentityResolver;

  const captureRescue: CheckpointNavigationWorkspace["Service"]["captureRescue"] = Effect.fn(
    "CheckpointNavigationWorkspace.captureRescue",
  )(function* ({ cwd, snapshotId }) {
    const checkpointRef = yield* store
      .allocateCheckpointRef({ cwd, snapshotId })
      .pipe(Effect.mapError(mapUnknownError("rescue-allocation-failed", null)));
    const [identity, metadata] = yield* Effect.all([
      identities.resolve(cwd),
      sidecars.captureWithMetadata({ cwd, checkpointRef }),
    ]).pipe(Effect.mapError(mapUnknownError("rescue-capture-failed", null)));
    return { snapshotId, objectFormat: identity.objectFormat, ...metadata };
  });

  const restoreSnapshot: CheckpointNavigationWorkspace["Service"]["restoreSnapshot"] = Effect.fn(
    "CheckpointNavigationWorkspace.restoreSnapshot",
  )(function* ({ cwd, snapshotId }) {
    const checkpointRef = yield* store
      .allocateCheckpointRef({ cwd, snapshotId })
      .pipe(Effect.mapError(mapUnknownError("snapshot-allocation-failed", null)));
    const restored = yield* store
      .restoreCheckpoint({ cwd, checkpointRef })
      .pipe(Effect.mapError(mapUnknownError("filesystem-restore-failed", null)));
    if (!restored) {
      return yield* navigationError("snapshot-unavailable", "Checkpoint snapshot was not found.");
    }
  });

  return CheckpointNavigationWorkspace.of({ captureRescue, restoreSnapshot });
});

export const CheckpointNavigationWorkspaceLive = Layer.effect(
  CheckpointNavigationWorkspace,
  makeWorkspace,
);

const make = Effect.gen(function* () {
  const timeline = yield* CheckpointTimelineRepository;
  const operations = yield* CheckpointNavigationRepository;
  const retention = yield* CheckpointRetentionRepository;
  const workspace = yield* CheckpointNavigationWorkspace;
  const mutations = yield* WorkspaceMutationCoordinator;
  const provider = yield* ProviderConversationNavigation;
  const projections = yield* ProjectionSnapshotQuery;
  const identities = yield* CheckpointRepositoryIdentityResolver;
  const crypto = yield* Crypto.Crypto;
  const threadLocks = new Map<string, Semaphore.Semaphore>();

  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) => {
    let lock = threadLocks.get(threadId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      threadLocks.set(threadId, lock);
    }
    return lock.withPermits(1)(effect);
  };

  const advance = Effect.fn("CheckpointNavigationService.advance")(function* (
    operation: CheckpointNavigationOperation,
    phase: CheckpointNavigationOperation["phase"],
    extra?: {
      readonly rescueSnapshotId?: string;
      readonly targetProviderBindingJson?: string;
      readonly preparedProviderCursorJson?: string;
      readonly recoveryFromPhase?: CheckpointNavigationPhase | null;
      readonly failureCode?: string;
      readonly compensationFailureCode?: string;
      readonly completedAt?: string;
    },
  ) {
    const updatedAt = yield* isoNow;
    const changed = yield* operations
      .advancePhase({
        operationId: operation.operationId,
        expectedPhase: operation.phase,
        phase,
        updatedAt,
        ...extra,
      })
      .pipe(Effect.mapError(mapUnknownError("navigation-journal-failed", operation.operationId)));
    if (!changed) {
      return yield* navigationError(
        "navigation-phase-conflict",
        "Navigation phase changed concurrently.",
        operation.operationId,
      );
    }
    return { ...operation, phase, updatedAt, ...extra } as CheckpointNavigationOperation;
  });

  const resolveContext = Effect.fn("CheckpointNavigationService.resolveContext")(function* (
    threadId: ThreadId,
  ) {
    if (projections.getCheckpointNavigationContext === undefined) {
      return yield* navigationError(
        "navigation-context-unavailable",
        "Projection query is missing checkpoint navigation context support.",
      );
    }
    const context = yield* projections
      .getCheckpointNavigationContext(threadId)
      .pipe(Effect.mapError(mapUnknownError("navigation-context-failed", null)));
    if (Option.isNone(context)) {
      return yield* navigationError("thread-not-found", "Thread was not found.");
    }
    return context.value;
  });

  const restoreCursorToEntry = Effect.fn("CheckpointNavigationService.restoreCursorToEntry")(
    function* (operation: CheckpointNavigationOperation) {
      const cursor = yield* timeline
        .getCursor({ threadId: operation.threadId })
        .pipe(Effect.mapError(mapUnknownError("cursor-read-failed", operation.operationId)));
      if (Option.isNone(cursor)) return;
      const fromEntry =
        operation.fromEntryId === null
          ? Option.none<ThreadCheckpointEntry>()
          : yield* timeline
              .getEntry({ entryId: operation.fromEntryId })
              .pipe(Effect.mapError(mapUnknownError("entry-read-failed", operation.operationId)));
      const current = cursor.value;
      const restored = yield* timeline
        .moveCursor({
          threadId: operation.threadId,
          expectedNavigationVersion: current.navigationVersion,
          activeGeneration: current.activeGeneration,
          currentEntryId: Option.isSome(fromEntry) ? fromEntry.value.entryId : null,
          currentOrdinal: Option.isSome(fromEntry) ? fromEntry.value.ordinal : null,
          forwardTipEntryId: current.forwardTipEntryId,
          forwardTipOrdinal: current.forwardTipOrdinal,
          updatedAt: yield* isoNow,
        })
        .pipe(
          Effect.mapError(mapUnknownError("cursor-compensation-failed", operation.operationId)),
        );
      if (!restored) {
        return yield* navigationError(
          "cursor-compensation-conflict",
          "Timeline cursor changed during compensation.",
          operation.operationId,
        );
      }
    },
  );

  const compensate = Effect.fn("CheckpointNavigationService.compensate")(function* (
    initial: CheckpointNavigationOperation,
    reachedPhase?: CheckpointNavigationPhase,
  ) {
    let operation = initial;
    if (operation.mode === "files-only") {
      const phase =
        reachedPhase ??
        (operation.phase === "needs-recovery" ? operation.recoveryFromPhase : operation.phase) ??
        operation.phase;
      // Once rescue-ready is durable, a process may have died immediately before,
      // during, or after the target restore. Restoring the rescue is idempotent in
      // all three cases and deliberately avoids every provider/timeline API.
      const filesystemMayHaveChanged =
        phase === "rescue-ready" ||
        phase === "filesystem-restored" ||
        phase === "compensating-filesystem";

      const attempt = Effect.gen(function* () {
        if (filesystemMayHaveChanged) {
          const context = yield* resolveContext(ThreadId.make(operation.threadId));
          const identity = yield* identities
            .resolve(context.workspaceCwd)
            .pipe(
              Effect.mapError(mapUnknownError("worktree-identity-failed", operation.operationId)),
            );
          if (operation.phase !== "compensating-filesystem") {
            operation = yield* advance(operation, "compensating-filesystem");
          }
          const rescueSnapshotId =
            operation.rescueSnapshotId ?? `nav-rescue-${operation.operationId}`;
          yield* mutations.withMutation(
            identity.worktreeKey,
            workspace.restoreSnapshot({ cwd: context.workspaceCwd, snapshotId: rescueSnapshotId }),
          );
        }
        operation = yield* advance(operation, "compensated", { completedAt: yield* isoNow });
        return operation.operationId;
      });

      return yield* attempt.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const updatedAt = yield* isoNow;
            yield* operations
              .advancePhase({
                operationId: operation.operationId,
                expectedPhase: operation.phase,
                phase: "needs-recovery",
                recoveryFromPhase: operation.phase,
                compensationFailureCode: error.code,
                updatedAt,
              })
              .pipe(Effect.catch(() => Effect.void));
            return yield* error;
          }),
        ),
      );
    }

    const context = yield* resolveContext(ThreadId.make(operation.threadId));
    const identity = yield* identities
      .resolve(context.workspaceCwd)
      .pipe(Effect.mapError(mapUnknownError("worktree-identity-failed", operation.operationId)));
    const phase =
      reachedPhase ??
      (operation.phase === "needs-recovery" ? operation.recoveryFromPhase : operation.phase) ??
      operation.phase;
    const providerNeedsCompensation =
      phase === "provider-prepared" ||
      phase === "filesystem-restored" ||
      phase === "provider-activated" ||
      phase === "cursor-committed" ||
      phase === "committed" ||
      phase === "compensating-cursor" ||
      phase === "compensating-provider";
    const cursorWasMoved =
      phase === "cursor-committed" || phase === "committed" || phase === "compensating-cursor";
    const filesystemWasRestored = providerNeedsCompensation || phase === "compensating-filesystem";

    const attempt = Effect.gen(function* () {
      if (cursorWasMoved) {
        if (operation.phase !== "compensating-cursor") {
          operation = yield* advance(operation, "compensating-cursor");
        }
        yield* restoreCursorToEntry(operation);
        operation = yield* advance(operation, "compensating-provider");
      } else if (providerNeedsCompensation && operation.phase !== "compensating-provider") {
        operation = yield* advance(operation, "compensating-provider");
      }

      if (providerNeedsCompensation) {
        const oldBinding = yield* parseOpaque<ProviderConversationBinding>(
          operation.oldProviderBindingJson,
          "old-provider-binding-invalid",
          operation.operationId,
        );
        yield* provider
          .restoreBinding(ThreadId.make(operation.threadId), oldBinding)
          .pipe(
            Effect.mapError(mapUnknownError("provider-compensation-failed", operation.operationId)),
          );
        const preparedCursor = yield* parseOpaque<ProviderConversationCursor>(
          operation.preparedProviderCursorJson,
          "prepared-provider-cursor-invalid",
          operation.operationId,
        );
        yield* provider
          .disposeCursor(preparedCursor)
          .pipe(Effect.mapError(mapUnknownError("provider-dispose-failed", operation.operationId)));
        operation = yield* advance(operation, "compensating-filesystem");
      } else if (filesystemWasRestored && operation.phase !== "compensating-filesystem") {
        operation = yield* advance(operation, "compensating-filesystem");
      }

      if (filesystemWasRestored) {
        const rescueSnapshotId =
          operation.rescueSnapshotId ?? `nav-rescue-${operation.operationId}`;
        yield* mutations.withMutation(
          identity.worktreeKey,
          workspace.restoreSnapshot({ cwd: context.workspaceCwd, snapshotId: rescueSnapshotId }),
        );
      }
      operation = yield* advance(operation, "compensated", { completedAt: yield* isoNow });
      return operation.operationId;
    });

    return yield* attempt.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const updatedAt = yield* isoNow;
          yield* operations
            .advancePhase({
              operationId: operation.operationId,
              expectedPhase: operation.phase,
              phase: "needs-recovery",
              recoveryFromPhase: operation.phase,
              compensationFailureCode: error.code,
              updatedAt,
            })
            .pipe(Effect.catch(() => Effect.void));
          return yield* error;
        }),
      ),
    );
  });

  const runPrepared = Effect.fn("CheckpointNavigationService.runPrepared")(function* (
    initial: CheckpointNavigationOperation,
    context: { readonly workspaceCwd: string },
    target: ThreadCheckpointEntry,
    cursor: ThreadCheckpointCursor,
  ) {
    let operation = initial;
    let reachedPhase: CheckpointNavigationPhase = operation.phase;
    const rescueSnapshotId = `nav-rescue-${operation.operationId}`;
    const expiresAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 24 }));

    return yield* Effect.gen(function* () {
      const rescue = yield* workspace.captureRescue({
        cwd: context.workspaceCwd,
        snapshotId: rescueSnapshotId,
      });
      const identity = yield* identities
        .resolve(context.workspaceCwd)
        .pipe(Effect.mapError(mapUnknownError("worktree-identity-failed", operation.operationId)));
      if (
        rescue.repositoryKey !== identity.repositoryKey ||
        rescue.worktreeKey !== identity.worktreeKey ||
        rescue.objectFormat !== identity.objectFormat
      ) {
        return yield* navigationError(
          "worktree-identity-mismatch",
          "Navigation rescue belongs to a different repository or worktree.",
          operation.operationId,
        );
      }
      yield* operations
        .recordRescueSnapshot({ ...rescue, createdAt: yield* isoNow, expiresAt })
        .pipe(Effect.mapError(mapUnknownError("rescue-journal-failed", operation.operationId)));
      operation = yield* advance(operation, "rescue-ready", { rescueSnapshotId });

      const targetBinding = yield* parseOpaque<ProviderConversationBinding>(
        target.providerBindingJson,
        "target-provider-binding-invalid",
        operation.operationId,
      );
      const preparedCursor = yield* provider
        .prepareCursor(ThreadId.make(operation.threadId), {
          binding: targetBinding,
          targetTurnId: target.providerTurnId,
        })
        .pipe(Effect.mapError(mapUnknownError("provider-prepare-failed", operation.operationId)));
      const preparedProviderCursorJson = yield* stringifyOpaque(
        preparedCursor,
        operation.operationId,
      );
      operation = { ...operation, preparedProviderCursorJson };
      reachedPhase = "provider-prepared";
      operation = yield* advance(operation, "provider-prepared", { preparedProviderCursorJson });

      yield* mutations.withMutation(
        rescue.worktreeKey,
        workspace.restoreSnapshot({ cwd: context.workspaceCwd, snapshotId: target.snapshotId }),
      );
      reachedPhase = "filesystem-restored";
      operation = yield* advance(operation, "filesystem-restored");

      const activatedBinding = yield* provider
        .activateCursor(ThreadId.make(operation.threadId), preparedCursor)
        .pipe(Effect.mapError(mapUnknownError("provider-activate-failed", operation.operationId)));
      const targetProviderBindingJson = yield* stringifyOpaque(
        activatedBinding,
        operation.operationId,
      );
      operation = { ...operation, targetProviderBindingJson };
      reachedPhase = "provider-activated";
      operation = yield* advance(operation, "provider-activated", { targetProviderBindingJson });

      const moved = yield* timeline
        .moveCursor({
          threadId: operation.threadId,
          expectedNavigationVersion: cursor.navigationVersion,
          activeGeneration: cursor.activeGeneration,
          currentEntryId: target.entryId,
          currentOrdinal: target.ordinal,
          forwardTipEntryId: cursor.forwardTipEntryId,
          forwardTipOrdinal: cursor.forwardTipOrdinal,
          updatedAt: yield* isoNow,
        })
        .pipe(Effect.mapError(mapUnknownError("cursor-move-failed", operation.operationId)));
      if (!moved) {
        return yield* navigationError(
          "cursor-version-conflict",
          "Timeline cursor changed during navigation.",
          operation.operationId,
        );
      }
      reachedPhase = "cursor-committed";
      operation = yield* advance(operation, "cursor-committed");
      yield* timeline
        .upsertProviderBinding({
          threadId: operation.threadId,
          providerBindingJson: targetProviderBindingJson,
          bindingVersion: cursor.navigationVersion + 1,
          updatedAt: yield* isoNow,
        })
        .pipe(
          Effect.mapError(
            mapUnknownError("provider-binding-journal-failed", operation.operationId),
          ),
        );
      yield* retention
        .scheduleSnapshotDeletion({
          snapshotId: rescueSnapshotId,
          retentionClass: "rescue",
          deleteAfter: expiresAt,
        })
        .pipe(Effect.mapError(mapUnknownError("rescue-retention-failed", operation.operationId)));
      operation = yield* advance(operation, "committed", { completedAt: yield* isoNow });

      return {
        status: "completed",
        operationId: operation.operationId,
        kind: operation.kind,
        targetEntryId: target.entryId,
        cursorVersion: cursor.navigationVersion + 1,
      } as const;
    }).pipe(
      Effect.mapError(mapUnknownError("navigation-failed", operation.operationId)),
      Effect.catch((failure) =>
        compensate(operation, reachedPhase).pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(Effect.fail(failure)),
        ),
      ),
    );
  });

  const runFilesOnlyRestore = Effect.fn("CheckpointNavigationService.runFilesOnlyRestore")(
    function* (
      initial: CheckpointNavigationOperation,
      context: { readonly workspaceCwd: string },
      target: ThreadCheckpointEntry,
      cursor: ThreadCheckpointCursor,
    ) {
      let operation = initial;
      let reachedPhase: CheckpointNavigationPhase = operation.phase;
      const rescueSnapshotId = `nav-rescue-${operation.operationId}`;
      const expiresAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 24 }));
      return yield* Effect.gen(function* () {
        const identity = yield* identities
          .resolve(context.workspaceCwd)
          .pipe(
            Effect.mapError(mapUnknownError("worktree-identity-failed", operation.operationId)),
          );
        const targetContext = yield* retention
          .getSnapshotExecutionContext({ snapshotId: target.snapshotId })
          .pipe(
            Effect.mapError(
              mapUnknownError("snapshot-identity-read-failed", operation.operationId),
            ),
          );
        if (targetContext === undefined) {
          return yield* navigationError(
            "snapshot-identity-unavailable",
            "Checkpoint ownership metadata was not found.",
            operation.operationId,
          );
        }
        if (
          targetContext.repositoryKey !== identity.repositoryKey ||
          targetContext.worktreeKey !== identity.worktreeKey
        ) {
          return yield* navigationError(
            "worktree-identity-mismatch",
            "The checkpoint belongs to a different repository or worktree.",
            operation.operationId,
          );
        }

        yield* mutations.withMutation(
          identity.worktreeKey,
          Effect.gen(function* () {
            const rescue = yield* workspace.captureRescue({
              cwd: context.workspaceCwd,
              snapshotId: rescueSnapshotId,
            });
            if (
              rescue.repositoryKey !== identity.repositoryKey ||
              rescue.worktreeKey !== identity.worktreeKey ||
              rescue.objectFormat !== identity.objectFormat
            ) {
              return yield* navigationError(
                "worktree-identity-mismatch",
                "The restore rescue belongs to a different repository or worktree.",
                operation.operationId,
              );
            }
            yield* operations
              .recordRescueSnapshot({ ...rescue, createdAt: yield* isoNow, expiresAt })
              .pipe(
                Effect.mapError(mapUnknownError("rescue-journal-failed", operation.operationId)),
              );
            // Schedule before mutating so every recorded rescue has a bounded lifetime,
            // including rescues used to compensate a failed restore.
            yield* retention
              .scheduleSnapshotDeletion({
                snapshotId: rescueSnapshotId,
                retentionClass: "rescue",
                deleteAfter: expiresAt,
              })
              .pipe(
                Effect.mapError(mapUnknownError("rescue-retention-failed", operation.operationId)),
              );

            operation = yield* advance(operation, "rescue-ready", { rescueSnapshotId });
            // Treat the filesystem as potentially changed before entering the
            // restore call; the restore may mutate and then fail.
            reachedPhase = "filesystem-restored";
            yield* workspace
              .restoreSnapshot({ cwd: context.workspaceCwd, snapshotId: target.snapshotId })
              .pipe(
                Effect.mapError(
                  mapUnknownError("filesystem-restore-failed", operation.operationId),
                ),
              );
            operation = yield* advance(operation, "filesystem-restored");
          }),
        );
        operation = yield* advance(operation, "committed", { completedAt: yield* isoNow });

        return {
          status: "files-restored",
          operationId: operation.operationId,
          kind: operation.kind as "undo" | "jump",
          targetEntryId: target.entryId,
          cursorVersion: cursor.navigationVersion,
        } as const;
      }).pipe(
        Effect.mapError(mapUnknownError("navigation-failed", operation.operationId)),
        Effect.catch((failure) =>
          compensate(operation, reachedPhase).pipe(
            Effect.catch(() => Effect.void),
            Effect.andThen(Effect.fail(failure)),
          ),
        ),
      );
    },
  );

  const navigateUnlocked = Effect.fn("CheckpointNavigationService.navigateUnlocked")(function* (
    input: CheckpointNavigationInput,
  ) {
    const existing = yield* operations
      .getByCommandId({ commandId: input.commandId })
      .pipe(Effect.mapError(mapUnknownError("navigation-journal-read-failed", null)));
    if (Option.isSome(existing)) {
      const operation = existing.value;
      if (operation.phase === "committed") {
        const cursor = yield* timeline
          .getCursor({ threadId: input.threadId })
          .pipe(Effect.mapError(mapUnknownError("cursor-read-failed", operation.operationId)));
        return operation.mode === "files-only"
          ? ({
              status: "files-restored",
              operationId: operation.operationId,
              kind: operation.kind as "undo" | "jump",
              targetEntryId: operation.toEntryId,
              cursorVersion: Option.isSome(cursor) ? cursor.value.navigationVersion : 0,
            } as const)
          : ({
              status: "completed",
              operationId: operation.operationId,
              kind: operation.kind,
              targetEntryId: operation.toEntryId,
              cursorVersion: Option.isSome(cursor) ? cursor.value.navigationVersion : 0,
            } as const);
      }
      return yield* navigationError(
        "navigation-command-incomplete",
        "This navigation command is awaiting recovery.",
        operation.operationId,
      );
    }

    const context = yield* resolveContext(input.threadId);
    if (context.hasPendingApprovals || context.hasPendingUserInput) {
      return yield* navigationError(
        "approval-pending",
        "Resolve pending provider interaction first.",
      );
    }
    if (context.sessionStatus === "starting" || context.sessionStatus === "running") {
      return yield* navigationError("thread-busy", "The thread must be idle before navigation.");
    }
    const unresolved = yield* operations
      .getUnresolvedByThread({ threadId: input.threadId })
      .pipe(Effect.mapError(mapUnknownError("navigation-journal-read-failed", null)));
    if (Option.isSome(unresolved)) {
      return yield* navigationError(
        "navigation-recovery-required",
        "A prior navigation operation requires recovery.",
        unresolved.value.operationId,
      );
    }
    const capability = yield* provider
      .getCapability(input.threadId)
      .pipe(Effect.mapError(mapUnknownError("provider-capability-failed", null)));
    if (capability !== "branching" && input.kind === "redo") {
      return yield* navigationError(
        "redo-requires-branching",
        "The provider cannot preserve conversation branches for this navigation.",
      );
    }
    const filesOnlyRequested = input.kind !== "redo" && input.filesOnlyConfirmed === true;
    if (capability !== "branching" && !filesOnlyRequested) {
      return yield* navigationError(
        "files-only-confirmation-required",
        "Confirm that only workspace files will be restored and chat history will remain unchanged.",
      );
    }

    const cursorOption = yield* timeline
      .getCursor({ threadId: input.threadId })
      .pipe(Effect.mapError(mapUnknownError("cursor-read-failed", null)));
    if (Option.isNone(cursorOption)) {
      return yield* navigationError(
        "timeline-uninitialized",
        "Checkpoint timeline is not initialized.",
      );
    }
    const cursor = cursorOption.value;
    const noOp = (reason: "baseline" | "tip" | "already-current") =>
      ({
        status: "noop",
        operationId: input.commandId,
        kind: input.kind,
        reason,
        targetEntryId: cursor.currentEntryId,
        cursorVersion: cursor.navigationVersion,
      }) as const;
    if (
      !filesOnlyRequested &&
      input.kind === "jump" &&
      input.targetTurnCount === cursor.currentOrdinal
    ) {
      return noOp("already-current");
    }
    const entries = (yield* timeline
      .listGenerationLineage({
        threadId: input.threadId,
        generation: cursor.activeGeneration,
      })
      .pipe(Effect.mapError(mapUnknownError("timeline-read-failed", null))))
      .filter((entry) => entry.state === "ready")
      .toSorted((left, right) => left.ordinal - right.ordinal);

    const target =
      input.kind === "undo"
        ? entries.findLast(
            (entry) => cursor.currentOrdinal !== null && entry.ordinal < cursor.currentOrdinal,
          )
        : input.kind === "redo"
          ? entries.find(
              (entry) => cursor.currentOrdinal === null || entry.ordinal > cursor.currentOrdinal,
            )
          : entries.find((entry) => entry.ordinal === input.targetTurnCount);
    if (target === undefined) {
      if (input.kind === "undo") return noOp("baseline");
      if (input.kind === "redo") return noOp("tip");
      if (input.targetTurnCount === cursor.currentOrdinal) {
        return noOp("already-current");
      }
      return yield* navigationError("target-unavailable", "Requested checkpoint is not ready.");
    }
    if (filesOnlyRequested) {
      // Explicit files-only intent wins over a live branching capability. This
      // keeps a confirmation made from a cached capability from turning into a
      // conversation navigation if provider capability changes before dispatch.
      const operationId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(mapUnknownError("operation-id-failed", null)),
      );
      const createdAt = yield* isoNow;
      const operation = yield* operations
        .begin({
          operationId,
          commandId: input.commandId,
          threadId: input.threadId,
          kind: input.kind,
          mode: "files-only",
          fromEntryId: cursor.currentEntryId,
          toEntryId: target.entryId,
          rescueSnapshotId: null,
          oldProviderBindingJson: "",
          targetProviderBindingJson: "",
          preparedProviderCursorJson: "",
          phase: "prepared",
          recoveryFromPhase: null,
          failureCode: null,
          compensationFailureCode: null,
          createdAt,
          updatedAt: createdAt,
          completedAt: null,
        })
        .pipe(Effect.mapError(mapUnknownError("navigation-journal-failed", null)));
      return yield* runFilesOnlyRestore(operation, context, target, cursor);
    }
    if (target.providerTurnId === null && target.ordinal !== 0) {
      return yield* navigationError(
        "provider-turn-id-unavailable",
        "This checkpoint does not contain a native provider turn id.",
      );
    }

    const oldBinding = yield* provider
      .getBinding(input.threadId)
      .pipe(Effect.mapError(mapUnknownError("provider-binding-read-failed", null)));
    const oldProviderBindingJson = yield* stringifyOpaque(oldBinding, null);
    const operationId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(mapUnknownError("operation-id-failed", null)),
    );
    const createdAt = yield* isoNow;
    const operation = yield* operations
      .begin({
        operationId,
        commandId: input.commandId,
        threadId: input.threadId,
        kind: input.kind,
        mode: "full",
        fromEntryId: cursor.currentEntryId,
        toEntryId: target.entryId,
        rescueSnapshotId: null,
        oldProviderBindingJson,
        targetProviderBindingJson: target.providerBindingJson,
        preparedProviderCursorJson: "",
        phase: "prepared",
        recoveryFromPhase: null,
        failureCode: null,
        compensationFailureCode: null,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      })
      .pipe(Effect.mapError(mapUnknownError("navigation-journal-failed", null)));
    return yield* runPrepared(operation, context, target, cursor);
  });

  const navigate: CheckpointNavigationService["Service"]["navigate"] = (input) =>
    withThreadLock(input.threadId, navigateUnlocked(input));

  const recover: CheckpointNavigationService["Service"]["recover"] = () =>
    Effect.gen(function* () {
      const recoverable = yield* operations
        .listRecoverable()
        .pipe(Effect.mapError(mapUnknownError("navigation-recovery-read-failed", null)));
      return yield* Effect.forEach(
        recoverable,
        (operation) => withThreadLock(operation.threadId, compensate(operation)),
        { concurrency: "unbounded" },
      );
    });

  const abandonForwardHistory: CheckpointNavigationService["Service"]["abandonForwardHistory"] = (
    threadId,
  ) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const cursorOption = yield* timeline
          .getCursor({ threadId })
          .pipe(Effect.mapError(mapUnknownError("cursor-read-failed", null)));
        if (Option.isNone(cursorOption)) {
          return {
            abandoned: false,
            abandonedGeneration: 0,
            activeGeneration: 0,
            cursorVersion: 0,
          };
        }
        const cursor = cursorOption.value;
        if (cursor.currentOrdinal === cursor.forwardTipOrdinal) {
          return {
            abandoned: false,
            abandonedGeneration: cursor.activeGeneration,
            activeGeneration: cursor.activeGeneration,
            cursorVersion: cursor.navigationVersion,
          };
        }
        const now = yield* DateTime.now;
        const nextGeneration = cursor.activeGeneration + 1;
        const changed = yield* timeline
          .forkGeneration({
            threadId,
            expectedNavigationVersion: cursor.navigationVersion,
            newGeneration: nextGeneration,
            currentEntryId: cursor.currentEntryId,
            currentOrdinal: cursor.currentOrdinal,
            createdAt: DateTime.formatIso(now),
            deleteAfter: DateTime.formatIso(DateTime.add(now, { days: 7 })),
          })
          .pipe(Effect.mapError(mapUnknownError("forward-abandon-failed", null)));
        if (!changed) {
          return yield* navigationError(
            "cursor-version-conflict",
            "Timeline cursor changed concurrently.",
          );
        }
        return {
          abandoned: true,
          abandonedGeneration: cursor.activeGeneration,
          activeGeneration: nextGeneration,
          cursorVersion: cursor.navigationVersion + 1,
        };
      }),
    );

  return CheckpointNavigationService.of({ navigate, recover, abandonForwardHistory });
});

export const CheckpointNavigationServiceLive = Layer.effect(CheckpointNavigationService, make);
