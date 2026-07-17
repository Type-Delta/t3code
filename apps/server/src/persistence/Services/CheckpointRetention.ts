import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const CheckpointDeletionCandidate = Schema.Struct({
  snapshotId: Schema.String,
  repositoryKey: Schema.String,
  worktreeKey: Schema.String,
  commitOid: Schema.NullOr(Schema.String),
  deleteAfter: Schema.String,
  deletionStartedAt: Schema.NullOr(Schema.String),
});
export type CheckpointDeletionCandidate = typeof CheckpointDeletionCandidate.Type;

export const CheckpointRepositoryDeletionCandidate = Schema.Struct({
  repositoryKey: Schema.String,
  sidecarRelativePath: Schema.String,
  deleteAfter: Schema.String,
});
export type CheckpointRepositoryDeletionCandidate =
  typeof CheckpointRepositoryDeletionCandidate.Type;

export interface CheckpointRetentionRepositoryShape {
  readonly applyPolicy: (input: {
    readonly now: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly scheduleSnapshotDeletion: (input: {
    readonly snapshotId: string;
    readonly retentionClass: string;
    readonly deleteAfter: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listDeletionCandidates: (input: {
    readonly now: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<CheckpointDeletionCandidate>, ProjectionRepositoryError>;
  readonly markDeletionStarted: (input: {
    readonly snapshotId: string;
    readonly now: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markDeleted: (input: {
    readonly snapshotId: string;
    readonly now: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markDeletionFailed: (input: {
    readonly snapshotId: string;
    readonly errorCode: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getSnapshotExecutionContext: (input: { readonly snapshotId: string }) => Effect.Effect<
    | {
        readonly cwd: string;
        readonly repositoryKey: string;
        readonly worktreeKey: string;
      }
    | undefined,
    ProjectionRepositoryError
  >;
  readonly listGcExecutionCandidates: (input: {
    readonly minimumDeletedSnapshots: number;
  }) => Effect.Effect<ReadonlyArray<{ readonly cwd: string }>, ProjectionRepositoryError>;
  /** Repositories are eligible only after all owned snapshots are marked deleted. */
  readonly listRepositoryDeletionCandidates: (input: {
    readonly now: string;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<CheckpointRepositoryDeletionCandidate>,
    ProjectionRepositoryError
  >;
  readonly scheduleRepositoryDeletion: (input: {
    readonly repositoryKey: string;
    readonly retentionClass: string;
    readonly deleteAfter: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markRepositoryDeletionStarted: (input: {
    readonly repositoryKey: string;
    readonly now: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markRepositoryDeleted: (input: {
    readonly repositoryKey: string;
    readonly now: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markRepositoryDeletionFailed: (input: {
    readonly repositoryKey: string;
    readonly errorCode: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class CheckpointRetentionRepository extends Context.Service<
  CheckpointRetentionRepository,
  CheckpointRetentionRepositoryShape
>()("t3/persistence/Services/CheckpointRetention/CheckpointRetentionRepository") {}
