import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable state for sidecar checkpoint capture and timeline navigation.
 *
 * Provider bindings are deliberately opaque JSON strings. They are decoded only
 * by the provider adapter that created them and must never contain credentials.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoint_repositories (
      repository_key TEXT PRIMARY KEY,
      common_dir_fingerprint TEXT NOT NULL,
      object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
      sidecar_relative_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      retention_class TEXT NOT NULL DEFAULT 'standard',
      delete_after TEXT,
      deletion_started_at TEXT,
      deleted_at TEXT,
      deletion_error_code TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoint_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      repository_key TEXT NOT NULL REFERENCES checkpoint_repositories(repository_key),
      worktree_key TEXT NOT NULL,
      commit_oid TEXT,
      tree_oid TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('baseline', 'turn', 'rescue', 'legacy-import')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'ready', 'contended', 'error')),
      created_at TEXT NOT NULL,
      ready_at TEXT,
      expires_at TEXT,
      retention_class TEXT NOT NULL DEFAULT 'standard',
      delete_after TEXT,
      deletion_started_at TEXT,
      deleted_at TEXT,
      deletion_error_code TEXT,
      error_code TEXT,
      CHECK ((state = 'ready' AND commit_oid IS NOT NULL AND tree_oid IS NOT NULL) OR state <> 'ready')
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoint_capture_jobs (
      job_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL UNIQUE REFERENCES checkpoint_snapshots(snapshot_id),
      thread_id TEXT NOT NULL,
      timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 0),
      turn_id TEXT NOT NULL,
      provider_turn_id TEXT,
      turn_ordinal INTEGER NOT NULL CHECK (turn_ordinal >= 0),
      repository_key TEXT NOT NULL REFERENCES checkpoint_repositories(repository_key),
      worktree_key TEXT NOT NULL,
      requested_boundary TEXT NOT NULL,
      requested_generation INTEGER NOT NULL CHECK (requested_generation >= 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'ready', 'contended', 'error')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_owner TEXT,
      lease_expires_at TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (thread_id, timeline_generation, turn_id, requested_boundary)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS checkpoint_capture_jobs_claim_idx
    ON checkpoint_capture_jobs (state, lease_expires_at, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS checkpoint_capture_jobs_worktree_idx
    ON checkpoint_capture_jobs (worktree_key, state, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_checkpoint_entries (
      entry_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 0),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      turn_id TEXT NOT NULL,
      provider_turn_id TEXT,
      snapshot_id TEXT NOT NULL REFERENCES checkpoint_snapshots(snapshot_id),
      provider_binding_json TEXT NOT NULL,
      provider_cursor_json TEXT NOT NULL,
      assistant_message_id TEXT,
      completed_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'contended', 'error')),
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, timeline_generation, ordinal),
      UNIQUE (thread_id, timeline_generation, turn_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS thread_checkpoint_entries_snapshot_idx
    ON thread_checkpoint_entries (snapshot_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_checkpoint_cursors (
      thread_id TEXT PRIMARY KEY,
      active_generation INTEGER NOT NULL CHECK (active_generation >= 0),
      current_entry_id TEXT REFERENCES thread_checkpoint_entries(entry_id),
      current_ordinal INTEGER CHECK (current_ordinal IS NULL OR current_ordinal >= 0),
      forward_tip_entry_id TEXT REFERENCES thread_checkpoint_entries(entry_id),
      forward_tip_ordinal INTEGER CHECK (forward_tip_ordinal IS NULL OR forward_tip_ordinal >= 0),
      navigation_version INTEGER NOT NULL DEFAULT 0 CHECK (navigation_version >= 0),
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_checkpoint_generations (
      thread_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      parent_generation INTEGER,
      forked_from_entry_id TEXT REFERENCES thread_checkpoint_entries(entry_id),
      state TEXT NOT NULL CHECK (state IN ('active', 'abandoned')),
      created_at TEXT NOT NULL,
      abandoned_at TEXT,
      delete_after TEXT,
      PRIMARY KEY (thread_id, generation)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_provider_bindings (
      thread_id TEXT PRIMARY KEY,
      provider_binding_json TEXT NOT NULL,
      binding_version INTEGER NOT NULL DEFAULT 0 CHECK (binding_version >= 0),
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoint_navigation_operations (
      operation_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('undo', 'redo', 'jump')),
      from_entry_id TEXT REFERENCES thread_checkpoint_entries(entry_id),
      to_entry_id TEXT NOT NULL REFERENCES thread_checkpoint_entries(entry_id),
      rescue_snapshot_id TEXT REFERENCES checkpoint_snapshots(snapshot_id),
      old_provider_binding_json TEXT NOT NULL,
      target_provider_binding_json TEXT NOT NULL,
      prepared_provider_cursor_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN (
        'prepared',
        'rescue-ready',
        'provider-prepared',
        'filesystem-restored',
        'provider-activated',
        'cursor-committed',
        'committed',
        'compensating-cursor',
        'compensating-filesystem',
        'compensating-provider',
        'compensated',
        'failed',
        'needs-recovery'
      )),
      recovery_from_phase TEXT CHECK (recovery_from_phase IS NULL OR recovery_from_phase IN (
        'prepared',
        'rescue-ready',
        'provider-prepared',
        'filesystem-restored',
        'provider-activated',
        'cursor-committed',
        'committed',
        'compensating-cursor',
        'compensating-filesystem',
        'compensating-provider',
        'compensated',
        'failed',
        'needs-recovery'
      )),
      failure_code TEXT,
      compensation_failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS checkpoint_navigation_operations_unresolved_thread_idx
    ON checkpoint_navigation_operations (thread_id)
    WHERE phase NOT IN ('committed', 'compensated', 'failed')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS checkpoint_navigation_operations_recovery_idx
    ON checkpoint_navigation_operations (phase, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS checkpoint_snapshots_retention_idx
    ON checkpoint_snapshots (delete_after, state)
    WHERE deleted_at IS NULL
  `;
});
