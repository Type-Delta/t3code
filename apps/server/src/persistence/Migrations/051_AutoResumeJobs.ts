import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable wakeups for provider usage-limit recovery.
 *
 * There is intentionally one row per thread.  A newer failed turn supersedes
 * an older schedule, while the schedule id remains the compare-and-fire token
 * used by the server-side command.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auto_resume_jobs (
      schedule_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      scheduled_sequence INTEGER NOT NULL,
      source_turn_id TEXT NOT NULL,
      expected_user_message_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      retry_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS auto_resume_jobs_retry_at_idx
    ON auto_resume_jobs (retry_at ASC, schedule_id ASC)
  `;
});
