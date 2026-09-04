import { MessageId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { AutoResumeJobRepositoryLive } from "./AutoResumeJobs.ts";
import {
  AutoResumeJobRepository,
  type ScheduleAutoResumeJobInput,
} from "../Services/AutoResumeJobs.ts";

const layer = it.layer(
  AutoResumeJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const makeJob = (
  suffix: string,
  input: {
    readonly threadId?: ThreadId;
    readonly retryAt?: string;
    readonly scheduledSequence?: number;
  } = {},
): ScheduleAutoResumeJobInput => ({
  scheduleId: `schedule-${suffix}`,
  threadId: input.threadId ?? ThreadId.make(`thread-${suffix}`),
  scheduledSequence: input.scheduledSequence ?? 10,
  sourceTurnId: TurnId.make(`turn-${suffix}`),
  expectedUserMessageId: MessageId.make(`user-${suffix}`),
  providerInstanceId: ProviderInstanceId.make("codex"),
  messageId: MessageId.make(`auto-resume-message-${suffix}`),
  reason: "usage_limit",
  retryAt: input.retryAt ?? "2026-01-01T00:05:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
});

layer("AutoResumeJobRepository", (it) => {
  it.effect("migrates, replaces one thread schedule, orders it, and deletes conditionally", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* AutoResumeJobRepository;

      const table = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'auto_resume_jobs'
      `;
      assert.deepEqual(table, [{ name: "auto_resume_jobs" }]);

      const first = yield* repository.upsert(makeJob("first"));
      assert.equal(first.scheduleId, "schedule-first");
      assert.equal(first.updatedAt, first.createdAt);

      const second = yield* repository.upsert(
        makeJob("second", {
          threadId: first.threadId,
          retryAt: "2026-01-01T00:02:00.000Z",
        }),
      );
      assert.equal(second.scheduleId, "schedule-second");

      const current = yield* repository.getByThreadId({ threadId: first.threadId });
      assert.isTrue(Option.isSome(current));
      if (Option.isSome(current)) {
        assert.equal(current.value.scheduleId, "schedule-second");
        assert.equal(current.value.retryAt, "2026-01-01T00:02:00.000Z");
      }

      const jobs = yield* repository.list();
      assert.deepEqual(jobs, [second]);
      assert.isFalse(
        yield* repository.deferRetryIfCurrent({
          threadId: first.threadId,
          scheduleId: "schedule-first",
          retryAt: "2026-01-01T00:03:00.000Z",
          updatedAt: "2026-01-01T00:02:30.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.deferRetryIfCurrent({
          threadId: first.threadId,
          scheduleId: second.scheduleId,
          retryAt: "2026-01-01T00:03:00.000Z",
          updatedAt: "2026-01-01T00:02:30.000Z",
        }),
      );
      const deferred = yield* repository.getByThreadId({ threadId: first.threadId });
      assert.isTrue(Option.isSome(deferred));
      if (Option.isSome(deferred)) {
        assert.equal(deferred.value.retryAt, "2026-01-01T00:03:00.000Z");
        assert.equal(deferred.value.updatedAt, "2026-01-01T00:02:30.000Z");
      }
      assert.isFalse(
        yield* repository.deleteIfCurrent({
          threadId: first.threadId,
          scheduleId: "schedule-first",
        }),
      );
      assert.isTrue(
        yield* repository.deleteIfCurrent({
          threadId: first.threadId,
          scheduleId: second.scheduleId,
        }),
      );
      assert.deepEqual(yield* repository.list(), []);
    }),
  );

  it.effect("finds only cancellation events after the durable schedule sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* AutoResumeJobRepository;
      let eventIndex = 0;
      const append = (threadId: ThreadId, eventType: string, payload: string) => {
        eventIndex += 1;
        return sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            causation_event_id,
            correlation_id,
            actor_kind,
            payload_json,
            metadata_json
          ) VALUES (
            ${`auto-resume-event-${eventIndex}`},
            'thread',
            ${threadId},
            ${eventIndex},
            ${eventType},
            '2026-01-01T00:01:00.000Z',
            ${`auto-resume-command-${eventIndex}`},
            NULL,
            NULL,
            'client',
            ${payload},
            '{}'
          )
          RETURNING sequence
        `;
      };

      const neutralThread = ThreadId.make("thread-neutral-events");
      yield* append(neutralThread, "thread.message-sent", '{"role":"assistant"}');
      yield* append(neutralThread, "thread.meta-updated", '{"title":"Renamed"}');
      assert.isFalse(
        yield* repository.hasInvalidatingEventAfter({
          threadId: neutralThread,
          scheduledSequence: 0,
        }),
      );

      const cancellationEvents = [
        ["thread.deleted", "{}"],
        ["thread.archived", "{}"],
        ["thread.unarchived", "{}"],
        ["thread.settled", "{}"],
        ["thread.unsettled", "{}"],
        ["thread.turn-start-requested", "{}"],
        ["thread.message-sent", '{"role":"user"}'],
        ["thread.meta-updated", '{"modelSelection":{"instanceId":"codex","model":"gpt-5.4"}}'],
      ] as const;

      for (const [index, [eventType, payload]] of cancellationEvents.entries()) {
        const threadId = ThreadId.make(`thread-cancellation-${index}`);
        const [event] = yield* append(threadId, eventType, payload);
        assert.isTrue(
          yield* repository.hasInvalidatingEventAfter({
            threadId,
            scheduledSequence: event!.sequence - 1,
          }),
          eventType,
        );
        assert.isFalse(
          yield* repository.hasInvalidatingEventAfter({
            threadId,
            scheduledSequence: event!.sequence,
          }),
          `${eventType} at the schedule boundary`,
        );
      }
    }),
  );

  it.effect("deletes every pending schedule when the global setting is disabled", () =>
    Effect.gen(function* () {
      const repository = yield* AutoResumeJobRepository;
      yield* repository.upsert(makeJob("delete-all-first"));
      yield* repository.upsert(makeJob("delete-all-second"));

      assert.equal(yield* repository.deleteAll, 2);
      assert.deepEqual(yield* repository.list(), []);
      assert.equal(yield* repository.deleteAll, 0);
    }),
  );

  it.effect("finds only the matching sent user message", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* AutoResumeJobRepository;
      const threadId = ThreadId.make("thread-sent-resume");
      const messageId = MessageId.make("message-sent-resume");

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        ) VALUES (
          ${messageId},
          ${threadId},
          NULL,
          'user',
          'automatic resume',
          0,
          '2026-01-01T00:01:00.000Z',
          '2026-01-01T00:01:00.000Z'
        )
      `;

      assert.isTrue(yield* repository.hasSentMessage({ threadId, messageId }));
      assert.isFalse(
        yield* repository.hasSentMessage({
          threadId,
          messageId: MessageId.make("message-other"),
        }),
      );
      assert.isFalse(
        yield* repository.hasSentMessage({
          threadId: ThreadId.make("thread-other"),
          messageId,
        }),
      );
    }),
  );
});
