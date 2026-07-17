import { CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CheckpointLegacyMigrationRepository } from "../persistence/Services/CheckpointLegacyMigrations.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointMigration from "./CheckpointMigration.ts";
import { sanitizedGitEnvironment } from "./CheckpointRepositoryIdentity.ts";

export class CheckpointLegacyCleanupError extends Schema.TaggedErrorClass<CheckpointLegacyCleanupError>()(
  "CheckpointLegacyCleanupError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface CheckpointLegacyCleanupReport
  extends CheckpointMigration.LegacyCheckpointInspection {
  readonly deletedRefs: ReadonlyArray<CheckpointRef>;
  readonly confirmed: boolean;
}

export class CheckpointLegacyCleanup extends Context.Service<
  CheckpointLegacyCleanup,
  {
    readonly inspect: (input: {
      readonly cwd: string;
    }) => Effect.Effect<CheckpointLegacyCleanupReport, CheckpointLegacyCleanupError>;
    readonly cleanup: (input: {
      readonly cwd: string;
      /** Local ref deletion is impossible unless this is explicitly true. */
      readonly confirmed?: boolean;
    }) => Effect.Effect<CheckpointLegacyCleanupReport, CheckpointLegacyCleanupError>;
  }
>()("t3/checkpointing/CheckpointLegacyCleanup") {}

const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const migration = yield* CheckpointMigration.CheckpointMigration;
  const repository = yield* CheckpointLegacyMigrationRepository;

  const discover = (cwd: string) =>
    process
      .run({
        operation: "CheckpointLegacyCleanup.discover",
        command: "git",
        args: ["-C", cwd, "for-each-ref", "--format=%(refname)", "refs/t3/checkpoints"],
        cwd,
        spawnCwd: globalThis.process.cwd(),
        env: sanitizedGitEnvironment(),
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split(/\r?\n/u)
            .filter((value) => value.startsWith("refs/t3/checkpoints/"))
            .map((value) => CheckpointRef.make(value)),
        ),
      );

  const inspect: CheckpointLegacyCleanup["Service"]["inspect"] = (input) =>
    Effect.gen(function* () {
      const report = yield* migration.inspectLegacyRefs({
        cwd: input.cwd,
        discoveredRefs: yield* discover(input.cwd),
      });
      return { ...report, deletedRefs: [], confirmed: false };
    }).pipe(
      Effect.mapError((cause) => new CheckpointLegacyCleanupError({ operation: "inspect", cause })),
    );

  const cleanup: CheckpointLegacyCleanup["Service"]["cleanup"] = (input) =>
    Effect.gen(function* () {
      const discoveredRefs = yield* discover(input.cwd);
      const report = yield* migration.inspectLegacyRefs({ cwd: input.cwd, discoveredRefs });
      if (input.confirmed !== true) return { ...report, deletedRefs: [], confirmed: false };
      const deletedRefs: Array<CheckpointRef> = [];
      const now = DateTime.formatIso(yield* DateTime.now);
      const allEligible = yield* repository.listCleanupEligibleRefs({ cwd: input.cwd, now });
      const discovered = new Set(discoveredRefs.map(String));
      for (const eligibleRef of allEligible) {
        const legacyRef = CheckpointRef.make(eligibleRef);
        if (
          !(yield* repository.markCleanupPending({
            cwd: input.cwd,
            legacyRef: eligibleRef,
            now,
          }))
        ) {
          continue;
        }
        if (discovered.has(eligibleRef)) {
          yield* process.run({
            operation: "CheckpointLegacyCleanup.deleteRef",
            command: "git",
            args: ["-C", input.cwd, "update-ref", "--no-deref", "-d", eligibleRef],
            cwd: input.cwd,
            spawnCwd: globalThis.process.cwd(),
            env: sanitizedGitEnvironment(),
            timeoutMs: 10_000,
            maxOutputBytes: 8_192,
          });
          deletedRefs.push(legacyRef);
        }
        const marked = yield* repository.markCleaned({
          cwd: input.cwd,
          legacyRef: eligibleRef,
          now,
        });
        if (!marked) {
          yield* Effect.logWarning("Legacy checkpoint cleanup journal finalization failed.");
        }
      }
      return { ...report, deletedRefs, confirmed: true };
    }).pipe(
      Effect.mapError((cause) => new CheckpointLegacyCleanupError({ operation: "cleanup", cause })),
    );

  return CheckpointLegacyCleanup.of({ inspect, cleanup });
});

export const layer = Layer.effect(CheckpointLegacyCleanup, make);
