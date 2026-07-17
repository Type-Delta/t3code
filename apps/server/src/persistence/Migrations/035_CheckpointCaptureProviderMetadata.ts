import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Provider navigation metadata frozen at the capture boundary. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE checkpoint_capture_jobs
    ADD COLUMN provider_binding_json TEXT
  `;

  yield* sql`
    ALTER TABLE checkpoint_capture_jobs
    ADD COLUMN provider_cursor_json TEXT
  `;
});
