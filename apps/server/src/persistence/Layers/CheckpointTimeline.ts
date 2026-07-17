import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CheckpointTimelineRepository,
  type CheckpointTimelineRepositoryShape,
  type ThreadCheckpointCursor,
  type ThreadCheckpointEntry,
  type ThreadCheckpointGeneration,
  type ThreadProviderBinding,
} from "../Services/CheckpointTimeline.ts";

const entrySelect = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`
  entry_id AS "entryId",
  thread_id AS "threadId",
  timeline_generation AS "timelineGeneration",
  ordinal,
  turn_id AS "turnId",
  provider_turn_id AS "providerTurnId",
  snapshot_id AS "snapshotId",
  provider_binding_json AS "providerBindingJson",
  provider_cursor_json AS "providerCursorJson",
  assistant_message_id AS "assistantMessageId",
  completed_at AS "completedAt",
  state,
  created_at AS "createdAt"
`);

const cursorSelect = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`
  thread_id AS "threadId",
  active_generation AS "activeGeneration",
  current_entry_id AS "currentEntryId",
  current_ordinal AS "currentOrdinal",
  forward_tip_entry_id AS "forwardTipEntryId",
  forward_tip_ordinal AS "forwardTipOrdinal",
  navigation_version AS "navigationVersion",
  updated_at AS "updatedAt"
`);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEntry: CheckpointTimelineRepositoryShape["appendEntry"] = (entry) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO thread_checkpoint_entries (
              entry_id,
              thread_id,
              timeline_generation,
              ordinal,
              turn_id,
              provider_turn_id,
              snapshot_id,
              provider_binding_json,
              provider_cursor_json,
              assistant_message_id,
              completed_at,
              state,
              created_at
            ) VALUES (
              ${entry.entryId},
              ${entry.threadId},
              ${entry.timelineGeneration},
              ${entry.ordinal},
              ${entry.turnId},
              ${entry.providerTurnId},
              ${entry.snapshotId},
              ${entry.providerBindingJson},
              ${entry.providerCursorJson},
              ${entry.assistantMessageId},
              ${entry.completedAt},
              ${entry.state},
              ${entry.createdAt}
            )
            ON CONFLICT (entry_id) DO NOTHING
          `;
          const rows = yield* sql<ThreadCheckpointEntry>`
            SELECT ${entrySelect(sql)}
            FROM thread_checkpoint_entries
            WHERE entry_id = ${entry.entryId}
            LIMIT 1
          `;
          return rows[0]!;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.appendEntry")));

  const getEntry: CheckpointTimelineRepositoryShape["getEntry"] = ({ entryId }) =>
    sql<ThreadCheckpointEntry>`
      SELECT ${entrySelect(sql)}
      FROM thread_checkpoint_entries
      WHERE entry_id = ${entryId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.getEntry")),
    );

  const listGeneration: CheckpointTimelineRepositoryShape["listGeneration"] = (input) =>
    sql<ThreadCheckpointEntry>`
      SELECT ${entrySelect(sql)}
      FROM thread_checkpoint_entries
      WHERE thread_id = ${input.threadId}
        AND timeline_generation = ${input.generation}
      ORDER BY ordinal ASC
    `.pipe(Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.listGeneration")));

  const listGenerationLineage: CheckpointTimelineRepositoryShape["listGenerationLineage"] = (
    input,
  ) =>
    sql<ThreadCheckpointEntry>`
      WITH RECURSIVE lineage(generation, max_ordinal, depth) AS (
        SELECT generation, NULL, 0
        FROM thread_checkpoint_generations
        WHERE thread_id = ${input.threadId}
          AND generation = ${input.generation}

        UNION ALL

        SELECT parent.generation, fork_entry.ordinal, lineage.depth + 1
        FROM lineage
        INNER JOIN thread_checkpoint_generations AS child
          ON child.thread_id = ${input.threadId}
          AND child.generation = lineage.generation
        INNER JOIN thread_checkpoint_entries AS fork_entry
          ON fork_entry.thread_id = child.thread_id
          AND fork_entry.entry_id = child.forked_from_entry_id
        INNER JOIN thread_checkpoint_generations AS parent
          ON parent.thread_id = child.thread_id
          AND parent.generation = child.parent_generation
      )
      SELECT ${entrySelect(sql)}
      FROM thread_checkpoint_entries AS entry
      INNER JOIN lineage ON lineage.generation = entry.timeline_generation
      WHERE entry.thread_id = ${input.threadId}
        AND (lineage.max_ordinal IS NULL OR entry.ordinal <= lineage.max_ordinal)
      ORDER BY entry.ordinal ASC, lineage.depth DESC
    `.pipe(
      Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.listGenerationLineage")),
    );

  const createGeneration: CheckpointTimelineRepositoryShape["createGeneration"] = (generation) =>
    sql`
      INSERT INTO thread_checkpoint_generations (
        thread_id,
        generation,
        parent_generation,
        forked_from_entry_id,
        state,
        created_at,
        abandoned_at,
        delete_after
      ) VALUES (
        ${generation.threadId},
        ${generation.generation},
        ${generation.parentGeneration},
        ${generation.forkedFromEntryId},
        ${generation.state},
        ${generation.createdAt},
        ${generation.abandonedAt},
        ${generation.deleteAfter}
      )
      ON CONFLICT (thread_id, generation) DO NOTHING
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.createGeneration")),
    );

  const getGeneration: CheckpointTimelineRepositoryShape["getGeneration"] = (input) =>
    sql<ThreadCheckpointGeneration>`
      SELECT
        thread_id AS "threadId",
        generation,
        parent_generation AS "parentGeneration",
        forked_from_entry_id AS "forkedFromEntryId",
        state,
        created_at AS "createdAt",
        abandoned_at AS "abandonedAt",
        delete_after AS "deleteAfter"
      FROM thread_checkpoint_generations
      WHERE thread_id = ${input.threadId}
        AND generation = ${input.generation}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.getGeneration")),
    );

  const initializeCursor: CheckpointTimelineRepositoryShape["initializeCursor"] = (cursor) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO thread_checkpoint_cursors (
              thread_id,
              active_generation,
              current_entry_id,
              current_ordinal,
              forward_tip_entry_id,
              forward_tip_ordinal,
              navigation_version,
              updated_at
            ) VALUES (
              ${cursor.threadId},
              ${cursor.activeGeneration},
              ${cursor.currentEntryId},
              ${cursor.currentOrdinal},
              ${cursor.forwardTipEntryId},
              ${cursor.forwardTipOrdinal},
              ${cursor.navigationVersion},
              ${cursor.updatedAt}
            )
            ON CONFLICT (thread_id) DO NOTHING
          `;
          const rows = yield* sql<ThreadCheckpointCursor>`
            SELECT ${cursorSelect(sql)}
            FROM thread_checkpoint_cursors
            WHERE thread_id = ${cursor.threadId}
          `;
          return rows[0]!;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.initializeCursor")),
      );

  const getCursor: CheckpointTimelineRepositoryShape["getCursor"] = ({ threadId }) =>
    sql<ThreadCheckpointCursor>`
      SELECT ${cursorSelect(sql)}
      FROM thread_checkpoint_cursors
      WHERE thread_id = ${threadId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.getCursor")),
    );

  const moveCursor: CheckpointTimelineRepositoryShape["moveCursor"] = (input) =>
    sql<{ readonly threadId: string }>`
      UPDATE thread_checkpoint_cursors
      SET
        active_generation = ${input.activeGeneration},
        current_entry_id = ${input.currentEntryId},
        current_ordinal = ${input.currentOrdinal},
        forward_tip_entry_id = ${input.forwardTipEntryId},
        forward_tip_ordinal = ${input.forwardTipOrdinal},
        navigation_version = navigation_version + 1,
        updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId}
        AND navigation_version = ${input.expectedNavigationVersion}
      RETURNING thread_id AS "threadId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.moveCursor")),
    );

  const forkGeneration: CheckpointTimelineRepositoryShape["forkGeneration"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* sql<{ readonly activeGeneration: number }>`
            SELECT active_generation AS "activeGeneration"
            FROM thread_checkpoint_cursors
            WHERE thread_id = ${input.threadId}
              AND navigation_version = ${input.expectedNavigationVersion}
            LIMIT 1
          `;
          const row = current[0];
          if (row === undefined) return false;
          yield* sql`
            UPDATE thread_checkpoint_generations
            SET
              state = 'abandoned',
              abandoned_at = ${input.createdAt},
              delete_after = ${input.deleteAfter}
            WHERE thread_id = ${input.threadId}
              AND generation = ${row.activeGeneration}
          `;
          yield* sql`
            INSERT INTO thread_checkpoint_generations (
              thread_id,
              generation,
              parent_generation,
              forked_from_entry_id,
              state,
              created_at
            ) VALUES (
              ${input.threadId},
              ${input.newGeneration},
              ${row.activeGeneration},
              ${input.currentEntryId},
              'active',
              ${input.createdAt}
            )
          `;
          yield* sql`
            UPDATE thread_checkpoint_cursors
            SET
              active_generation = ${input.newGeneration},
              forward_tip_entry_id = ${input.currentEntryId},
              forward_tip_ordinal = ${input.currentOrdinal},
              navigation_version = navigation_version + 1,
              updated_at = ${input.createdAt}
            WHERE thread_id = ${input.threadId}
              AND navigation_version = ${input.expectedNavigationVersion}
          `;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.forkGeneration")));

  const upsertProviderBinding: CheckpointTimelineRepositoryShape["upsertProviderBinding"] = (
    binding,
  ) =>
    sql`
      INSERT INTO thread_provider_bindings (
        thread_id,
        provider_binding_json,
        binding_version,
        updated_at
      ) VALUES (
        ${binding.threadId},
        ${binding.providerBindingJson},
        ${binding.bindingVersion},
        ${binding.updatedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        provider_binding_json = excluded.provider_binding_json,
        binding_version = excluded.binding_version,
        updated_at = excluded.updated_at
      WHERE excluded.binding_version >= thread_provider_bindings.binding_version
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.upsertProviderBinding")),
    );

  const getProviderBinding: CheckpointTimelineRepositoryShape["getProviderBinding"] = ({
    threadId,
  }) =>
    sql<ThreadProviderBinding>`
      SELECT
        thread_id AS "threadId",
        provider_binding_json AS "providerBindingJson",
        binding_version AS "bindingVersion",
        updated_at AS "updatedAt"
      FROM thread_provider_bindings
      WHERE thread_id = ${threadId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("CheckpointTimelineRepository.getProviderBinding")),
    );

  return {
    appendEntry,
    getEntry,
    listGeneration,
    listGenerationLineage,
    createGeneration,
    getGeneration,
    initializeCursor,
    getCursor,
    moveCursor,
    forkGeneration,
    upsertProviderBinding,
    getProviderBinding,
  } satisfies CheckpointTimelineRepositoryShape;
});

export const CheckpointTimelineRepositoryLive = Layer.effect(CheckpointTimelineRepository, make);
