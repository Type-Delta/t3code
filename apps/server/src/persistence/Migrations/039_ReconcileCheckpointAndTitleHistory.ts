import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Reconciles databases that ran either the fork or upstream 33-38 history. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const navigationColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(checkpoint_navigation_operations)
  `;

  if (!navigationColumns.some((column) => column.name === "mode")) {
    yield* sql`
      ALTER TABLE checkpoint_navigation_operations
      ADD COLUMN mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'files-only'))
    `;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "settled_override")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_override TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "settled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_at TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "snoozed_until")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_until TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "snoozed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_at TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "title_regeneration_request_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_regeneration_request_id TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "title_regeneration_started_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_regeneration_started_at TEXT
    `;
  }
});
