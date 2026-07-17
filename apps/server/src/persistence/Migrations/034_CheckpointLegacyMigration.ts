import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Durable, path-free journal for restartable legacy checkpoint migration. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoint_legacy_migrations (
      candidate_id TEXT PRIMARY KEY,
      projection_turn_row_id INTEGER NOT NULL UNIQUE REFERENCES projection_turns(row_id),
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      legacy_ref TEXT NOT NULL UNIQUE,
      snapshot_id TEXT NOT NULL UNIQUE REFERENCES checkpoint_snapshots(snapshot_id),
      repository_key TEXT NOT NULL REFERENCES checkpoint_repositories(repository_key),
      worktree_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'pending',
        'importing',
        'verified',
        'cleanup-pending',
        'cleaned',
        'error'
      )),
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified_at TEXT,
      cleanup_after TEXT,
      cleaned_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS checkpoint_legacy_migrations_work_idx
    ON checkpoint_legacy_migrations (state, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS checkpoint_legacy_migrations_cleanup_idx
    ON checkpoint_legacy_migrations (cleanup_after, state)
  `;
});
