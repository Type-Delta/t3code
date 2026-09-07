import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import projectionThreadsPinned from "./041_ProjectionThreadsPinned.ts";
import projectionTurnsKeysetIndex from "./042_ProjectionTurnsKeysetIndex.ts";
import projectionThreadsPinOrderKey from "./043_ProjectionThreadsPinOrderKey.ts";
import projectionProjectsDefaultThreadEnvMode from "./044_ProjectionProjectsDefaultThreadEnvMode.ts";
import projectionProjectFaviconPath from "./045_ProjectionProjectFaviconPath.ts";
import authSessionClientConnection from "./047_AuthSessionClientConnection.ts";
import projectionThreadLinkedPullRequest from "./048_ProjectionThreadLinkedPullRequest.ts";
import projectionThreadsUnsettledAt from "./049_ProjectionThreadsUnsettledAt.ts";
import clearAutomaticProjectModelDefaults from "./054_ClearAutomaticProjectModelDefaults.ts";
import projectionProjectsAutoPull from "./055_ProjectionProjectsAutoPull.ts";
import repairAutomaticSettlementTimestamps from "./056_RepairAutomaticSettlementTimestamps.ts";
import projectionProjectIcon from "./057_ProjectionProjectIcon.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ReconcileUpstream47History", (it) => {
  it.effect("repairs fork schema after the upstream 36-47 ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });

      // Reproduce the upstream schema and ledger that occupied IDs 36-47.
      yield* projectionThreadsPinned;
      yield* projectionTurnsKeysetIndex;
      yield* projectionThreadsPinOrderKey;
      yield* projectionProjectsDefaultThreadEnvMode;
      yield* projectionProjectFaviconPath;
      yield* authSessionClientConnection;
      yield* projectionThreadLinkedPullRequest;
      yield* projectionThreadsUnsettledAt;
      yield* clearAutomaticProjectModelDefaults;
      yield* projectionProjectsAutoPull;
      yield* repairAutomaticSettlementTimestamps;
      yield* projectionProjectIcon;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (36, 'ProjectionThreadsPinned'),
          (37, 'ProjectionTurnsKeysetIndex'),
          (38, 'ProjectionThreadsPinOrderKey'),
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath'),
          (41, 'AuthSessionClientConnection'),
          (42, 'ProjectionThreadLinkedPullRequest'),
          (43, 'ProjectionThreadsUnsettledAt'),
          (44, 'ClearAutomaticProjectModelDefaults'),
          (45, 'ProjectionProjectsAutoPull'),
          (46, 'RepairAutomaticSettlementTimestamps'),
          (47, 'ProjectionProjectIcon')
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

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
      assert.ok(captureColumns.some((column) => column.name === "provider_binding_json"));
      assert.ok(captureColumns.some((column) => column.name === "provider_cursor_json"));

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

      const forkTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('management_api_keys', 'auto_resume_jobs')
      `;
      assert.equal(forkTables.length, 2);

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 53
      `;
      assert.deepEqual(ledger, [{ migrationId: 53, name: "ReconcileUpstream47History" }]);
    }),
  );
});
