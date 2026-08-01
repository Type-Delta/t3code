import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Provider navigation metadata frozen at the capture boundary. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(checkpoint_capture_jobs)
  `;

  if (!columns.some((column) => column.name === "provider_binding_json")) {
    yield* sql`
      ALTER TABLE checkpoint_capture_jobs
      ADD COLUMN provider_binding_json TEXT
    `;
  }

  if (!columns.some((column) => column.name === "provider_cursor_json")) {
    yield* sql`
      ALTER TABLE checkpoint_capture_jobs
      ADD COLUMN provider_cursor_json TEXT
    `;
  }
});
