import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      EffectOutbox.OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): EffectOutbox.OrchestrationEffectV2 {
  const timestamp = DateTime.formatIso(now);
  return {
    id: `effect:restart:${sessionTransition.type}`,
    commandId: CommandId.make(`command:restart:${sessionTransition.type}`),
    threadId,
    request: {
      type: "provider-turn.restart",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      interruptedAttemptId: attemptId,
      runId,
      sessionTransition,
    },
    status: "running",
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test-worker",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

function layerExecutorFor(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
  readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  readonly continueAfterRestart?: boolean;
  readonly interrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"];
  readonly finalization?: RunFinalizationService.RunFinalizationService["Service"];
  readonly rollback?: CheckpointRollbackService.CheckpointRollbackServiceV2Shape["execute"];
  readonly respond?: RuntimeRequestService.RuntimeRequestServiceV2["Service"]["respond"];
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlService.ProviderTurnControlServiceV2,
      ProviderTurnControlService.ProviderTurnControlServiceV2.of({
        interrupt: input.interrupt ?? (() => Effect.void),
        steer: () => Effect.void,
        interruptAndAwaitTerminal: (request) =>
          record(
            request.replacementProviderSessionId === undefined
              ? "interrupt"
              : `interrupt:${request.replacementProviderSessionId}`,
          ),
      }),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      ProviderSessionManager.ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeedNone,
        isLive: () => Effect.succeed(false),
        close: () => Effect.void,
        closeInstance: () => Effect.void,
        release: () => record("release"),
        detach: () => record("detach"),
      }),
    ),
    Layer.succeed(
      ProviderTurnStartService.ProviderTurnStartServiceV2,
      ProviderTurnStartService.ProviderTurnStartServiceV2.of({
        start: () =>
          Effect.gen(function* () {
            yield* record("start");
            if (
              input.failFirstStart !== undefined &&
              (yield* Ref.getAndSet(input.failFirstStart, false))
            ) {
              return yield* new ProviderTurnStartService.ProviderTurnStartError({
                runId,
                cause: "simulated first start failure",
              });
            }
          }),
      }),
    ),
    Layer.succeed(
      RunFinalizationService.RunFinalizationService,
      input.finalization ??
        RunFinalizationService.RunFinalizationService.of({
          finalize: () => Effect.void,
          abandonCapture: () => Effect.void,
        }),
    ),
    Layer.succeed(
      CheckpointRollbackService.CheckpointRollbackServiceV2,
      CheckpointRollbackService.CheckpointRollbackServiceV2.of({
        execute: input.rollback ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      RuntimeRequestService.RuntimeRequestServiceV2,
      RuntimeRequestService.RuntimeRequestServiceV2.of({
        respond: input.respond ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService.ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
        execute: () => Effect.void,
      }),
    ),
  );
  return EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads ?? {}),
        ServerSettings.layerTest(
          input.continueAfterRestart === true ? { continueThreadsAfterServerUpdate: true } : {},
        ),
      ),
    ),
  );
}

it.effect("settles a stopped run when its adapter has already lost the native turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      interrupt: () =>
        new ProviderTurnControlService.ProviderTurnControlError({
          threadId,
          operation: "interrupt",
          providerTurnId,
          cause: "Provider turn is not active.",
        }),
      threads: {
        dispatch: (command) =>
          Ref.update(events, (current) => [...current, command.type]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute({
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
        },
      });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(events), ["thread.background-work.settle"]);
  }),
);

// A run parked at `waiting` is only completed by its capture, so a capture
// that will not be retried must still complete it.
it.effect.each([true, false])(
  "completes a waiting run only after its final capture attempt fails, willRetry=%s",
  (willRetry) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        finalization: RunFinalizationService.RunFinalizationService.of({
          finalize: (input) =>
            new RunFinalizationService.RunFinalizationError({
              ...input,
              operation: "capture-checkpoint",
              cause: "simulated checkpoint backend failure",
            }),
          abandonCapture: (input) =>
            Ref.update(events, (current) => [...current, `abandon:${input.runId}`]),
        }),
      });
      const exit = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        return yield* executor
          .execute(
            {
              ...restartEffect(now, { type: "detach" }),
              request: {
                type: "checkpoint.capture",
                runId,
                scopeId: CheckpointScopeId.make("scope:effect-worker-capture"),
              },
            },
            { willRetry },
          )
          .pipe(Effect.exit);
      }).pipe(Effect.provide(layer));
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(yield* Ref.get(events), willRetry ? [] : [`abandon:${runId}`]);
    }),
);

const lockedIndexMessage =
  "Git's index is locked. Wait for other Git operations to finish, then try again.";
const rollbackCheckpointId = CheckpointId.make("checkpoint:effect-worker-rollback");
const rollbackScopeId = CheckpointScopeId.make("checkpoint-scope:effect-worker-rollback");
const restoreFailure = (detail: string) =>
  new CheckpointRollbackService.CheckpointRollbackExecutionError({
    reason: "unexpected-failure",
    threadId,
    providerThreadId,
    checkpointId: rollbackCheckpointId,
    cause: new CheckpointService.CheckpointRestoreError({
      scopeId: rollbackScopeId,
      checkpointId: rollbackCheckpointId,
      cause: new VcsProcessExitError({
        operation: "GitVcsDriverCore.restoreCheckpoint",
        command: "git",
        cwd: "/private/repo",
        exitCode: 128,
        detail,
        failureKind: "command-failed",
      }),
    }),
  });

it.effect.each([
  {
    name: "a held Git index lock",
    failure: restoreFailure(lockedIndexMessage),
    message: lockedIndexMessage,
  },
  {
    name: "raw Git output",
    failure: restoreFailure("error: could not clean /private/repo/secret.txt"),
    message: CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
  },
])("reports a rollback blocked by $name only after the last attempt", ({ failure, message }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const failures = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      rollback: () => Effect.fail(failure),
      threads: {
        dispatch: (command) =>
          Ref.update(failures, (current) =>
            command.type === "checkpoint.rollback.fail" ? [...current, command.message] : current,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const rollback: EffectOutbox.OrchestrationEffectV2 = {
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-thread.rollback",
          providerThreadId,
          checkpointId: rollbackCheckpointId,
          scopeId: rollbackScopeId,
          restoreFiles: true,
        },
      };
      yield* Effect.flip(executor.execute(rollback, { willRetry: true }));
      assert.deepEqual(yield* Ref.get(failures), []);
      yield* Effect.flip(executor.execute(rollback, { willRetry: false }));
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(failures), [message]);
  }),
);

it.effect("does not report an answer whose last delivery attempt is interrupted", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const reported = yield* Ref.make(0);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      respond: () => Effect.interrupt,
      threads: {
        dispatch: (command) =>
          Ref.update(reported, (count) =>
            command.type === "runtime-request.delivery.fail" ? count + 1 : count,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    const exit = yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return yield* Effect.exit(
        executor.execute(
          {
            ...restartEffect(now, { type: "detach" }),
            request: {
              type: "runtime-request.respond",
              providerSessionId: oldSessionId,
              requestId: RuntimeRequestId.make("runtime-request:effect-worker-interrupted"),
              answers: { next: "Ship it" },
            },
          },
          { willRetry: false },
        ),
      );
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.hasInterrupts(exit));
    assert.equal(yield* Ref.get(reported), 0);
  }),
);

it.effect("requeues a claim when a pre-execution worker check fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-pre-execution-failure";
    const workerId = "worker-pre-execution-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-pre-execution-failure"),
      threadId: ThreadId.make("thread:worker-pre-execution-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make<
      ReadonlyArray<{
        readonly effectId: string;
        readonly workerId: string;
        readonly error: string;
        readonly delayMs: number;
      }>
    >([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: (input) =>
        Ref.update(retries, (existing) => [...existing, input]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(Cause.pretty(exit.cause), "simulated cancellation-state read failure");
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    const retry = (yield* Ref.get(retries))[0];
    assert.isDefined(retry);
    assert.equal(retry.effectId, effectId);
    assert.equal(retry.workerId, workerId);
    assert.equal(retry.delayMs, 0);
    assert.include(retry.error, "simulated cancellation-state read failure");
  }),
);

it.effect("arms cancellation before the durable pre-execution check", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-cancellation-registration-race";
    const workerId = "worker-cancellation-registration-race";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-cancellation-registration-race"),
      threadId: ThreadId.make("thread:worker-cancellation-registration-race"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const signal = yield* Deferred.make<void>();
    let cancellationArmed = false;
    const executionCount = yield* Ref.make(0);
    const settlementCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => {
        cancellationArmed = true;
        return Deferred.await(signal);
      },
      get: () =>
        Effect.gen(function* () {
          if (cancellationArmed) {
            yield* Deferred.succeed(signal, undefined);
          }
          return Option.some(claimedEffect);
        }),
      clearCancellation: () => Effect.void,
      succeed: () => Ref.update(settlementCount, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.yieldNow.pipe(Effect.andThen(Ref.update(executionCount, (count) => count + 1))),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      assert.fail(Cause.pretty(exit.cause));
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    assert.equal(yield* Ref.get(settlementCount), 0);
  }),
);

it.effect("terminalizes a process-bound claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-settlement-failure";
    const workerId = "worker-process-bound-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalErrors = yield* Ref.make<ReadonlyArray<string>>([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated success settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: ({ error }) =>
        Ref.update(terminalErrors, (existing) => [...existing, error]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(executionCount), 1);
    assert.equal(yield* Ref.get(retries), 0);
    const terminalError = (yield* Ref.get(terminalErrors))[0];
    assert.isDefined(terminalError);
    assert.include(terminalError, "after execution started");
    assert.include(terminalError, "simulated success settlement failure");
  }),
);

it.effect("settles a delegated child once its restart continuation fails for good", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const recovered = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = layerExecutorFor({
      events,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.fail(new Error("provider instance removed") as never),
        recoverDelegatedTask: (childThreadId) =>
          Ref.update(recovered, (ids) => [...ids, childThreadId]),
      },
    });
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      id: `effect:restart-continuation:${runId}`,
      commandId: CommandId.make("command:restart-continuation-failure"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: runId },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "test-worker",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: true }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), []);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: false }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), [threadId]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["confirmed", "unconfirmed", "failed"] as const)(
  "a native subagent stop only repairs %s provider evidence",
  (outcome) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        interrupt: (input) => {
          assert.equal(input.subagent?.nativeTaskId, "native-task");
          return Ref.update(events, (current) => [...current, "stop-child"]).pipe(
            Effect.andThen(
              outcome === "failed"
                ? new ProviderTurnControlService.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "interrupt",
                    cause: "SDK stop failed",
                  })
                : Effect.succeed(
                    outcome === "confirmed"
                      ? {
                          status: "cancelled" as const,
                          completedAt: now,
                          result: "Stopped by Claude",
                        }
                      : undefined,
                  ),
            ),
          );
        },
        threads: {
          dispatch: (command) => {
            assert.equal(command.type, "thread.background-work.settle");
            if (command.type === "thread.background-work.settle") {
              assert.equal(command.subagent?.id, "subagent");
              assert.deepEqual(command.subagent?.outcome, {
                status: "cancelled",
                completedAt: now,
                result: "Stopped by Claude",
              });
            }
            return Ref.update(events, (current) => [...current, "settle-child"]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            );
          },
        },
      });
      const execution = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* executor.execute({
          ...restartEffect(now, { type: "detach" }),
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
            subagent: { id: NodeId.make("subagent"), nativeTaskId: "native-task" },
          },
        });
      }).pipe(Effect.provide(layer), Effect.exit);
      assert.equal(Exit.isFailure(execution), outcome === "failed");
      assert.deepEqual(
        yield* Ref.get(events),
        outcome === "confirmed" ? ["stop-child", "settle-child"] : ["stop-child"],
      );
    }),
);

// DL020: a terminal run's capture must never delay the thread's next turn or Stop.
it.effect("starts a new turn and Stop while the previous run's capture hangs", () =>
  Effect.gen(function* () {
    const captureStarted = yield* Deferred.make<void>();
    const started = yield* Deferred.make<string>();
    const executor = EffectWorker.OrchestrationEffectExecutorV2.of({
      execute: (effect) =>
        effect.request.type === "checkpoint.capture"
          ? Deferred.succeed(captureStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Deferred.succeed(started, effect.request.type).pipe(Effect.asVoid),
    });
    const layer = EffectWorker.layer.pipe(
      Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      Layer.provide(Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, executor)),
    );
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const commandId = CommandId.make("command:effect-worker-hung-capture");
      yield* outbox.enqueue([
        {
          id: "effect:hung-capture:a-capture",
          commandId,
          threadId,
          request: {
            type: "checkpoint.capture",
            runId,
            scopeId: CheckpointScopeId.make("scope:effect-worker-hung-capture"),
          },
        },
      ]);
      const captureWorker = yield* Effect.forkChild(worker.runOnce);
      yield* Deferred.await(captureStarted);

      yield* outbox.enqueue([
        {
          id: "effect:hung-capture:b-start",
          commandId,
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make("run:effect-worker-next") },
        },
      ]);
      assert.isTrue(yield* worker.runOnce);
      assert.equal(yield* Deferred.await(started), "provider-turn.start");

      yield* outbox.enqueue([
        {
          id: "effect:hung-capture:c-stop",
          commandId,
          threadId,
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          },
        },
      ]);
      assert.isTrue(yield* worker.runOnce);
      assert.equal(
        Option.map(yield* outbox.get("effect:hung-capture:c-stop"), (effect) => effect.status).pipe(
          Option.getOrUndefined,
        ),
        "succeeded",
      );
      yield* Fiber.interrupt(captureWorker);
    }).pipe(Effect.provide(layer));
  }),
);

// DL020: captures on other threads must leave workers for a turn start or Stop.
it.effect("keeps workers free for other threads while captures saturate", () =>
  Effect.gen(function* () {
    const capturesStarted = yield* Queue.unbounded<string>();
    const releaseCaptures = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const executor = EffectWorker.OrchestrationEffectExecutorV2.of({
      execute: (effect) =>
        effect.request.type === "checkpoint.capture"
          ? Queue.offer(capturesStarted, effect.id).pipe(
              Effect.andThen(Deferred.await(releaseCaptures)),
            )
          : Deferred.succeed(started, undefined).pipe(Effect.asVoid),
    });
    const layer = EffectWorker.layer.pipe(
      Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      Layer.provide(Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, executor)),
    );
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:effect-worker-capture-saturation");
      yield* outbox.enqueue([
        ...[1, 2, 3, 4].map((index) => ({
          id: `effect:capture-saturation:a-capture-${index}`,
          commandId,
          threadId: ThreadId.make(`thread:capture-saturation:${index}`),
          request: {
            type: "checkpoint.capture" as const,
            runId: RunId.make(`run:capture-saturation:${index}`),
            scopeId: CheckpointScopeId.make(`scope:capture-saturation:${index}`),
          },
        })),
        {
          id: "effect:capture-saturation:b-start",
          commandId,
          threadId: ThreadId.make("thread:capture-saturation:other"),
          request: { type: "provider-turn.start", runId: RunId.make("run:capture-saturation:5") },
        },
      ]);
      const daemon = yield* EffectWorker.runDaemonWithOptions({ concurrency: 4 }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      assert.deepEqual(yield* Queue.takeAll(capturesStarted), [
        "effect:capture-saturation:a-capture-1",
        "effect:capture-saturation:a-capture-2",
      ]);

      // A finished capture frees its slot for the next one.
      yield* Deferred.succeed(releaseCaptures, undefined);
      assert.deepEqual(
        [yield* Queue.take(capturesStarted), yield* Queue.take(capturesStarted)].toSorted(),
        ["effect:capture-saturation:a-capture-3", "effect:capture-saturation:a-capture-4"],
      );
      yield* Fiber.interrupt(daemon);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("times out a hung capture so its run can settle", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      finalization: RunFinalizationService.RunFinalizationService.of({
        finalize: () => Effect.never,
        abandonCapture: (input) =>
          Ref.update(events, (current) => [...current, `abandon:${input.runId}`]),
      }),
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const fiber = yield* executor
        .execute(
          {
            ...restartEffect(now, { type: "detach" }),
            request: {
              type: "checkpoint.capture",
              runId,
              scopeId: CheckpointScopeId.make("scope:effect-worker-capture-timeout"),
            },
          },
          { willRetry: false },
        )
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust(EffectWorker.CHECKPOINT_CAPTURE_TIMEOUT);
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(yield* Ref.get(events), [`abandon:${runId}`]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps a capture queued while its run cannot be completed", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const writesFail = yield* Ref.make(true);
    const layer = EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
      Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      Layer.provide(
        layerExecutorFor({
          events,
          finalization: RunFinalizationService.RunFinalizationService.of({
            finalize: (input) =>
              new RunFinalizationService.RunFinalizationError({
                ...input,
                operation: "capture-checkpoint",
                cause: "simulated checkpoint backend failure",
              }),
            abandonCapture: (input) =>
              Ref.update(events, (current) => [...current, "abandon"]).pipe(
                Effect.andThen(Ref.get(writesFail)),
                Effect.flatMap((fail) =>
                  fail
                    ? new RunFinalizationService.RunFinalizationError({
                        ...input,
                        operation: "capture-checkpoint",
                        cause: "simulated projection write failure",
                      })
                    : Effect.void,
                ),
              ),
          }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const effectId = "effect:abandon-writes-fail:capture";
      const status = outbox
        .get(effectId)
        .pipe(Effect.map(Option.match({ onNone: () => undefined, onSome: (row) => row.status })));
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId: CommandId.make("command:abandon-writes-fail"),
          threadId,
          request: {
            type: "checkpoint.capture",
            runId,
            scopeId: CheckpointScopeId.make("scope:abandon-writes-fail"),
          },
        },
      ]);
      const runAttempt = Effect.gen(function* () {
        const attempt = yield* Effect.forkChild(worker.runOnce);
        yield* TestClock.adjust("1 minute");
        assert.isTrue(yield* Fiber.join(attempt));
      });

      // The only attempt fails, and so does every write that completes the run.
      yield* runAttempt;
      assert.equal(yield* status, "pending");
      assert.equal((yield* Ref.get(events)).length, 5);

      yield* Ref.set(writesFail, false);
      yield* runAttempt;
      assert.equal(yield* status, "failed");
      assert.equal((yield* Ref.get(events)).length, 6);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retries completing a run whose capture failed for good", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const attempts = yield* Ref.make(0);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      finalization: RunFinalizationService.RunFinalizationService.of({
        finalize: (input) =>
          new RunFinalizationService.RunFinalizationError({
            ...input,
            operation: "capture-checkpoint",
            cause: "simulated checkpoint backend failure",
          }),
        abandonCapture: (input) =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count < 3
                ? new RunFinalizationService.RunFinalizationError({
                    ...input,
                    operation: "capture-checkpoint",
                    cause: "simulated projection write failure",
                  })
                : Effect.void,
            ),
          ),
      }),
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const fiber = yield* executor
        .execute(
          {
            ...restartEffect(now, { type: "detach" }),
            request: {
              type: "checkpoint.capture",
              runId,
              scopeId: CheckpointScopeId.make("scope:effect-worker-abandon-retry"),
            },
          },
          { willRetry: false },
        )
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(yield* Ref.get(attempts), 3);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps checkpoint capture and rollback in order on their thread", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const commandId = CommandId.make("command:effect-worker-capture-rollback-lane");
    const claim = outbox.claimNext({ workerId: "lane-worker" });
    yield* outbox.enqueue([
      {
        id: "effect:lane:a-capture",
        commandId,
        threadId,
        request: {
          type: "checkpoint.capture",
          runId,
          scopeId: CheckpointScopeId.make("scope:effect-worker-lane"),
        },
      },
      {
        id: "effect:lane:b-rollback",
        commandId,
        threadId,
        request: {
          type: "provider-thread.rollback",
          providerThreadId,
          checkpointId: CheckpointId.make("checkpoint:effect-worker-lane"),
          scopeId: CheckpointScopeId.make("scope:effect-worker-lane"),
        },
      },
      {
        id: "effect:lane:c-start",
        commandId,
        threadId,
        request: { type: "provider-turn.start", runId: RunId.make("run:effect-worker-lane") },
      },
    ]);

    const capture = yield* claim;
    assert.equal(Option.getOrUndefined(capture)?.id, "effect:lane:a-capture");
    // The rollback waits for the running capture, and the turn waits for the rollback.
    assert.isTrue(Option.isNone(yield* claim));
    yield* outbox.succeed({ effectId: "effect:lane:a-capture", workerId: "lane-worker" });
    assert.equal(Option.getOrUndefined(yield* claim)?.id, "effect:lane:b-rollback");
    assert.isTrue(Option.isNone(yield* claim));
    yield* outbox.succeed({ effectId: "effect:lane:b-rollback", workerId: "lane-worker" });
    assert.equal(Option.getOrUndefined(yield* claim)?.id, "effect:lane:c-start");
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);
