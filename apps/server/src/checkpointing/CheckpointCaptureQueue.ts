import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import {
  CheckpointCaptureJobRepository,
  type CheckpointCaptureJob,
  type EnqueueCheckpointCaptureInput,
} from "../persistence/Services/CheckpointCaptureJobs.ts";
import { WorkspaceMutationCoordinator } from "./WorkspaceMutationCoordinator.ts";

export type CheckpointCaptureExecutionResult =
  | { readonly state: "ready"; readonly commitOid: string; readonly treeOid: string }
  | { readonly state: "contended"; readonly errorCode: string | null }
  | { readonly state: "error"; readonly errorCode: string };

export interface CheckpointCaptureExecutorShape {
  readonly execute: (
    job: CheckpointCaptureJob,
    signal: AbortSignal,
  ) => Effect.Effect<CheckpointCaptureExecutionResult>;
}

export class CheckpointCaptureExecutor extends Context.Service<
  CheckpointCaptureExecutor,
  CheckpointCaptureExecutorShape
>()("t3/checkpointing/CheckpointCaptureQueue/CheckpointCaptureExecutor") {}

export interface CheckpointCaptureObserverShape {
  readonly onCompleted: (
    job: CheckpointCaptureJob,
    result: CheckpointCaptureExecutionResult,
  ) => Effect.Effect<void>;
}

/** Runs publication side effects only after the durable job transition succeeds. */
export class CheckpointCaptureObserver extends Context.Service<
  CheckpointCaptureObserver,
  CheckpointCaptureObserverShape
>()("t3/checkpointing/CheckpointCaptureQueue/CheckpointCaptureObserver") {}

export interface CheckpointCaptureQueueShape {
  /** Durable insert followed by an in-memory wakeup. */
  readonly enqueue: (
    input: EnqueueCheckpointCaptureInput,
  ) => ReturnType<CheckpointCaptureJobRepository["Service"]["enqueue"]>;
  /** Wakes workers after an external durable insert or recovery event. */
  readonly notify: Effect.Effect<void>;
  /** Reclaims expired leases and wakes all worker slots. */
  readonly recover: Effect.Effect<
    number,
    import("../persistence/Errors.ts").ProjectionRepositoryError
  >;
}

export class CheckpointCaptureQueue extends Context.Service<
  CheckpointCaptureQueue,
  CheckpointCaptureQueueShape
>()("t3/checkpointing/CheckpointCaptureQueue") {}

export interface CheckpointCaptureQueueOptions {
  readonly workerId: string;
  readonly concurrency?: number;
  readonly leaseDuration?: Duration.Input;
}

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

export const makeCheckpointCaptureQueueLayer = (
  options: CheckpointCaptureQueueOptions,
): Layer.Layer<
  CheckpointCaptureQueue,
  never,
  | CheckpointCaptureJobRepository
  | CheckpointCaptureExecutor
  | CheckpointCaptureObserver
  | WorkspaceMutationCoordinator
> =>
  Layer.effect(
    CheckpointCaptureQueue,
    Effect.gen(function* () {
      const repository = yield* CheckpointCaptureJobRepository;
      const executor = yield* CheckpointCaptureExecutor;
      const observer = yield* CheckpointCaptureObserver;
      const mutationCoordinator = yield* WorkspaceMutationCoordinator;
      const wakeups = yield* Queue.unbounded<void>();
      const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
      const leaseDuration = Duration.fromInputUnsafe(options.leaseDuration ?? Duration.minutes(2));
      const leaseMillis = Duration.toMillis(leaseDuration);
      const heartbeatDelay = Duration.millis(Math.max(250, Math.floor(leaseMillis / 3)));
      const leaseWindow = Effect.map(DateTime.now, (now) => ({
        now: DateTime.formatIso(now),
        leaseExpiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: leaseMillis })),
      }));

      const processJob = Effect.fn("CheckpointCaptureQueue.processJob")(
        function* (job: CheckpointCaptureJob, leaseOwner: string) {
          const ticket = yield* mutationCoordinator.beginCapture(job.worktreeKey);
          const heartbeat = Effect.forever(
            Effect.sleep(heartbeatDelay).pipe(
              Effect.flatMap(() => leaseWindow),
              Effect.flatMap(({ now, leaseExpiresAt }) =>
                repository.renewLease({
                  jobId: job.jobId,
                  leaseOwner,
                  now,
                  leaseExpiresAt,
                }),
              ),
              Effect.orElseSucceed(() => false),
            ),
          );
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.forkScoped(heartbeat);
              return yield* executor.execute(job, ticket.signal).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Checkpoint capture executor failed", {
                    jobId: job.jobId,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as({ state: "error" as const, errorCode: "capture-failed" })),
                ),
              );
            }),
          );
          const stable = yield* mutationCoordinator.completeCapture(ticket);
          const finalResult: CheckpointCaptureExecutionResult =
            stable && !ticket.signal.aborted
              ? result
              : { state: "contended", errorCode: "workspace-mutated" };
          const completedAt = yield* isoNow;
          const completed = yield* repository.complete({
            jobId: job.jobId,
            leaseOwner,
            state: finalResult.state,
            commitOid: finalResult.state === "ready" ? finalResult.commitOid : null,
            treeOid: finalResult.state === "ready" ? finalResult.treeOid : null,
            errorCode: finalResult.state === "ready" ? null : finalResult.errorCode,
            completedAt,
          });
          if (completed) {
            yield* observer.onCompleted(job, finalResult).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Checkpoint capture completion observer failed", {
                  jobId: job.jobId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }
        },
        Effect.catchCause((cause) => Effect.logError("Checkpoint capture worker failed", cause)),
      );

      const claimAndRun = Effect.fn("CheckpointCaptureQueue.claimAndRun")(
        function* (leaseOwner: string) {
          while (true) {
            const { now, leaseExpiresAt } = yield* leaseWindow;
            const claimed = yield* repository.claimNext({
              leaseOwner,
              now,
              leaseExpiresAt,
            });
            if (Option.isNone(claimed)) return;
            yield* processJob(claimed.value, leaseOwner);
          }
        },
        Effect.catchCause((cause) => Effect.logError("Checkpoint capture claim failed", cause)),
      );

      for (let index = 0; index < concurrency; index += 1) {
        const leaseOwner = `${options.workerId}:${index}`;
        const worker = Effect.forever(
          Queue.take(wakeups).pipe(Effect.flatMap(() => claimAndRun(leaseOwner))),
        );
        yield* Effect.forkScoped(worker);
      }

      const notify = Queue.offer(wakeups, undefined).pipe(Effect.asVoid);
      const recover = Effect.gen(function* () {
        const now = yield* isoNow;
        const count = yield* repository.reclaimExpired({ now });
        yield* Queue.offerAll(
          wakeups,
          Array.from({ length: concurrency }, () => undefined),
        );
        return count;
      });
      yield* recover.pipe(
        Effect.catchCause((cause) => Effect.logError("Checkpoint recovery failed", cause)),
      );

      const enqueue: CheckpointCaptureQueueShape["enqueue"] = (input) =>
        repository.enqueue(input).pipe(Effect.tap(() => notify));

      return CheckpointCaptureQueue.of({ enqueue, notify, recover });
    }),
  );
