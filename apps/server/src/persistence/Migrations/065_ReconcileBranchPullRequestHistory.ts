import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Repairs databases where the deployed fork's old migration 058 was suggestions. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "branch_pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN branch_pull_request_json TEXT
    `;
  }

  yield* sql`
    UPDATE effect_sql_migrations
    SET name = 'ProjectionThreadBranchPullRequest'
    WHERE migration_id = 58 AND name = 'ProjectionThreadMessageSuggestions'
  `;
});
