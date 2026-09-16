import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  ChatAttachment,
  OrchestrationMessageContext,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AppendStreamingProjectionThreadMessage,
  GetProjectionThreadMessageInput,
  HasProjectionThreadAssistantMessageInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    subagentId: Schema.NullOr(TrimmedNonEmptyString),
    context: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
    suggestion: Schema.NullOr(TrimmedNonEmptyString),
  }),
);
const ProjectionThreadMessageExistsDbRowSchema = Schema.Struct({ exists: Schema.Number });

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    ...(row.subagentId !== null ? { subagentId: row.subagentId } : {}),
    ...(row.suggestion !== null ? { suggestion: row.suggestion } : {}),
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextContextJson = row.context !== undefined ? JSON.stringify(row.context) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          subagent_id,
          suggestion,
          role,
          text,
          attachments_json,
          context_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.subagentId ?? null},
          ${row.suggestion ?? null},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextContextJson},
            (
              SELECT context_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          subagent_id = COALESCE(excluded.subagent_id, projection_thread_messages.subagent_id),
          suggestion = COALESCE(excluded.suggestion, projection_thread_messages.suggestion),
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          context_json = COALESCE(
            excluded.context_json,
            projection_thread_messages.context_json
          ),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const appendStreamingProjectionThreadMessageRow = SqlSchema.void({
    Request: AppendStreamingProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextContextJson = row.context !== undefined ? JSON.stringify(row.context) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          suggestion,
          role,
          text,
          attachments_json,
          context_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          NULL,
          ${row.role},
          ${row.text},
          ${nextAttachmentsJson},
          ${nextContextJson},
          1,
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          suggestion = NULL,
          role = excluded.role,
          text = projection_thread_messages.text || excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          context_json = COALESCE(
            excluded.context_json,
            projection_thread_messages.context_json
          ),
          is_streaming = 1,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          subagent_id AS "subagentId",
          suggestion,
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const hasProjectionThreadAssistantMessageRow = SqlSchema.findOne({
    Request: HasProjectionThreadAssistantMessageInput,
    Result: ProjectionThreadMessageExistsDbRowSchema,
    execute: ({ threadId, turnId, streamingOnly }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
            AND role = 'assistant'
            AND (${streamingOnly ? 1 : 0} = 0 OR is_streaming = 1)
          LIMIT 1
        ) AS "exists"
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          subagent_id AS "subagentId",
          suggestion,
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const getLatestUserMessageAtRow = SqlSchema.findOne({
    Request: ListProjectionThreadMessagesInput,
    Result: Schema.Struct({
      latestUserMessageAt: Schema.NullOr(ProjectionThreadMessage.fields.createdAt),
    }),
    execute: ({ threadId }) => sql`
      SELECT MAX(created_at) AS "latestUserMessageAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
        AND message_id NOT GLOB 'import:*'
    `,
  });

  const getLatestUserMessageIdRow = SqlSchema.findOneOption({
    Request: ListProjectionThreadMessagesInput,
    Result: Schema.Struct({
      messageId: ProjectionThreadMessage.fields.messageId,
    }),
    execute: ({ threadId }) => sql`
      SELECT message_id AS "messageId"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const appendStreaming: ProjectionThreadMessageRepositoryShape["appendStreaming"] = (row) =>
    appendStreamingProjectionThreadMessageRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.appendStreaming:query"),
      ),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const hasAssistantMessageForTurn: ProjectionThreadMessageRepositoryShape["hasAssistantMessageForTurn"] =
    (input) =>
      hasProjectionThreadAssistantMessageRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.hasAssistantMessageForTurn:query",
          ),
        ),
        Effect.map((row) => row.exists === 1),
      );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const getLatestUserMessageAt: ProjectionThreadMessageRepositoryShape["getLatestUserMessageAt"] = (
    input,
  ) =>
    getLatestUserMessageAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getLatestUserMessageAt:query"),
      ),
      Effect.map((row) => row.latestUserMessageAt),
    );

  const getLatestUserMessageId: ProjectionThreadMessageRepositoryShape["getLatestUserMessageId"] = (
    input,
  ) =>
    getLatestUserMessageIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getLatestUserMessageId:query"),
      ),
      Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.messageId })),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    appendStreaming,
    getByMessageId,
    hasAssistantMessageForTurn,
    listByThreadId,
    getLatestUserMessageAt,
    getLatestUserMessageId,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
