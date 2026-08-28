import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_ProjectionThreadsUnsettledAt", (it) => {
  it.effect("adds the unsettled timestamp after the fork migration history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* runMigrations({ toMigrationInclusive: 49 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "linked_pull_request_json"));
      assert.ok(columns.some((column) => column.name === "unsettled_at"));

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id IN (48, 49)
        ORDER BY migration_id
      `;
      assert.deepEqual(ledger, [
        { migrationId: 48, name: "ProjectionThreadLinkedPullRequest" },
        { migrationId: 49, name: "ProjectionThreadsUnsettledAt" },
      ]);
    }),
  );
});
