import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

/** A migrated source db with one thread per lifecycle state. Only
 * `stopped-thread` qualifies for the clone. */
const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "state.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // The real shared db carries this column from a branch build without a
      // matching migration; reproduce that drift so the filter is exercised.
      yield* sql`ALTER TABLE projection_threads ADD COLUMN monitor_json TEXT`;

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const threads = [
        ["stopped-thread", "project-kept", "stopped", null, null],
        ["running-thread", "project-kept", "running", null, null],
        ["settled-thread", "project-kept", "stopped", "2026-08-01", null],
        ["monitored-thread", "project-kept", "stopped", null, '{"kind":"pr"}'],
        ["deleted-project-thread", "project-deleted", "stopped", null, null],
      ] as const;
      for (const [threadId, projectId, status, settledAt, monitorJson] of threads) {
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, created_at, updated_at, settled_at, monitor_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, '2026-08-01', '2026-08-01', ${settledAt}, ${monitorJson})`;
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
          VALUES (${threadId}, ${status}, '2026-08-01')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("keeps only stopped threads from live projects and clears auth state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "state.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events`;
          const [auth] = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM auth_sessions`;
          return { threads, events, authCount: auth?.count ?? 0 };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["stopped-thread"],
      );
      assert.equal(kept.authCount, 0);
    }),
  );

  it.effect("fails loudly on a migration slot collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      // Simulate another branch having claimed slot 1 first: the id is
      // recorded, so this checkout's migration 1 silently never runs.
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations
            SET name = 'SomebodyElsesMigration' WHERE migration_id = 1`;
        }),
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSlotCollisionError");
      if (error._tag === "MigrateDevDbSlotCollisionError") {
        assert.equal(error.slot, 1);
        assert.equal(error.appliedName, "SomebodyElsesMigration");
      }
    }),
  );

  it.effect("prunes checkpoint children and live jobs while preserving retained history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-checkpoints-",
      });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-checkpoints-dest-",
      });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO checkpoint_repositories
          (repository_key, common_dir_fingerprint, object_format, sidecar_relative_path, created_at, last_used_at)
          VALUES ('repo', 'fingerprint', 'sha1', 'checkpoint-sidecar', '2026-08-01', '2026-08-01')`;
          for (const [rowId, threadId] of [
            [101, "running-thread"],
            [102, "stopped-thread"],
          ] as const) {
            yield* sql`INSERT INTO projection_turns
            (row_id, thread_id, turn_id, state, requested_at, checkpoint_files_json)
            VALUES (${rowId}, ${threadId}, ${threadId}, 'completed', '2026-08-01', '[]')`;
            yield* sql`INSERT INTO checkpoint_snapshots
            (snapshot_id, repository_key, worktree_key, kind, state, created_at)
            VALUES (${threadId}, 'repo', 'worktree', 'legacy-import', 'pending', '2026-08-01')`;
            yield* sql`INSERT INTO checkpoint_legacy_migrations
            (candidate_id, projection_turn_row_id, thread_id, turn_id, legacy_ref, snapshot_id,
             repository_key, worktree_key, state, created_at, updated_at)
            VALUES (${threadId}, ${rowId}, ${threadId}, ${threadId}, ${threadId}, ${threadId},
                    'repo', 'worktree', 'pending', '2026-08-01', '2026-08-01')`;
            yield* sql`INSERT INTO thread_checkpoint_entries
            (entry_id, thread_id, timeline_generation, ordinal, turn_id, snapshot_id,
             provider_binding_json, provider_cursor_json, completed_at, state, created_at)
            VALUES (${threadId}, ${threadId}, 0, 0, ${threadId}, ${threadId}, '{}', '{}',
                    '2026-08-01', 'pending', '2026-08-01')`;
            yield* sql`INSERT INTO thread_checkpoint_cursors
            (thread_id, active_generation, current_entry_id, updated_at)
            VALUES (${threadId}, 0, ${threadId}, '2026-08-01')`;
            yield* sql`INSERT INTO thread_checkpoint_generations
            (thread_id, generation, forked_from_entry_id, state, created_at)
            VALUES (${threadId}, 0, ${threadId}, 'active', '2026-08-01')`;
            yield* sql`INSERT INTO thread_provider_bindings (thread_id, provider_binding_json, updated_at)
            VALUES (${threadId}, '{}', '2026-08-01')`;
            yield* sql`INSERT INTO checkpoint_navigation_operations
            (operation_id, command_id, thread_id, kind, to_entry_id, old_provider_binding_json,
             target_provider_binding_json, prepared_provider_cursor_json, phase, created_at, updated_at)
            VALUES (${threadId}, ${threadId}, ${threadId}, 'undo', ${threadId}, '{}', '{}', '{}',
                    'prepared', '2026-08-01', '2026-08-01')`;
            yield* sql`INSERT INTO checkpoint_capture_jobs
            (job_id, snapshot_id, thread_id, timeline_generation, turn_id, turn_ordinal,
             repository_key, worktree_key, requested_boundary, requested_generation, state, created_at, updated_at)
            VALUES (${threadId}, ${threadId}, ${threadId}, 0, ${threadId}, 0, 'repo', 'worktree',
                    'turn', 0, 'pending', '2026-08-01', '2026-08-01')`;
            yield* sql`INSERT INTO auto_resume_jobs
            (schedule_id, thread_id, scheduled_sequence, source_turn_id, expected_user_message_id,
             provider_instance_id, message_id, reason, retry_at, created_at, updated_at)
            VALUES (${threadId}, ${threadId}, 1, ${threadId}, 'message', 'claude', 'message',
                    'usage-limit', '2026-08-01', '2026-08-01', '2026-08-01')`;
            yield* sql`INSERT INTO projection_thread_pull_requests
            (thread_id, host, repository, number, url, source, linked_at)
            VALUES (${threadId}, 'github.com', 't3code', 1, 'https://example.com/pr/1', 'manual', '2026-08-01')`;
          }
        }),
      );
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const table of [
            "checkpoint_legacy_migrations",
            "thread_checkpoint_entries",
            "thread_checkpoint_cursors",
            "thread_checkpoint_generations",
            "thread_provider_bindings",
            "projection_turns",
            "projection_thread_pull_requests",
          ]) {
            const rows = yield* sql.unsafe<{ thread_id: string }>(`SELECT thread_id FROM ${table}`)
              .unprepared;
            assert.deepEqual(
              rows.map((row) => row.thread_id),
              ["stopped-thread"],
            );
          }
          for (const table of [
            "checkpoint_capture_jobs",
            "checkpoint_navigation_operations",
            "auto_resume_jobs",
          ]) {
            const [row] = yield* sql.unsafe<{ count: number }>(
              `SELECT COUNT(*) AS count FROM ${table}`,
            ).unprepared;
            assert.equal(row?.count, 0);
          }
          const snapshots = yield* sql<{
            snapshot_id: string;
          }>`SELECT snapshot_id FROM checkpoint_snapshots`;
          assert.deepEqual(
            snapshots.map((row) => row.snapshot_id),
            ["stopped-thread"],
          );
          const violations = yield* sql.unsafe("PRAGMA foreign_key_check").unprepared;
          assert.deepEqual(violations, []);
        }),
      );
    }),
  );

  for (const [history, ledger] of [
    [
      "old fork",
      [
        [33, "CheckpointDurableState"],
        [34, "CheckpointLegacyMigration"],
        [35, "CheckpointCaptureProviderMetadata"],
        [36, "CheckpointNavigationMode"],
        [37, "ProjectionThreadsSettled"],
        [38, "ProjectionThreadsSnoozed"],
      ],
    ],
    [
      "upstream",
      [
        [36, "ProjectionThreadsPinned"],
        [37, "ProjectionTurnsKeysetIndex"],
        [38, "ProjectionThreadsPinOrderKey"],
        [39, "ProjectionProjectsDefaultThreadEnvMode"],
        [40, "ProjectionProjectFaviconPath"],
        [41, "AuthSessionClientConnection"],
        [42, "ProjectionThreadLinkedPullRequest"],
        [43, "ProjectionThreadsUnsettledAt"],
        [44, "ClearAutomaticProjectModelDefaults"],
        [45, "ProjectionProjectsAutoPull"],
        [46, "RepairAutomaticSettlementTimestamps"],
        [47, "ProjectionProjectIcon"],
      ],
    ],
  ] as const) {
    it.effect(`accepts reconciled ${history} history without rewriting its ledger`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-history-" });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-history-dest-",
        });
        const source = yield* createFixtureSource(sourceDir);
        yield* withDatabase(
          source,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const [slot, name] of ledger) {
              yield* sql`UPDATE effect_sql_migrations SET name = ${name} WHERE migration_id = ${slot}`;
            }
          }),
        );
        const result = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
          { sharedHome: sourceDir },
        );
        yield* withDatabase(
          result.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const [slot, name] of ledger) {
              const [row] = yield* sql<{ name: string }>`
              SELECT name FROM effect_sql_migrations WHERE migration_id = ${slot}`;
              assert.equal(row?.name, name);
            }
          }),
        );
      }),
    );
  }

  it.effect("rejects a known historical name when the reconciled schema is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-bad-repair-" });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-bad-repair-dest-",
      });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations SET name = 'CheckpointDurableState' WHERE migration_id = 33`;
          yield* sql`ALTER TABLE checkpoint_capture_jobs DROP COLUMN provider_cursor_json`;
        }),
      );
      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSlotCollisionError");
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      // This test process stands in for a live dev server.
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect("refuses a source that resolves to a destination path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      // A leftover snapshot from a prior failed run, passed as --source: it
      // must not be deleted before it is read.
      const leftoverSnapshot = path.join(destDir, "userdata", "state.sqlite.migrate-dev-db-tmp");
      yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
      yield* fs.writeFileString(leftoverSnapshot, "not a real db");

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.exists(leftoverSnapshot), true);
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );
});
