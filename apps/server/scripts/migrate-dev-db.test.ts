// oxlint-disable t3code/no-test-in-loop -- These cases intentionally exercise independent provider/process variants.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

/** A migrated source db with one V2 thread per lifecycle state. Only
 * `stopped-thread` and its fork qualify for the clone. */
const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      // Excluded threads are newer than the kept family, so only the filters
      // can keep them out of a one-family-per-project clone.
      const threads = [
        ["stopped-thread", "project-kept", "completed", "{}", "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        // Its result never reached the parent, so startup would deliver it.
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      // A provider session shared by two threads names its latest writer.
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'settled-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("keeps stopped thread families from live projects and clears pending work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "statev2.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
          const [leftovers] = yield* sql<{ auth: number; tasks: number; transfers: number }>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers) AS transfers`;
          return { threads, events, sessions, leftovers };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["fork-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["fork-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.sessions.map((row) => row.provider_session_id),
        ["session-shared"],
      );
      assert.deepStrictEqual(kept.leftovers, { auth: 0, tasks: 0, transfers: 0 });
    }),
  );

  it.effect("warns and continues on a migration slot collision", () =>
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

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      assert.equal(result.projects.length, 1);
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
    it.effect(`converts ${history} history into the split ledgers`, () =>
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
              const [row] =
                history === "old fork"
                  ? yield* sql<{
                      name: string;
                    }>`SELECT name FROM fork_sql_migrations WHERE name = ${name}`
                  : yield* sql<{
                      name: string;
                    }>`SELECT name FROM effect_sql_migrations WHERE migration_id = ${slot}`;
              if (
                history === "old fork" &&
                (name === "ProjectionThreadsSettled" || name === "ProjectionThreadsSnoozed")
              )
                continue;
              assert.equal(row?.name, name);
            }
          }),
        );
      }),
    );
  }

  it.effect("repairs a known historical name when the schema is missing", () =>
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
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      const hasProviderCursor = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql`PRAGMA table_info(checkpoint_capture_jobs)`).some(
            (row) => row.name === "provider_cursor_json",
          );
        }),
      );
      assert.isTrue(hasProviderCursor);
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
      const leftoverSnapshot = path.join(destDir, "userdata", "statev2.sqlite.migrate-dev-db-tmp");
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
