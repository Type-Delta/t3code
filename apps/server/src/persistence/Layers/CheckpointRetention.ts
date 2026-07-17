import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CheckpointRetentionRepository,
  type CheckpointDeletionCandidate,
  type CheckpointRepositoryDeletionCandidate,
  type CheckpointRetentionRepositoryShape,
} from "../Services/CheckpointRetention.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const applyPolicy: CheckpointRetentionRepositoryShape["applyPolicy"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          UPDATE checkpoint_snapshots
          SET retention_class = 'failed-unpublished', delete_after = created_at
          WHERE state IN ('contended', 'error')
            AND commit_oid IS NULL
            AND deleted_at IS NULL
            AND delete_after IS NULL
        `;
          yield* sql`
          UPDATE checkpoint_snapshots
          SET retention_class = 'rescue',
              delete_after = strftime('%Y-%m-%dT%H:%M:%fZ', datetime(created_at, '+1 day'))
          WHERE kind = 'rescue'
            AND deleted_at IS NULL
            AND delete_after IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM checkpoint_navigation_operations AS operation
              WHERE operation.rescue_snapshot_id = checkpoint_snapshots.snapshot_id
                AND operation.phase NOT IN ('committed', 'compensated', 'failed')
            )
        `;
          yield* sql`
          WITH RECURSIVE active_lineage(thread_id, generation, max_ordinal) AS (
            SELECT generation.thread_id, generation.generation, NULL
            FROM thread_checkpoint_generations AS generation
            WHERE generation.state = 'active'

            UNION ALL

            SELECT parent.thread_id, parent.generation, fork_entry.ordinal
            FROM active_lineage AS lineage
            JOIN thread_checkpoint_generations AS child
              ON child.thread_id = lineage.thread_id
             AND child.generation = lineage.generation
            JOIN thread_checkpoint_entries AS fork_entry
              ON fork_entry.thread_id = child.thread_id
             AND fork_entry.entry_id = child.forked_from_entry_id
            JOIN thread_checkpoint_generations AS parent
              ON parent.thread_id = child.thread_id
             AND parent.generation = child.parent_generation
          ),
          reachable_snapshots(snapshot_id) AS (
            SELECT DISTINCT entry.snapshot_id
            FROM thread_checkpoint_entries AS entry
            JOIN active_lineage AS lineage
              ON lineage.thread_id = entry.thread_id
             AND lineage.generation = entry.timeline_generation
             AND (lineage.max_ordinal IS NULL OR entry.ordinal <= lineage.max_ordinal)
          )
          UPDATE checkpoint_snapshots
          SET retention_class = 'abandoned',
              delete_after = (
                SELECT COALESCE(
                  generation.delete_after,
                  strftime('%Y-%m-%dT%H:%M:%fZ', datetime(generation.abandoned_at, '+7 days'))
                )
                FROM thread_checkpoint_entries AS entry
                JOIN thread_checkpoint_generations AS generation
                  ON generation.thread_id = entry.thread_id
                 AND generation.generation = entry.timeline_generation
                WHERE entry.snapshot_id = checkpoint_snapshots.snapshot_id
                  AND generation.state = 'abandoned'
                LIMIT 1
              )
          WHERE deleted_at IS NULL
            AND snapshot_id NOT IN (SELECT snapshot_id FROM reachable_snapshots)
            AND EXISTS (
              SELECT 1
              FROM thread_checkpoint_entries AS entry
              JOIN thread_checkpoint_generations AS generation
                ON generation.thread_id = entry.thread_id
               AND generation.generation = entry.timeline_generation
              WHERE entry.snapshot_id = checkpoint_snapshots.snapshot_id
                AND generation.state = 'abandoned'
            )
        `;
          yield* sql`
          UPDATE checkpoint_snapshots
          SET retention_class = 'deleted-thread',
              delete_after = (
                SELECT strftime('%Y-%m-%dT%H:%M:%fZ', datetime(thread.deleted_at, '+1 day'))
                FROM projection_threads AS thread
                WHERE thread.deleted_at IS NOT NULL
                  AND thread.thread_id IN (
                    SELECT job.thread_id FROM checkpoint_capture_jobs AS job
                    WHERE job.snapshot_id = checkpoint_snapshots.snapshot_id
                    UNION
                    SELECT entry.thread_id FROM thread_checkpoint_entries AS entry
                    WHERE entry.snapshot_id = checkpoint_snapshots.snapshot_id
                    UNION
                    SELECT migration.thread_id FROM checkpoint_legacy_migrations AS migration
                    WHERE migration.snapshot_id = checkpoint_snapshots.snapshot_id
                  )
                ORDER BY thread.deleted_at ASC
                LIMIT 1
              )
          WHERE deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM projection_threads AS thread
              WHERE thread.deleted_at IS NOT NULL
                AND thread.thread_id IN (
                  SELECT job.thread_id FROM checkpoint_capture_jobs AS job
                  WHERE job.snapshot_id = checkpoint_snapshots.snapshot_id
                  UNION
                  SELECT entry.thread_id FROM thread_checkpoint_entries AS entry
                  WHERE entry.snapshot_id = checkpoint_snapshots.snapshot_id
                  UNION
                  SELECT migration.thread_id FROM checkpoint_legacy_migrations AS migration
                  WHERE migration.snapshot_id = checkpoint_snapshots.snapshot_id
                )
            )
        `;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CheckpointRetentionRepository.applyPolicy")));

  const scheduleSnapshotDeletion: CheckpointRetentionRepositoryShape["scheduleSnapshotDeletion"] = (
    input,
  ) =>
    sql`
        UPDATE checkpoint_snapshots
        SET
          retention_class = ${input.retentionClass},
          delete_after = ${input.deleteAfter},
          deletion_error_code = NULL
        WHERE snapshot_id = ${input.snapshotId}
          AND deleted_at IS NULL
      `.pipe(
      Effect.asVoid,
      Effect.mapError(
        toPersistenceSqlError("CheckpointRetentionRepository.scheduleSnapshotDeletion"),
      ),
    );

  const listDeletionCandidates: CheckpointRetentionRepositoryShape["listDeletionCandidates"] = (
    input,
  ) =>
    sql<CheckpointDeletionCandidate>`
      WITH RECURSIVE active_lineage(thread_id, generation, max_ordinal) AS (
        SELECT generation.thread_id, generation.generation, NULL
        FROM thread_checkpoint_generations AS generation
        WHERE generation.state = 'active'

        UNION ALL

        SELECT parent.thread_id, parent.generation, fork_entry.ordinal
        FROM active_lineage AS lineage
        JOIN thread_checkpoint_generations AS child
          ON child.thread_id = lineage.thread_id
         AND child.generation = lineage.generation
        JOIN thread_checkpoint_entries AS fork_entry
          ON fork_entry.thread_id = child.thread_id
         AND fork_entry.entry_id = child.forked_from_entry_id
        JOIN thread_checkpoint_generations AS parent
          ON parent.thread_id = child.thread_id
         AND parent.generation = child.parent_generation
      ),
      reachable_snapshots(snapshot_id) AS (
        SELECT DISTINCT entry.snapshot_id
        FROM thread_checkpoint_entries AS entry
        JOIN active_lineage AS lineage
          ON lineage.thread_id = entry.thread_id
         AND lineage.generation = entry.timeline_generation
         AND (lineage.max_ordinal IS NULL OR entry.ordinal <= lineage.max_ordinal)
      )
      SELECT
        snapshot_id AS "snapshotId",
        repository_key AS "repositoryKey",
        worktree_key AS "worktreeKey",
        commit_oid AS "commitOid",
        delete_after AS "deleteAfter",
        deletion_started_at AS "deletionStartedAt"
      FROM checkpoint_snapshots
      WHERE delete_after IS NOT NULL
        AND delete_after <= ${input.now}
        AND deleted_at IS NULL
        AND state IN ('ready', 'contended', 'error')
        AND snapshot_id NOT IN (SELECT snapshot_id FROM reachable_snapshots)
        AND NOT EXISTS (
          SELECT 1
          FROM checkpoint_navigation_operations AS operation
          WHERE operation.rescue_snapshot_id = checkpoint_snapshots.snapshot_id
            AND operation.phase NOT IN ('committed', 'compensated', 'failed')
        )
      ORDER BY delete_after ASC, snapshot_id ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(
        toPersistenceSqlError("CheckpointRetentionRepository.listDeletionCandidates"),
      ),
    );

  const markDeletionStarted: CheckpointRetentionRepositoryShape["markDeletionStarted"] = (input) =>
    sql<{ readonly snapshotId: string }>`
      WITH RECURSIVE active_lineage(thread_id, generation, max_ordinal) AS (
        SELECT generation.thread_id, generation.generation, NULL
        FROM thread_checkpoint_generations AS generation
        WHERE generation.state = 'active'

        UNION ALL

        SELECT parent.thread_id, parent.generation, fork_entry.ordinal
        FROM active_lineage AS lineage
        JOIN thread_checkpoint_generations AS child
          ON child.thread_id = lineage.thread_id
         AND child.generation = lineage.generation
        JOIN thread_checkpoint_entries AS fork_entry
          ON fork_entry.thread_id = child.thread_id
         AND fork_entry.entry_id = child.forked_from_entry_id
        JOIN thread_checkpoint_generations AS parent
          ON parent.thread_id = child.thread_id
         AND parent.generation = child.parent_generation
      ),
      reachable_snapshots(snapshot_id) AS (
        SELECT DISTINCT entry.snapshot_id
        FROM thread_checkpoint_entries AS entry
        JOIN active_lineage AS lineage
          ON lineage.thread_id = entry.thread_id
         AND lineage.generation = entry.timeline_generation
         AND (lineage.max_ordinal IS NULL OR entry.ordinal <= lineage.max_ordinal)
      )
      UPDATE checkpoint_snapshots
      SET deletion_started_at = ${input.now}, deletion_error_code = NULL
      WHERE snapshot_id = ${input.snapshotId}
        AND deletion_started_at IS NULL
        AND deleted_at IS NULL
        AND snapshot_id NOT IN (SELECT snapshot_id FROM reachable_snapshots)
        AND NOT EXISTS (
          SELECT 1
          FROM checkpoint_navigation_operations AS operation
          WHERE operation.rescue_snapshot_id = checkpoint_snapshots.snapshot_id
            AND operation.phase NOT IN ('committed', 'compensated', 'failed')
        )
      RETURNING snapshot_id AS "snapshotId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("CheckpointRetentionRepository.markDeletionStarted")),
    );

  const markDeleted: CheckpointRetentionRepositoryShape["markDeleted"] = (input) =>
    sql`
      UPDATE checkpoint_snapshots
      SET deleted_at = ${input.now}, deletion_error_code = NULL
      WHERE snapshot_id = ${input.snapshotId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("CheckpointRetentionRepository.markDeleted")),
    );

  const markDeletionFailed: CheckpointRetentionRepositoryShape["markDeletionFailed"] = (input) =>
    sql`
      UPDATE checkpoint_snapshots
      SET deletion_started_at = NULL, deletion_error_code = ${input.errorCode}
      WHERE snapshot_id = ${input.snapshotId}
        AND deleted_at IS NULL
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("CheckpointRetentionRepository.markDeletionFailed")),
    );

  const getSnapshotExecutionContext: CheckpointRetentionRepositoryShape["getSnapshotExecutionContext"] =
    (input) =>
      sql<{
        readonly cwd: string;
        readonly repositoryKey: string;
        readonly worktreeKey: string;
      }>`
        SELECT
          COALESCE(thread.worktree_path, project.workspace_root) AS "cwd",
          snapshot.repository_key AS "repositoryKey",
          snapshot.worktree_key AS "worktreeKey"
        FROM checkpoint_snapshots AS snapshot
        JOIN projection_threads AS thread ON thread.thread_id = COALESCE(
          (SELECT job.thread_id FROM checkpoint_capture_jobs AS job
           WHERE job.snapshot_id = snapshot.snapshot_id LIMIT 1),
          (SELECT entry.thread_id FROM thread_checkpoint_entries AS entry
           WHERE entry.snapshot_id = snapshot.snapshot_id LIMIT 1),
          (SELECT migration.thread_id FROM checkpoint_legacy_migrations AS migration
           WHERE migration.snapshot_id = snapshot.snapshot_id LIMIT 1)
        )
        JOIN projection_projects AS project ON project.project_id = thread.project_id
        WHERE snapshot.snapshot_id = ${input.snapshotId}
      `.pipe(
        Effect.map((rows) => rows[0]),
        Effect.mapError(
          toPersistenceSqlError("CheckpointRetentionRepository.getSnapshotExecutionContext"),
        ),
      );

  const listGcExecutionCandidates: CheckpointRetentionRepositoryShape["listGcExecutionCandidates"] =
    (input) =>
      sql<{ readonly cwd: string }>`
        SELECT DISTINCT COALESCE(thread.worktree_path, project.workspace_root) AS "cwd"
        FROM checkpoint_repositories AS repository
        JOIN projection_threads AS thread ON thread.thread_id = COALESCE(
          (SELECT job.thread_id FROM checkpoint_capture_jobs AS job
           JOIN checkpoint_snapshots AS owned ON owned.snapshot_id = job.snapshot_id
           WHERE owned.repository_key = repository.repository_key LIMIT 1),
          (SELECT entry.thread_id FROM thread_checkpoint_entries AS entry
           JOIN checkpoint_snapshots AS owned ON owned.snapshot_id = entry.snapshot_id
           WHERE owned.repository_key = repository.repository_key LIMIT 1),
          (SELECT migration.thread_id FROM checkpoint_legacy_migrations AS migration
           WHERE migration.repository_key = repository.repository_key LIMIT 1)
        )
        JOIN projection_projects AS project ON project.project_id = thread.project_id
        WHERE repository.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM checkpoint_snapshots AS live
            WHERE live.repository_key = repository.repository_key
              AND live.state IN ('pending', 'running')
              AND live.deleted_at IS NULL
          )
          AND (
            SELECT COUNT(*) FROM checkpoint_snapshots AS removed
            WHERE removed.repository_key = repository.repository_key
              AND removed.deleted_at IS NOT NULL
          ) >= ${input.minimumDeletedSnapshots}
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("CheckpointRetentionRepository.listGcExecutionCandidates"),
        ),
      );

  const listRepositoryDeletionCandidates: CheckpointRetentionRepositoryShape["listRepositoryDeletionCandidates"] =
    (input) =>
      sql<CheckpointRepositoryDeletionCandidate>`
        SELECT
          repository_key AS "repositoryKey",
          sidecar_relative_path AS "sidecarRelativePath",
          delete_after AS "deleteAfter"
        FROM checkpoint_repositories AS repository
        WHERE repository.delete_after IS NOT NULL
          AND repository.delete_after <= ${input.now}
          AND repository.deletion_started_at IS NULL
          AND repository.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM checkpoint_snapshots AS snapshot
            WHERE snapshot.repository_key = repository.repository_key
              AND snapshot.deleted_at IS NULL
          )
        ORDER BY repository.delete_after ASC, repository.repository_key ASC
        LIMIT ${input.limit}
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("CheckpointRetentionRepository.listRepositoryDeletionCandidates"),
        ),
      );

  const scheduleRepositoryDeletion: CheckpointRetentionRepositoryShape["scheduleRepositoryDeletion"] =
    (input) =>
      sql`
        UPDATE checkpoint_repositories
        SET
          retention_class = ${input.retentionClass},
          delete_after = ${input.deleteAfter},
          deletion_error_code = NULL
        WHERE repository_key = ${input.repositoryKey}
          AND deleted_at IS NULL
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("CheckpointRetentionRepository.scheduleRepositoryDeletion"),
        ),
      );

  const markRepositoryDeletionStarted: CheckpointRetentionRepositoryShape["markRepositoryDeletionStarted"] =
    (input) =>
      sql<{ readonly repositoryKey: string }>`
        UPDATE checkpoint_repositories
        SET deletion_started_at = ${input.now}, deletion_error_code = NULL
        WHERE repository_key = ${input.repositoryKey}
          AND deletion_started_at IS NULL
          AND deleted_at IS NULL
        RETURNING repository_key AS "repositoryKey"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          toPersistenceSqlError("CheckpointRetentionRepository.markRepositoryDeletionStarted"),
        ),
      );

  const markRepositoryDeleted: CheckpointRetentionRepositoryShape["markRepositoryDeleted"] = (
    input,
  ) =>
    sql`
      UPDATE checkpoint_repositories
      SET deleted_at = ${input.now}, deletion_error_code = NULL
      WHERE repository_key = ${input.repositoryKey}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("CheckpointRetentionRepository.markRepositoryDeleted")),
    );

  const markRepositoryDeletionFailed: CheckpointRetentionRepositoryShape["markRepositoryDeletionFailed"] =
    (input) =>
      sql`
        UPDATE checkpoint_repositories
        SET deletion_started_at = NULL, deletion_error_code = ${input.errorCode}
        WHERE repository_key = ${input.repositoryKey}
          AND deleted_at IS NULL
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("CheckpointRetentionRepository.markRepositoryDeletionFailed"),
        ),
      );

  return {
    applyPolicy,
    scheduleSnapshotDeletion,
    listDeletionCandidates,
    markDeletionStarted,
    markDeleted,
    markDeletionFailed,
    getSnapshotExecutionContext,
    listGcExecutionCandidates,
    listRepositoryDeletionCandidates,
    scheduleRepositoryDeletion,
    markRepositoryDeletionStarted,
    markRepositoryDeleted,
    markRepositoryDeletionFailed,
  } satisfies CheckpointRetentionRepositoryShape;
});

export const CheckpointRetentionRepositoryLive = Layer.effect(CheckpointRetentionRepository, make);
