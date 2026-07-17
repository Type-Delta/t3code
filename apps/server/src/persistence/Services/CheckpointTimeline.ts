import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ThreadCheckpointEntry = Schema.Struct({
  entryId: Schema.String,
  threadId: Schema.String,
  timelineGeneration: Schema.Number,
  ordinal: Schema.Number,
  turnId: Schema.String,
  providerTurnId: Schema.NullOr(Schema.String),
  snapshotId: Schema.String,
  providerBindingJson: Schema.String,
  providerCursorJson: Schema.String,
  assistantMessageId: Schema.NullOr(Schema.String),
  completedAt: Schema.String,
  state: Schema.Literals(["pending", "ready", "contended", "error"]),
  createdAt: Schema.String,
});
export type ThreadCheckpointEntry = typeof ThreadCheckpointEntry.Type;

export const ThreadCheckpointCursor = Schema.Struct({
  threadId: Schema.String,
  activeGeneration: Schema.Number,
  currentEntryId: Schema.NullOr(Schema.String),
  currentOrdinal: Schema.NullOr(Schema.Number),
  forwardTipEntryId: Schema.NullOr(Schema.String),
  forwardTipOrdinal: Schema.NullOr(Schema.Number),
  navigationVersion: Schema.Number,
  updatedAt: Schema.String,
});
export type ThreadCheckpointCursor = typeof ThreadCheckpointCursor.Type;

export const ThreadCheckpointGeneration = Schema.Struct({
  threadId: Schema.String,
  generation: Schema.Number,
  parentGeneration: Schema.NullOr(Schema.Number),
  forkedFromEntryId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["active", "abandoned"]),
  createdAt: Schema.String,
  abandonedAt: Schema.NullOr(Schema.String),
  deleteAfter: Schema.NullOr(Schema.String),
});
export type ThreadCheckpointGeneration = typeof ThreadCheckpointGeneration.Type;

export const ThreadProviderBinding = Schema.Struct({
  threadId: Schema.String,
  providerBindingJson: Schema.String,
  bindingVersion: Schema.Number,
  updatedAt: Schema.String,
});
export type ThreadProviderBinding = typeof ThreadProviderBinding.Type;

export interface CheckpointTimelineRepositoryShape {
  /** Inserts an entry once. Existing immutable entries are returned unchanged. */
  readonly appendEntry: (
    entry: ThreadCheckpointEntry,
  ) => Effect.Effect<ThreadCheckpointEntry, ProjectionRepositoryError>;
  readonly getEntry: (input: {
    readonly entryId: string;
  }) => Effect.Effect<Option.Option<ThreadCheckpointEntry>, ProjectionRepositoryError>;
  readonly listGeneration: (input: {
    readonly threadId: string;
    readonly generation: number;
  }) => Effect.Effect<ReadonlyArray<ThreadCheckpointEntry>, ProjectionRepositoryError>;
  /**
   * Lists the visible branch: the requested generation plus each ancestor,
   * bounded by the checkpoint where its child forked.
   */
  readonly listGenerationLineage: (input: {
    readonly threadId: string;
    readonly generation: number;
  }) => Effect.Effect<ReadonlyArray<ThreadCheckpointEntry>, ProjectionRepositoryError>;
  readonly createGeneration: (
    generation: ThreadCheckpointGeneration,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getGeneration: (input: {
    readonly threadId: string;
    readonly generation: number;
  }) => Effect.Effect<Option.Option<ThreadCheckpointGeneration>, ProjectionRepositoryError>;
  readonly initializeCursor: (
    cursor: ThreadCheckpointCursor,
  ) => Effect.Effect<ThreadCheckpointCursor, ProjectionRepositoryError>;
  readonly getCursor: (input: {
    readonly threadId: string;
  }) => Effect.Effect<Option.Option<ThreadCheckpointCursor>, ProjectionRepositoryError>;
  /** Optimistic cursor move. Returns false when the expected version is stale. */
  readonly moveCursor: (input: {
    readonly threadId: string;
    readonly expectedNavigationVersion: number;
    readonly activeGeneration: number;
    readonly currentEntryId: string | null;
    readonly currentOrdinal: number | null;
    readonly forwardTipEntryId: string | null;
    readonly forwardTipOrdinal: number | null;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Abandons redo and starts a new generation in one transaction. */
  readonly forkGeneration: (input: {
    readonly threadId: string;
    readonly expectedNavigationVersion: number;
    readonly newGeneration: number;
    readonly currentEntryId: string | null;
    readonly currentOrdinal: number | null;
    readonly createdAt: string;
    readonly deleteAfter: string | null;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly upsertProviderBinding: (
    binding: ThreadProviderBinding,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getProviderBinding: (input: {
    readonly threadId: string;
  }) => Effect.Effect<Option.Option<ThreadProviderBinding>, ProjectionRepositoryError>;
}

export class CheckpointTimelineRepository extends Context.Service<
  CheckpointTimelineRepository,
  CheckpointTimelineRepositoryShape
>()("t3/persistence/Services/CheckpointTimeline/CheckpointTimelineRepository") {}
