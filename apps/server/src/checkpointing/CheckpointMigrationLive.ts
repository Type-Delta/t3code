// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { CheckpointRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CheckpointLegacyMigrationRepository } from "../persistence/Services/CheckpointLegacyMigrations.ts";
import * as CheckpointMigration from "./CheckpointMigration.ts";
import * as CheckpointRepositoryIdentity from "./CheckpointRepositoryIdentity.ts";
import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";

const LEGACY_CLEANUP_SAFETY_MS = 7 * 24 * 60 * 60 * 1_000;

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const persistenceError = (operation: string, cause: unknown) =>
  new CheckpointMigration.CheckpointMigrationPersistenceError({ operation, cause });

/**
 * Durable SQLite adapter for the legacy importer. Workspace paths are joined
 * from the live projection only and never copied into the migration journal.
 */
const make = Effect.gen(function* () {
  const repository = yield* CheckpointLegacyMigrationRepository;
  const identities = yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
  const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;

  const listPending: CheckpointMigration.CheckpointMigrationPersistence["Service"]["listPending"] =
    (input) =>
      Effect.gen(function* () {
        const rows = yield* repository.listProjected(input);
        const now = yield* nowIso;
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const identity = yield* identities.resolve(row.cwd);
            const digest = sha256(
              `t3-legacy-migration:v1\0${row.projectionTurnRowId}\0${row.threadId}\0${row.turnId}\0${row.legacyRef}`,
            );
            const candidateId = `legacy-${digest}`;
            const snapshotId = `legacy-${digest.slice(0, 48)}`;
            yield* repository.prepare({
              ...row,
              candidateId,
              snapshotId,
              repositoryKey: identity.repositoryKey,
              worktreeKey: identity.worktreeKey,
              commonDirFingerprint: sha256(identity.commonDir),
              objectFormat: identity.objectFormat,
              sidecarRelativePath: `repositories/${identity.repositoryKey}.git`,
              now,
            });
            return {
              candidateId,
              cwd: row.cwd,
              legacyCheckpointRef: CheckpointRef.make(row.legacyRef),
              snapshotId,
            };
          }),
        );
      }).pipe(Effect.mapError((cause) => persistenceError("listPending", cause)));

  const markImported: CheckpointMigration.CheckpointMigrationPersistence["Service"]["markImported"] =
    (input) =>
      Effect.gen(function* () {
        const execution = yield* repository.getExecutionContext({ candidateId: input.candidateId });
        if (
          !execution ||
          execution.legacyRef !== String(input.legacyCheckpointRef) ||
          execution.snapshotId !==
            SidecarCheckpointRepository.sidecarSnapshotId(input.sidecarCheckpointRef)
        ) {
          return yield* persistenceError(
            "markImported",
            "Legacy migration candidate changed before publish.",
          );
        }

        // Tree equality is established by importLegacy. An explicit empty
        // binary diff additionally pins equivalence before the locator swap.
        const diff = yield* sidecars.diff({
          cwd: execution.cwd,
          fromCheckpointRef: input.legacyCheckpointRef,
          toCheckpointRef: input.sidecarCheckpointRef,
          ignoreWhitespace: false,
        });
        if (diff.length !== 0) {
          return yield* persistenceError(
            "markImported",
            "Legacy and sidecar checkpoint diffs differ.",
          );
        }
        const verifiedAtValue = yield* DateTime.now;
        const verifiedAt = DateTime.formatIso(verifiedAtValue);
        const marked = yield* repository.markVerified({
          candidateId: input.candidateId,
          legacyRef: String(input.legacyCheckpointRef),
          sidecarRef: String(input.sidecarCheckpointRef),
          commitOid: input.commitOid,
          treeOid: input.treeOid,
          verifiedAt,
          cleanupAfter: DateTime.formatIso(
            DateTime.add(verifiedAtValue, { milliseconds: LEGACY_CLEANUP_SAFETY_MS }),
          ),
        });
        if (!marked) {
          return yield* persistenceError(
            "markImported",
            "Legacy projection locator changed before publish.",
          );
        }
      }).pipe(Effect.mapError((cause) => persistenceError("markImported", cause)));

  const recordFailure: CheckpointMigration.CheckpointMigrationPersistence["Service"]["recordFailure"] =
    (input) =>
      nowIso.pipe(
        Effect.flatMap((now) =>
          repository.markFailure({
            candidateId: input.candidateId,
            failureCode: input.reason,
            now,
          }),
        ),
        Effect.mapError((cause) => persistenceError("recordFailure", cause)),
      );

  const listKnownLegacyRefs: CheckpointMigration.CheckpointMigrationPersistence["Service"]["listKnownLegacyRefs"] =
    (input) =>
      repository.listKnownRefs(input).pipe(
        Effect.map((refs) => refs.map((ref) => CheckpointRef.make(ref))),
        Effect.mapError((cause) => persistenceError("listKnownLegacyRefs", cause)),
      );

  const listCleanupEligibleLegacyRefs: CheckpointMigration.CheckpointMigrationPersistence["Service"]["listCleanupEligibleLegacyRefs"] =
    (input) =>
      Effect.gen(function* () {
        const refs = yield* repository.listCleanupEligibleRefs({
          ...input,
          now: yield* nowIso,
        });
        return refs.map((ref) => CheckpointRef.make(ref));
      }).pipe(Effect.mapError((cause) => persistenceError("listCleanupEligibleLegacyRefs", cause)));

  return CheckpointMigration.CheckpointMigrationPersistence.of({
    listPending,
    markImported,
    recordFailure,
    listKnownLegacyRefs,
    listCleanupEligibleLegacyRefs,
  });
});

export const CheckpointMigrationPersistenceLive = Layer.effect(
  CheckpointMigration.CheckpointMigrationPersistence,
  make,
);

/** Production importer composition; server startup can provide this as a seam. */
export const CheckpointMigrationLive = CheckpointMigration.layer.pipe(
  Layer.provideMerge(CheckpointMigrationPersistenceLive),
);
