import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_CheckpointNavigationMode", (it) => {
  it.effect("adds a constrained full-mode default for existing navigation journals", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(checkpoint_navigation_operations)
      `;
      assert.isFalse(before.some((column) => column.name === "mode"));

      yield* runMigrations({ toMigrationInclusive: 36 });
      const after = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(checkpoint_navigation_operations)
      `;
      const mode = after.find((column) => column.name === "mode");
      assert.equal(mode?.notnull, 1);
      assert.equal(mode?.dflt_value, "'full'");

      const table = yield* sql<{ readonly sql: string }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = 'checkpoint_navigation_operations'
      `;
      assert.include(table[0]?.sql ?? "", "mode IN ('full', 'files-only')");
    }),
  );
});
