import { CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";

export interface LegacyCheckpointMigrationCandidate {
  /** Durable, unique projection/migration row identity. */
  readonly candidateId: string;
  readonly cwd: string;
  readonly legacyCheckpointRef: CheckpointRef;
  /** Stable across retries; must not contain workspace paths or credentials. */
  readonly snapshotId: string;
}

export interface ImportedLegacyCheckpoint {
  readonly candidateId: string;
  readonly legacyCheckpointRef: CheckpointRef;
  readonly sidecarCheckpointRef: CheckpointRef;
  readonly commitOid: string;
  readonly treeOid: string;
}

export class CheckpointMigrationPersistenceError extends Schema.TaggedErrorClass<CheckpointMigrationPersistenceError>()(
  "CheckpointMigrationPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Injected persistence seam. The SQLite implementation owns candidate
 * discovery and must atomically replace the projection locator while recording
 * completion in `markImported`.
 */
export class CheckpointMigrationPersistence extends Context.Service<
  CheckpointMigrationPersistence,
  {
    readonly listPending: (input: {
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<LegacyCheckpointMigrationCandidate>,
      CheckpointMigrationPersistenceError
    >;
    readonly markImported: (
      input: ImportedLegacyCheckpoint,
    ) => Effect.Effect<void, CheckpointMigrationPersistenceError>;
    readonly recordFailure: (input: {
      readonly candidateId: string;
      readonly reason: "legacy-unavailable" | "verification-failed" | "storage-failed";
    }) => Effect.Effect<void, CheckpointMigrationPersistenceError>;
    readonly listKnownLegacyRefs: (input: {
      readonly cwd: string;
    }) => Effect.Effect<ReadonlyArray<CheckpointRef>, CheckpointMigrationPersistenceError>;
    readonly listCleanupEligibleLegacyRefs: (input: {
      readonly cwd: string;
    }) => Effect.Effect<ReadonlyArray<CheckpointRef>, CheckpointMigrationPersistenceError>;
  }
>()("t3/checkpointing/CheckpointMigration/CheckpointMigrationPersistence") {}

export interface CheckpointMigrationBatchResult {
  readonly attempted: number;
  readonly imported: number;
  readonly alreadyImported: number;
  readonly failed: number;
}

export interface LegacyCheckpointInspection {
  readonly knownRefs: ReadonlyArray<CheckpointRef>;
  readonly unknownRefs: ReadonlyArray<CheckpointRef>;
  /** Always dry-run: exact verified refs persistence considers safe to remove. */
  readonly cleanupEligibleRefs: ReadonlyArray<CheckpointRef>;
}

export const classifyLegacyRefs = (
  discovered: ReadonlyArray<CheckpointRef>,
  known: ReadonlyArray<CheckpointRef>,
) => {
  const knownSet = new Set(known.map(String));
  return {
    knownRefs: discovered.filter((ref) => knownSet.has(String(ref))),
    unknownRefs: discovered.filter((ref) => !knownSet.has(String(ref))),
  };
};

export class CheckpointMigration extends Context.Service<
  CheckpointMigration,
  {
    readonly runBatch: (input?: {
      readonly limit?: number;
    }) => Effect.Effect<CheckpointMigrationBatchResult, CheckpointMigrationPersistenceError>;
    readonly inspectLegacyRefs: (input: {
      readonly cwd: string;
      /** Exact refs discovered by the diagnostics/legacy Git adapter. */
      readonly discoveredRefs: ReadonlyArray<CheckpointRef>;
    }) => Effect.Effect<LegacyCheckpointInspection, CheckpointMigrationPersistenceError>;
  }
>()("t3/checkpointing/CheckpointMigration") {}

export const make = Effect.gen(function* () {
  const persistence = yield* CheckpointMigrationPersistence;
  const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;

  const runBatch: CheckpointMigration["Service"]["runBatch"] = Effect.fn(
    "CheckpointMigration.runBatch",
  )(function* (input) {
    const candidates = yield* persistence.listPending({ limit: input?.limit ?? 50 });
    let imported = 0;
    let alreadyImported = 0;
    let failed = 0;

    for (const candidate of candidates) {
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const sidecarCheckpointRef = yield* sidecars.allocate({
            cwd: candidate.cwd,
            snapshotId: candidate.snapshotId,
          });
          const migration = yield* sidecars.importLegacy({
            cwd: candidate.cwd,
            legacyCheckpointRef: candidate.legacyCheckpointRef,
            sidecarCheckpointRef,
          });
          yield* persistence.markImported({
            candidateId: candidate.candidateId,
            legacyCheckpointRef: candidate.legacyCheckpointRef,
            sidecarCheckpointRef,
            commitOid: migration.commitOid,
            treeOid: migration.treeOid,
          });
          return migration;
        }),
      );

      if (result._tag === "Success") {
        if (result.success.alreadyImported) alreadyImported += 1;
        else imported += 1;
        continue;
      }

      failed += 1;
      const error = result.failure;
      const reason =
        error._tag === "VcsProcessExitError" && error.detail === "Legacy checkpoint is unavailable."
          ? "legacy-unavailable"
          : error._tag === "VcsProcessExitError" && error.detail.includes("verification")
            ? "verification-failed"
            : "storage-failed";
      yield* persistence.recordFailure({ candidateId: candidate.candidateId, reason });
    }

    return {
      attempted: candidates.length,
      imported,
      alreadyImported,
      failed,
    };
  });

  const inspectLegacyRefs: CheckpointMigration["Service"]["inspectLegacyRefs"] = Effect.fn(
    "CheckpointMigration.inspectLegacyRefs",
  )(function* (input) {
    const [known, cleanupEligible] = yield* Effect.all([
      persistence.listKnownLegacyRefs(input),
      persistence.listCleanupEligibleLegacyRefs(input),
    ]);
    const classified = classifyLegacyRefs(input.discoveredRefs, known);
    const discoveredSet = new Set(input.discoveredRefs.map(String));
    return {
      ...classified,
      cleanupEligibleRefs: cleanupEligible.filter((ref) => discoveredSet.has(String(ref))),
    };
  });

  return CheckpointMigration.of({ runBatch, inspectLegacyRefs });
});

export const layer = Layer.effect(CheckpointMigration, make);
