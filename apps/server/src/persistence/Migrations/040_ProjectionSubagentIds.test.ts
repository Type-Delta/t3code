import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_ProjectionSubagentIds", (it) => {
  it.effect("adds nullable subagent ids to message and activity projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* runMigrations({ toMigrationInclusive: 40 });

      const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const activityColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_activities)
      `;

      assert.ok(messageColumns.some((column) => column.name === "subagent_id"));
      assert.ok(activityColumns.some((column) => column.name === "subagent_id"));
    }),
  );
});
