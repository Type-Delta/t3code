import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type ServerSettings,
  ThreadId,
  MessageId,
  ProviderInstanceId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { AutoResumeReactorLive } from "./AutoResumeReactor.ts";
import { AutoResumeReactor } from "../Services/AutoResumeReactor.ts";
import {
  AutoResumeJobRepository,
  type AutoResumeJob,
  type AutoResumeJobRepositoryShape,
} from "../../persistence/Services/AutoResumeJobs.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const THREAD_ID = ThreadId.make("thread-auto-resume-reactor");
const JOB: AutoResumeJob = {
  scheduleId: "schedule-auto-resume-reactor",
  threadId: THREAD_ID,
  scheduledSequence: 10,
  sourceTurnId: TurnId.make("turn-auto-resume-reactor"),
  expectedUserMessageId: MessageId.make("user-auto-resume-reactor"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  messageId: MessageId.make("message-auto-resume-reactor"),
  reason: "usage_limit",
  retryAt: "1969-12-31T23:59:57.000Z",
  createdAt: "1969-12-31T23:00:00.000Z",
  updatedAt: "1969-12-31T23:00:00.000Z",
};

interface Scenario {
  readonly layer: Layer.Layer<AutoResumeReactor, never, never>;
  readonly jobs: Ref.Ref<ReadonlyArray<AutoResumeJob>>;
  readonly enabled: Ref.Ref<boolean>;
  readonly invalidated: Ref.Ref<boolean>;
  readonly sent: Ref.Ref<boolean>;
  readonly settingsChanges: PubSub.PubSub<ServerSettings>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly dispatchStarted: Deferred.Deferred<void>;
  readonly retryDeferred: Deferred.Deferred<void>;
  readonly deleted: Deferred.Deferred<void>;
}

type DispatchMode = "success" | "stale" | "transient";

const makeScenario = (mode: DispatchMode, job: AutoResumeJob = JOB): Effect.Effect<Scenario> =>
  Effect.gen(function* () {
    const jobs = yield* Ref.make<ReadonlyArray<AutoResumeJob>>([job]);
    const enabled = yield* Ref.make(true);
    const invalidated = yield* Ref.make(false);
    const sent = yield* Ref.make(false);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const dispatchStarted = yield* Deferred.make<void>();
    const retryDeferred = yield* Deferred.make<void>();
    const deleted = yield* Deferred.make<void>();
    const setEnabled = (autoResumeOnUsageLimit: boolean) =>
      Effect.gen(function* () {
        yield* Ref.set(enabled, autoResumeOnUsageLimit);
        yield* PubSub.publish(settingsChanges, {
          ...DEFAULT_SERVER_SETTINGS,
          autoResumeOnUsageLimit,
        });
      });

    const repository: AutoResumeJobRepositoryShape = {
      upsert: (input) => {
        const job: AutoResumeJob = {
          ...input,
          updatedAt: input.updatedAt ?? input.createdAt,
        };
        return Ref.update(jobs, (current) => [
          ...current.filter((entry) => entry.threadId !== job.threadId),
          job,
        ]).pipe(Effect.as(job));
      },
      list: () => Ref.get(jobs),
      getByThreadId: ({ threadId }) =>
        Ref.get(jobs).pipe(
          Effect.map((current) =>
            Option.fromNullishOr(current.find((entry) => entry.threadId === threadId)),
          ),
        ),
      deleteIfCurrent: ({ threadId, scheduleId }) =>
        Ref.modify(jobs, (current) => {
          const deletedCurrent = current.some(
            (entry) => entry.threadId === threadId && entry.scheduleId === scheduleId,
          );
          return [
            deletedCurrent,
            deletedCurrent
              ? current.filter(
                  (entry) => !(entry.threadId === threadId && entry.scheduleId === scheduleId),
                )
              : current,
          ];
        }).pipe(
          Effect.tap((wasDeleted) =>
            wasDeleted ? Deferred.succeed(deleted, undefined) : Effect.void,
          ),
        ),
      deferRetryIfCurrent: ({ threadId, scheduleId, retryAt, updatedAt }) =>
        Ref.modify(jobs, (current) => {
          const found = current.find(
            (entry) => entry.threadId === threadId && entry.scheduleId === scheduleId,
          );
          return [
            found !== undefined,
            found === undefined
              ? current
              : current.map((entry) =>
                  entry === found ? { ...entry, retryAt, updatedAt } : entry,
                ),
          ];
        }).pipe(
          Effect.tap((updated) =>
            updated ? Deferred.succeed(retryDeferred, undefined) : Effect.void,
          ),
        ),
      deleteAll: Ref.modify(jobs, (current) => [current.length, []]).pipe(
        Effect.tap((deletedCount) =>
          deletedCount > 0 ? Deferred.succeed(deleted, undefined) : Effect.void,
        ),
      ),
      hasSentMessage: () => Ref.get(sent),
      hasInvalidatingEventAfter: () => Ref.get(invalidated),
      awaitWake: Effect.never,
    };

    const settings: ServerSettingsService["Service"] = {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(enabled).pipe(
        Effect.map(
          (autoResumeOnUsageLimit): ServerSettings => ({
            ...DEFAULT_SERVER_SETTINGS,
            autoResumeOnUsageLimit,
          }),
        ),
      ),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          if (patch.autoResumeOnUsageLimit !== undefined) {
            yield* setEnabled(patch.autoResumeOnUsageLimit);
          }
          const next: ServerSettings = {
            ...DEFAULT_SERVER_SETTINGS,
            autoResumeOnUsageLimit: yield* Ref.get(enabled),
          };
          yield* PubSub.publish(settingsChanges, next);
          return next;
        }),
      streamChanges: Stream.empty,
      subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    };

    const engine: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(dispatched, (current) => [...current, command]);
          yield* Deferred.succeed(dispatchStarted, undefined);
          if (mode === "stale") {
            return yield* Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "stale in reactor test",
              }),
            );
          }
          if (mode === "transient") {
            return yield* Effect.die("temporary dispatch failure");
          }
          return { sequence: 1 };
        }),
    };

    const layer = AutoResumeReactorLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AutoResumeJobRepository, repository),
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ServerSettingsService, settings),
        ),
      ),
    );

    return {
      layer,
      jobs,
      enabled,
      invalidated,
      sent,
      settingsChanges,
      setEnabled,
      dispatched,
      dispatchStarted,
      retryDeferred,
      deleted,
    };
  });

const runScenario = <A, E>(
  scenario: Scenario,
  effect: Effect.Effect<A, E, AutoResumeReactor | Scope.Scope | TestClock.TestClock>,
): Effect.Effect<A, E> =>
  Effect.scoped(
    effect.pipe(Effect.provide(Layer.merge(scenario.layer, TestClock.layer()))),
  ) as Effect.Effect<A, E>;

it.effect("does not persist a schedule when the global setting is disabled", () =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario("success");
    yield* Ref.set(scenario.enabled, false);
    const scheduled = yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        return yield* reactor.schedule(JOB);
      }),
    );
    assert.isFalse(scheduled);
    assert.deepEqual(yield* Ref.get(scenario.jobs), [JOB]);
  }),
);

it.effect("fires one due job and removes it after successful dispatch", () =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario("success");
    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* Deferred.await(scenario.dispatchStarted);
        yield* Deferred.await(scenario.deleted);
      }),
    );
    assert.lengthOf(yield* Ref.get(scenario.dispatched), 1);
    assert.deepEqual(yield* Ref.get(scenario.jobs), []);
  }),
);

it.effect("waits for a future retry time and then fires exactly once", () =>
  Effect.gen(function* () {
    const futureJob: AutoResumeJob = {
      ...JOB,
      retryAt: "1970-01-01T00:01:00.000Z",
    };
    const scenario = yield* makeScenario("success", futureJob);
    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.deepEqual(yield* Ref.get(scenario.dispatched), []);

        yield* TestClock.adjust("62 seconds");
        assert.deepEqual(yield* Ref.get(scenario.dispatched), []);

        yield* TestClock.adjust("1 second");
        yield* Deferred.await(scenario.dispatchStarted);
        yield* Deferred.await(scenario.deleted);
      }),
    );
    assert.lengthOf(yield* Ref.get(scenario.dispatched), 1);
    assert.deepEqual(yield* Ref.get(scenario.jobs), []);
  }),
);

it.effect("deletes a pending job without dispatch when disabled before its due time", () =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario("success", {
      ...JOB,
      retryAt: "1970-01-01T00:01:00.000Z",
    });
    yield* Ref.set(scenario.enabled, false);
    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* Deferred.await(scenario.deleted);
      }),
    );
    assert.deepEqual(yield* Ref.get(scenario.dispatched), []);
    assert.deepEqual(yield* Ref.get(scenario.jobs), []);
  }),
);

it.effect("permanently deletes future jobs when the setting is toggled off then on", () =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario("success", {
      ...JOB,
      retryAt: "1970-01-01T00:01:00.000Z",
    });
    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* scenario.setEnabled(false);
        yield* Deferred.await(scenario.deleted);
        yield* scenario.setEnabled(true);
        yield* TestClock.adjust("1 minute");
        yield* Effect.yieldNow;
      }),
    );
    assert.deepEqual(yield* Ref.get(scenario.dispatched), []);
    assert.deepEqual(yield* Ref.get(scenario.jobs), []);
  }),
);

it.effect("deletes a durably invalidated job without dispatch", () =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario("success");
    yield* Ref.set(scenario.invalidated, true);
    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* Deferred.await(scenario.deleted);
      }),
    );
    assert.deepEqual(yield* Ref.get(scenario.dispatched), []);
    assert.deepEqual(yield* Ref.get(scenario.jobs), []);
  }),
);

it.effect("deletes a job without dispatch when its resume message was already sent", () =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario("success");
    yield* Ref.set(scenario.sent, true);
    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* Deferred.await(scenario.deleted);
      }),
    );
    assert.deepEqual(yield* Ref.get(scenario.dispatched), []);
    assert.deepEqual(yield* Ref.get(scenario.jobs), []);
  }),
);

it.effect("deletes a stale schedule after an invariant rejection", () =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario("stale");
    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* Deferred.await(scenario.deleted);
      }),
    );
    assert.lengthOf(yield* Ref.get(scenario.dispatched), 1);
    assert.deepEqual(yield* Ref.get(scenario.jobs), []);
  }),
);

it.effect("waits three seconds before retrying a transient dispatch failure", () =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario("transient");
    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* Deferred.await(scenario.dispatchStarted);
        yield* Deferred.await(scenario.retryDeferred);
        const [deferredJob] = yield* Ref.get(scenario.jobs);
        assert.equal(deferredJob?.retryAt, "1970-01-01T00:00:00.000Z");
        assert.lengthOf(yield* Ref.get(scenario.dispatched), 1);
      }),
    );

    yield* runScenario(
      scenario,
      Effect.gen(function* () {
        const reactor = yield* AutoResumeReactor;
        yield* reactor.start();
        yield* TestClock.adjust("2 seconds");
        assert.lengthOf(yield* Ref.get(scenario.dispatched), 1);

        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.lengthOf(yield* Ref.get(scenario.dispatched), 2);
      }),
    );
  }),
);
