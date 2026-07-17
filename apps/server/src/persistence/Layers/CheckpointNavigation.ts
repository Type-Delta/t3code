import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CheckpointNavigationRepository,
  type CheckpointNavigationOperation,
  type CheckpointNavigationRepositoryShape,
} from "../Services/CheckpointNavigation.ts";

const operationColumns = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`
  operation_id AS "operationId",
  command_id AS "commandId",
  thread_id AS "threadId",
  kind,
  mode,
  from_entry_id AS "fromEntryId",
  to_entry_id AS "toEntryId",
  rescue_snapshot_id AS "rescueSnapshotId",
  old_provider_binding_json AS "oldProviderBindingJson",
  target_provider_binding_json AS "targetProviderBindingJson",
  prepared_provider_cursor_json AS "preparedProviderCursorJson",
  phase,
  recovery_from_phase AS "recoveryFromPhase",
  failure_code AS "failureCode",
  compensation_failure_code AS "compensationFailureCode",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
`);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordRescueSnapshot: CheckpointNavigationRepositoryShape["recordRescueSnapshot"] = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
              INSERT INTO checkpoint_repositories (
                repository_key, common_dir_fingerprint, object_format,
                sidecar_relative_path, created_at, last_used_at
              ) VALUES (
                ${input.repositoryKey}, ${input.repositoryKey}, ${input.objectFormat},
                ${`repositories/${input.repositoryKey}.git`}, ${input.createdAt}, ${input.createdAt}
              )
              ON CONFLICT (repository_key) DO UPDATE SET last_used_at = excluded.last_used_at
            `;
          yield* sql`
              INSERT INTO checkpoint_snapshots (
                snapshot_id, repository_key, worktree_key, commit_oid, tree_oid,
                kind, state, created_at, ready_at, expires_at, retention_class
              ) VALUES (
                ${input.snapshotId}, ${input.repositoryKey}, ${input.worktreeKey},
                ${input.commitOid}, ${input.treeOid}, 'rescue', 'ready',
                ${input.createdAt}, ${input.createdAt}, ${input.expiresAt}, 'rescue'
              )
              ON CONFLICT (snapshot_id) DO NOTHING
            `;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("CheckpointNavigationRepository.recordRescueSnapshot"),
        ),
      );

  const getByCommand = (commandId: string) =>
    sql<CheckpointNavigationOperation>`
      SELECT ${operationColumns(sql)}
      FROM checkpoint_navigation_operations
      WHERE command_id = ${commandId}
      LIMIT 1
    `;

  const begin: CheckpointNavigationRepositoryShape["begin"] = (operation) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO checkpoint_navigation_operations (
              operation_id,
              command_id,
              thread_id,
              kind,
              mode,
              from_entry_id,
              to_entry_id,
              rescue_snapshot_id,
              old_provider_binding_json,
              target_provider_binding_json,
              prepared_provider_cursor_json,
              phase,
              recovery_from_phase,
              failure_code,
              compensation_failure_code,
              created_at,
              updated_at,
              completed_at
            ) VALUES (
              ${operation.operationId},
              ${operation.commandId},
              ${operation.threadId},
              ${operation.kind},
              ${operation.mode},
              ${operation.fromEntryId},
              ${operation.toEntryId},
              ${operation.rescueSnapshotId},
              ${operation.oldProviderBindingJson},
              ${operation.targetProviderBindingJson},
              ${operation.preparedProviderCursorJson},
              ${operation.phase},
              ${operation.recoveryFromPhase},
              ${operation.failureCode},
              ${operation.compensationFailureCode},
              ${operation.createdAt},
              ${operation.updatedAt},
              ${operation.completedAt}
            )
            ON CONFLICT (command_id) DO NOTHING
          `;
          const rows = yield* getByCommand(operation.commandId);
          return rows[0]!;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CheckpointNavigationRepository.begin")));

  const getByCommandId: CheckpointNavigationRepositoryShape["getByCommandId"] = ({ commandId }) =>
    getByCommand(commandId).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("CheckpointNavigationRepository.getByCommandId")),
    );

  const getUnresolvedByThread: CheckpointNavigationRepositoryShape["getUnresolvedByThread"] = ({
    threadId,
  }) =>
    sql<CheckpointNavigationOperation>`
      SELECT ${operationColumns(sql)}
      FROM checkpoint_navigation_operations
      WHERE thread_id = ${threadId}
        AND phase NOT IN ('committed', 'compensated', 'failed')
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(
        toPersistenceSqlError("CheckpointNavigationRepository.getUnresolvedByThread"),
      ),
    );

  const listRecoverable: CheckpointNavigationRepositoryShape["listRecoverable"] = () =>
    sql<CheckpointNavigationOperation>`
      SELECT ${operationColumns(sql)}
      FROM checkpoint_navigation_operations
      WHERE phase NOT IN ('committed', 'compensated', 'failed')
      ORDER BY created_at ASC, operation_id ASC
    `.pipe(
      Effect.mapError(toPersistenceSqlError("CheckpointNavigationRepository.listRecoverable")),
    );

  const advancePhase: CheckpointNavigationRepositoryShape["advancePhase"] = (input) =>
    sql<{ readonly operationId: string }>`
      UPDATE checkpoint_navigation_operations
      SET
        phase = ${input.phase},
        recovery_from_phase = COALESCE(
          ${input.recoveryFromPhase ?? null},
          recovery_from_phase
        ),
        rescue_snapshot_id = COALESCE(${input.rescueSnapshotId ?? null}, rescue_snapshot_id),
        target_provider_binding_json = COALESCE(
          ${input.targetProviderBindingJson ?? null},
          target_provider_binding_json
        ),
        prepared_provider_cursor_json = COALESCE(
          ${input.preparedProviderCursorJson ?? null},
          prepared_provider_cursor_json
        ),
        failure_code = COALESCE(${input.failureCode ?? null}, failure_code),
        compensation_failure_code = COALESCE(
          ${input.compensationFailureCode ?? null},
          compensation_failure_code
        ),
        updated_at = ${input.updatedAt},
        completed_at = ${input.completedAt ?? null}
      WHERE operation_id = ${input.operationId}
        AND phase = ${input.expectedPhase}
      RETURNING operation_id AS "operationId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("CheckpointNavigationRepository.advancePhase")),
    );

  return {
    recordRescueSnapshot,
    begin,
    getByCommandId,
    getUnresolvedByThread,
    listRecoverable,
    advancePhase,
  } satisfies CheckpointNavigationRepositoryShape;
});

export const CheckpointNavigationRepositoryLive = Layer.effect(
  CheckpointNavigationRepository,
  make,
);
