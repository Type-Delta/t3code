import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const CheckpointCaptureState = Schema.Literals([
  "pending",
  "running",
  "ready",
  "contended",
  "error",
]);
export type CheckpointCaptureState = typeof CheckpointCaptureState.Type;

export const CheckpointRepository = Schema.Struct({
  repositoryKey: Schema.String,
  commonDirFingerprint: Schema.String,
  objectFormat: Schema.Literals(["sha1", "sha256"]),
  sidecarRelativePath: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
});
export type CheckpointRepository = typeof CheckpointRepository.Type;

export const CheckpointSnapshot = Schema.Struct({
  snapshotId: Schema.String,
  repositoryKey: Schema.String,
  worktreeKey: Schema.String,
  commitOid: Schema.NullOr(Schema.String),
  treeOid: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["baseline", "turn", "rescue", "legacy-import"]),
  state: CheckpointCaptureState,
  createdAt: Schema.String,
  readyAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
});
export type CheckpointSnapshot = typeof CheckpointSnapshot.Type;

export const CheckpointCaptureJob = Schema.Struct({
  jobId: Schema.String,
  snapshotId: Schema.String,
  threadId: Schema.String,
  timelineGeneration: Schema.Number,
  turnId: Schema.String,
  providerTurnId: Schema.NullOr(Schema.String),
  providerBindingJson: Schema.NullOr(Schema.String),
  providerCursorJson: Schema.NullOr(Schema.String),
  turnOrdinal: Schema.Number,
  repositoryKey: Schema.String,
  worktreeKey: Schema.String,
  requestedBoundary: Schema.String,
  requestedGeneration: Schema.Number,
  state: CheckpointCaptureState,
  attemptCount: Schema.Number,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type CheckpointCaptureJob = typeof CheckpointCaptureJob.Type;

export interface EnqueueCheckpointCaptureInput {
  readonly snapshot: Pick<
    CheckpointSnapshot,
    "snapshotId" | "repositoryKey" | "worktreeKey" | "kind" | "createdAt" | "expiresAt"
  >;
  readonly job: Pick<
    CheckpointCaptureJob,
    | "jobId"
    | "snapshotId"
    | "threadId"
    | "timelineGeneration"
    | "turnId"
    | "providerTurnId"
    | "turnOrdinal"
    | "repositoryKey"
    | "worktreeKey"
    | "requestedBoundary"
    | "requestedGeneration"
    | "createdAt"
  > & {
    readonly providerBindingJson?: string | null;
    readonly providerCursorJson?: string | null;
  };
}

export interface ClaimCheckpointCaptureInput {
  readonly leaseOwner: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface CompleteCheckpointCaptureInput {
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly state: "ready" | "contended" | "error";
  readonly commitOid: string | null;
  readonly treeOid: string | null;
  readonly errorCode: string | null;
  readonly completedAt: string;
}

export interface CheckpointCaptureJobRepositoryShape {
  readonly upsertRepository: (
    repository: CheckpointRepository,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly enqueue: (
    input: EnqueueCheckpointCaptureInput,
  ) => Effect.Effect<CheckpointCaptureJob, ProjectionRepositoryError>;
  readonly claimNext: (
    input: ClaimCheckpointCaptureInput,
  ) => Effect.Effect<Option.Option<CheckpointCaptureJob>, ProjectionRepositoryError>;
  readonly renewLease: (input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly leaseExpiresAt: string;
    readonly now: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly complete: (
    input: CompleteCheckpointCaptureInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly reclaimExpired: (input: {
    readonly now: string;
  }) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly getById: (input: {
    readonly jobId: string;
  }) => Effect.Effect<Option.Option<CheckpointCaptureJob>, ProjectionRepositoryError>;
  readonly getSnapshot: (input: {
    readonly snapshotId: string;
  }) => Effect.Effect<Option.Option<CheckpointSnapshot>, ProjectionRepositoryError>;
  /** Ready durable captures that have not yet been projected into the timeline. */
  readonly listReadyWithoutTimelineEntry: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<CheckpointCaptureJob>, ProjectionRepositoryError>;
}

export class CheckpointCaptureJobRepository extends Context.Service<
  CheckpointCaptureJobRepository,
  CheckpointCaptureJobRepositoryShape
>()("t3/persistence/Services/CheckpointCaptureJobs/CheckpointCaptureJobRepository") {}
