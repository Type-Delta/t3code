import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ManagementApiKeys", (it) => {
  it.effect("creates the management key table, index, and migration ledger entry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* runMigrations({ toMigrationInclusive: 50 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(management_api_keys)
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "id",
          "name",
          "secret_hash",
          "secret_prefix",
          "scopes",
          "created_at",
          "expires_at",
          "last_used_at",
          "revoked_at",
        ],
      );
      assert.ok(
        columns.every(
          (column) =>
            column.notnull === 1 ||
            ["expires_at", "last_used_at", "revoked_at"].includes(column.name) ||
            column.name === "id",
        ),
      );

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(management_api_keys)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_management_api_keys_active"));

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 50
      `;
      assert.deepEqual(ledger, [{ migrationId: 50, name: "ManagementApiKeys" }]);
    }),
  );
});
