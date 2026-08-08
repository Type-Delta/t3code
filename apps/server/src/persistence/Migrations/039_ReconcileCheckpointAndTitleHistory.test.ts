import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import projectionThreadsSettled from "./033_ProjectionThreadsSettled.ts";
import projectionThreadsSnoozed from "./034_ProjectionThreadsSnoozed.ts";
import projectionThreadTitleRegeneration from "./035_ProjectionThreadTitleRegeneration.ts";
import checkpointDurableState from "./036_CheckpointDurableState.ts";
import checkpointLegacyMigration from "./037_CheckpointLegacyMigration.ts";
import checkpointCaptureProviderMetadata from "./038_CheckpointCaptureProviderMetadata.ts";
import projectionThreadsPinned from "./041_ProjectionThreadsPinned.ts";
import projectionTurnsKeysetIndex from "./042_ProjectionTurnsKeysetIndex.ts";
import projectionThreadsPinOrderKey from "./043_ProjectionThreadsPinOrderKey.ts";

const assertReconciledColumns = Effect.fn("assertReconciledColumns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const navigationColumns = yield* sql<{
    readonly dflt_value: string | null;
    readonly name: string;
    readonly notnull: number;
  }>`
    PRAGMA table_info(checkpoint_navigation_operations)
  `;
  const navigationTable = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'checkpoint_navigation_operations'
  `;
  const captureColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(checkpoint_capture_jobs)
  `;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const mode = navigationColumns.find((column) => column.name === "mode");
  assert.strictEqual(mode?.notnull, 1);
  assert.strictEqual(mode?.dflt_value, "'full'");
  assert.include(navigationTable[0]?.sql, "CHECK (mode IN ('full', 'files-only'))");
  for (const name of ["provider_binding_json", "provider_cursor_json"]) {
    assert.ok(captureColumns.some((column) => column.name === name));
  }
  for (const name of [
    "settled_override",
    "settled_at",
    "snoozed_until",
    "snoozed_at",
    "title_regeneration_request_id",
    "title_regeneration_started_at",
  ]) {
    assert.ok(threadColumns.some((column) => column.name === name));
  }
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "039_ReconcileCheckpointAndTitleHistory upstream ledger",
  (it) => {
    it.effect("upgrades the upstream 33-35 ledger", () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 35 });
        yield* runMigrations({ toMigrationInclusive: 39 });
        yield* assertReconciledColumns();
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "039_ReconcileCheckpointAndTitleHistory fork ledger",
  (it) => {
    it.effect("upgrades the fork 33-38 ledger", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 32 });
        yield* checkpointDurableState;
        yield* checkpointLegacyMigration;
        yield* checkpointCaptureProviderMetadata;
        yield* sql`
        ALTER TABLE projection_threads ADD COLUMN settled_override TEXT
      `;
        yield* sql`
        ALTER TABLE projection_threads ADD COLUMN settled_at TEXT
      `;
        yield* sql`
        ALTER TABLE projection_threads ADD COLUMN snoozed_until TEXT
      `;
        yield* sql`
        ALTER TABLE projection_threads ADD COLUMN snoozed_at TEXT
      `;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (33, 'CheckpointDurableState'),
          (34, 'CheckpointLegacyMigration'),
          (35, 'CheckpointCaptureProviderMetadata'),
          (36, 'CheckpointNavigationMode'),
          (37, 'ProjectionThreadsSettled'),
          (38, 'ProjectionThreadsSnoozed')
      `;

        yield* runMigrations({ toMigrationInclusive: 39 });
        yield* assertReconciledColumns();
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "039_ReconcileCheckpointAndTitleHistory upstream 38 ledger",
  (it) => {
    it.effect("repairs checkpoint schema skipped by upstream-numbered migrations", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 32 });
        yield* projectionThreadsSettled;
        yield* projectionThreadsSnoozed;
        yield* projectionThreadTitleRegeneration;
        yield* projectionThreadsPinned;
        yield* projectionTurnsKeysetIndex;
        yield* projectionThreadsPinOrderKey;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES
            (33, 'ProjectionThreadsSettled'),
            (34, 'ProjectionThreadsSnoozed'),
            (35, 'ProjectionThreadTitleRegeneration'),
            (36, 'ProjectionThreadsPinned'),
            (37, 'ProjectionTurnsKeysetIndex'),
            (38, 'ProjectionThreadsPinOrderKey')
        `;

        yield* runMigrations({ toMigrationInclusive: 39 });
        yield* assertReconciledColumns();
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "039_ReconcileCheckpointAndTitleHistory old fork ledger",
  (it) => {
    it.effect("upgrades the old fork 33-36 ledger", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 32 });
        yield* checkpointDurableState;
        yield* checkpointLegacyMigration;
        yield* checkpointCaptureProviderMetadata;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES
            (33, 'CheckpointDurableState'),
            (34, 'CheckpointLegacyMigration'),
            (35, 'CheckpointCaptureProviderMetadata'),
            (36, 'CheckpointNavigationMode')
        `;

        yield* runMigrations({ toMigrationInclusive: 39 });
        yield* assertReconciledColumns();
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "039_ReconcileCheckpointAndTitleHistory pre-navigation fork ledger",
  (it) => {
    it.effect("adds navigation mode after the old fork 33-35 ledger", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 32 });
        yield* checkpointDurableState;
        yield* sql`ALTER TABLE checkpoint_navigation_operations DROP COLUMN mode`;
        yield* checkpointLegacyMigration;
        yield* checkpointCaptureProviderMetadata;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES
            (33, 'CheckpointDurableState'),
            (34, 'CheckpointLegacyMigration'),
            (35, 'CheckpointCaptureProviderMetadata')
        `;

        yield* runMigrations({ toMigrationInclusive: 39 });
        yield* assertReconciledColumns();
      }),
    );
  },
);
