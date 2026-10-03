import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/064_PullRequestFilesViewed.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";

const upstreamNames = new Map<number, string>([
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionTurnsKeysetIndex"],
  [38, "ProjectionThreadsPinOrderKey"],
  [39, "ProjectionProjectsDefaultThreadEnvMode"],
  [40, "ProjectionProjectFaviconPath"],
  [41, "AuthSessionClientConnection"],
  [42, "ProjectionThreadLinkedPullRequest"],
  [43, "ProjectionThreadsUnsettledAt"],
  [44, "ClearAutomaticProjectModelDefaults"],
  [45, "ProjectionProjectsAutoPull"],
  [46, "RepairAutomaticSettlementTimestamps"],
  [47, "ProjectionProjectIcon"],
  [48, "ProjectionThreadBranchPullRequest"],
  [49, "ProjectionThreadsActiveOrderKey"],
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
]);

const resetAfterCommonHistory = Effect.fn("migrationLineageTest.resetAfterCommonHistory")(
  function* (throughId: number) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 35`;
    for (let id = 36; id <= throughId; id++) {
      const name = upstreamNames.get(id);
      if (name === undefined) throw new Error(`Missing upstream fixture migration ${id}`);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
  },
);

const readHistory = Effect.fn("migrationLineageTest.readHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`
    SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
  `;
});

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "migrates a fork database through its unchanged ID 66, then performs the V2 cutover once",
  () =>
    Effect.gen(function* () {
      const history = yield* runMigrations();
      assert.deepEqual(
        history,
        migrationManifest.map(([id, name]) => [id, name]),
      );
      assert.equal(history.at(-1)?.[1], "CoreV2Cutover");
      assert.deepEqual(yield* runMigrations(), []);

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* readHistory();
      assert.equal(rows[65]?.name, "ProjectionThreadsAutoSettleDisabledAt");
      assert.equal(rows[66]?.name, "CoreV2Cutover");
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_events'`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_files_viewed'`)
          .length,
        1,
      );
    }).pipe(Effect.provide(sqlite)),
);

it.effect("adds V2 to upstream V1 while preserving its migration IDs and names", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 35 });
    yield* resetAfterCommonHistory(54);
    const before = yield* readHistory();

    assert.deepEqual(yield* runMigrations(), [[67, "CoreV2Cutover"]]);
    assert.deepEqual(yield* runMigrations(), []);
    const after = yield* readHistory();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after[54]?.migration_id, 67);
    assert.equal(after[54]?.name, "CoreV2Cutover");
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_events'`)
        .length,
      1,
    );
  }).pipe(Effect.provide(sqlite)),
);

it.effect("keeps an upstream V2 ledger intact and recognizes its complete schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 35 });
    yield* OrchestrationV2;
    yield* RemoveRedundantProjectionIndexes;
    yield* resetAfterCommonHistory(56);
    const before = yield* readHistory();

    assert.deepEqual(yield* runMigrations(), [[67, "CoreV2Cutover"]]);
    const after = yield* readHistory();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after[54]?.name, "OrchestrationV2");
    assert.equal(after[55]?.name, "RemoveRedundantProjectionIndexes");
    assert.equal(after[56]?.name, "CoreV2Cutover");
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_runs'`)
        .length,
      1,
    );
  }).pipe(Effect.provide(sqlite)),
);

it.effect.each(["preview-53", "preview-54"] as const)(
  "upgrades %s without rewriting preview rows",
  (kind) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* resetAfterCommonHistory(52);
      if (kind === "preview-54") yield* PullRequestFilesViewed;
      yield* OrchestrationV2;
      if (kind === "preview-54") yield* RemoveRedundantProjectionIndexes;
      if (kind === "preview-53") {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'OrchestrationV2')`;
      } else {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'OrchestrationV2')`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'RemoveRedundantProjectionIndexes')`;
      }
      const before = yield* readHistory();

      assert.deepEqual(yield* runMigrations(), [[67, "CoreV2Cutover"]]);
      assert.deepEqual(yield* runMigrations(), []);
      const after = yield* readHistory();
      assert.deepEqual(after.slice(0, before.length), before);
      assert.equal(after.at(-1)?.migration_id, 67);
      assert.equal(
        (yield* sql`PRAGMA table_info(projection_threads)`).some(
          (column) => column.name === "auto_settle_disabled_at",
        ),
        true,
      );
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_files_viewed'`)
          .length,
        1,
      );
    }).pipe(Effect.provide(sqlite)),
);

it.effect("rejects unknown and partial schemas without changing the migration ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 35 });
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (36, 'UnknownMigration')`;
    const before = yield* readHistory();
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepEqual(yield* readHistory(), before);
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_events'`).length,
      0,
    );
  }).pipe(Effect.provide(sqlite)),
);

it.effect("refuses application tables without a migration ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE partial_schema (value TEXT)`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE name = 'partial_schema'`).length,
      1,
    );
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`).length,
      0,
    );
  }).pipe(Effect.provide(sqlite)),
);

it.effect("rejects a V2 marker with an incomplete V2 schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 35 });
    yield* resetAfterCommonHistory(54);
    yield* sql`CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY)`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'OrchestrationV2')`;
    const before = yield* readHistory();

    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepEqual(yield* readHistory(), before);
  }).pipe(Effect.provide(sqlite)),
);
