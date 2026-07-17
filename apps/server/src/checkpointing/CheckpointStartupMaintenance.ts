// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ServerConfig } from "../config.ts";
import * as CheckpointMaintenance from "./CheckpointMaintenance.ts";
import * as CheckpointMigration from "./CheckpointMigration.ts";

const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1_000;

export interface CheckpointStartupReport {
  readonly migrationCompleted: boolean;
  readonly maintenanceCompleted: boolean;
  readonly scavengedTemporaryDirectories: number;
}

class CheckpointStartupTaskError extends Schema.TaggedErrorClass<CheckpointStartupTaskError>()(
  "CheckpointStartupTaskError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class CheckpointStartupMaintenance extends Context.Service<
  CheckpointStartupMaintenance,
  {
    readonly runNow: () => Effect.Effect<CheckpointStartupReport>;
    /** Forks all recovery work; layer construction/server readiness does not await it. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/checkpointing/CheckpointStartupMaintenance") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const migration = yield* CheckpointMigration.CheckpointMigration;
  const maintenance = yield* CheckpointMaintenance.CheckpointMaintenance;

  const scavenge = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.tryPromise({
      try: async () => {
        const temporaryRoot = NodePath.resolve(config.checkpointsDir, "tmp");
        let entries;
        try {
          entries = await NodeFSP.readdir(temporaryRoot, { withFileTypes: true });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
          throw cause;
        }
        let removed = 0;
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidate = NodePath.resolve(temporaryRoot, entry.name);
          if (NodePath.dirname(candidate) !== temporaryRoot) continue;
          const info = await NodeFSP.stat(candidate);
          if (info.mtimeMs > now - STALE_TMP_AGE_MS) continue;
          await NodeFSP.rm(candidate, { recursive: true, force: true });
          removed += 1;
        }
        return removed;
      },
      catch: (cause) => new CheckpointStartupTaskError({ operation: "scavenge", cause }),
    });
  });

  const runNow: CheckpointStartupMaintenance["Service"]["runNow"] = () =>
    Effect.gen(function* () {
      const [migrationResult, maintenanceResult, scavengeResult] = yield* Effect.all(
        [
          Effect.result(migration.runBatch({ limit: 100 })),
          Effect.result(maintenance.runOnce({ limit: 100, collectGarbage: true })),
          Effect.result(scavenge),
        ],
        { concurrency: "unbounded" },
      );
      if (migrationResult._tag === "Failure") {
        yield* Effect.logWarning("Checkpoint legacy migration startup pass failed.");
      }
      if (maintenanceResult._tag === "Failure") {
        yield* Effect.logWarning("Checkpoint retention startup pass failed.");
      }
      if (scavengeResult._tag === "Failure") {
        yield* Effect.logWarning("Checkpoint temporary-directory scavenging failed.");
      }
      return {
        migrationCompleted: migrationResult._tag === "Success",
        maintenanceCompleted: maintenanceResult._tag === "Success",
        scavengedTemporaryDirectories:
          scavengeResult._tag === "Success" ? scavengeResult.success : 0,
      };
    });

  const start: CheckpointStartupMaintenance["Service"]["start"] = () =>
    runNow().pipe(Effect.forkScoped, Effect.asVoid);

  return CheckpointStartupMaintenance.of({ runNow, start });
});

export const layer = Layer.effect(CheckpointStartupMaintenance, make);

/** Explicit server seam: merge this layer to launch recovery without blocking readiness. */
export const backgroundLayer = Layer.effectDiscard(
  Effect.flatMap(CheckpointStartupMaintenance, (maintenance) => maintenance.start()),
);
