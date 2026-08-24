import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import projectionThreadsPinned from "./041_ProjectionThreadsPinned.ts";
import projectionTurnsKeysetIndex from "./042_ProjectionTurnsKeysetIndex.ts";
import projectionThreadsPinOrderKey from "./043_ProjectionThreadsPinOrderKey.ts";
import projectionProjectsDefaultThreadEnvMode from "./044_ProjectionProjectsDefaultThreadEnvMode.ts";
import projectionProjectFaviconPath from "./045_ProjectionProjectFaviconPath.ts";
import authSessionClientConnection from "./047_AuthSessionClientConnection.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ReconcileUpstream41History", (it) => {
  it.effect("repairs fork schema after the upstream 36-41 ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* projectionThreadsPinned;
      yield* projectionTurnsKeysetIndex;
      yield* projectionThreadsPinOrderKey;
      yield* projectionProjectsDefaultThreadEnvMode;
      yield* projectionProjectFaviconPath;
      yield* authSessionClientConnection;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (36, 'ProjectionThreadsPinned'),
          (37, 'ProjectionTurnsKeysetIndex'),
          (38, 'ProjectionThreadsPinOrderKey'),
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath'),
          (41, 'AuthSessionClientConnection')
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const checkpointTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'checkpoint_repositories',
            'checkpoint_snapshots',
            'checkpoint_capture_jobs',
            'checkpoint_navigation_operations',
            'checkpoint_legacy_migrations'
          )
      `;
      assert.equal(checkpointTables.length, 5);

      const captureColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(checkpoint_capture_jobs)
      `;
      for (const name of ["provider_binding_json", "provider_cursor_json"]) {
        assert.ok(captureColumns.some((column) => column.name === name));
      }

      const navigationColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(checkpoint_navigation_operations)
      `;
      assert.ok(navigationColumns.some((column) => column.name === "mode"));

      const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const activityColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_activities)
      `;
      assert.ok(messageColumns.some((column) => column.name === "subagent_id"));
      assert.ok(activityColumns.some((column) => column.name === "subagent_id"));

      const authColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.ok(authColumns.some((column) => column.name === "client_surface"));
      assert.ok(authColumns.some((column) => column.name === "client_app_version"));

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id IN (46, 47)
        ORDER BY migration_id
      `;
      assert.deepEqual(ledger, [
        { migrationId: 46, name: "ReconcileUpstream41History" },
        { migrationId: 47, name: "AuthSessionClientConnection" },
      ]);
    }),
  );
});
