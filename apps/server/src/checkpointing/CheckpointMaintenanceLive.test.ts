import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointRetentionRepositoryLive } from "../persistence/Layers/CheckpointRetention.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CheckpointMaintenance from "./CheckpointMaintenance.ts";
import { CheckpointMaintenancePersistenceLive } from "./CheckpointMaintenanceLive.ts";

const persistence = CheckpointRetentionRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const layer = it.layer(CheckpointMaintenancePersistenceLive.pipe(Layer.provideMerge(persistence)));

layer("CheckpointMaintenancePersistenceLive", (it) => {
  it.effect("applies deleted-thread grace and resumes deletion through a sidecar locator", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const adapter = yield* CheckpointMaintenance.CheckpointMaintenancePersistence;
      const created = "2026-07-14T00:00:00.000Z";
      const deleted = "2026-07-15T00:00:00.000Z";
      const now = 1_784_160_000_000;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-retention-live', 'Retention', '/repo', '[]', ${created}, ${created})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at, deleted_at
        ) VALUES ('thread-retention-live', 'project-retention-live', 'Retention',
          '{"provider":"codex","model":"model"}', ${created}, ${created}, ${deleted})
      `;
      yield* sql`
        INSERT INTO checkpoint_repositories (
          repository_key, common_dir_fingerprint, object_format,
          sidecar_relative_path, created_at, last_used_at
        ) VALUES (${"a".repeat(64)}, ${"c".repeat(64)}, 'sha1',
          'repositories/repo.git', ${created}, ${created})
      `;
      yield* sql`
        INSERT INTO checkpoint_snapshots (
          snapshot_id, repository_key, worktree_key, commit_oid, tree_oid,
          kind, state, created_at, ready_at
        ) VALUES ('snapshot-retention-live', ${"a".repeat(64)}, ${"b".repeat(64)},
          ${"d".repeat(40)}, ${"e".repeat(40)}, 'turn', 'ready', ${created}, ${created})
      `;
      yield* sql`
        INSERT INTO checkpoint_capture_jobs (
          job_id, snapshot_id, thread_id, timeline_generation, turn_id, turn_ordinal,
          repository_key, worktree_key, requested_boundary, requested_generation,
          state, created_at, updated_at
        ) VALUES ('job-retention-live', 'snapshot-retention-live', 'thread-retention-live',
          0, 'turn-retention-live', 1, ${"a".repeat(64)}, ${"b".repeat(64)},
          'turn-completed', 0, 'ready', ${created}, ${created})
      `;

      const claimed = yield* adapter.claimExpired({ now, limit: 10 });
      assert.equal(claimed.length, 1);
      assert.match(String(claimed[0]?.checkpointRef), /^t3-sidecar:v1:/u);
      const policy = yield* sql<{
        readonly retentionClass: string;
        readonly deleteAfter: string;
      }>`
        SELECT retention_class AS "retentionClass", delete_after AS "deleteAfter"
        FROM checkpoint_snapshots WHERE snapshot_id = 'snapshot-retention-live'
      `;
      assert.deepEqual(policy[0], {
        retentionClass: "deleted-thread",
        deleteAfter: "2026-07-16T00:00:00.000Z",
      });
      yield* adapter.markDeleted({ deletionId: "snapshot-retention-live" });
      const deletedRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM checkpoint_snapshots
        WHERE snapshot_id = 'snapshot-retention-live' AND deleted_at IS NOT NULL
      `;
      assert.equal(deletedRows[0]?.count, 1);
    }),
  );
});
