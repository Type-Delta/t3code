import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ServerSettingsError } from "@t3tools/contracts";

import type {
  AutoResumeJob,
  AutoResumeJobRepositoryShape,
  ScheduleAutoResumeJobInput,
} from "../../persistence/Services/AutoResumeJobs.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface AutoResumeReactorShape {
  /** Start the single durable auto-resume wake loop. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Persist a usage-limit schedule when the global setting permits it. */
  readonly schedule: (
    input: ScheduleAutoResumeJobInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError | ServerSettingsError>;
  /** Resolves after currently executing fire commands have completed. */
  readonly drain: Effect.Effect<void>;
}

export class AutoResumeReactor extends Context.Service<AutoResumeReactor, AutoResumeReactorShape>()(
  "t3/orchestration/Services/AutoResumeReactor",
) {}

// Kept here instead of in an adapter so every provider uses the same stable
// compare-and-fire identifiers for a given failed turn.
export const autoResumeScheduleId = (threadId: string, sourceTurnId: string): string =>
  `auto-resume:${threadId}:${sourceTurnId}`;

export const autoResumeMessageId = (threadId: string, sourceTurnId: string): string =>
  `auto-resume-message:${threadId}:${sourceTurnId}`;

export const autoResumeCommandId = (scheduleId: string): string =>
  `server:auto-resume-fire:${scheduleId}`;

export type AutoResumeRepository = AutoResumeJobRepositoryShape;
export type { AutoResumeJob };
