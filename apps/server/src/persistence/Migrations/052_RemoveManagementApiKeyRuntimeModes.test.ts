import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_RemoveManagementApiKeyRuntimeModes", (it) => {
  it.effect("removes runtime-mode policy from management keys", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 50 });
      // Simulate an installation that already ran the original migration 50.
      yield* sql`
        ALTER TABLE management_api_keys
        ADD COLUMN default_runtime_mode TEXT NOT NULL DEFAULT 'approval-required'
      `;
      yield* sql`
        ALTER TABLE management_api_keys
        ADD COLUMN maximum_runtime_mode TEXT NOT NULL DEFAULT 'auto-accept-edits'
      `;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runMigrations({ toMigrationInclusive: 52 });

      const columns = yield* sql<{ readonly name: string }>`
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

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 52
      `;
      assert.deepEqual(ledger, [{ migrationId: 52, name: "RemoveManagementApiKeyRuntimeModes" }]);
    }),
  );
});
