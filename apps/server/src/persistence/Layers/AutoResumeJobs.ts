import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AutoResumeJobRepository,
  type AutoResumeJob,
  type AutoResumeJobRepositoryShape,
  type ScheduleAutoResumeJobInput,
} from "../Services/AutoResumeJobs.ts";

const jobColumns = `
  schedule_id AS "scheduleId",
  thread_id AS "threadId",
  scheduled_sequence AS "scheduledSequence",
  source_turn_id AS "sourceTurnId",
  expected_user_message_id AS "expectedUserMessageId",
  provider_instance_id AS "providerInstanceId",
  message_id AS "messageId",
  reason,
  retry_at AS "retryAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wakeups = yield* Queue.unbounded<void>();

  const getByScheduleId = (scheduleId: string) =>
    sql<AutoResumeJob>`
      SELECT ${sql.unsafe(jobColumns)}
      FROM auto_resume_jobs
      WHERE schedule_id = ${scheduleId}
      LIMIT 1
    `;

  const getByThreadId: AutoResumeJobRepositoryShape["getByThreadId"] = ({ threadId }) =>
    sql<AutoResumeJob>`
      SELECT ${sql.unsafe(jobColumns)}
      FROM auto_resume_jobs
      WHERE thread_id = ${threadId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("AutoResumeJobRepository.getByThreadId")),
    );

  const upsert: AutoResumeJobRepositoryShape["upsert"] = (input: ScheduleAutoResumeJobInput) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const updatedAt = input.updatedAt ?? input.createdAt;
          yield* sql`
            INSERT INTO auto_resume_jobs (
              schedule_id,
              thread_id,
              scheduled_sequence,
              source_turn_id,
              expected_user_message_id,
              provider_instance_id,
              message_id,
              reason,
              retry_at,
              created_at,
              updated_at
            ) VALUES (
              ${input.scheduleId},
              ${input.threadId},
              ${input.scheduledSequence},
              ${input.sourceTurnId},
              ${input.expectedUserMessageId},
              ${input.providerInstanceId},
              ${input.messageId},
              ${input.reason},
              ${input.retryAt},
              ${input.createdAt},
              ${updatedAt}
            )
            ON CONFLICT (thread_id) DO UPDATE SET
              schedule_id = excluded.schedule_id,
              scheduled_sequence = excluded.scheduled_sequence,
              source_turn_id = excluded.source_turn_id,
              expected_user_message_id = excluded.expected_user_message_id,
              provider_instance_id = excluded.provider_instance_id,
              message_id = excluded.message_id,
              reason = excluded.reason,
              retry_at = excluded.retry_at,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at
          `;
          const rows = yield* getByScheduleId(input.scheduleId);
          return rows[0]!;
        }),
      )
      .pipe(
        Effect.tap(() => Queue.offer(wakeups, undefined)),
        Effect.mapError(toPersistenceSqlError("AutoResumeJobRepository.upsert")),
      );

  const list: AutoResumeJobRepositoryShape["list"] = () =>
    sql<AutoResumeJob>`
      SELECT ${sql.unsafe(jobColumns)}
      FROM auto_resume_jobs
      ORDER BY retry_at ASC, schedule_id ASC
    `.pipe(Effect.mapError(toPersistenceSqlError("AutoResumeJobRepository.list")));

  const deleteIfCurrent: AutoResumeJobRepositoryShape["deleteIfCurrent"] = ({
    threadId,
    scheduleId,
  }) =>
    sql<{ readonly scheduleId: string }>`
      DELETE FROM auto_resume_jobs
      WHERE thread_id = ${threadId}
        AND schedule_id = ${scheduleId}
      RETURNING schedule_id AS "scheduleId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.tap((deleted) => (deleted ? Queue.offer(wakeups, undefined) : Effect.void)),
      Effect.mapError(toPersistenceSqlError("AutoResumeJobRepository.deleteIfCurrent")),
    );

  const deferRetryIfCurrent: AutoResumeJobRepositoryShape["deferRetryIfCurrent"] = ({
    threadId,
    scheduleId,
    retryAt,
    updatedAt,
  }) =>
    sql<{ readonly scheduleId: string }>`
      UPDATE auto_resume_jobs
      SET retry_at = ${retryAt}, updated_at = ${updatedAt}
      WHERE thread_id = ${threadId}
        AND schedule_id = ${scheduleId}
      RETURNING schedule_id AS "scheduleId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.tap((updated) => (updated ? Queue.offer(wakeups, undefined) : Effect.void)),
      Effect.mapError(toPersistenceSqlError("AutoResumeJobRepository.deferRetryIfCurrent")),
    );

  const deleteAll: AutoResumeJobRepositoryShape["deleteAll"] = sql<{
    readonly scheduleId: string;
  }>`
    DELETE FROM auto_resume_jobs
    RETURNING schedule_id AS "scheduleId"
  `.pipe(
    Effect.map((rows) => rows.length),
    Effect.tap((deleted) => (deleted > 0 ? Queue.offer(wakeups, undefined) : Effect.void)),
    Effect.mapError(toPersistenceSqlError("AutoResumeJobRepository.deleteAll")),
  );

  const hasSentMessage: AutoResumeJobRepositoryShape["hasSentMessage"] = ({
    threadId,
    messageId,
  }) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found
      FROM projection_thread_messages
      WHERE message_id = ${messageId}
        AND thread_id = ${threadId}
        AND role = 'user'
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("AutoResumeJobRepository.hasSentMessage")),
    );

  const hasInvalidatingEventAfter: AutoResumeJobRepositoryShape["hasInvalidatingEventAfter"] = ({
    threadId,
    scheduledSequence,
  }) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND sequence > ${scheduledSequence}
        AND (
          event_type IN (
            'thread.deleted',
            'thread.archived',
            'thread.unarchived',
            'thread.settled',
            'thread.unsettled',
            'thread.turn-start-requested'
          )
          OR (
            event_type = 'thread.message-sent'
            AND json_extract(payload_json, '$.role') = 'user'
          )
          OR (
            event_type = 'thread.meta-updated'
            AND json_type(payload_json, '$.modelSelection') IS NOT NULL
          )
        )
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("AutoResumeJobRepository.hasInvalidatingEventAfter")),
    );

  const awaitWake = Queue.take(wakeups).pipe(Effect.asVoid);

  return AutoResumeJobRepository.of({
    upsert,
    list,
    getByThreadId,
    deleteIfCurrent,
    deferRetryIfCurrent,
    deleteAll,
    hasSentMessage,
    hasInvalidatingEventAfter,
    awaitWake,
  });
});

export const AutoResumeJobRepositoryLive = Layer.effect(AutoResumeJobRepository, make);
