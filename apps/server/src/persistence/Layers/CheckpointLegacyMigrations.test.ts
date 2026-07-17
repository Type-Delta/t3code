import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointLegacyMigrationRepositoryLive } from "./CheckpointLegacyMigrations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { CheckpointLegacyMigrationRepository } from "../Services/CheckpointLegacyMigrations.ts";

const layer = it.layer(
  CheckpointLegacyMigrationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const now = "2026-07-16T00:00:00.000Z";
const cleanupAfter = "2026-07-23T00:00:00.000Z";
const legacyRef = "refs/t3/checkpoints/thread-legacy/turn/1";

layer("CheckpointLegacyMigrationRepository", (it) => {
  it.effect("journals only projected refs and atomically swaps a verified locator", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* CheckpointLegacyMigrationRepository;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-legacy', 'Legacy', '/workspace', '[]', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES ('thread-legacy', 'project-legacy', 'Legacy',
          '{"provider":"codex","model":"model"}', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_ref, checkpoint_files_json
        ) VALUES ('thread-legacy', 'turn-legacy', 'completed', ${now}, ${legacyRef}, '[]')
      `;

      const projected = yield* repository.listProjected({ limit: 10 });
      assert.equal(projected.length, 1);
      assert.equal(projected[0]?.cwd, "/workspace");
      const row = projected[0]!;
      yield* repository.prepare({
        ...row,
        candidateId: "candidate-legacy",
        snapshotId: "snapshot-legacy",
        repositoryKey: "a".repeat(64),
        worktreeKey: "b".repeat(64),
        commonDirFingerprint: "c".repeat(64),
        objectFormat: "sha1",
        sidecarRelativePath: `repositories/${"a".repeat(64)}.git`,
        now,
      });
      const sidecarRef = `t3-sidecar:v1:${"a".repeat(64)}.${"b".repeat(64)}.snapshot-legacy`;
      assert.isTrue(
        yield* repository.markVerified({
          candidateId: "candidate-legacy",
          legacyRef,
          sidecarRef,
          commitOid: "d".repeat(40),
          treeOid: "e".repeat(40),
          verifiedAt: now,
          cleanupAfter,
        }),
      );
      const projection = yield* sql<{ readonly checkpointRef: string }>`
        SELECT checkpoint_ref AS "checkpointRef" FROM projection_turns
        WHERE turn_id = 'turn-legacy'
      `;
      const snapshot = yield* sql<{
        readonly state: string;
        readonly treeOid: string;
      }>`
        SELECT state, tree_oid AS "treeOid" FROM checkpoint_snapshots
        WHERE snapshot_id = 'snapshot-legacy'
      `;
      assert.equal(projection[0]?.checkpointRef, sidecarRef);
      assert.deepEqual(snapshot[0], { state: "ready", treeOid: "e".repeat(40) });
      assert.deepEqual(yield* repository.listKnownRefs({ cwd: "/workspace" }), [legacyRef]);
      assert.deepEqual(
        yield* repository.listCleanupEligibleRefs({
          cwd: "/workspace",
          now: "2026-07-22T23:59:59.999Z",
        }),
        [],
      );
      assert.deepEqual(
        yield* repository.listCleanupEligibleRefs({ cwd: "/workspace", now: cleanupAfter }),
        [legacyRef],
      );
      assert.isTrue(
        yield* repository.markCleanupPending({
          cwd: "/workspace",
          legacyRef,
          now: cleanupAfter,
        }),
      );
      assert.isTrue(
        yield* repository.markCleaned({ cwd: "/workspace", legacyRef, now: cleanupAfter }),
      );
      assert.deepEqual(
        yield* repository.listCleanupEligibleRefs({
          cwd: "/workspace",
          now: "2026-07-24T00:00:00.000Z",
        }),
        [],
      );
    }),
  );

  it.effect("refuses locator publication after the projection changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* CheckpointLegacyMigrationRepository;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-race', 'Race', '/race', '[]', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES ('thread-race', 'project-race', 'Race',
          '{"provider":"codex","model":"model"}', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_ref, checkpoint_files_json
        ) VALUES ('thread-race', 'turn-race', 'completed', ${now},
          'refs/t3/checkpoints/race/turn/1', '[]')
      `;
      const row = (yield* repository.listProjected({ limit: 10 }))[0]!;
      yield* repository.prepare({
        ...row,
        candidateId: "candidate-race",
        snapshotId: "snapshot-race",
        repositoryKey: "1".repeat(64),
        worktreeKey: "2".repeat(64),
        commonDirFingerprint: "3".repeat(64),
        objectFormat: "sha1",
        sidecarRelativePath: `repositories/${"1".repeat(64)}.git`,
        now,
      });
      yield* sql`UPDATE projection_turns SET checkpoint_ref = 'external-change' WHERE turn_id = 'turn-race'`;
      assert.isFalse(
        yield* repository.markVerified({
          candidateId: "candidate-race",
          legacyRef: row.legacyRef,
          sidecarRef: "sidecar",
          commitOid: "4".repeat(40),
          treeOid: "5".repeat(40),
          verifiedAt: now,
          cleanupAfter,
        }),
      );
    }),
  );
});
