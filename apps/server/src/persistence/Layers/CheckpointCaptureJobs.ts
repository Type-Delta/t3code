import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CheckpointCaptureJobRepository,
  type CheckpointCaptureJob,
  type CheckpointCaptureJobRepositoryShape,
  type CheckpointSnapshot,
} from "../Services/CheckpointCaptureJobs.ts";

const jobColumns = `
  job_id AS "jobId",
  snapshot_id AS "snapshotId",
  thread_id AS "threadId",
  timeline_generation AS "timelineGeneration",
  turn_id AS "turnId",
  provider_turn_id AS "providerTurnId",
  provider_binding_json AS "providerBindingJson",
  provider_cursor_json AS "providerCursorJson",
  turn_ordinal AS "turnOrdinal",
  repository_key AS "repositoryKey",
  worktree_key AS "worktreeKey",
  requested_boundary AS "requestedBoundary",
  requested_generation AS "requestedGeneration",
  state,
  attempt_count AS "attemptCount",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  error_code AS "errorCode",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRepository: CheckpointCaptureJobRepositoryShape["upsertRepository"] = (repository) =>
    sql`
      INSERT INTO checkpoint_repositories (
        repository_key,
        common_dir_fingerprint,
        object_format,
        sidecar_relative_path,
        created_at,
        last_used_at
      ) VALUES (
        ${repository.repositoryKey},
        ${repository.commonDirFingerprint},
        ${repository.objectFormat},
        ${repository.sidecarRelativePath},
        ${repository.createdAt},
        ${repository.lastUsedAt}
      )
      ON CONFLICT (repository_key) DO UPDATE SET
        last_used_at = excluded.last_used_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("CheckpointCaptureJobRepository.upsertRepository")),
    );

  const findLogicalJob = (input: {
    readonly threadId: string;
    readonly timelineGeneration: number;
    readonly turnId: string;
    readonly requestedBoundary: string;
  }) =>
    sql<CheckpointCaptureJob>`
      SELECT ${sql.unsafe(jobColumns)}
      FROM checkpoint_capture_jobs
      WHERE thread_id = ${input.threadId}
        AND timeline_generation = ${input.timelineGeneration}
        AND turn_id = ${input.turnId}
        AND requested_boundary = ${input.requestedBoundary}
      LIMIT 1
    `;

  const findSnapshotJob = (snapshotId: string) =>
    sql<CheckpointCaptureJob>`
      SELECT ${sql.unsafe(jobColumns)}
      FROM checkpoint_capture_jobs
      WHERE snapshot_id = ${snapshotId}
      LIMIT 1
    `;

  const retrySnapshotJob = Effect.fn("retrySnapshotJob")(function* (
    snapshotJob: CheckpointCaptureJob,
    input: Parameters<CheckpointCaptureJobRepositoryShape["enqueue"]>[0],
  ) {
    // Reuse a failed snapshot row so retries preserve the one-job-per-snapshot invariant.
    yield* sql`
      UPDATE checkpoint_snapshots
      SET
        kind = ${input.snapshot.kind},
        state = 'pending',
        commit_oid = NULL,
        tree_oid = NULL,
        created_at = ${input.snapshot.createdAt},
        ready_at = NULL,
        expires_at = ${input.snapshot.expiresAt},
        error_code = NULL
      WHERE snapshot_id = ${snapshotJob.snapshotId}
    `;
    yield* sql`
      UPDATE checkpoint_capture_jobs
      SET
        thread_id = ${input.job.threadId},
        timeline_generation = ${input.job.timelineGeneration},
        turn_id = ${input.job.turnId},
        provider_turn_id = ${input.job.providerTurnId},
        provider_binding_json = ${input.job.providerBindingJson ?? null},
        provider_cursor_json = ${input.job.providerCursorJson ?? null},
        turn_ordinal = ${input.job.turnOrdinal},
        repository_key = ${input.job.repositoryKey},
        worktree_key = ${input.job.worktreeKey},
        requested_boundary = ${input.job.requestedBoundary},
        requested_generation = ${input.job.requestedGeneration},
        state = 'pending',
        attempt_count = 0,
        lease_owner = NULL,
        lease_expires_at = NULL,
        error_code = NULL,
        created_at = ${input.job.createdAt},
        updated_at = ${input.job.createdAt},
        completed_at = NULL
      WHERE job_id = ${snapshotJob.jobId}
    `;
    const retried = yield* findLogicalJob(input.job);
    return retried[0]!;
  });

  const listReadyWithoutTimelineEntry: CheckpointCaptureJobRepositoryShape["listReadyWithoutTimelineEntry"] =
    ({ limit }) =>
      sql<CheckpointCaptureJob>`
        SELECT ${sql.unsafe(jobColumns)}
        FROM checkpoint_capture_jobs AS job
        WHERE job.state = 'ready'
          AND NOT EXISTS (
            SELECT 1
            FROM thread_checkpoint_entries AS entry
            WHERE entry.snapshot_id = job.snapshot_id
          )
        ORDER BY job.completed_at ASC, job.created_at ASC, job.job_id ASC
        LIMIT ${limit}
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("CheckpointCaptureJobRepository.listReadyWithoutTimelineEntry"),
        ),
      );

  const enqueue: CheckpointCaptureJobRepositoryShape["enqueue"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findLogicalJob(input.job);
          if (existing[0] !== undefined) {
            if (existing[0].state === "contended" || existing[0].state === "error") {
              return yield* retrySnapshotJob(existing[0], input);
            }
            if (
              (existing[0].providerTurnId === null && input.job.providerTurnId !== null) ||
              (existing[0].providerBindingJson === null &&
                input.job.providerBindingJson !== null &&
                input.job.providerBindingJson !== undefined)
            ) {
              yield* sql`
                UPDATE checkpoint_capture_jobs
                SET
                  provider_turn_id = COALESCE(provider_turn_id, ${input.job.providerTurnId}),
                  provider_binding_json = COALESCE(
                    provider_binding_json,
                    ${input.job.providerBindingJson ?? null}
                  ),
                  provider_cursor_json = COALESCE(
                    provider_cursor_json,
                    ${input.job.providerCursorJson ?? null}
                  )
                WHERE job_id = ${existing[0].jobId}
              `;
              const enriched = yield* findLogicalJob(input.job);
              return enriched[0]!;
            }
            return existing[0];
          }
          const snapshotJob = (yield* findSnapshotJob(input.snapshot.snapshotId))[0];
          if (snapshotJob !== undefined) {
            if (
              snapshotJob.state === "pending" ||
              snapshotJob.state === "running" ||
              snapshotJob.state === "ready"
            ) {
              return snapshotJob;
            }

            return yield* retrySnapshotJob(snapshotJob, input);
          }
          yield* sql`
            INSERT INTO checkpoint_snapshots (
              snapshot_id,
              repository_key,
              worktree_key,
              commit_oid,
              tree_oid,
              kind,
              state,
              created_at,
              ready_at,
              expires_at,
              error_code
            ) VALUES (
              ${input.snapshot.snapshotId},
              ${input.snapshot.repositoryKey},
              ${input.snapshot.worktreeKey},
              NULL,
              NULL,
              ${input.snapshot.kind},
              'pending',
              ${input.snapshot.createdAt},
              NULL,
              ${input.snapshot.expiresAt},
              NULL
            )
            ON CONFLICT (snapshot_id) DO NOTHING
          `;
          yield* sql`
            INSERT INTO checkpoint_capture_jobs (
              job_id,
              snapshot_id,
              thread_id,
              timeline_generation,
              turn_id,
              provider_turn_id,
              provider_binding_json,
              provider_cursor_json,
              turn_ordinal,
              repository_key,
              worktree_key,
              requested_boundary,
              requested_generation,
              state,
              attempt_count,
              created_at,
              updated_at
            ) VALUES (
              ${input.job.jobId},
              ${input.job.snapshotId},
              ${input.job.threadId},
              ${input.job.timelineGeneration},
              ${input.job.turnId},
              ${input.job.providerTurnId},
              ${input.job.providerBindingJson ?? null},
              ${input.job.providerCursorJson ?? null},
              ${input.job.turnOrdinal},
              ${input.job.repositoryKey},
              ${input.job.worktreeKey},
              ${input.job.requestedBoundary},
              ${input.job.requestedGeneration},
              'pending',
              0,
              ${input.job.createdAt},
              ${input.job.createdAt}
            )
            ON CONFLICT (thread_id, timeline_generation, turn_id, requested_boundary) DO NOTHING
          `;
          const rows = yield* findLogicalJob(input.job);
          return rows[0]!;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CheckpointCaptureJobRepository.enqueue")));

  const claimNext: CheckpointCaptureJobRepositoryShape["claimNext"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<CheckpointCaptureJob>`
            UPDATE checkpoint_capture_jobs
            SET
              state = 'running',
              attempt_count = attempt_count + 1,
              lease_owner = ${input.leaseOwner},
              lease_expires_at = ${input.leaseExpiresAt},
              updated_at = ${input.now}
            WHERE job_id = (
              SELECT candidate.job_id
              FROM checkpoint_capture_jobs AS candidate
              WHERE (
                candidate.state = 'pending'
                OR (
                  candidate.state = 'running'
                  AND candidate.lease_expires_at IS NOT NULL
                  AND candidate.lease_expires_at <= ${input.now}
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM checkpoint_capture_jobs AS active
                WHERE active.worktree_key = candidate.worktree_key
                  AND active.job_id <> candidate.job_id
                  AND active.state = 'running'
                  AND active.lease_expires_at > ${input.now}
              )
              ORDER BY candidate.created_at ASC, candidate.job_id ASC
              LIMIT 1
            )
            RETURNING ${sql.unsafe(jobColumns)}
          `;
          const row = rows[0];
          if (row !== undefined) {
            yield* sql`
              UPDATE checkpoint_snapshots
              SET state = 'running'
              WHERE snapshot_id = ${row.snapshotId}
                AND state = 'pending'
            `;
          }
          return Option.fromNullishOr(row);
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CheckpointCaptureJobRepository.claimNext")));

  const renewLease: CheckpointCaptureJobRepositoryShape["renewLease"] = (input) =>
    sql<{ readonly jobId: string }>`
      UPDATE checkpoint_capture_jobs
      SET lease_expires_at = ${input.leaseExpiresAt}, updated_at = ${input.now}
      WHERE job_id = ${input.jobId}
        AND lease_owner = ${input.leaseOwner}
        AND state = 'running'
      RETURNING job_id AS "jobId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("CheckpointCaptureJobRepository.renewLease")),
    );

  const complete: CheckpointCaptureJobRepositoryShape["complete"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly snapshotId: string }>`
            UPDATE checkpoint_capture_jobs
            SET
              state = ${input.state},
              lease_owner = NULL,
              lease_expires_at = NULL,
              error_code = ${input.errorCode},
              updated_at = ${input.completedAt},
              completed_at = ${input.completedAt}
            WHERE job_id = ${input.jobId}
              AND lease_owner = ${input.leaseOwner}
              AND state = 'running'
            RETURNING snapshot_id AS "snapshotId"
          `;
          const row = rows[0];
          if (row === undefined) return false;
          yield* sql`
            UPDATE checkpoint_snapshots
            SET
              state = ${input.state},
              commit_oid = ${input.commitOid},
              tree_oid = ${input.treeOid},
              ready_at = ${input.state === "ready" ? input.completedAt : null},
              error_code = ${input.errorCode}
            WHERE snapshot_id = ${row.snapshotId}
          `;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CheckpointCaptureJobRepository.complete")));

  const reclaimExpired: CheckpointCaptureJobRepositoryShape["reclaimExpired"] = ({ now }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly snapshotId: string }>`
            UPDATE checkpoint_capture_jobs
            SET
              state = 'pending',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = ${now}
            WHERE state = 'running'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= ${now}
            RETURNING snapshot_id AS "snapshotId"
          `;
          for (const row of rows) {
            yield* sql`
              UPDATE checkpoint_snapshots
              SET state = 'pending'
              WHERE snapshot_id = ${row.snapshotId}
                AND state = 'running'
            `;
          }
          return rows.length;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("CheckpointCaptureJobRepository.reclaimExpired")),
      );

  const getById: CheckpointCaptureJobRepositoryShape["getById"] = ({ jobId }) =>
    sql<CheckpointCaptureJob>`
      SELECT ${sql.unsafe(jobColumns)}
      FROM checkpoint_capture_jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("CheckpointCaptureJobRepository.getById")),
    );

  const getSnapshot: CheckpointCaptureJobRepositoryShape["getSnapshot"] = ({ snapshotId }) =>
    sql<CheckpointSnapshot>`
      SELECT
        snapshot_id AS "snapshotId",
        repository_key AS "repositoryKey",
        worktree_key AS "worktreeKey",
        commit_oid AS "commitOid",
        tree_oid AS "treeOid",
        kind,
        state,
        created_at AS "createdAt",
        ready_at AS "readyAt",
        expires_at AS "expiresAt",
        error_code AS "errorCode"
      FROM checkpoint_snapshots
      WHERE snapshot_id = ${snapshotId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("CheckpointCaptureJobRepository.getSnapshot")),
    );

  return {
    upsertRepository,
    enqueue,
    claimNext,
    renewLease,
    complete,
    reclaimExpired,
    getById,
    getSnapshot,
    listReadyWithoutTimelineEntry,
  } satisfies CheckpointCaptureJobRepositoryShape;
});

export const CheckpointCaptureJobRepositoryLive = Layer.effect(
  CheckpointCaptureJobRepository,
  make,
);
