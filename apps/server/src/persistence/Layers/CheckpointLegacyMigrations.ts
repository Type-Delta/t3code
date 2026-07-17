import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CheckpointLegacyMigrationRepository,
  type CheckpointLegacyMigrationRepositoryShape,
  type ProjectedLegacyCheckpoint,
} from "../Services/CheckpointLegacyMigrations.ts";

const LEGACY_PREFIX = "refs/t3/checkpoints/";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listProjected: CheckpointLegacyMigrationRepositoryShape["listProjected"] = (input) =>
    sql<ProjectedLegacyCheckpoint>`
      SELECT
        turn.row_id AS "projectionTurnRowId",
        turn.thread_id AS "threadId",
        turn.turn_id AS "turnId",
        turn.checkpoint_ref AS "legacyRef",
        COALESCE(thread.worktree_path, project.workspace_root) AS "cwd"
      FROM projection_turns AS turn
      JOIN projection_threads AS thread ON thread.thread_id = turn.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      LEFT JOIN checkpoint_legacy_migrations AS migration
        ON migration.projection_turn_row_id = turn.row_id
      WHERE turn.turn_id IS NOT NULL
        AND turn.checkpoint_ref LIKE ${`${LEGACY_PREFIX}%`}
        AND (migration.candidate_id IS NULL OR migration.state IN ('pending', 'error'))
      ORDER BY turn.row_id ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("CheckpointLegacyMigrationRepository.listProjected")),
    );

  const prepare: CheckpointLegacyMigrationRepositoryShape["prepare"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO checkpoint_repositories (
            repository_key, common_dir_fingerprint, object_format,
            sidecar_relative_path, created_at, last_used_at
          ) VALUES (
            ${input.repositoryKey}, ${input.commonDirFingerprint}, ${input.objectFormat},
            ${input.sidecarRelativePath}, ${input.now}, ${input.now}
          )
          ON CONFLICT (repository_key) DO UPDATE SET last_used_at = excluded.last_used_at
        `;
          yield* sql`
          INSERT INTO checkpoint_snapshots (
            snapshot_id, repository_key, worktree_key, kind, state, created_at
          ) VALUES (
            ${input.snapshotId}, ${input.repositoryKey}, ${input.worktreeKey},
            'legacy-import', 'pending', ${input.now}
          )
          ON CONFLICT (snapshot_id) DO NOTHING
        `;
          yield* sql`
          INSERT INTO checkpoint_legacy_migrations (
            candidate_id, projection_turn_row_id, thread_id, turn_id, legacy_ref,
            snapshot_id, repository_key, worktree_key, state, created_at, updated_at
          ) VALUES (
            ${input.candidateId}, ${input.projectionTurnRowId}, ${input.threadId}, ${input.turnId},
            ${input.legacyRef}, ${input.snapshotId}, ${input.repositoryKey}, ${input.worktreeKey},
            'pending', ${input.now}, ${input.now}
          )
          ON CONFLICT (candidate_id) DO UPDATE SET
            state = CASE
              WHEN checkpoint_legacy_migrations.state = 'error' THEN 'pending'
              ELSE checkpoint_legacy_migrations.state
            END,
            failure_code = CASE
              WHEN checkpoint_legacy_migrations.state = 'error' THEN NULL
              ELSE checkpoint_legacy_migrations.failure_code
            END,
            updated_at = excluded.updated_at
        `;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CheckpointLegacyMigrationRepository.prepare")));

  const markVerified: CheckpointLegacyMigrationRepositoryShape["markVerified"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly snapshotId: string;
            readonly projectionTurnRowId: number;
          }>`
          SELECT
            snapshot_id AS "snapshotId",
            projection_turn_row_id AS "projectionTurnRowId"
          FROM checkpoint_legacy_migrations
          WHERE candidate_id = ${input.candidateId}
            AND legacy_ref = ${input.legacyRef}
        `;
          const record = rows[0];
          if (!record) return false;
          const projection = yield* sql<{ readonly checkpointRef: string }>`
          SELECT checkpoint_ref AS "checkpointRef"
          FROM projection_turns
          WHERE row_id = ${record.projectionTurnRowId}
        `;
          const currentRef = projection[0]?.checkpointRef;
          if (currentRef !== input.legacyRef && currentRef !== input.sidecarRef) return false;
          yield* sql`
          UPDATE checkpoint_snapshots
          SET state = 'ready', commit_oid = ${input.commitOid}, tree_oid = ${input.treeOid},
              ready_at = ${input.verifiedAt}, error_code = NULL
          WHERE snapshot_id = ${record.snapshotId}
        `;
          yield* sql`
          UPDATE projection_turns
          SET checkpoint_ref = ${input.sidecarRef}
          WHERE row_id = ${record.projectionTurnRowId}
            AND checkpoint_ref = ${input.legacyRef}
        `;
          yield* sql`
          UPDATE checkpoint_legacy_migrations
          SET state = 'verified', failure_code = NULL, verified_at = ${input.verifiedAt},
              cleanup_after = ${input.cleanupAfter}, updated_at = ${input.verifiedAt}
          WHERE candidate_id = ${input.candidateId}
        `;
          return true;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("CheckpointLegacyMigrationRepository.markVerified")),
      );

  const markFailure: CheckpointLegacyMigrationRepositoryShape["markFailure"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          UPDATE checkpoint_legacy_migrations
          SET state = 'error', failure_code = ${input.failureCode}, updated_at = ${input.now}
          WHERE candidate_id = ${input.candidateId}
            AND state NOT IN ('verified', 'cleanup-pending', 'cleaned')
        `;
          yield* sql`
          UPDATE checkpoint_snapshots
          SET state = 'error', error_code = ${input.failureCode}
          WHERE snapshot_id = (
            SELECT snapshot_id FROM checkpoint_legacy_migrations
            WHERE candidate_id = ${input.candidateId}
          ) AND state <> 'ready'
        `;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("CheckpointLegacyMigrationRepository.markFailure")),
      );

  const getExecutionContext: CheckpointLegacyMigrationRepositoryShape["getExecutionContext"] = (
    input,
  ) =>
    sql<{
      readonly cwd: string;
      readonly legacyRef: string;
      readonly snapshotId: string;
      readonly repositoryKey: string;
      readonly worktreeKey: string;
    }>`
      SELECT
        COALESCE(thread.worktree_path, project.workspace_root) AS "cwd",
        migration.legacy_ref AS "legacyRef",
        migration.snapshot_id AS "snapshotId",
        migration.repository_key AS "repositoryKey",
        migration.worktree_key AS "worktreeKey"
      FROM checkpoint_legacy_migrations AS migration
      JOIN projection_threads AS thread ON thread.thread_id = migration.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE migration.candidate_id = ${input.candidateId}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(
        toPersistenceSqlError("CheckpointLegacyMigrationRepository.getExecutionContext"),
      ),
    );

  const cwdPredicate = sql`
    COALESCE(thread.worktree_path, project.workspace_root)
  `;

  const listKnownRefs: CheckpointLegacyMigrationRepositoryShape["listKnownRefs"] = (input) =>
    sql<{ readonly legacyRef: string }>`
      SELECT DISTINCT known.legacy_ref AS "legacyRef"
      FROM (
        SELECT turn.thread_id, turn.checkpoint_ref AS legacy_ref
        FROM projection_turns AS turn
        WHERE turn.checkpoint_ref LIKE ${`${LEGACY_PREFIX}%`}
        UNION ALL
        SELECT migration.thread_id, migration.legacy_ref
        FROM checkpoint_legacy_migrations AS migration
      ) AS known
      JOIN projection_threads AS thread ON thread.thread_id = known.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE ${cwdPredicate} = ${input.cwd}
      ORDER BY known.legacy_ref ASC
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.legacyRef)),
      Effect.mapError(toPersistenceSqlError("CheckpointLegacyMigrationRepository.listKnownRefs")),
    );

  const listCleanupEligibleRefs: CheckpointLegacyMigrationRepositoryShape["listCleanupEligibleRefs"] =
    (input) =>
      sql<{ readonly legacyRef: string }>`
        SELECT migration.legacy_ref AS "legacyRef"
        FROM checkpoint_legacy_migrations AS migration
        JOIN projection_threads AS thread ON thread.thread_id = migration.thread_id
        JOIN projection_projects AS project ON project.project_id = thread.project_id
        WHERE ${cwdPredicate} = ${input.cwd}
          AND migration.state IN ('verified', 'cleanup-pending')
          AND migration.cleanup_after IS NOT NULL
          AND migration.cleanup_after <= ${input.now}
          AND NOT EXISTS (
            SELECT 1 FROM projection_turns AS turn
            WHERE turn.checkpoint_ref = migration.legacy_ref
          )
        ORDER BY migration.legacy_ref ASC
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.legacyRef)),
        Effect.mapError(
          toPersistenceSqlError("CheckpointLegacyMigrationRepository.listCleanupEligibleRefs"),
        ),
      );

  const markCleaned: CheckpointLegacyMigrationRepositoryShape["markCleaned"] = (input) =>
    sql<{ readonly candidateId: string }>`
      UPDATE checkpoint_legacy_migrations
      SET state = 'cleaned', cleaned_at = ${input.now}, updated_at = ${input.now}
      WHERE legacy_ref = ${input.legacyRef}
        AND state IN ('verified', 'cleanup-pending')
        AND thread_id IN (
          SELECT thread.thread_id
          FROM projection_threads AS thread
          JOIN projection_projects AS project ON project.project_id = thread.project_id
          WHERE COALESCE(thread.worktree_path, project.workspace_root) = ${input.cwd}
        )
        AND NOT EXISTS (
          SELECT 1 FROM projection_turns AS turn
          WHERE turn.checkpoint_ref = checkpoint_legacy_migrations.legacy_ref
        )
      RETURNING candidate_id AS "candidateId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("CheckpointLegacyMigrationRepository.markCleaned")),
    );

  const markCleanupPending: CheckpointLegacyMigrationRepositoryShape["markCleanupPending"] = (
    input,
  ) =>
    sql<{ readonly candidateId: string }>`
      UPDATE checkpoint_legacy_migrations
      SET state = 'cleanup-pending', updated_at = ${input.now}
      WHERE legacy_ref = ${input.legacyRef}
        AND state IN ('verified', 'cleanup-pending')
        AND cleanup_after IS NOT NULL
        AND cleanup_after <= ${input.now}
        AND thread_id IN (
          SELECT thread.thread_id
          FROM projection_threads AS thread
          JOIN projection_projects AS project ON project.project_id = thread.project_id
          WHERE COALESCE(thread.worktree_path, project.workspace_root) = ${input.cwd}
        )
        AND NOT EXISTS (
          SELECT 1 FROM projection_turns AS turn
          WHERE turn.checkpoint_ref = checkpoint_legacy_migrations.legacy_ref
        )
      RETURNING candidate_id AS "candidateId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("CheckpointLegacyMigrationRepository.markCleanupPending"),
      ),
    );

  return CheckpointLegacyMigrationRepository.of({
    listProjected,
    prepare,
    markVerified,
    markFailure,
    getExecutionContext,
    listKnownRefs,
    listCleanupEligibleRefs,
    markCleanupPending,
    markCleaned,
  });
});

export const CheckpointLegacyMigrationRepositoryLive = Layer.effect(
  CheckpointLegacyMigrationRepository,
  make,
);
