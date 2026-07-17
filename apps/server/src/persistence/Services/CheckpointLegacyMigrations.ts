import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface ProjectedLegacyCheckpoint {
  readonly projectionTurnRowId: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly legacyRef: string;
  /** Resolved transiently; this value is never stored in the migration journal. */
  readonly cwd: string;
}

export interface PreparedLegacyCheckpoint extends ProjectedLegacyCheckpoint {
  readonly candidateId: string;
  readonly snapshotId: string;
  readonly repositoryKey: string;
  readonly worktreeKey: string;
}

export interface CheckpointLegacyMigrationRepositoryShape {
  readonly listProjected: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ProjectedLegacyCheckpoint>, ProjectionRepositoryError>;
  readonly prepare: (
    input: PreparedLegacyCheckpoint & {
      readonly commonDirFingerprint: string;
      readonly objectFormat: "sha1" | "sha256";
      readonly sidecarRelativePath: string;
      readonly now: string;
    },
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markVerified: (input: {
    readonly candidateId: string;
    readonly legacyRef: string;
    readonly sidecarRef: string;
    readonly commitOid: string;
    readonly treeOid: string;
    readonly verifiedAt: string;
    readonly cleanupAfter: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markFailure: (input: {
    readonly candidateId: string;
    readonly failureCode: string;
    readonly now: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getExecutionContext: (input: { readonly candidateId: string }) => Effect.Effect<
    | {
        readonly cwd: string;
        readonly legacyRef: string;
        readonly snapshotId: string;
        readonly repositoryKey: string;
        readonly worktreeKey: string;
      }
    | undefined,
    ProjectionRepositoryError
  >;
  readonly listKnownRefs: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<string>, ProjectionRepositoryError>;
  readonly listCleanupEligibleRefs: (input: {
    readonly cwd: string;
    readonly now: string;
  }) => Effect.Effect<ReadonlyArray<string>, ProjectionRepositoryError>;
  readonly markCleanupPending: (input: {
    readonly cwd: string;
    readonly legacyRef: string;
    readonly now: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markCleaned: (input: {
    readonly cwd: string;
    readonly legacyRef: string;
    readonly now: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class CheckpointLegacyMigrationRepository extends Context.Service<
  CheckpointLegacyMigrationRepository,
  CheckpointLegacyMigrationRepositoryShape
>()("t3/persistence/Services/CheckpointLegacyMigrations/CheckpointLegacyMigrationRepository") {}
