import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("upgrades a V2 preview and keeps its import tables", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* OrchestrationV2;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'OrchestrationV2')`;

    const ran = yield* runMigrations();
    assert.isTrue(ran.some(([id, name]) => id === 58 && name === "WebhookRelayDeliveries"));
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'`)
        .length,
      1,
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(sqlite)),
);

it.effect("does not reject unfamiliar records after a preview marker", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* OrchestrationV2;
    yield* RemoveRedundantProjectionIndexes;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'OrchestrationV2')`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'LocalMigration')`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 99`,
      [{ name: "LocalMigration" }],
    );
  }).pipe(Effect.provide(sqlite)),
);
