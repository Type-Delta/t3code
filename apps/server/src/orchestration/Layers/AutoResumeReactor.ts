import { CommandId, MessageId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AutoResumeJobRepository,
  type AutoResumeJob,
  type ScheduleAutoResumeJobInput,
} from "../../persistence/Services/AutoResumeJobs.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  AutoResumeReactor,
  autoResumeCommandId,
  type AutoResumeReactorShape,
} from "../Services/AutoResumeReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";

const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);

const AUTO_RESUME_GRACE_PERIOD_MS = 3_000;
const WAKE_LOOP_FAILURE_RETRY_DELAY_MS = 3_000;

function isAutoResumeEnabled(settings: unknown): boolean {
  if (settings === null || typeof settings !== "object") {
    return true;
  }
  const value = (settings as { readonly autoResumeOnUsageLimit?: unknown }).autoResumeOnUsageLimit;
  // The field was added after the first persisted settings shape. Missing is
  // the global-on default so old settings files opt in automatically.
  return value !== false;
}

function retryAtMillis(job: { readonly retryAt: string }): number {
  const millis = Date.parse(job.retryAt);
  return Number.isFinite(millis) ? millis : 0;
}

function firstAttemptAtMillis(job: { readonly retryAt: string }): number {
  return retryAtMillis(job) + AUTO_RESUME_GRACE_PERIOD_MS;
}

const make = Effect.gen(function* () {
  const repository = yield* AutoResumeJobRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;
  const started = yield* Ref.make(false);
  const activeFires = yield* SubscriptionRef.make(0);

  const withActiveFire = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      SubscriptionRef.update(activeFires, (count) => count + 1),
      () => effect,
      () => SubscriptionRef.update(activeFires, (count) => Math.max(0, count - 1)),
    );

  const schedule: AutoResumeReactorShape["schedule"] = (input: ScheduleAutoResumeJobInput) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (!isAutoResumeEnabled(settings)) {
        return false;
      }
      yield* repository.upsert(input);
      return true;
    });

  const removeStaleSchedule = (job: { readonly threadId: string; readonly scheduleId: string }) =>
    repository.deleteIfCurrent({
      threadId: ThreadId.make(job.threadId),
      scheduleId: job.scheduleId,
    });

  const deleteAllSchedules = repository.deleteAll.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to delete disabled auto-resume schedules", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const processJob = Effect.fn("AutoResumeReactor.processJob")(function* (job: AutoResumeJob) {
    const settings = yield* serverSettings.getSettings;
    if (!isAutoResumeEnabled(settings)) {
      yield* removeStaleSchedule(job);
      return;
    }

    const alreadySent = yield* repository.hasSentMessage({
      threadId: ThreadId.make(job.threadId),
      messageId: MessageId.make(job.messageId),
    });
    if (alreadySent) {
      yield* removeStaleSchedule(job);
      return;
    }

    const invalidated = yield* repository.hasInvalidatingEventAfter({
      threadId: ThreadId.make(job.threadId),
      scheduledSequence: job.scheduledSequence,
    });
    if (invalidated) {
      yield* removeStaleSchedule(job);
      return;
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const command = {
      type: "thread.auto-resume.fire" as const,
      commandId: CommandId.make(autoResumeCommandId(job.scheduleId)),
      threadId: ThreadId.make(job.threadId),
      scheduleId: job.scheduleId,
      scheduledSequence: job.scheduledSequence,
      sourceTurnId: TurnId.make(job.sourceTurnId),
      expectedUserMessageId: MessageId.make(job.expectedUserMessageId),
      providerInstanceId: ProviderInstanceId.make(job.providerInstanceId),
      messageId: MessageId.make(job.messageId),
      createdAt: now,
    };

    const result = yield* Effect.exit(orchestrationEngine.dispatch(command));
    if (Exit.isSuccess(result)) {
      yield* removeStaleSchedule(job);
      return;
    }

    const error = Cause.squash(result.cause);
    if (
      isOrchestrationCommandInvariantError(error) ||
      isOrchestrationCommandPreviouslyRejectedError(error) ||
      isOrchestrationCommandIdConflictError(error)
    ) {
      // A stale schedule is terminal. Keeping it would make the one wake loop
      // spin forever because its retryAt is already in the past.
      yield* removeStaleSchedule(job);
      yield* Effect.logDebug("Auto-resume schedule was no longer applicable", {
        threadId: job.threadId,
        scheduleId: job.scheduleId,
        cause: error,
      });
      return;
    }

    yield* Effect.logWarning("Auto-resume fire dispatch failed; schedule retained", {
      threadId: job.threadId,
      scheduleId: job.scheduleId,
      cause: Cause.pretty(result.cause),
    });
    const failedAt = DateTime.formatIso(yield* DateTime.now);
    yield* repository.deferRetryIfCurrent({
      threadId: ThreadId.make(job.threadId),
      scheduleId: job.scheduleId,
      retryAt: failedAt,
      updatedAt: failedAt,
    });
  });

  const runWakeLoop = Effect.forever(
    Effect.gen(function* () {
      const jobs = yield* repository.list();
      const nowMillis = yield* Clock.currentTimeMillis;
      const dueJob = jobs.find((job) => firstAttemptAtMillis(job) <= nowMillis);
      if (dueJob !== undefined) {
        yield* withActiveFire(processJob(dueJob));
        return;
      }

      const nextJob = jobs[0];
      if (nextJob === undefined) {
        yield* repository.awaitWake;
        return;
      }

      const delayMillis = Math.max(0, firstAttemptAtMillis(nextJob) - nowMillis);
      yield* Effect.raceFirst(repository.awaitWake, Effect.sleep(delayMillis));
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Auto-resume wake loop iteration failed", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(Effect.sleep(WAKE_LOOP_FAILURE_RETRY_DELAY_MS))),
      ),
    ),
  );

  const start: AutoResumeReactorShape["start"] = Effect.fn("AutoResumeReactor.start")(function* () {
    const shouldStart = yield* Ref.modify(started, (alreadyStarted) => [!alreadyStarted, true]);
    if (shouldStart) {
      // Subscribe before reading the snapshot so a concurrent setting update
      // cannot land between startup cleanup and the change watcher.
      const settingsChanges = yield* serverSettings.subscribeChanges;
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to read auto-resume setting during startup", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ autoResumeOnUsageLimit: false })),
        ),
      );
      if (!isAutoResumeEnabled(settings)) {
        yield* deleteAllSchedules;
      }
      yield* forkParked(
        settingsChanges.pipe(
          Stream.runForEach((settings) =>
            isAutoResumeEnabled(settings) ? Effect.void : deleteAllSchedules,
          ),
        ),
      );
      // The first list() is the startup recovery pass: jobs persisted by a
      // previous process are handled before the loop waits for a new wake.
      yield* forkParked(runWakeLoop);
    }
  });

  const drain: AutoResumeReactorShape["drain"] = Effect.gen(function* () {
    const active = yield* SubscriptionRef.get(activeFires);
    if (active === 0) return;
    yield* SubscriptionRef.changes(activeFires).pipe(
      Stream.filter((count) => count === 0),
      Stream.runHead,
    );
  });

  return AutoResumeReactor.of({ start, schedule, drain });
});

export const AutoResumeReactorLive = Layer.effect(AutoResumeReactor, make);
