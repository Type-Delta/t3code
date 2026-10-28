import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture UUIDs are test-only filesystem names.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture paths are test-only filesystem names.
import * as NodePath from "node:path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  forkMigrationManifest,
  reconcileForkMigrationHistory,
  runMissingUpstreamMigrations,
  runForkMigrations,
} from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const assertCurrentSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const webhookColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  assert.isTrue(webhookColumns.some((column) => column.name === "last_run_webhook_delivery_id"));
  const objects = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE name IN (
      'orchestration_v2_provider_turns_codex_native_id_idx',
      'orchestration_v2_projection_turn_items_stop_request_idx',
      'scheduled_task_webhook_replay_keys',
      'scheduled_task_webhook_pending',
      'idx_webhook_pending_key',
      'orchestration_v2_message_search',
      'orchestration_v2_message_search_insert',
      'orchestration_v2_message_search_update',
      'orchestration_v2_message_search_delete'
    )`;
  assert.equal(objects.length, 9);
  assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
  assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
});

it.effect.each([0, 64])(
  "upgrades schema at upstream migration %s and restarts unchanged",
  (fromId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (fromId > 0) {
        yield* runMigrations({ toMigrationInclusive: fromId });
        const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
        assert.isFalse(columns.some((column) => column.name === "last_run_webhook_delivery_id"));
      }
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > fromId),
      );
      yield* assertCurrentSchema;
      const before = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`,
        before,
      );
      yield* assertCurrentSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("repairs the historical 58 suggestion collision before newer upstream schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 47 });
    yield* runForkMigrations();
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (58, 'ProjectionThreadMessageSuggestions')`;
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.isFalse(columns.some((column) => column.name === "branch_pull_request_json"));

    yield* runMigrations();

    const repaired = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.isTrue(repaired.some((column) => column.name === "branch_pull_request_json"));
    const messages = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(projection_thread_messages)`;
    assert.isTrue(messages.some((column) => column.name === "suggestion"));
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (48, 58) ORDER BY migration_id`,
      [
        { migration_id: 48, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 58, name: "WebhookRelayDeliveries" },
      ],
    );
    yield* assertCurrentSchema;
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([false, true])(
  "upgrades the deployed fork ledger with bad-merge webhooks %s",
  (withWebhooks) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: withWebhooks ? 58 : 56 });
      yield* runForkMigrations();
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 36`;
      const names = [
        "CheckpointDurableState",
        "CheckpointLegacyMigration",
        "CheckpointCaptureProviderMetadata",
        "ReconcileCheckpointAndTitleHistory",
        "ProjectionSubagentIds",
        "ProjectionThreadsPinned",
        "ProjectionTurnsKeysetIndex",
        "ProjectionThreadsPinOrderKey",
        "ProjectionProjectsDefaultThreadEnvMode",
        "ProjectionProjectFaviconPath",
        "ReconcileUpstream41History",
        "AuthSessionClientConnection",
        "ProjectionThreadLinkedPullRequest",
        "ProjectionThreadsUnsettledAt",
        "ManagementApiKeys",
        "AutoResumeJobs",
        "RemoveManagementApiKeyRuntimeModes",
        "ReconcileUpstream47History",
        "ClearAutomaticProjectModelDefaults",
        "ProjectionProjectsAutoPull",
        "RepairAutomaticSettlementTimestamps",
        "ProjectionProjectIcon",
        "ProjectionThreadBranchPullRequest",
        "ProjectionThreadsActiveOrderKey",
        "ProjectionThreadPullRequests",
        "ProjectionThreadMessageContext",
        "ProjectionThreadMessageSuggestions",
        "ProjectionThreadTitleState",
        "PullRequestFilesViewed",
        "ReconcileBranchPullRequestHistory",
        "ProjectionThreadsAutoSettleDisabledAt",
        "CoreV2Cutover",
        ...(withWebhooks ? ["ScheduledTaskWebhooks", "WebhookRelayDeliveries"] : []),
      ];
      for (const [index, name] of names.entries()) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${index + 36}, ${name})`;
      }
      yield* sql`DELETE FROM fork_sql_migrations`;
      yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at, suggestion)
      VALUES ('fork-message', 'fork-thread', 'assistant', 'Retained reply', 0,
        '2026-10-01', '2026-10-01', 'Retained suggestion')`;

      yield* runMigrations();

      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
        migrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT text, suggestion FROM projection_thread_messages WHERE message_id = 'fork-message'`,
        [{ text: "Retained reply", suggestion: "Retained suggestion" }],
      );
      yield* assertCurrentSchema;
      assert.deepStrictEqual(yield* runMigrations(), []);
      yield* assertCurrentSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

const seedSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Build the complete shared schema once, then remove ledger rows to model
  // each deployed history without replaying migrations against partial tables.
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* sql`CREATE TABLE IF NOT EXISTS fork_sql_migrations (
    migration_id integer PRIMARY KEY NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp
  )`;
  yield* sql`DELETE FROM fork_sql_migrations`;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 35`;
});

const seedShape = (
  shape:
    | "current"
    | "legacy"
    | "upstream-v1"
    | "upstream-v2"
    | "preview-53"
    | "preview-54"
    | "bad-merge",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedSchema;
    if (shape === "current") {
      const names = [
        "CheckpointDurableState",
        "CheckpointLegacyMigration",
        "CheckpointCaptureProviderMetadata",
        "ReconcileCheckpointAndTitleHistory",
        "ProjectionSubagentIds",
        "ProjectionThreadsPinned",
      ];
      for (const [index, name] of names.entries())
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${36 + index}, ${name})`;
    } else if (shape === "legacy") {
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 33`;
      const names = [
        "CheckpointDurableState",
        "CheckpointLegacyMigration",
        "CheckpointCaptureProviderMetadata",
        "CheckpointNavigationMode",
        "ProjectionThreadsSettled",
        "ProjectionThreadsSnoozed",
      ];
      for (const [index, name] of names.entries())
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${33 + index}, ${name})`;
    } else if (shape === "bad-merge") {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (67, 'CoreV2Cutover'), (68, 'ScheduledTaskWebhooks'), (69, 'WebhookRelayDeliveries')`;
    } else if (shape.startsWith("preview")) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'OrchestrationV2')`;
      if (shape === "preview-54")
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'OrchestrationV2'), (55, 'RemoveRedundantProjectionIndexes')`;
    } else {
      const end = shape === "upstream-v1" ? 54 : 56;
      for (const [id, name] of migrationManifest)
        if (id >= 36 && id <= end)
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
  });

it.effect.each([
  "current",
  "legacy",
  "upstream-v1",
  "upstream-v2",
  "preview-53",
  "preview-54",
  "bad-merge",
] as const)("converts %s ledger records and retains V1 rows", (shape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedShape(shape);
    yield* reconcileForkMigrationHistory(migrationManifest);
    yield* runForkMigrations();
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('fixture-project', 'Fixture', '/tmp/fixture', '[]', '2026-01-01', '2026-01-01')`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES ('fixture-thread', 'fixture-project', 'Fixture', '{}', 'full-access', 'default', '2026-01-01', '2026-01-01')`;
    assert.equal((yield* sql`SELECT count(*) AS count FROM projection_threads`)[0]?.count, 1);
    assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    const forkTables =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_sql_migrations'`;
    if (forkTables.length > 0) {
      assert.isAtLeast(
        Number((yield* sql`SELECT count(*) AS count FROM fork_sql_migrations`)[0]?.count ?? 0),
        15,
      );
    }
    yield* reconcileForkMigrationHistory(migrationManifest);
    yield* runForkMigrations();
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({
        filename: NodePath.join(
          NodeOS.tmpdir(),
          `t3-fork-migrations-${shape}-${NodeCrypto.randomUUID()}.sqlite`,
        ),
      }),
    ),
  ),
);

it.effect("converts every deployed 59-67 fork collision before upstream migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 58 });
    for (const [id, name] of [
      [59, "ProjectionThreadsActiveOrderKey"],
      [60, "ProjectionThreadPullRequests"],
      [61, "ProjectionThreadMessageContext"],
      [62, "ProjectionThreadMessageSuggestions"],
      [63, "ProjectionThreadTitleState"],
      [64, "PullRequestFilesViewed"],
      [65, "ReconcileBranchPullRequestHistory"],
      [66, "ProjectionThreadsAutoSettleDisabledAt"],
      [67, "CoreV2Cutover"],
    ] as const) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${id}, ${name})`;
    }
    const executed = yield* runMigrations();
    assert.deepStrictEqual(executed, [
      [59, "McpAppModelContext"],
      [60, "ThreadSnapshotWindowIndexes"],
      [61, "PullRequestReviewGuides"],
      [62, "ThreadFailureLookupIndex"],
      [63, "DropUnusedV1Projections"],
      [64, "CanonicalizeThreadPullRequestLinks"],
      [65, "CodexUsageNativeTurnIndex"],
      [66, "RepairClientSettlementTimestamps"],
      [67, "WebhookDedupe"],
      [68, "ShellStopRequestIndex"],
      [69, "ThreadMessageSearch"],
      [70, "PeerLinks"],
      [71, "PeerLinkFence"],
      [72, "WaitingLinkRequestIndex"],
    ]);
    const effectRows = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 48 ORDER BY migration_id`;
    assert.deepEqual(
      effectRows.map((row) => [row.migration_id, row.name] as const),
      migrationManifest.filter(([id]) => id >= 48),
    );
    const forkRows = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM fork_sql_migrations WHERE migration_id >= 59 ORDER BY migration_id`;
    assert.deepEqual(
      forkRows.map((row) => [row.migration_id, row.name]),
      [
        [59, "ProjectionThreadsActiveOrderKey"],
        [60, "ProjectionThreadPullRequests"],
        [61, "ProjectionThreadMessageContext"],
        [62, "ProjectionThreadMessageSuggestions"],
        [63, "ProjectionThreadTitleState"],
        [64, "PullRequestFilesViewed"],
        [65, "ReconcileBranchPullRequestHistory"],
        [66, "ProjectionThreadsAutoSettleDisabledAt"],
        [67, "CoreV2Cutover"],
      ],
    );
    yield* assertCurrentSchema;
    assert.deepStrictEqual(yield* runMigrations(), []);
    yield* assertCurrentSchema;
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({
        filename: NodePath.join(
          NodeOS.tmpdir(),
          `t3-fork-collisions-${NodeCrypto.randomUUID()}.sqlite`,
        ),
      }),
    ),
  ),
);

it.effect("keeps the manifests collision-free and names every deployed record", () =>
  Effect.sync(() => {
    assert.equal(new Set(migrationManifest.map(([id]) => id)).size, migrationManifest.length);
    assert.equal(
      new Set(forkMigrationManifest.map(([id]) => id)).size,
      forkMigrationManifest.length,
    );
    assert.isTrue(forkMigrationManifest.some(([, name]) => name === "CheckpointDurableState"));
    assert.isTrue(migrationManifest.some(([, name]) => name === "OrchestrationV2"));
  }),
);

it.effect("repairs a lower upstream gap created by reconciliation once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp
    )`;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (36, 'ProjectionThreadsPinned'),
             (41, 'ThreadSummaryTimeline'),
             (42, 'Tail')
    `;

    const repaired = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE repaired_upstream_gap (value TEXT NOT NULL)`;
      yield* sql`INSERT INTO repaired_upstream_gap (value) VALUES ('applied')`;
    });
    const entries = [
      [36, "ProjectionThreadsPinned", Effect.void],
      [41, "AuthSessionClientConnection", repaired],
      [42, "Tail", Effect.void],
    ] as const;

    yield* reconcileForkMigrationHistory([
      [36, "ProjectionThreadsPinned"],
      [41, "AuthSessionClientConnection"],
      [42, "Tail"],
    ]);
    assert.deepStrictEqual(yield* runMissingUpstreamMigrations(entries), [
      [41, "AuthSessionClientConnection"],
    ]);
    assert.deepStrictEqual(yield* sql`SELECT value FROM repaired_upstream_gap`, [
      { value: "applied" },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 41`,
      [{ migration_id: 41, name: "AuthSessionClientConnection" }],
    );

    yield* reconcileForkMigrationHistory([
      [36, "ProjectionThreadsPinned"],
      [41, "AuthSessionClientConnection"],
      [42, "Tail"],
    ]);
    assert.deepStrictEqual(yield* runMissingUpstreamMigrations(entries), []);
    assert.equal((yield* sql`SELECT count(*) AS count FROM repaired_upstream_gap`)[0]?.count, 1);
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({
        filename: NodePath.join(
          NodeOS.tmpdir(),
          `t3-fork-migrations-gap-${NodeCrypto.randomUUID()}.sqlite`,
        ),
      }),
    ),
  ),
);

it.effect("drops V1 turns with legacy checkpoint rows that still reference them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 62 });
    yield* runForkMigrations();
    // Deployed fork databases created this table with a key into projection_turns.
    yield* sql`DROP TABLE checkpoint_legacy_migrations`;
    yield* sql`CREATE TABLE checkpoint_legacy_migrations (
      candidate_id TEXT PRIMARY KEY,
      projection_turn_row_id INTEGER NOT NULL UNIQUE REFERENCES projection_turns(row_id),
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      legacy_ref TEXT NOT NULL UNIQUE,
      snapshot_id TEXT NOT NULL UNIQUE REFERENCES checkpoint_snapshots(snapshot_id),
      repository_key TEXT NOT NULL REFERENCES checkpoint_repositories(repository_key),
      worktree_key TEXT NOT NULL,
      state TEXT NOT NULL,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified_at TEXT,
      cleanup_after TEXT,
      cleaned_at TEXT
    )`;
    yield* sql`INSERT INTO projection_turns
      (row_id, thread_id, turn_id, state, requested_at, checkpoint_files_json)
      VALUES (7, 'thread', 'turn', 'completed', '2026-08-01', '[]')`;
    yield* sql`INSERT INTO checkpoint_repositories
      (repository_key, common_dir_fingerprint, object_format, sidecar_relative_path, created_at, last_used_at)
      VALUES ('repo', 'fingerprint', 'sha1', 'sidecar', '2026-08-01', '2026-08-01')`;
    yield* sql`INSERT INTO checkpoint_snapshots
      (snapshot_id, repository_key, worktree_key, kind, state, created_at)
      VALUES ('snapshot', 'repo', 'worktree', 'legacy-import', 'pending', '2026-08-01')`;
    yield* sql`INSERT INTO checkpoint_legacy_migrations
      (candidate_id, projection_turn_row_id, thread_id, turn_id, legacy_ref, snapshot_id,
       repository_key, worktree_key, state, created_at, updated_at)
      VALUES ('candidate', 7, 'thread', 'turn', 'ref', 'snapshot', 'repo', 'worktree',
              'pending', '2026-08-01', '2026-08-01')`;

    yield* runMigrations();

    const turns = yield* sql`SELECT name FROM sqlite_master WHERE name = 'projection_turns'`;
    assert.deepEqual(turns, []);
    const keys = yield* sql<{ readonly table: string }>`
      SELECT "table" FROM pragma_foreign_key_list('checkpoint_legacy_migrations')`;
    assert.deepEqual(keys.map((key) => key.table).toSorted(), [
      "checkpoint_repositories",
      "checkpoint_snapshots",
    ]);
    const rows = yield* sql<{ readonly candidate_id: string }>`
      SELECT candidate_id FROM checkpoint_legacy_migrations`;
    assert.deepEqual(
      rows.map((row) => row.candidate_id),
      ["candidate"],
    );
    yield* sql`DELETE FROM checkpoint_legacy_migrations`;
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({
        filename: NodePath.join(
          NodeOS.tmpdir(),
          `t3-fork-legacy-turn-key-${NodeCrypto.randomUUID()}.sqlite`,
        ),
      }),
    ),
  ),
);
