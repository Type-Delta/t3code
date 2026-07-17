import { CheckpointRef, VcsProcessExitError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as CheckpointMigration from "./CheckpointMigration.ts";
import * as CheckpointRepositoryIdentity from "./CheckpointRepositoryIdentity.ts";
import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";

const identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity = {
  repositoryKey: "a".repeat(64),
  worktreeKey: "b".repeat(64),
  commonDir: "/repo/.git",
  worktreeRoot: "/repo",
  objectFormat: "sha1",
};

describe("CheckpointMigration", () => {
  it.effect("publishes only after verification and remains idempotent across retries", () =>
    Effect.gen(function* () {
      const legacyCheckpointRef = CheckpointRef.make("refs/t3/checkpoints/thread/turn/1");
      const candidate: CheckpointMigration.LegacyCheckpointMigrationCandidate = {
        candidateId: "candidate-1",
        cwd: "/repo",
        legacyCheckpointRef,
        snapshotId: "snapshot-1",
      };
      const completed: Array<CheckpointMigration.ImportedLegacyCheckpoint> = [];
      let importCalls = 0;
      const persistence: CheckpointMigration.CheckpointMigrationPersistence["Service"] = {
        listPending: () => Effect.succeed([candidate]),
        markImported: (result) => Effect.sync(() => completed.push(result)),
        recordFailure: () => Effect.void,
        listKnownLegacyRefs: () => Effect.succeed([legacyCheckpointRef]),
        listCleanupEligibleLegacyRefs: () => Effect.succeed([legacyCheckpointRef]),
      };
      const sidecars: SidecarCheckpointRepository.SidecarCheckpointRepository["Service"] = {
        allocate: ({ snapshotId }) =>
          Effect.succeed(SidecarCheckpointRepository.sidecarCheckpointRef(identity, snapshotId)),
        capture: () => Effect.void,
        captureWithMetadata: () => Effect.die("unused"),
        has: () => Effect.succeed(true),
        restore: () => Effect.succeed(true),
        diff: () => Effect.succeed(""),
        delete: () => Effect.void,
        gc: () => Effect.succeed(true),
        importLegacy: ({ sidecarCheckpointRef }) =>
          Effect.sync(() => ({
            checkpointRef: sidecarCheckpointRef,
            commitOid: "c".repeat(40),
            treeOid: "d".repeat(40),
            alreadyImported: importCalls++ > 0,
          })),
      };
      const layer = CheckpointMigration.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(CheckpointMigration.CheckpointMigrationPersistence, persistence),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver, {
            resolve: () => Effect.succeed(identity),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(SidecarCheckpointRepository.SidecarCheckpointRepository, sidecars),
        ),
      );

      const results = yield* Effect.gen(function* () {
        const migration = yield* CheckpointMigration.CheckpointMigration;
        return [yield* migration.runBatch(), yield* migration.runBatch()] as const;
      }).pipe(Effect.provide(layer));

      expect(results).toEqual([
        { attempted: 1, imported: 1, alreadyImported: 0, failed: 0 },
        { attempted: 1, imported: 0, alreadyImported: 1, failed: 0 },
      ]);
      expect(completed).toHaveLength(2);
      expect(completed[0]?.sidecarCheckpointRef).toBe(completed[1]?.sidecarCheckpointRef);
      expect(String(completed[0]?.sidecarCheckpointRef)).toMatch(
        /^t3-sidecar:v1:a{64}\.b{64}\.snapshot-1$/,
      );
    }),
  );

  it.effect("records unavailable known refs without updating locators", () =>
    Effect.gen(function* () {
      const failures: Array<string> = [];
      let completionCalls = 0;
      const persistence: CheckpointMigration.CheckpointMigrationPersistence["Service"] = {
        listPending: () =>
          Effect.succeed([
            {
              candidateId: "missing",
              cwd: "/repo",
              legacyCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/missing/turn/1"),
              snapshotId: "missing",
            },
          ]),
        markImported: () => Effect.sync(() => void (completionCalls += 1)),
        recordFailure: ({ reason }) => Effect.sync(() => failures.push(reason)),
        listKnownLegacyRefs: () => Effect.succeed([]),
        listCleanupEligibleLegacyRefs: () => Effect.succeed([]),
      };
      const sidecars: SidecarCheckpointRepository.SidecarCheckpointRepository["Service"] = {
        allocate: ({ snapshotId }) =>
          Effect.succeed(SidecarCheckpointRepository.sidecarCheckpointRef(identity, snapshotId)),
        capture: () => Effect.void,
        captureWithMetadata: () => Effect.die("unused"),
        has: () => Effect.succeed(false),
        restore: () => Effect.succeed(false),
        diff: () => Effect.succeed(""),
        delete: () => Effect.void,
        gc: () => Effect.succeed(false),
        importLegacy: ({ cwd }) =>
          Effect.fail(
            new VcsProcessExitError({
              operation: "SidecarCheckpointRepository.importLegacy",
              command: "git",
              cwd,
              exitCode: 1,
              detail: "Legacy checkpoint is unavailable.",
            }),
          ),
      };
      const layer = CheckpointMigration.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(CheckpointMigration.CheckpointMigrationPersistence, persistence),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver, {
            resolve: () => Effect.succeed(identity),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(SidecarCheckpointRepository.SidecarCheckpointRepository, sidecars),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const migration = yield* CheckpointMigration.CheckpointMigration;
        return yield* migration.runBatch();
      }).pipe(Effect.provide(layer));
      expect(result).toEqual({ attempted: 1, imported: 0, alreadyImported: 0, failed: 1 });
      expect(completionCalls).toBe(0);
      expect(failures).toEqual(["legacy-unavailable"]);
    }),
  );

  it.effect("reports unknown refs and only exact cleanup-eligible known refs", () =>
    Effect.gen(function* () {
      const known = CheckpointRef.make("refs/t3/checkpoints/known/turn/1");
      const unknown = CheckpointRef.make("refs/t3/checkpoints/unknown/turn/1");
      const absentEligible = CheckpointRef.make("refs/t3/checkpoints/absent/turn/1");
      const persistence: CheckpointMigration.CheckpointMigrationPersistence["Service"] = {
        listPending: () => Effect.succeed([]),
        markImported: () => Effect.void,
        recordFailure: () => Effect.void,
        listKnownLegacyRefs: () => Effect.succeed([known]),
        listCleanupEligibleLegacyRefs: () => Effect.succeed([known, absentEligible]),
      };
      const sidecars: SidecarCheckpointRepository.SidecarCheckpointRepository["Service"] = {
        allocate: () => Effect.die("unused"),
        capture: () => Effect.void,
        captureWithMetadata: () => Effect.die("unused"),
        has: () => Effect.succeed(false),
        restore: () => Effect.succeed(false),
        diff: () => Effect.succeed(""),
        delete: () => Effect.void,
        gc: () => Effect.succeed(false),
        importLegacy: () => Effect.die("unused"),
      };
      const layer = CheckpointMigration.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(CheckpointMigration.CheckpointMigrationPersistence, persistence),
        ),
        Layer.provideMerge(
          Layer.succeed(SidecarCheckpointRepository.SidecarCheckpointRepository, sidecars),
        ),
      );
      const report = yield* Effect.gen(function* () {
        const migration = yield* CheckpointMigration.CheckpointMigration;
        return yield* migration.inspectLegacyRefs({
          cwd: "/repo",
          discoveredRefs: [known, unknown],
        });
      }).pipe(Effect.provide(layer));
      expect(report).toEqual({
        knownRefs: [known],
        unknownRefs: [unknown],
        cleanupEligibleRefs: [known],
      });
    }),
  );
});
