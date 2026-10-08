import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_thread_messages'
  `;
  if (tables.length === 0) return;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  // Idempotent by design: deployed fork databases already carry this column from
  // the pre-merge 058 (ProjectionThreadMessageSuggestions), which shared its ID
  // with upstream's 058 (ProjectionThreadBranchPullRequest) and lost the race.
  if (!columns.some((column) => column.name === "suggestion")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN suggestion TEXT
    `;
  }
});
