import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CheckpointDiagnostics, layer as diagnosticsLayer } from "./CheckpointDiagnostics.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-diagnostics-test-",
}).pipe(Layer.provide(NodeServices.layer));
const layer = it.layer(
  diagnosticsLayer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("CheckpointDiagnostics", (it) => {
  it.effect("reports aggregate state without checkpoint identifiers or content", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const diagnostics = yield* CheckpointDiagnostics;
      const now = "2026-07-16T00:00:00.000Z";
      yield* sql`
        INSERT INTO checkpoint_repositories (
          repository_key, common_dir_fingerprint, object_format,
          sidecar_relative_path, created_at, last_used_at
        ) VALUES (${"a".repeat(64)}, ${"b".repeat(64)}, 'sha1',
          'repositories/repo.git', ${now}, ${now})
      `;
      const objectDirectory = path.join(config.checkpointsDir, "repositories", "repo.git");
      yield* fs.makeDirectory(objectDirectory, { recursive: true });
      yield* fs.writeFileString(path.join(objectDirectory, "object"), "private-checkpoint-data");

      const summary = yield* diagnostics.summarize();
      assert.equal(summary.sidecarLocation, config.checkpointsDir);
      assert.equal(summary.repositoryCount, 1);
      assert.isAtLeast(summary.totalSizeBytes, "private-checkpoint-data".length);
      assert.deepEqual(summary.queue, { pending: 0, running: 0, oldestAgeMs: null });
      assert.deepEqual(summary.recoverableFailures, {
        capture: 0,
        navigation: 0,
        deletion: 0,
        migration: 0,
      });
      assert.notProperty(summary, "snapshotId");
    }),
  );
});
