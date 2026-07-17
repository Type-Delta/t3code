import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointRetentionRepository } from "../Services/CheckpointRetention.ts";
import { CheckpointRetentionRepositoryLive } from "./CheckpointRetention.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  CheckpointRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const createdAt = "2026-07-01T00:00:00.000Z";
const expiredAt = "2026-07-08T00:00:00.000Z";

layer("CheckpointRetentionRepository", (it) => {
  it.effect("deletes only forward segments abandoned outside the recursive active lineage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const retention = yield* CheckpointRetentionRepository;

      yield* sql`
        INSERT INTO checkpoint_repositories (
          repository_key, common_dir_fingerprint, object_format,
          sidecar_relative_path, created_at, last_used_at
        ) VALUES ('repo-lineage-retention', 'fingerprint-lineage-retention', 'sha1',
          'repositories/repo-lineage-retention.git', ${createdAt}, ${createdAt})
      `;
      for (const snapshotId of [
        "snapshot-root-0",
        "snapshot-root-1",
        "snapshot-root-forward",
        "snapshot-child-2",
        "snapshot-child-forward",
        "snapshot-active-3",
      ]) {
        yield* sql`
          INSERT INTO checkpoint_snapshots (
            snapshot_id, repository_key, worktree_key, commit_oid, tree_oid,
            kind, state, created_at, ready_at
          ) VALUES (${snapshotId}, 'repo-lineage-retention', 'worktree-lineage-retention',
            ${`commit-${snapshotId}`}, ${`tree-${snapshotId}`}, 'turn', 'ready',
            ${createdAt}, ${createdAt})
        `;
      }

      yield* sql`
        INSERT INTO thread_checkpoint_generations (
          thread_id, generation, parent_generation, forked_from_entry_id,
          state, created_at, abandoned_at, delete_after
        ) VALUES ('thread-lineage-retention', 0, NULL, NULL, 'abandoned',
          ${createdAt}, ${createdAt}, ${expiredAt})
      `;
      for (const [ordinal, suffix, snapshotId] of [
        [0, "root-0", "snapshot-root-0"],
        [1, "root-1", "snapshot-root-1"],
        [2, "root-forward", "snapshot-root-forward"],
      ] as const) {
        yield* sql`
          INSERT INTO thread_checkpoint_entries (
            entry_id, thread_id, timeline_generation, ordinal, turn_id,
            provider_turn_id, snapshot_id, provider_binding_json,
            provider_cursor_json, completed_at, state, created_at
          ) VALUES (${`entry-${suffix}`}, 'thread-lineage-retention', 0, ${ordinal},
            ${`turn-${suffix}`}, ${`provider-${suffix}`}, ${snapshotId}, '{}', '{}',
            ${createdAt}, 'ready', ${createdAt})
        `;
      }

      yield* sql`
        INSERT INTO thread_checkpoint_generations (
          thread_id, generation, parent_generation, forked_from_entry_id,
          state, created_at, abandoned_at, delete_after
        ) VALUES ('thread-lineage-retention', 1, 0, 'entry-root-1', 'abandoned',
          ${createdAt}, ${createdAt}, ${expiredAt})
      `;
      for (const [ordinal, suffix, snapshotId] of [
        [2, "child-2", "snapshot-child-2"],
        [3, "child-forward", "snapshot-child-forward"],
      ] as const) {
        yield* sql`
          INSERT INTO thread_checkpoint_entries (
            entry_id, thread_id, timeline_generation, ordinal, turn_id,
            provider_turn_id, snapshot_id, provider_binding_json,
            provider_cursor_json, completed_at, state, created_at
          ) VALUES (${`entry-${suffix}`}, 'thread-lineage-retention', 1, ${ordinal},
            ${`turn-${suffix}`}, ${`provider-${suffix}`}, ${snapshotId}, '{}', '{}',
            ${createdAt}, 'ready', ${createdAt})
        `;
      }

      yield* sql`
        INSERT INTO thread_checkpoint_generations (
          thread_id, generation, parent_generation, forked_from_entry_id,
          state, created_at
        ) VALUES ('thread-lineage-retention', 2, 1, 'entry-child-2', 'active', ${createdAt})
      `;
      yield* sql`
        INSERT INTO thread_checkpoint_entries (
          entry_id, thread_id, timeline_generation, ordinal, turn_id,
          provider_turn_id, snapshot_id, provider_binding_json,
          provider_cursor_json, completed_at, state, created_at
        ) VALUES ('entry-active-3', 'thread-lineage-retention', 2, 3,
          'turn-active-3', 'provider-active-3', 'snapshot-active-3', '{}', '{}',
          ${createdAt}, 'ready', ${createdAt})
      `;

      yield* retention.scheduleSnapshotDeletion({
        snapshotId: "snapshot-root-0",
        retentionClass: "abandoned",
        deleteAfter: expiredAt,
      });
      yield* retention.applyPolicy({ now: expiredAt });

      const candidates = yield* retention.listDeletionCandidates({ now: expiredAt, limit: 20 });
      assert.deepStrictEqual(
        candidates.map((candidate) => candidate.snapshotId),
        ["snapshot-child-forward", "snapshot-root-forward"],
      );
      assert.isFalse(
        yield* retention.markDeletionStarted({
          snapshotId: "snapshot-root-0",
          now: expiredAt,
        }),
      );
      assert.isTrue(
        yield* retention.markDeletionStarted({
          snapshotId: "snapshot-root-forward",
          now: expiredAt,
        }),
      );
    }),
  );

  it.effect("protects rescue snapshots for in-flight and needs-recovery operations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const retention = yield* CheckpointRetentionRepository;

      yield* sql`
        INSERT INTO checkpoint_repositories (
          repository_key, common_dir_fingerprint, object_format,
          sidecar_relative_path, created_at, last_used_at
        ) VALUES ('repo-rescue-retention', 'fingerprint-rescue-retention', 'sha1',
          'repositories/repo-rescue-retention.git', ${createdAt}, ${createdAt})
      `;
      for (const snapshotId of ["snapshot-target", "rescue-in-flight", "rescue-recovery"]) {
        yield* sql`
          INSERT INTO checkpoint_snapshots (
            snapshot_id, repository_key, worktree_key, commit_oid, tree_oid,
            kind, state, created_at, ready_at, retention_class, delete_after
          ) VALUES (${snapshotId}, 'repo-rescue-retention', 'worktree-rescue-retention',
            ${`commit-${snapshotId}`}, ${`tree-${snapshotId}`},
            ${snapshotId === "snapshot-target" ? "turn" : "rescue"}, 'ready',
            ${createdAt}, ${createdAt},
            ${snapshotId === "snapshot-target" ? "standard" : "rescue"},
            ${snapshotId === "snapshot-target" ? null : expiredAt})
        `;
      }
      for (const [threadId, entryId] of [
        ["thread-rescue-in-flight", "entry-rescue-in-flight"],
        ["thread-rescue-recovery", "entry-rescue-recovery"],
      ] as const) {
        yield* sql`
          INSERT INTO thread_checkpoint_entries (
            entry_id, thread_id, timeline_generation, ordinal, turn_id,
            provider_turn_id, snapshot_id, provider_binding_json,
            provider_cursor_json, completed_at, state, created_at
          ) VALUES (${entryId}, ${threadId}, 0, 0, ${`turn-${threadId}`}, NULL,
            'snapshot-target', '{}', '{}', ${createdAt}, 'ready', ${createdAt})
        `;
      }
      yield* sql`
        INSERT INTO checkpoint_navigation_operations (
          operation_id, command_id, thread_id, kind, from_entry_id, to_entry_id,
          rescue_snapshot_id, old_provider_binding_json, target_provider_binding_json,
          prepared_provider_cursor_json, phase, recovery_from_phase, created_at, updated_at
        ) VALUES
          ('operation-in-flight', 'command-in-flight', 'thread-rescue-in-flight', 'undo',
            'entry-rescue-in-flight', 'entry-rescue-in-flight', 'rescue-in-flight',
            '{}', '{}', '{}', 'filesystem-restored', NULL, ${createdAt}, ${createdAt}),
          ('operation-recovery', 'command-recovery', 'thread-rescue-recovery', 'undo',
            'entry-rescue-recovery', 'entry-rescue-recovery', 'rescue-recovery',
            '{}', '{}', '{}', 'needs-recovery', 'compensating-filesystem',
            ${createdAt}, ${createdAt})
      `;

      yield* retention.applyPolicy({ now: expiredAt });
      assert.deepStrictEqual(
        (yield* retention.listDeletionCandidates({ now: expiredAt, limit: 20 }))
          .map((candidate) => candidate.snapshotId)
          .filter((snapshotId) => snapshotId.startsWith("rescue-")),
        [],
      );
      assert.isFalse(
        yield* retention.markDeletionStarted({ snapshotId: "rescue-in-flight", now: expiredAt }),
      );
      assert.isFalse(
        yield* retention.markDeletionStarted({ snapshotId: "rescue-recovery", now: expiredAt }),
      );

      yield* sql`
        UPDATE checkpoint_navigation_operations
        SET phase = 'committed', completed_at = ${expiredAt}, updated_at = ${expiredAt}
        WHERE operation_id = 'operation-in-flight'
      `;
      assert.deepStrictEqual(
        (yield* retention.listDeletionCandidates({ now: expiredAt, limit: 20 }))
          .map((candidate) => candidate.snapshotId)
          .filter((snapshotId) => snapshotId.startsWith("rescue-")),
        ["rescue-in-flight"],
      );
    }),
  );
});
