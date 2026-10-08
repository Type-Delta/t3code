import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture UUIDs are test-only filesystem names.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture paths are test-only filesystem names.
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture paths are test-only filesystem names.
import * as NodePath from "node:path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  forkMigrationManifest,
  reconcileForkMigrationHistory,
  runForkMigrations,
} from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

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
] as const)("converts %s history with schema, integrity, retention, and restart checks", (shape) =>
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
      assert.equal((yield* sql`SELECT count(*) AS count FROM fork_sql_migrations`)[0]?.count, 15);
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
