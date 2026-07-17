import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointLegacyMigrationRepositoryLive } from "../persistence/Layers/CheckpointLegacyMigrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CheckpointMigration from "./CheckpointMigration.ts";
import { CheckpointMigrationPersistenceLive } from "./CheckpointMigrationLive.ts";
import * as CheckpointRepositoryIdentity from "./CheckpointRepositoryIdentity.ts";
import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";

const identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity = {
  repositoryKey: "a".repeat(64),
  worktreeKey: "b".repeat(64),
  commonDir: "/repo/.git",
  worktreeRoot: "/repo",
  objectFormat: "sha1",
};
let diffCalls = 0;
const sidecars: SidecarCheckpointRepository.SidecarCheckpointRepository["Service"] = {
  allocate: () => Effect.die("unused"),
  capture: () => Effect.die("unused"),
  captureWithMetadata: () => Effect.die("unused"),
  has: () => Effect.die("unused"),
  restore: () => Effect.die("unused"),
  diff: () => Effect.sync(() => ((diffCalls += 1), "")),
  delete: () => Effect.die("unused"),
  gc: () => Effect.die("unused"),
  importLegacy: () => Effect.die("unused"),
};

const persistence = CheckpointLegacyMigrationRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const layer = it.layer(
  CheckpointMigrationPersistenceLive.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(
      Layer.succeed(CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver, {
        resolve: () => Effect.succeed(identity),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(SidecarCheckpointRepository.SidecarCheckpointRepository, sidecars),
    ),
  ),
);

layer("CheckpointMigrationPersistenceLive", (it) => {
  it.effect("resolves paths transiently and verifies an empty diff before atomic publication", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const adapter = yield* CheckpointMigration.CheckpointMigrationPersistence;
      const now = "2026-07-16T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-live', 'Live', '/repo', '[]', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES ('thread-live', 'project-live', 'Live',
          '{"provider":"codex","model":"model"}', ${now}, ${now})
      `;
      const legacyRef = "refs/t3/checkpoints/thread-live/turn/1";
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_ref, checkpoint_files_json
        ) VALUES ('thread-live', 'turn-live', 'completed', ${now}, ${legacyRef}, '[]')
      `;
      const [candidate] = yield* adapter.listPending({ limit: 10 });
      assert.isDefined(candidate);
      const sidecarRef = SidecarCheckpointRepository.sidecarCheckpointRef(
        identity,
        candidate!.snapshotId,
      );
      yield* adapter.markImported({
        candidateId: candidate!.candidateId,
        legacyCheckpointRef: candidate!.legacyCheckpointRef,
        sidecarCheckpointRef: sidecarRef,
        commitOid: "c".repeat(40),
        treeOid: "d".repeat(40),
      });
      const rows = yield* sql<{ readonly checkpointRef: string }>`
        SELECT checkpoint_ref AS "checkpointRef" FROM projection_turns
        WHERE turn_id = 'turn-live'
      `;
      assert.equal(rows[0]?.checkpointRef, String(sidecarRef));
      assert.equal(diffCalls, 1);
    }),
  );
});
