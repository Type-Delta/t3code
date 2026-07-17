import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
