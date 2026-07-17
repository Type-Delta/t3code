import { CheckpointRef, VcsProcessExitError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as CheckpointMaintenance from "./CheckpointMaintenance.ts";
import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";

describe("CheckpointMaintenance", () => {
  it("encodes the conservative initial retention policy", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(CheckpointMaintenance.retentionDeadline("active", now)).toBeNull();
    expect(CheckpointMaintenance.retentionDeadline("redo", now)).toBeNull();
    expect(CheckpointMaintenance.retentionDeadline("abandoned", now)).toBe(
      now + 7 * 24 * 60 * 60 * 1_000,
    );
    expect(CheckpointMaintenance.retentionDeadline("rescue", now)).toBe(now + 24 * 60 * 60 * 1_000);
    expect(CheckpointMaintenance.retentionDeadline("deleted-thread", now)).toBe(
      now + 24 * 60 * 60 * 1_000,
    );
    expect(CheckpointMaintenance.retentionDeadline("failed-unpublished", now)).toBe(now);
  });

  it.effect("finalizes only deleted sidecar refs and uses sidecar-only GC", () =>
    Effect.gen(function* () {
      const goodRef = CheckpointRef.make(`t3-sidecar:v1:${"a".repeat(64)}.${"b".repeat(64)}.good`);
      const failedRef = CheckpointRef.make(
        `t3-sidecar:v1:${"a".repeat(64)}.${"b".repeat(64)}.failed`,
      );
      const finalized: Array<string> = [];
      const failures: Array<string> = [];
      const deletedRefs: Array<CheckpointRef> = [];
      const gcCwds: Array<string> = [];
      const persistence: CheckpointMaintenance.CheckpointMaintenancePersistence["Service"] = {
        claimExpired: () =>
          Effect.succeed([
            { deletionId: "delete-good", cwd: "/repo", checkpointRef: goodRef },
            { deletionId: "delete-failed", cwd: "/repo", checkpointRef: failedRef },
          ]),
        markDeleted: ({ deletionId }) => Effect.sync(() => finalized.push(deletionId)),
        recordDeletionFailure: ({ deletionId }) => Effect.sync(() => failures.push(deletionId)),
        listSidecarGcCandidates: () => Effect.succeed([{ cwd: "/repo" }]),
      };
      const sidecars: SidecarCheckpointRepository.SidecarCheckpointRepository["Service"] = {
        allocate: () => Effect.die("unused"),
        capture: () => Effect.void,
        captureWithMetadata: () => Effect.die("unused"),
        has: () => Effect.succeed(true),
        restore: () => Effect.succeed(true),
        diff: () => Effect.succeed(""),
        importLegacy: ({ sidecarCheckpointRef }) =>
          Effect.succeed({
            checkpointRef: sidecarCheckpointRef,
            commitOid: "c".repeat(40),
            treeOid: "d".repeat(40),
            alreadyImported: false,
          }),
        delete: ({ cwd, checkpointRefs }) =>
          checkpointRefs[0] === failedRef
            ? Effect.fail(
                new VcsProcessExitError({
                  operation: "SidecarCheckpointRepository.delete",
                  command: "git",
                  cwd,
                  exitCode: 1,
                  detail: "injected",
                }),
              )
            : Effect.sync(() => deletedRefs.push(...checkpointRefs)),
        gc: ({ cwd }) => Effect.sync(() => (gcCwds.push(cwd), true)),
      };
      const layer = CheckpointMaintenance.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(CheckpointMaintenance.CheckpointMaintenancePersistence, persistence),
        ),
        Layer.provideMerge(
          Layer.succeed(SidecarCheckpointRepository.SidecarCheckpointRepository, sidecars),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const maintenance = yield* CheckpointMaintenance.CheckpointMaintenance;
        return yield* maintenance.runOnce({ now: 123, limit: 10, collectGarbage: true });
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({ claimed: 2, deleted: 1, failed: 1, repositoriesCollected: 1 });
      expect(deletedRefs).toEqual([goodRef]);
      expect(finalized).toEqual(["delete-good"]);
      expect(failures).toEqual(["delete-failed"]);
      expect(gcCwds).toEqual(["/repo"]);
    }),
  );
});
