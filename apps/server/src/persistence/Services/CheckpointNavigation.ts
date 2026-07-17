import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const CheckpointNavigationPhase = Schema.Literals([
  "prepared",
  "rescue-ready",
  "provider-prepared",
  "filesystem-restored",
  "provider-activated",
  "cursor-committed",
  "committed",
  "compensating-cursor",
  "compensating-filesystem",
  "compensating-provider",
  "compensated",
  "failed",
  "needs-recovery",
]);
export type CheckpointNavigationPhase = typeof CheckpointNavigationPhase.Type;

export const CheckpointNavigationMode = Schema.Literals(["full", "files-only"]);
export type CheckpointNavigationMode = typeof CheckpointNavigationMode.Type;

export const CheckpointNavigationOperation = Schema.Struct({
  operationId: Schema.String,
  commandId: Schema.String,
  threadId: Schema.String,
  kind: Schema.Literals(["undo", "redo", "jump"]),
  mode: CheckpointNavigationMode,
  fromEntryId: Schema.NullOr(Schema.String),
  toEntryId: Schema.String,
  rescueSnapshotId: Schema.NullOr(Schema.String),
  oldProviderBindingJson: Schema.String,
  targetProviderBindingJson: Schema.String,
  preparedProviderCursorJson: Schema.String,
  phase: CheckpointNavigationPhase,
  recoveryFromPhase: Schema.NullOr(CheckpointNavigationPhase),
  failureCode: Schema.NullOr(Schema.String),
  compensationFailureCode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type CheckpointNavigationOperation = typeof CheckpointNavigationOperation.Type;

export interface CheckpointNavigationRepositoryShape {
  readonly recordRescueSnapshot: (input: {
    readonly snapshotId: string;
    readonly repositoryKey: string;
    readonly worktreeKey: string;
    readonly objectFormat: "sha1" | "sha256";
    readonly commitOid: string;
    readonly treeOid: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Idempotently creates an operation by command id. */
  readonly begin: (
    operation: CheckpointNavigationOperation,
  ) => Effect.Effect<CheckpointNavigationOperation, ProjectionRepositoryError>;
  readonly getByCommandId: (input: {
    readonly commandId: string;
  }) => Effect.Effect<Option.Option<CheckpointNavigationOperation>, ProjectionRepositoryError>;
  readonly getUnresolvedByThread: (input: {
    readonly threadId: string;
  }) => Effect.Effect<Option.Option<CheckpointNavigationOperation>, ProjectionRepositoryError>;
  readonly listRecoverable: () => Effect.Effect<
    ReadonlyArray<CheckpointNavigationOperation>,
    ProjectionRepositoryError
  >;
  /** Persists one compare-and-set saga phase transition. */
  readonly advancePhase: (input: {
    readonly operationId: string;
    readonly expectedPhase: CheckpointNavigationPhase;
    readonly phase: CheckpointNavigationPhase;
    readonly rescueSnapshotId?: string | null;
    readonly targetProviderBindingJson?: string;
    readonly preparedProviderCursorJson?: string;
    readonly recoveryFromPhase?: CheckpointNavigationPhase | null;
    readonly failureCode?: string | null;
    readonly compensationFailureCode?: string | null;
    readonly updatedAt: string;
    readonly completedAt?: string | null;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class CheckpointNavigationRepository extends Context.Service<
  CheckpointNavigationRepository,
  CheckpointNavigationRepositoryShape
>()("t3/persistence/Services/CheckpointNavigation/CheckpointNavigationRepository") {}
