// @effect-diagnostics-next-line nodeBuiltinImport:off -- UUID names rollback backup files; the Effect Crypto service is unavailable at this module boundary.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import CheckpointDurableState from "./Migrations/036_CheckpointDurableState.ts";
import CheckpointLegacyMigration from "./Migrations/037_CheckpointLegacyMigration.ts";
import CheckpointCaptureProviderMetadata from "./Migrations/038_CheckpointCaptureProviderMetadata.ts";
import ManagementApiKeys from "./Migrations/050_ManagementApiKeys.ts";
import AutoResumeJobs from "./Migrations/051_AutoResumeJobs.ts";
import ProjectionThreadMessageSuggestions from "./Migrations/062_ProjectionThreadMessageSuggestions.ts";

const noOp = Effect.void;

/** The fork ledger is independent of upstream's effect_sql_migrations table. */
export const forkMigrationEntries = [
  [1, "CheckpointDurableState", CheckpointDurableState],
  [2, "CheckpointLegacyMigration", CheckpointLegacyMigration],
  [3, "CheckpointCaptureProviderMetadata", CheckpointCaptureProviderMetadata],
  [
    4,
    "CheckpointNavigationMode",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoint_navigation_operations'`;
      if (tables.length === 0) return;
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(checkpoint_navigation_operations)`;
      if (!columns.some((column) => column.name === "mode")) {
        yield* sql`ALTER TABLE checkpoint_navigation_operations ADD COLUMN mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'files-only'))`;
      }
    }),
  ],
  [
    5,
    "ProjectionSubagentIds",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projection_thread_messages', 'projection_thread_activities')`;
      if (tables.length < 2) return;
      const messages = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      if (!messages.some((column) => column.name === "subagent_id")) {
        yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN subagent_id TEXT`;
      }
      const activities = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_activities)`;
      if (!activities.some((column) => column.name === "subagent_id")) {
        yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN subagent_id TEXT`;
      }
    }),
  ],
  [6, "ManagementApiKeys", ManagementApiKeys],
  [
    7,
    "RemoveManagementApiKeyRuntimeModes",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'management_api_keys'`;
      if (tables.length === 0) return;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(management_api_keys)`;
      if (columns.some((column) => column.name === "default_runtime_mode")) {
        yield* sql`ALTER TABLE management_api_keys DROP COLUMN default_runtime_mode`;
      }
      if (columns.some((column) => column.name === "maximum_runtime_mode")) {
        yield* sql`ALTER TABLE management_api_keys DROP COLUMN maximum_runtime_mode`;
      }
    }),
  ],
  [8, "AutoResumeJobs", AutoResumeJobs],
  [9, "ProjectionThreadMessageSuggestions", ProjectionThreadMessageSuggestions],
  [
    10,
    "ProjectionThreadTitleState",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'`;
      if (tables.length === 0) return;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      if (!columns.some((column) => column.name === "title_state_json")) {
        yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
      }
    }),
  ],
  // Historical fork cutover records this name. The upstream 55/56 migrations
  // now own the schema, so the replacement record has no SQL to run.
  [11, "CoreV2Cutover", noOp],
  [12, "ReconcileCheckpointAndTitleHistory", noOp],
  [13, "ReconcileUpstream41History", noOp],
  [14, "ReconcileUpstream47History", noOp],
  [15, "ReconcileBranchPullRequestHistory", noOp],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);
// This migration removes columns that older fork builds added after recording
// the entry. Re-run its guarded cleanup so a partially converted database is
// repaired on the next boot.
const repairOnEveryRun = new Set([7]);

/** Run the independent fork ledger. Effect's numeric migrator assumes a
 * contiguous history and skips holes below the highest applied id, while
 * converted fork databases intentionally have sparse records. Apply only
 * missing entries in order; a normal boot therefore does no schema work. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_sql_migrations (
    migration_id integer PRIMARY KEY NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp
  )`;
  const applied = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM fork_sql_migrations
  `;
  const appliedIds = new Set(applied.map((row) => Number(row.migration_id)));
  const executed: Array<readonly [number, string]> = [];
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const [id, name, migration] of forkMigrationEntries) {
        if (appliedIds.has(id) && !repairOnEveryRun.has(id)) continue;
        yield* migration;
        if (!appliedIds.has(id)) {
          yield* sql`INSERT INTO fork_sql_migrations (migration_id, name)
            VALUES (${id}, ${name})`;
        }
        appliedIds.add(id);
        executed.push([id, name]);
      }
    }),
  );
  return executed;
});

type Manifest = ReadonlyArray<readonly [number, string]>;
type MigrationRow = {
  readonly migration_id: number;
  readonly name: string;
  readonly created_at: string;
};

const readHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  return tables.length === 0
    ? []
    : yield* sql<MigrationRow>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
});

/** Snapshot the complete SQLite database, including WAL contents, before a
 * one-way ledger conversion. Memory-only fixtures have no file to copy. */
export const backupMigrationHistory = Effect.fn("backupMigrationHistory")(function* (
  manifest: Manifest,
) {
  const rows = yield* readHistory;
  const byName = new Map(manifest.map(([id, name]) => [name, id]));
  const needsConversion = rows.some(
    (row) =>
      forkMigrationManifest.some(([, name]) => name === row.name && !byName.has(name)) ||
      row.name === "ThreadSummaryTimeline" ||
      (byName.has(row.name) && byName.get(row.name) !== row.migration_id),
  );
  if (!needsConversion) return;
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const file = databases.find((database) => database.name === "main")?.file;
  if (!file) return;
  const backupPath = `${file}.before-fork-ledger-${NodeCrypto.randomUUID()}.sqlite`;
  yield* sql`VACUUM INTO ${backupPath}`;
  yield* Effect.log("Saved database before migration ledger conversion").pipe(
    Effect.annotateLogs({ backupPath }),
  );
});

/** Names identify deployed fork histories; upstream ids are never renumbered. */
export const reconcileForkMigrationHistory = Effect.fn("reconcileForkMigrationHistory")(function* (
  manifest: Manifest,
) {
  const rows = yield* readHistory;
  const upstreamByName = new Map(manifest.map(([id, name]) => [name, id]));
  const upstreamNames = new Map(manifest);
  const forkNames = new Map<string, number>(forkMigrationManifest.map(([id, name]) => [name, id]));
  const needsConversion = rows.some(
    (row) =>
      (forkNames.has(row.name) && !upstreamByName.has(row.name)) ||
      row.name === "ThreadSummaryTimeline" ||
      (upstreamByName.has(row.name) && upstreamByName.get(row.name) !== row.migration_id),
  );
  if (!needsConversion) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS fork_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp
    )`;
      const upstreamRows = new Map<number, MigrationRow>();
      const forkRows = new Map<number, MigrationRow>();
      const knownIds = new Set<number>();
      for (const row of rows) {
        const upstreamId = row.name === "ThreadSummaryTimeline" ? 36 : upstreamByName.get(row.name);
        const forkId = forkNames.get(row.name);
        if (upstreamId !== undefined) {
          knownIds.add(row.migration_id);
          upstreamRows.set(upstreamId, { ...row, name: upstreamNames.get(upstreamId)! });
        } else if (forkId !== undefined) {
          knownIds.add(row.migration_id);
          forkRows.set(forkId, row);
        }
      }
      for (const row of rows) {
        const equivalents =
          row.name === "CoreV2Cutover"
            ? [53, 54, 55, 56]
            : row.name === "ReconcileCheckpointAndTitleHistory"
              ? [33, 34, 35]
              : row.name === "ReconcileBranchPullRequestHistory"
                ? [48]
                : [];
        for (const id of equivalents) {
          if (!upstreamRows.has(id)) upstreamRows.set(id, { ...row, name: upstreamNames.get(id)! });
        }
        if (row.name === "CoreV2Cutover") {
          for (const [id, name] of forkMigrationManifest) {
            if (id <= 11 && !forkRows.has(id)) forkRows.set(id, { ...row, migration_id: id, name });
          }
        }
      }
      for (const id of knownIds)
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id}`;
      for (const [id, row] of upstreamRows) {
        // Preserve unfamiliar records at occupied slots for the divergence warning.
        yield* sql`INSERT OR IGNORE INTO effect_sql_migrations (migration_id, name, created_at) VALUES (${id}, ${row.name}, ${row.created_at})`;
      }
      for (const [id, row] of forkRows) {
        yield* sql`INSERT OR IGNORE INTO fork_sql_migrations (migration_id, name, created_at) VALUES (${id}, ${row.name}, ${row.created_at})`;
      }
    }),
  );
});

export const migrationHistoryDivergence = Effect.fn("migrationHistoryDivergence")(function* (
  manifest: Manifest,
) {
  const rows = yield* readHistory;
  const names = new Map(manifest);
  return rows.flatMap((row) =>
    names.get(row.migration_id) === row.name ? [] : [`${row.migration_id}:${row.name}`],
  );
});
