import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_ProjectionThreadMessageSuggestions", (it) => {
  it.effect("adds a nullable suggestion to thread message projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* runMigrations({ toMigrationInclusive: 58 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const suggestion = columns.find((column) => column.name === "suggestion");

      assert.equal(suggestion?.name, "suggestion");
      assert.equal(suggestion?.notnull, 0);
    }),
  );
});
