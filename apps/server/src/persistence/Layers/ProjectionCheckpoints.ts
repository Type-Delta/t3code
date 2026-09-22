import { OrchestrationCheckpointFile } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteByThreadIdInput,
  GetByThreadAndTurnCountInput,
  ListByThreadIdInput,
  ProjectionCheckpoint,
  ProjectionCheckpointRepository,
  type ProjectionCheckpointRepositoryShape,
} from "../Services/ProjectionCheckpoints.ts";

export * from "../Services/ProjectionCheckpoints.ts";

const Row = ProjectionCheckpoint.mapFields(
  Struct.assign({ files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)) }),
);
const mapError = (sql: string, decode: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? toPersistenceDecodeError(decode)(cause)
    : toPersistenceSqlError(sql)(cause);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listRows = SqlSchema.findAll({
    Request: ListByThreadIdInput,
    Result: Row,
    execute: ({ threadId }) => sql`
      SELECT thread_id AS "threadId", turn_id AS "turnId", checkpoint_turn_count AS "checkpointTurnCount",
        checkpoint_ref AS "checkpointRef", checkpoint_status AS "status", checkpoint_files_json AS "files",
        assistant_message_id AS "assistantMessageId", completed_at AS "completedAt"
      FROM projection_turns WHERE thread_id = ${threadId} AND checkpoint_turn_count IS NOT NULL
      ORDER BY checkpoint_turn_count ASC
    `,
  });
  const getRow = SqlSchema.findOneOption({
    Request: GetByThreadAndTurnCountInput,
    Result: Row,
    execute: ({ threadId, checkpointTurnCount }) => sql`
      SELECT thread_id AS "threadId", turn_id AS "turnId", checkpoint_turn_count AS "checkpointTurnCount",
        checkpoint_ref AS "checkpointRef", checkpoint_status AS "status", checkpoint_files_json AS "files",
        assistant_message_id AS "assistantMessageId", completed_at AS "completedAt"
      FROM projection_turns WHERE thread_id = ${threadId} AND checkpoint_turn_count = ${checkpointTurnCount}
    `,
  });
  const upsertRow = SqlSchema.void({
    Request: Row,
    execute: (row) => sql`
      INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id, state,
        requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json)
      VALUES (${row.threadId}, ${row.turnId}, NULL, ${row.assistantMessageId}, ${row.status === "error" ? "error" : "completed"},
        ${row.completedAt}, ${row.completedAt}, ${row.completedAt}, ${row.checkpointTurnCount}, ${row.checkpointRef}, ${row.status}, ${row.files})
      ON CONFLICT (thread_id, turn_id) DO UPDATE SET assistant_message_id = excluded.assistant_message_id,
        state = excluded.state, completed_at = excluded.completed_at, checkpoint_turn_count = excluded.checkpoint_turn_count,
        checkpoint_ref = excluded.checkpoint_ref, checkpoint_status = excluded.checkpoint_status,
        checkpoint_files_json = excluded.checkpoint_files_json
    `,
  });
  const clearConflict = (row: Schema.Schema.Type<typeof Row>) => sql`
    UPDATE projection_turns SET checkpoint_turn_count = NULL, checkpoint_ref = NULL,
      checkpoint_status = NULL, checkpoint_files_json = '[]'
    WHERE thread_id = ${row.threadId} AND checkpoint_turn_count = ${row.checkpointTurnCount}
  `;
  const upsert: ProjectionCheckpointRepositoryShape["upsert"] = (row) =>
    sql
      .withTransaction(sql` ${clearConflict(row)} `.pipe(Effect.andThen(upsertRow(row))))
      .pipe(
        Effect.mapError(
          mapError(
            "ProjectionCheckpointRepository.upsert:query",
            "ProjectionCheckpointRepository.upsert:encodeRequest",
          ),
        ),
      );
  const listByThreadId: ProjectionCheckpointRepositoryShape["listByThreadId"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(
        mapError(
          "ProjectionCheckpointRepository.listByThreadId:query",
          "ProjectionCheckpointRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionCheckpoint>>),
    );
  const getByThreadAndTurnCount: ProjectionCheckpointRepositoryShape["getByThreadAndTurnCount"] = (
    input,
  ) =>
    getRow(input).pipe(
      Effect.mapError(
        mapError(
          "ProjectionCheckpointRepository.getByThreadAndTurnCount:query",
          "ProjectionCheckpointRepository.getByThreadAndTurnCount:decodeRow",
        ),
      ),
      Effect.map((row) =>
        Option.map(row, (value) => value as Schema.Schema.Type<typeof ProjectionCheckpoint>),
      ),
    );
  const deleteByThreadId: ProjectionCheckpointRepositoryShape["deleteByThreadId"] = ({
    threadId,
  }) =>
    sql`UPDATE projection_turns SET checkpoint_turn_count = NULL, checkpoint_ref = NULL, checkpoint_status = NULL, checkpoint_files_json = '[]' WHERE thread_id = ${threadId} AND checkpoint_turn_count IS NOT NULL`.pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCheckpointRepository.deleteByThreadId:query"),
      ),
      Effect.asVoid,
    );
  return {
    upsert,
    listByThreadId,
    getByThreadAndTurnCount,
    deleteByThreadId,
  } satisfies ProjectionCheckpointRepositoryShape;
});

export const ProjectionCheckpointRepositoryLive = Layer.effect(
  ProjectionCheckpointRepository,
  make,
);
