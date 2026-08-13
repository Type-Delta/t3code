import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  CheckpointCaptureExecutor,
  CheckpointCaptureObserver,
  CheckpointCaptureQueue,
  makeCheckpointCaptureQueueLayer,
} from "./CheckpointCaptureQueue.ts";
import { WorkspaceMutationCoordinatorLive } from "./WorkspaceMutationCoordinator.ts";
import { CheckpointCaptureJobRepositoryLive } from "../persistence/Layers/CheckpointCaptureJobs.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CheckpointCaptureJobRepository } from "../persistence/Services/CheckpointCaptureJobs.ts";

const ExecutorLive = Layer.succeed(
  CheckpointCaptureExecutor,
  CheckpointCaptureExecutor.of({
    execute: (job, signal) =>
      Effect.succeed(
        signal.aborted
          ? { state: "contended" as const, errorCode: "preempted" }
          : {
              state: "ready" as const,
              commitOid: `commit-${job.jobId}`,
              treeOid: `tree-${job.jobId}`,
            },
      ),
  }),
);

const observedCompletions: Array<{ readonly jobId: string; readonly durableState: string }> = [];
const ObserverLive = Layer.effect(
  CheckpointCaptureObserver,
  Effect.gen(function* () {
    const repository = yield* CheckpointCaptureJobRepository;
    return CheckpointCaptureObserver.of({
      onCompleted: (job) =>
        repository.getById({ jobId: job.jobId }).pipe(
          Effect.flatMap((persisted) =>
            Effect.sync(() => {
              observedCompletions.push({
                jobId: job.jobId,
                durableState: Option.getOrThrow(persisted).state,
              });
            }),
          ),
          Effect.orDie,
        ),
    });
  }),
);
const ObserverProvided = ObserverLive.pipe(Layer.provide(CheckpointCaptureJobRepositoryLive));

const DependenciesLive = Layer.mergeAll(
  CheckpointCaptureJobRepositoryLive,
  WorkspaceMutationCoordinatorLive,
  ExecutorLive,
  ObserverProvided,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const QueueLive = makeCheckpointCaptureQueueLayer({
  workerId: "queue-test-worker",
  concurrency: 2,
  leaseDuration: "10 seconds",
}).pipe(Layer.provideMerge(DependenciesLive));

const awaitTerminal = Effect.fn("CheckpointCaptureQueue.test.awaitTerminal")(function* (
  jobId: string,
) {
  const repository = yield* CheckpointCaptureJobRepository;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const job = yield* repository.getById({ jobId });
    if (Option.isSome(job) && ["ready", "contended", "error"].includes(job.value.state)) {
      return job.value;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(`Timed out waiting for ${jobId}`);
});

it.layer(QueueLive)("CheckpointCaptureQueue", (it) => {
  it.effect("persists before waking a bounded worker and publishes ready state", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointCaptureJobRepository;
      const queue = yield* CheckpointCaptureQueue;
      observedCompletions.length = 0;
      const now = "2026-07-16T00:00:00.000Z";
      yield* repository.upsertRepository({
        repositoryKey: "queue-repo",
        commonDirFingerprint: "queue-fingerprint",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/queue-repo.git",
        createdAt: now,
        lastUsedAt: now,
      });
      const inserted = yield* queue.enqueue({
        snapshot: {
          snapshotId: "queue-snapshot",
          repositoryKey: "queue-repo",
          worktreeKey: "queue-worktree",
          kind: "turn",
          createdAt: now,
          expiresAt: null,
        },
        job: {
          jobId: "queue-job",
          snapshotId: "queue-snapshot",
          threadId: "queue-thread",
          timelineGeneration: 0,
          turnId: "queue-turn",
          providerTurnId: "provider-queue-turn",
          turnOrdinal: 1,
          repositoryKey: "queue-repo",
          worktreeKey: "queue-worktree",
          requestedBoundary: "turn-completed",
          requestedGeneration: 0,
          createdAt: now,
        },
      });
      assert.equal(inserted.state, "pending");
      const completed = yield* awaitTerminal("queue-job");
      assert.equal(completed.state, "ready");
      const snapshot = Option.getOrThrow(
        yield* repository.getSnapshot({ snapshotId: "queue-snapshot" }),
      );
      assert.equal(snapshot.commitOid, "commit-queue-job");
      assert.equal(snapshot.treeOid, "tree-queue-job");
      assert.deepEqual(observedCompletions, [{ jobId: "queue-job", durableState: "ready" }]);
    }),
  );

  it.effect("reclaims expired leases without a server restart", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointCaptureJobRepository;
      yield* repository.upsertRepository({
        repositoryKey: "recovery-repo",
        commonDirFingerprint: "recovery-fingerprint",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/recovery-repo.git",
        createdAt: "1970-01-01T00:00:00.000Z",
        lastUsedAt: "1970-01-01T00:00:00.000Z",
      });
      yield* repository.enqueue({
        snapshot: {
          snapshotId: "recovery-snapshot",
          repositoryKey: "recovery-repo",
          worktreeKey: "recovery-worktree",
          kind: "turn",
          createdAt: "1970-01-01T00:00:00.000Z",
          expiresAt: null,
        },
        job: {
          jobId: "recovery-job",
          snapshotId: "recovery-snapshot",
          threadId: "recovery-thread",
          timelineGeneration: 0,
          turnId: "recovery-turn",
          providerTurnId: null,
          turnOrdinal: 1,
          repositoryKey: "recovery-repo",
          worktreeKey: "recovery-worktree",
          requestedBoundary: "turn-completed",
          requestedGeneration: 0,
          createdAt: "1970-01-01T00:00:00.000Z",
        },
      });
      assert.isTrue(
        Option.isSome(
          yield* repository.claimNext({
            leaseOwner: "abandoned-worker",
            now: "1970-01-01T00:00:00.000Z",
            leaseExpiresAt: "1970-01-01T00:00:05.000Z",
          }),
        ),
      );

      yield* TestClock.adjust("7 seconds");
      const completed = yield* awaitTerminal("recovery-job");
      assert.equal(completed.state, "ready");
      assert.equal(completed.attemptCount, 2);
    }),
  );
});

const FailingExecutorLive = Layer.succeed(
  CheckpointCaptureExecutor,
  CheckpointCaptureExecutor.of({ execute: () => Effect.die("executor-defect") }),
);
const FailingDependenciesLive = Layer.mergeAll(
  CheckpointCaptureJobRepositoryLive,
  WorkspaceMutationCoordinatorLive,
  FailingExecutorLive,
  ObserverProvided,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const FailingQueueLive = makeCheckpointCaptureQueueLayer({
  workerId: "queue-failure-worker",
  concurrency: 1,
  leaseDuration: "10 seconds",
}).pipe(Layer.provideMerge(FailingDependenciesLive));

it.layer(FailingQueueLive)("CheckpointCaptureQueue failure handling", (it) => {
  it.effect("durably completes executor defects as error before notifying observers", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointCaptureJobRepository;
      const queue = yield* CheckpointCaptureQueue;
      observedCompletions.length = 0;
      const now = "2026-07-16T00:00:00.000Z";
      yield* repository.upsertRepository({
        repositoryKey: "failure-repo",
        commonDirFingerprint: "failure-fingerprint",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/failure-repo.git",
        createdAt: now,
        lastUsedAt: now,
      });
      yield* queue.enqueue({
        snapshot: {
          snapshotId: "failure-snapshot",
          repositoryKey: "failure-repo",
          worktreeKey: "failure-worktree",
          kind: "turn",
          createdAt: now,
          expiresAt: null,
        },
        job: {
          jobId: "failure-job",
          snapshotId: "failure-snapshot",
          threadId: "failure-thread",
          timelineGeneration: 0,
          turnId: "failure-turn",
          providerTurnId: null,
          turnOrdinal: 1,
          repositoryKey: "failure-repo",
          worktreeKey: "failure-worktree",
          requestedBoundary: "turn-completed",
          requestedGeneration: 0,
          createdAt: now,
        },
      });
      const completed = yield* awaitTerminal("failure-job");
      assert.equal(completed.state, "error");
      assert.equal(completed.errorCode, "capture-failed");
      assert.deepEqual(observedCompletions, [{ jobId: "failure-job", durableState: "error" }]);
    }),
  );
});

let retryExecutions = 0;
const RetryingExecutorLive = Layer.succeed(
  CheckpointCaptureExecutor,
  CheckpointCaptureExecutor.of({
    execute: (job) =>
      Effect.sync(() => {
        retryExecutions += 1;
        return retryExecutions < 3
          ? ({ state: "error", errorCode: "transient-capture-failure" } as const)
          : ({
              state: "ready",
              commitOid: `commit-${job.jobId}`,
              treeOid: `tree-${job.jobId}`,
            } as const);
      }),
  }),
);
const RetryingDependenciesLive = Layer.mergeAll(
  CheckpointCaptureJobRepositoryLive,
  WorkspaceMutationCoordinatorLive,
  RetryingExecutorLive,
  ObserverProvided,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const RetryingQueueLive = makeCheckpointCaptureQueueLayer({
  workerId: "queue-retrying-worker",
  concurrency: 1,
  leaseDuration: "10 seconds",
}).pipe(Layer.provideMerge(RetryingDependenciesLive));

it.layer(RetryingQueueLive)("CheckpointCaptureQueue retries", (it) => {
  it.effect("retries transient execution errors before completing the durable job", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointCaptureJobRepository;
      const queue = yield* CheckpointCaptureQueue;
      retryExecutions = 0;
      yield* repository.upsertRepository({
        repositoryKey: "retrying-repo",
        commonDirFingerprint: "retrying-fingerprint",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/retrying-repo.git",
        createdAt: "2026-07-16T00:00:00.000Z",
        lastUsedAt: "2026-07-16T00:00:00.000Z",
      });
      yield* queue.enqueue({
        snapshot: {
          snapshotId: "retrying-snapshot",
          repositoryKey: "retrying-repo",
          worktreeKey: "retrying-worktree",
          kind: "turn",
          createdAt: "2026-07-16T00:00:00.000Z",
          expiresAt: null,
        },
        job: {
          jobId: "retrying-job",
          snapshotId: "retrying-snapshot",
          threadId: "retrying-thread",
          timelineGeneration: 0,
          turnId: "retrying-turn",
          providerTurnId: null,
          turnOrdinal: 1,
          repositoryKey: "retrying-repo",
          worktreeKey: "retrying-worktree",
          requestedBoundary: "turn-completed",
          requestedGeneration: 0,
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      });
      assert.equal((yield* awaitTerminal("retrying-job")).state, "ready");
      assert.equal(retryExecutions, 3);
    }),
  );
});

const HangingExecutorLive = Layer.succeed(
  CheckpointCaptureExecutor,
  CheckpointCaptureExecutor.of({ execute: () => Effect.never }),
);
const HangingDependenciesLive = Layer.mergeAll(
  CheckpointCaptureJobRepositoryLive,
  WorkspaceMutationCoordinatorLive,
  HangingExecutorLive,
  ObserverProvided,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const HangingQueueLive = makeCheckpointCaptureQueueLayer({
  workerId: "queue-hanging-worker",
  concurrency: 1,
  leaseDuration: "10 seconds",
  executionTimeout: "1 second",
  maxExecutionAttempts: 1,
}).pipe(Layer.provideMerge(HangingDependenciesLive));

it.layer(HangingQueueLive)("CheckpointCaptureQueue timeouts", (it) => {
  it.effect("completes a hung capture as an error", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointCaptureJobRepository;
      const queue = yield* CheckpointCaptureQueue;
      yield* repository.upsertRepository({
        repositoryKey: "hanging-repo",
        commonDirFingerprint: "hanging-fingerprint",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/hanging-repo.git",
        createdAt: "2026-07-16T00:00:00.000Z",
        lastUsedAt: "2026-07-16T00:00:00.000Z",
      });
      yield* queue.enqueue({
        snapshot: {
          snapshotId: "hanging-snapshot",
          repositoryKey: "hanging-repo",
          worktreeKey: "hanging-worktree",
          kind: "turn",
          createdAt: "2026-07-16T00:00:00.000Z",
          expiresAt: null,
        },
        job: {
          jobId: "hanging-job",
          snapshotId: "hanging-snapshot",
          threadId: "hanging-thread",
          timelineGeneration: 0,
          turnId: "hanging-turn",
          providerTurnId: null,
          turnOrdinal: 1,
          repositoryKey: "hanging-repo",
          worktreeKey: "hanging-worktree",
          requestedBoundary: "turn-completed",
          requestedGeneration: 0,
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      });
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const job = yield* repository.getById({ jobId: "hanging-job" });
        if (Option.isSome(job) && job.value.state === "running") break;
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("1 second");
      const completed = yield* awaitTerminal("hanging-job");
      assert.equal(completed.state, "error");
      assert.equal(completed.errorCode, "capture-timeout");
    }),
  );
});
