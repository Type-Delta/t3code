import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CheckpointRetentionRepository } from "../persistence/Services/CheckpointRetention.ts";
import * as CheckpointMaintenance from "./CheckpointMaintenance.ts";
import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";

const DELETION_RESUME_AFTER_MS = 5 * 60 * 1_000;
const GC_MINIMUM_DELETED_SNAPSHOTS = 32;

const persistenceError = (operation: string, cause: unknown) =>
  new CheckpointMaintenance.CheckpointMaintenancePersistenceError({ operation, cause });

const make = Effect.gen(function* () {
  const retention = yield* CheckpointRetentionRepository;

  const claimExpired: CheckpointMaintenance.CheckpointMaintenancePersistence["Service"]["claimExpired"] =
    (input) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(DateTime.makeUnsafe(input.now));
        yield* retention.applyPolicy({ now });
        const candidates = yield* retention.listDeletionCandidates({ now, limit: input.limit });
        const resumeBefore = DateTime.formatIso(
          DateTime.makeUnsafe(input.now - DELETION_RESUME_AFTER_MS),
        );
        const claimed: Array<CheckpointMaintenance.ClaimedCheckpointDeletion> = [];
        for (const candidate of candidates) {
          const isClaimed =
            candidate.deletionStartedAt === null
              ? yield* retention.markDeletionStarted({ snapshotId: candidate.snapshotId, now })
              : candidate.deletionStartedAt <= resumeBefore;
          if (!isClaimed) continue;
          const execution = yield* retention.getSnapshotExecutionContext({
            snapshotId: candidate.snapshotId,
          });
          if (!execution) {
            yield* retention.markDeletionFailed({
              snapshotId: candidate.snapshotId,
              errorCode: "workspace-binding-unavailable",
            });
            continue;
          }
          claimed.push({
            deletionId: candidate.snapshotId,
            cwd: execution.cwd,
            checkpointRef: SidecarCheckpointRepository.sidecarCheckpointRef(
              {
                repositoryKey: candidate.repositoryKey,
                worktreeKey: candidate.worktreeKey,
              },
              candidate.snapshotId,
            ),
          });
        }
        return claimed;
      }).pipe(Effect.mapError((cause) => persistenceError("claimExpired", cause)));

  const markDeleted: CheckpointMaintenance.CheckpointMaintenancePersistence["Service"]["markDeleted"] =
    (input) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          retention.markDeleted({
            snapshotId: input.deletionId,
            now: DateTime.formatIso(now),
          }),
        ),
        Effect.mapError((cause) => persistenceError("markDeleted", cause)),
      );

  const recordDeletionFailure: CheckpointMaintenance.CheckpointMaintenancePersistence["Service"]["recordDeletionFailure"] =
    (input) =>
      retention
        .markDeletionFailed({
          snapshotId: input.deletionId,
          errorCode: "sidecar-ref-delete-failed",
        })
        .pipe(Effect.mapError((cause) => persistenceError("recordDeletionFailure", cause)));

  const listSidecarGcCandidates: CheckpointMaintenance.CheckpointMaintenancePersistence["Service"]["listSidecarGcCandidates"] =
    () =>
      retention
        .listGcExecutionCandidates({
          minimumDeletedSnapshots: GC_MINIMUM_DELETED_SNAPSHOTS,
        })
        .pipe(Effect.mapError((cause) => persistenceError("listSidecarGcCandidates", cause)));

  return CheckpointMaintenance.CheckpointMaintenancePersistence.of({
    claimExpired,
    markDeleted,
    recordDeletionFailure,
    listSidecarGcCandidates,
  });
});

export const CheckpointMaintenancePersistenceLive = Layer.effect(
  CheckpointMaintenance.CheckpointMaintenancePersistence,
  make,
);

export const CheckpointMaintenanceLive = CheckpointMaintenance.layer.pipe(
  Layer.provideMerge(CheckpointMaintenancePersistenceLive),
);
