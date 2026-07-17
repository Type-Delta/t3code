import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CheckpointCaptureJobRepositoryLive } from "./CheckpointCaptureJobs.ts";
import { CheckpointNavigationRepositoryLive } from "./CheckpointNavigation.ts";
import { CheckpointRetentionRepositoryLive } from "./CheckpointRetention.ts";
import { CheckpointTimelineRepositoryLive } from "./CheckpointTimeline.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { CheckpointCaptureJobRepository } from "../Services/CheckpointCaptureJobs.ts";
import { CheckpointNavigationRepository } from "../Services/CheckpointNavigation.ts";
import { CheckpointRetentionRepository } from "../Services/CheckpointRetention.ts";
import { CheckpointTimelineRepository } from "../Services/CheckpointTimeline.ts";

const layer = it.layer(
  Layer.mergeAll(
    CheckpointCaptureJobRepositoryLive,
    CheckpointTimelineRepositoryLive,
    CheckpointNavigationRepositoryLive,
    CheckpointRetentionRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const now = "2026-07-16T00:00:00.000Z";

layer("checkpoint durable state", (it) => {
  it.effect("deduplicates capture boundaries and serializes durable worktree leases", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointCaptureJobRepository;
      yield* repository.upsertRepository({
        repositoryKey: "repo-1",
        commonDirFingerprint: "fingerprint-1",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/repo-1.git",
        createdAt: now,
        lastUsedAt: now,
      });

      const first = yield* repository.enqueue({
        snapshot: {
          snapshotId: "snapshot-1",
          repositoryKey: "repo-1",
          worktreeKey: "worktree-a",
          kind: "turn",
          createdAt: now,
          expiresAt: null,
        },
        job: {
          jobId: "job-1",
          snapshotId: "snapshot-1",
          threadId: "thread-1",
          timelineGeneration: 0,
          turnId: "turn-1",
          providerTurnId: "provider-turn-1",
          turnOrdinal: 1,
          repositoryKey: "repo-1",
          worktreeKey: "worktree-a",
          requestedBoundary: "turn-completed",
          requestedGeneration: 4,
          createdAt: now,
        },
      });
      const duplicate = yield* repository.enqueue({
        snapshot: {
          snapshotId: "snapshot-orphan",
          repositoryKey: "repo-1",
          worktreeKey: "worktree-a",
          kind: "turn",
          createdAt: now,
          expiresAt: null,
        },
        job: {
          jobId: "job-duplicate",
          snapshotId: "snapshot-orphan",
          threadId: "thread-1",
          timelineGeneration: 0,
          turnId: "turn-1",
          providerTurnId: "provider-turn-1",
          turnOrdinal: 1,
          repositoryKey: "repo-1",
          worktreeKey: "worktree-a",
          requestedBoundary: "turn-completed",
          requestedGeneration: 4,
          createdAt: now,
        },
      });
      assert.equal(duplicate.jobId, first.jobId);
      assert.isTrue(
        Option.isNone(yield* repository.getSnapshot({ snapshotId: "snapshot-orphan" })),
      );

      yield* repository.enqueue({
        snapshot: {
          snapshotId: "snapshot-2",
          repositoryKey: "repo-1",
          worktreeKey: "worktree-a",
          kind: "turn",
          createdAt: "2026-07-16T00:00:01.000Z",
          expiresAt: null,
        },
        job: {
          jobId: "job-2",
          snapshotId: "snapshot-2",
          threadId: "thread-1",
          timelineGeneration: 0,
          turnId: "turn-2",
          providerTurnId: null,
          turnOrdinal: 2,
          repositoryKey: "repo-1",
          worktreeKey: "worktree-a",
          requestedBoundary: "turn-completed",
          requestedGeneration: 4,
          createdAt: "2026-07-16T00:00:01.000Z",
        },
      });
      yield* repository.enqueue({
        snapshot: {
          snapshotId: "snapshot-3",
          repositoryKey: "repo-1",
          worktreeKey: "worktree-b",
          kind: "turn",
          createdAt: "2026-07-16T00:00:02.000Z",
          expiresAt: null,
        },
        job: {
          jobId: "job-3",
          snapshotId: "snapshot-3",
          threadId: "thread-2",
          timelineGeneration: 0,
          turnId: "turn-3",
          providerTurnId: null,
          turnOrdinal: 1,
          repositoryKey: "repo-1",
          worktreeKey: "worktree-b",
          requestedBoundary: "turn-completed",
          requestedGeneration: 7,
          createdAt: "2026-07-16T00:00:02.000Z",
        },
      });

      const claimed = yield* repository.claimNext({
        leaseOwner: "worker-a",
        now,
        leaseExpiresAt: "2026-07-16T00:01:00.000Z",
      });
      assert.equal(Option.getOrThrow(claimed).jobId, "job-1");
      const concurrent = yield* repository.claimNext({
        leaseOwner: "worker-b",
        now,
        leaseExpiresAt: "2026-07-16T00:01:00.000Z",
      });
      assert.equal(Option.getOrThrow(concurrent).jobId, "job-3");
      assert.isTrue(
        Option.isNone(
          yield* repository.claimNext({
            leaseOwner: "worker-c",
            now,
            leaseExpiresAt: "2026-07-16T00:01:00.000Z",
          }),
        ),
      );
      assert.isTrue(
        yield* repository.complete({
          jobId: "job-1",
          leaseOwner: "worker-a",
          state: "ready",
          commitOid: "abc123",
          treeOid: "def456",
          errorCode: null,
          completedAt: "2026-07-16T00:00:02.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.complete({
          jobId: "job-3",
          leaseOwner: "worker-b",
          state: "contended",
          commitOid: null,
          treeOid: null,
          errorCode: "workspace-mutated",
          completedAt: "2026-07-16T00:00:02.000Z",
        }),
      );
      const next = yield* repository.claimNext({
        leaseOwner: "worker-b",
        now: "2026-07-16T00:00:03.000Z",
        leaseExpiresAt: "2026-07-16T00:01:03.000Z",
      });
      assert.equal(Option.getOrThrow(next).jobId, "job-2");
      assert.equal(yield* repository.reclaimExpired({ now: "2026-07-16T00:02:00.000Z" }), 1);
      const reclaimed = Option.getOrThrow(
        yield* repository.claimNext({
          leaseOwner: "worker-restarted",
          now: "2026-07-16T00:02:01.000Z",
          leaseExpiresAt: "2026-07-16T00:03:01.000Z",
        }),
      );
      assert.equal(reclaimed.jobId, "job-2");
      assert.equal(reclaimed.attemptCount, 2);
    }),
  );

  it.effect("reuses a contended turn snapshot for the next idle baseline retry", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointCaptureJobRepository;
      yield* repository.upsertRepository({
        repositoryKey: "repo-retry",
        commonDirFingerprint: "fingerprint-retry",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/repo-retry.git",
        createdAt: now,
        lastUsedAt: now,
      });
      yield* repository.enqueue({
        snapshot: {
          snapshotId: "snapshot-retry",
          repositoryKey: "repo-retry",
          worktreeKey: "worktree-retry",
          kind: "turn",
          createdAt: now,
          expiresAt: null,
        },
        job: {
          jobId: "job-turn-retry",
          snapshotId: "snapshot-retry",
          threadId: "thread-retry",
          timelineGeneration: 0,
          turnId: "turn-retry",
          providerTurnId: "provider-turn-retry",
          turnOrdinal: 1,
          repositoryKey: "repo-retry",
          worktreeKey: "worktree-retry",
          requestedBoundary: "turn-completed",
          requestedGeneration: 1,
          createdAt: now,
        },
      });
      const claimed = Option.getOrThrow(
        yield* repository.claimNext({
          leaseOwner: "worker-retry",
          now,
          leaseExpiresAt: "2026-07-16T00:01:00.000Z",
        }),
      );
      yield* repository.complete({
        jobId: claimed.jobId,
        leaseOwner: "worker-retry",
        state: "contended",
        commitOid: null,
        treeOid: null,
        errorCode: "workspace-mutated",
        completedAt: "2026-07-16T00:00:01.000Z",
      });

      const retried = yield* repository.enqueue({
        snapshot: {
          snapshotId: "snapshot-retry",
          repositoryKey: "repo-retry",
          worktreeKey: "worktree-retry",
          kind: "baseline",
          createdAt: "2026-07-16T00:00:02.000Z",
          expiresAt: null,
        },
        job: {
          jobId: "job-baseline-retry",
          snapshotId: "snapshot-retry",
          threadId: "thread-retry",
          timelineGeneration: 0,
          turnId: "baseline:thread-retry:1",
          providerTurnId: null,
          turnOrdinal: 1,
          repositoryKey: "repo-retry",
          worktreeKey: "worktree-retry",
          requestedBoundary: "pre-turn-baseline",
          requestedGeneration: 2,
          createdAt: "2026-07-16T00:00:02.000Z",
        },
      });

      assert.equal(retried.jobId, "job-turn-retry");
      assert.equal(retried.state, "pending");
      assert.equal(retried.requestedBoundary, "pre-turn-baseline");
      assert.equal(retried.turnId, "baseline:thread-retry:1");
      assert.equal(
        Option.getOrThrow(yield* repository.getSnapshot({ snapshotId: "snapshot-retry" })).state,
        "pending",
      );
    }),
  );

  it.effect("persists immutable entries, cursor generations, provider state, and saga phases", () =>
    Effect.gen(function* () {
      const captures = yield* CheckpointCaptureJobRepository;
      const timeline = yield* CheckpointTimelineRepository;
      const navigation = yield* CheckpointNavigationRepository;

      yield* captures.upsertRepository({
        repositoryKey: "repo-nav",
        commonDirFingerprint: "fingerprint-nav",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/repo-nav.git",
        createdAt: now,
        lastUsedAt: now,
      });
      yield* captures.enqueue({
        snapshot: {
          snapshotId: "snapshot-nav",
          repositoryKey: "repo-nav",
          worktreeKey: "worktree-nav",
          kind: "turn",
          createdAt: now,
          expiresAt: null,
        },
        job: {
          jobId: "job-nav",
          snapshotId: "snapshot-nav",
          threadId: "thread-nav",
          timelineGeneration: 0,
          turnId: "turn-nav",
          providerTurnId: "provider-turn-nav",
          turnOrdinal: 0,
          repositoryKey: "repo-nav",
          worktreeKey: "worktree-nav",
          requestedBoundary: "baseline",
          requestedGeneration: 0,
          createdAt: now,
        },
      });
      yield* timeline.createGeneration({
        threadId: "thread-nav",
        generation: 0,
        parentGeneration: null,
        forkedFromEntryId: null,
        state: "active",
        createdAt: now,
        abandonedAt: null,
        deleteAfter: null,
      });
      const entry = yield* timeline.appendEntry({
        entryId: "entry-nav",
        threadId: "thread-nav",
        timelineGeneration: 0,
        ordinal: 0,
        turnId: "turn-nav",
        providerTurnId: "provider-turn-nav",
        snapshotId: "snapshot-nav",
        providerBindingJson: '{"provider":"codex","version":1,"sessionId":"s"}',
        providerCursorJson: '{"provider":"codex","version":1,"nativeTurnId":"t"}',
        assistantMessageId: null,
        completedAt: now,
        state: "pending",
        createdAt: now,
      });
      assert.equal(entry.providerCursorJson.includes("nativeTurnId"), true);
      yield* timeline.initializeCursor({
        threadId: "thread-nav",
        activeGeneration: 0,
        currentEntryId: "entry-nav",
        currentOrdinal: 0,
        forwardTipEntryId: "entry-nav",
        forwardTipOrdinal: 0,
        navigationVersion: 0,
        updatedAt: now,
      });
      assert.isTrue(
        yield* timeline.moveCursor({
          threadId: "thread-nav",
          expectedNavigationVersion: 0,
          activeGeneration: 0,
          currentEntryId: null,
          currentOrdinal: null,
          forwardTipEntryId: "entry-nav",
          forwardTipOrdinal: 0,
          updatedAt: "2026-07-16T00:00:01.000Z",
        }),
      );
      assert.isFalse(
        yield* timeline.moveCursor({
          threadId: "thread-nav",
          expectedNavigationVersion: 0,
          activeGeneration: 0,
          currentEntryId: "entry-nav",
          currentOrdinal: 0,
          forwardTipEntryId: "entry-nav",
          forwardTipOrdinal: 0,
          updatedAt: "2026-07-16T00:00:02.000Z",
        }),
      );
      yield* timeline.upsertProviderBinding({
        threadId: "thread-nav",
        providerBindingJson: '{"provider":"codex","version":1,"sessionId":"s"}',
        bindingVersion: 1,
        updatedAt: now,
      });
      assert.equal(
        Option.getOrThrow(yield* timeline.getProviderBinding({ threadId: "thread-nav" }))
          .bindingVersion,
        1,
      );

      const operation = yield* navigation.begin({
        operationId: "operation-nav",
        commandId: "command-nav",
        threadId: "thread-nav",
        kind: "undo",
        mode: "full",
        fromEntryId: "entry-nav",
        toEntryId: "entry-nav",
        rescueSnapshotId: null,
        oldProviderBindingJson: '{"provider":"codex","version":1,"sessionId":"s"}',
        targetProviderBindingJson: '{"provider":"codex","version":1,"sessionId":"fork"}',
        preparedProviderCursorJson: '{"provider":"codex","version":1,"nativeTurnId":"target"}',
        phase: "prepared",
        recoveryFromPhase: null,
        failureCode: null,
        compensationFailureCode: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });
      assert.equal(operation.phase, "prepared");
      const duplicate = yield* navigation.begin({
        ...operation,
        operationId: "operation-nav-duplicate",
        mode: "files-only",
      });
      assert.equal(duplicate.operationId, "operation-nav");
      assert.equal(duplicate.mode, "full");
      assert.equal(
        Option.getOrThrow(yield* navigation.getByCommandId({ commandId: "command-nav" })).mode,
        "full",
      );
      assert.isTrue(
        yield* navigation.advancePhase({
          operationId: "operation-nav",
          expectedPhase: "prepared",
          phase: "rescue-ready",
          rescueSnapshotId: "snapshot-nav",
          updatedAt: "2026-07-16T00:00:03.000Z",
        }),
      );
      assert.isTrue(
        yield* navigation.advancePhase({
          operationId: "operation-nav",
          expectedPhase: "rescue-ready",
          phase: "needs-recovery",
          recoveryFromPhase: "compensating-filesystem",
          compensationFailureCode: "filesystem-compensation-failed",
          updatedAt: "2026-07-16T00:00:04.000Z",
        }),
      );
      const recoverable = yield* navigation.listRecoverable();
      assert.equal(recoverable.length, 1);
      assert.equal(recoverable[0]?.mode, "full");
      assert.equal(recoverable[0]?.phase, "needs-recovery");
      assert.equal(recoverable[0]?.recoveryFromPhase, "compensating-filesystem");
    }),
  );

  it.effect("lists a generation lineage bounded by every ancestor fork point", () =>
    Effect.gen(function* () {
      const captures = yield* CheckpointCaptureJobRepository;
      const timeline = yield* CheckpointTimelineRepository;
      yield* captures.upsertRepository({
        repositoryKey: "repo-lineage",
        commonDirFingerprint: "fingerprint-lineage",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/repo-lineage.git",
        createdAt: now,
        lastUsedAt: now,
      });
      yield* captures.enqueue({
        snapshot: {
          snapshotId: "snapshot-lineage",
          repositoryKey: "repo-lineage",
          worktreeKey: "worktree-lineage",
          kind: "turn",
          createdAt: now,
          expiresAt: null,
        },
        job: {
          jobId: "job-lineage",
          snapshotId: "snapshot-lineage",
          threadId: "thread-lineage",
          timelineGeneration: 0,
          turnId: "capture-lineage",
          providerTurnId: "capture-provider-lineage",
          turnOrdinal: 0,
          repositoryKey: "repo-lineage",
          worktreeKey: "worktree-lineage",
          requestedBoundary: "baseline",
          requestedGeneration: 0,
          createdAt: now,
        },
      });
      yield* timeline.createGeneration({
        threadId: "thread-lineage",
        generation: 0,
        parentGeneration: null,
        forkedFromEntryId: null,
        state: "abandoned",
        createdAt: now,
        abandonedAt: now,
        deleteAfter: null,
      });
      for (const ordinal of [0, 1, 2, 3, 4]) {
        yield* timeline.appendEntry({
          entryId: `lineage-0-${ordinal}`,
          threadId: "thread-lineage",
          timelineGeneration: 0,
          ordinal,
          turnId: `lineage-turn-0-${ordinal}`,
          providerTurnId: ordinal === 0 ? null : `lineage-provider-0-${ordinal}`,
          snapshotId: "snapshot-lineage",
          providerBindingJson: "{}",
          providerCursorJson: "{}",
          assistantMessageId: null,
          completedAt: now,
          state: "ready",
          createdAt: now,
        });
      }
      yield* timeline.createGeneration({
        threadId: "thread-lineage",
        generation: 1,
        parentGeneration: 0,
        forkedFromEntryId: "lineage-0-2",
        state: "abandoned",
        createdAt: now,
        abandonedAt: now,
        deleteAfter: null,
      });
      for (const ordinal of [3, 4]) {
        yield* timeline.appendEntry({
          entryId: `lineage-1-${ordinal}`,
          threadId: "thread-lineage",
          timelineGeneration: 1,
          ordinal,
          turnId: `lineage-turn-1-${ordinal}`,
          providerTurnId: `lineage-provider-1-${ordinal}`,
          snapshotId: "snapshot-lineage",
          providerBindingJson: "{}",
          providerCursorJson: "{}",
          assistantMessageId: null,
          completedAt: now,
          state: "ready",
          createdAt: now,
        });
      }
      yield* timeline.createGeneration({
        threadId: "thread-lineage",
        generation: 2,
        parentGeneration: 1,
        forkedFromEntryId: "lineage-1-3",
        state: "active",
        createdAt: now,
        abandonedAt: null,
        deleteAfter: null,
      });
      yield* timeline.appendEntry({
        entryId: "lineage-2-4",
        threadId: "thread-lineage",
        timelineGeneration: 2,
        ordinal: 4,
        turnId: "lineage-turn-2-4",
        providerTurnId: "lineage-provider-2-4",
        snapshotId: "snapshot-lineage",
        providerBindingJson: "{}",
        providerCursorJson: "{}",
        assistantMessageId: null,
        completedAt: now,
        state: "ready",
        createdAt: now,
      });

      const lineage = yield* timeline.listGenerationLineage({
        threadId: "thread-lineage",
        generation: 2,
      });
      assert.deepStrictEqual(
        lineage.map((entry) => entry.entryId),
        ["lineage-0-0", "lineage-0-1", "lineage-0-2", "lineage-1-3", "lineage-2-4"],
      );
    }),
  );

  it.effect("claims retention deletion once", () =>
    Effect.gen(function* () {
      const captures = yield* CheckpointCaptureJobRepository;
      const retention = yield* CheckpointRetentionRepository;
      const retentionCreatedAt = "2025-07-16T00:00:00.000Z";
      yield* captures.upsertRepository({
        repositoryKey: "repo-retention",
        commonDirFingerprint: "fingerprint-retention",
        objectFormat: "sha1",
        sidecarRelativePath: "repositories/repo-retention.git",
        createdAt: retentionCreatedAt,
        lastUsedAt: retentionCreatedAt,
      });
      yield* captures.enqueue({
        snapshot: {
          snapshotId: "snapshot-retention",
          repositoryKey: "repo-retention",
          worktreeKey: "worktree-retention",
          kind: "rescue",
          createdAt: retentionCreatedAt,
          expiresAt: now,
        },
        job: {
          jobId: "job-retention",
          snapshotId: "snapshot-retention",
          threadId: "thread-retention",
          timelineGeneration: 0,
          turnId: "turn-retention",
          providerTurnId: null,
          turnOrdinal: 0,
          repositoryKey: "repo-retention",
          worktreeKey: "worktree-retention",
          requestedBoundary: "rescue",
          requestedGeneration: 0,
          createdAt: retentionCreatedAt,
        },
      });
      const claimed = Option.getOrThrow(
        yield* captures.claimNext({
          leaseOwner: "retention-worker",
          now,
          leaseExpiresAt: "2026-07-16T00:01:00.000Z",
        }),
      );
      yield* captures.complete({
        jobId: claimed.jobId,
        leaseOwner: "retention-worker",
        state: "contended",
        commitOid: null,
        treeOid: null,
        errorCode: "workspace-mutated",
        completedAt: now,
      });
      yield* retention.scheduleSnapshotDeletion({
        snapshotId: "snapshot-retention",
        retentionClass: "rescue",
        deleteAfter: now,
      });
      assert.equal((yield* retention.listDeletionCandidates({ now, limit: 10 })).length, 1);
      assert.isTrue(
        yield* retention.markDeletionStarted({ snapshotId: "snapshot-retention", now }),
      );
      assert.isFalse(
        yield* retention.markDeletionStarted({ snapshotId: "snapshot-retention", now }),
      );
    }),
  );
});
