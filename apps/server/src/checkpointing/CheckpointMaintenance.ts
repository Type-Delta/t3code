import { CheckpointRef } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export type CheckpointRetentionKind =
  | "active"
  | "redo"
  | "abandoned"
  | "rescue"
  | "failed-unpublished"
  | "deleted-thread";

/** `null` means retained until its owning thread/timeline state changes. */
export const retentionDeadline = (
  kind: CheckpointRetentionKind,
  stateChangedAt: number,
): number | null => {
  switch (kind) {
    case "active":
    case "redo":
      return null;
    case "abandoned":
      return stateChangedAt + 7 * DAY_MS;
    case "rescue":
    case "deleted-thread":
      return stateChangedAt + DAY_MS;
    case "failed-unpublished":
      return stateChangedAt;
  }
};

export interface ClaimedCheckpointDeletion {
  readonly deletionId: string;
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export class CheckpointMaintenancePersistenceError extends Schema.TaggedErrorClass<CheckpointMaintenancePersistenceError>()(
  "CheckpointMaintenancePersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Injected persistence seam. `claimExpired` atomically transitions metadata to
 * deleting; repeated claims after restart must return the same deletion id.
 */
export class CheckpointMaintenancePersistence extends Context.Service<
  CheckpointMaintenancePersistence,
  {
    readonly claimExpired: (input: {
      readonly now: number;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<ClaimedCheckpointDeletion>,
      CheckpointMaintenancePersistenceError
    >;
    readonly markDeleted: (input: {
      readonly deletionId: string;
    }) => Effect.Effect<void, CheckpointMaintenancePersistenceError>;
    readonly recordDeletionFailure: (input: {
      readonly deletionId: string;
    }) => Effect.Effect<void, CheckpointMaintenancePersistenceError>;
    /** Persistence/diagnostics chooses repositories over the internal ceiling. */
    readonly listSidecarGcCandidates: () => Effect.Effect<
      ReadonlyArray<{ readonly cwd: string }>,
      CheckpointMaintenancePersistenceError
    >;
  }
>()("t3/checkpointing/CheckpointMaintenance/CheckpointMaintenancePersistence") {}

export interface CheckpointMaintenanceResult {
  readonly claimed: number;
  readonly deleted: number;
  readonly failed: number;
  readonly repositoriesCollected: number;
}

export class CheckpointMaintenance extends Context.Service<
  CheckpointMaintenance,
  {
    readonly runOnce: (input?: {
      readonly now?: number;
      readonly limit?: number;
      readonly collectGarbage?: boolean;
    }) => Effect.Effect<CheckpointMaintenanceResult, CheckpointMaintenancePersistenceError>;
  }
>()("t3/checkpointing/CheckpointMaintenance") {}

export const make = Effect.gen(function* () {
  const persistence = yield* CheckpointMaintenancePersistence;
  const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;

  const runOnce: CheckpointMaintenance["Service"]["runOnce"] = Effect.fn(
    "CheckpointMaintenance.runOnce",
  )(function* (input) {
    const claimed = yield* persistence.claimExpired({
      now: input?.now ?? (yield* Clock.currentTimeMillis),
      limit: input?.limit ?? 100,
    });
    let deleted = 0;
    let failed = 0;
    for (const candidate of claimed) {
      const result = yield* Effect.result(
        sidecars.delete({ cwd: candidate.cwd, checkpointRefs: [candidate.checkpointRef] }),
      );
      if (result._tag === "Success") {
        yield* persistence.markDeleted({ deletionId: candidate.deletionId });
        deleted += 1;
      } else {
        yield* persistence.recordDeletionFailure({ deletionId: candidate.deletionId });
        failed += 1;
      }
    }

    let repositoriesCollected = 0;
    if (input?.collectGarbage === true) {
      const repositories = yield* persistence.listSidecarGcCandidates();
      for (const repository of repositories) {
        const result = yield* Effect.result(sidecars.gc(repository));
        if (result._tag === "Success" && result.success) repositoriesCollected += 1;
      }
    }
    return { claimed: claimed.length, deleted, failed, repositoriesCollected };
  });

  return CheckpointMaintenance.of({ runOnce });
});

export const layer = Layer.effect(CheckpointMaintenance, make);
