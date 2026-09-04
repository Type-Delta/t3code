import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const AutoResumeReason = Schema.Literal("usage_limit");
export type AutoResumeReason = typeof AutoResumeReason.Type;

export const AutoResumeJob = Schema.Struct({
  scheduleId: TrimmedNonEmptyString,
  threadId: ThreadId,
  scheduledSequence: NonNegativeInt,
  sourceTurnId: TurnId,
  expectedUserMessageId: MessageId,
  providerInstanceId: ProviderInstanceId,
  messageId: MessageId,
  reason: AutoResumeReason,
  retryAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AutoResumeJob = typeof AutoResumeJob.Type;

export type ScheduleAutoResumeJobInput = Omit<AutoResumeJob, "updatedAt"> & {
  readonly updatedAt?: IsoDateTime;
};

export interface AutoResumeJobRepositoryShape {
  /** Insert or replace the pending schedule for a thread. */
  readonly upsert: (
    input: ScheduleAutoResumeJobInput,
  ) => Effect.Effect<AutoResumeJob, ProjectionRepositoryError>;
  /** Returns all schedules in deterministic wake order. */
  readonly list: () => Effect.Effect<ReadonlyArray<AutoResumeJob>, ProjectionRepositoryError>;
  readonly getByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<Option.Option<AutoResumeJob>, ProjectionRepositoryError>;
  readonly deleteIfCurrent: (input: {
    readonly threadId: ThreadId;
    readonly scheduleId: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Move the current schedule's base time after a transient dispatch failure. */
  readonly deferRetryIfCurrent: (input: {
    readonly threadId: ThreadId;
    readonly scheduleId: string;
    readonly retryAt: IsoDateTime;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Delete every pending schedule, used when global auto-resume is disabled. */
  readonly deleteAll: Effect.Effect<number, ProjectionRepositoryError>;
  /** Whether the deterministic auto-resume user message already exists. */
  readonly hasSentMessage: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Whether durable thread activity after scheduling permanently canceled the job. */
  readonly hasInvalidatingEventAfter: (input: {
    readonly threadId: ThreadId;
    readonly scheduledSequence: number;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Wait for a durable insert/update from another fiber. */
  readonly awaitWake: Effect.Effect<void>;
}

export class AutoResumeJobRepository extends Context.Service<
  AutoResumeJobRepository,
  AutoResumeJobRepositoryShape
>()("t3/persistence/Services/AutoResumeJobs/AutoResumeJobRepository") {}
