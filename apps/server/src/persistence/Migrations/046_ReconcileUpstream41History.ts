import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import reconcileCheckpointAndTitleHistory from "./039_ReconcileCheckpointAndTitleHistory.ts";

/** Repairs fork schema skipped when an upstream database already recorded migrations 36-41. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* reconcileCheckpointAndTitleHistory;

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "subagent_id")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN subagent_id TEXT
    `;
  }

  const activityColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_activities)
  `;
  if (!activityColumns.some((column) => column.name === "subagent_id")) {
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN subagent_id TEXT
    `;
  }
});
