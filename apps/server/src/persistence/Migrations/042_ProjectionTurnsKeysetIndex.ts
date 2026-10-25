import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Include turn_id so keyset pagination avoids sorting every turn before applying LIMIT.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
    ON projection_turns(thread_id, requested_at, turn_id)
  `;
});
