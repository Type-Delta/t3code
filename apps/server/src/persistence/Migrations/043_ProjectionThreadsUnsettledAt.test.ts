import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("043_ProjectionThreadsUnsettledAt", (it) => {
  it.effect("adds the unsettled timestamp after linked pull request history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "linked_pull_request_json"));
      assert.ok(columns.some((column) => column.name === "unsettled_at"));

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id IN (42, 43)
        ORDER BY migration_id
      `;
      assert.deepEqual(ledger, [
        { migrationId: 42, name: "ProjectionThreadLinkedPullRequest" },
        { migrationId: 43, name: "ProjectionThreadsUnsettledAt" },
      ]);
    }),
  );
});
