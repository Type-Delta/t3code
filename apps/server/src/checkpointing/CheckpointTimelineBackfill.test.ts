import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointCaptureJobRepositoryLive } from "../persistence/Layers/CheckpointCaptureJobs.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CheckpointTimelineRepositoryLive } from "../persistence/Layers/CheckpointTimeline.ts";
import { CheckpointCaptureJobRepository } from "../persistence/Services/CheckpointCaptureJobs.ts";
import { CheckpointTimelineRepository } from "../persistence/Services/CheckpointTimeline.ts";
import { ProviderConversationNavigation } from "../provider/Services/ProviderConversationNavigation.ts";
import { ProviderUnsupportedError } from "../provider/Errors.ts";
import { sidecarCheckpointRef } from "./SidecarCheckpointRepository.ts";
import { CheckpointTimelineBackfill, layer } from "./CheckpointTimelineBackfill.ts";

const repositoryKey = "a".repeat(64);
const worktreeKey = "b".repeat(64);
const snapshotId = "legacy-ready-snapshot";
const now = "2026-07-16T00:00:00.000Z";
const threadId = ThreadId.make("backfill-thread");
let bindingUnavailable = false;
const encodeOpaqueJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

const persistence = Layer.mergeAll(
  CheckpointCaptureJobRepositoryLive,
  CheckpointTimelineRepositoryLive,
).pipe(Layer.provide(SqlitePersistenceMemory));

const dependencies = Layer.mergeAll(
  persistence,
  Layer.succeed(ProjectionSnapshotQuery, {
    getSnapshot: () =>
      Effect.succeed({
        threads: [
          {
            id: threadId,
            checkpoints: [
              {
                turnId: TurnId.make("turn-1"),
                checkpointTurnCount: 1,
                checkpointRef: sidecarCheckpointRef({ repositoryKey, worktreeKey }, snapshotId),
                status: "ready",
                files: [],
                assistantMessageId: MessageId.make("assistant-1"),
                completedAt: now,
              },
            ],
          },
        ],
      } as never),
  } as unknown as ProjectionSnapshotQuery["Service"]),
  Layer.succeed(ProviderConversationNavigation, {
    getBinding: () =>
      bindingUnavailable
        ? Effect.fail(new ProviderUnsupportedError({ provider: "binding-unavailable" }))
        : Effect.succeed({
            schemaVersion: 1 as const,
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            payload: { threadId: "native-thread" },
          }),
  } as unknown as ProviderConversationNavigation["Service"]),
);

const TestLayer = layer.pipe(Layer.provideMerge(dependencies));

it.effect("idempotently initializes existing threads at their latest ready sidecar", () =>
  Effect.gen(function* () {
    bindingUnavailable = false;
    const captures = yield* CheckpointCaptureJobRepository;
    const timeline = yield* CheckpointTimelineRepository;
    const backfill = yield* CheckpointTimelineBackfill;
    yield* captures.upsertRepository({
      repositoryKey,
      commonDirFingerprint: repositoryKey,
      objectFormat: "sha1",
      sidecarRelativePath: `repositories/${repositoryKey}.git`,
      createdAt: now,
      lastUsedAt: now,
    });
    yield* captures.enqueue({
      snapshot: {
        snapshotId,
        repositoryKey,
        worktreeKey,
        kind: "legacy-import",
        createdAt: now,
        expiresAt: null,
      },
      job: {
        jobId: "backfill-job",
        snapshotId,
        threadId,
        timelineGeneration: 0,
        turnId: "turn-1",
        providerTurnId: null,
        turnOrdinal: 1,
        repositoryKey,
        worktreeKey,
        requestedBoundary: "legacy-import",
        requestedGeneration: 0,
        createdAt: now,
      },
    });
    const claimed = yield* captures.claimNext({
      leaseOwner: "backfill-test",
      now,
      leaseExpiresAt: "2026-07-16T00:01:00.000Z",
    });
    assert.isTrue(Option.isSome(claimed));
    yield* captures.complete({
      jobId: "backfill-job",
      leaseOwner: "backfill-test",
      state: "ready",
      commitOid: "c".repeat(40),
      treeOid: "d".repeat(40),
      errorCode: null,
      completedAt: now,
    });

    assert.equal((yield* captures.listReadyWithoutTimelineEntry({ limit: 10 })).length, 1);
    assert.equal(yield* backfill.run(), 1);
    assert.equal(yield* backfill.run(), 0);
    const cursor = yield* timeline.getCursor({ threadId });
    assert.isTrue(Option.isSome(cursor));
    if (Option.isSome(cursor)) {
      assert.equal(cursor.value.currentOrdinal, 1);
      assert.equal(cursor.value.forwardTipOrdinal, 1);
    }
    const entries = yield* timeline.listGeneration({ threadId, generation: 0 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.providerTurnId, null);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("repairs a missing ready publication after restart with an existing cursor", () =>
  Effect.gen(function* () {
    bindingUnavailable = false;
    const captures = yield* CheckpointCaptureJobRepository;
    const timeline = yield* CheckpointTimelineRepository;
    const backfill = yield* CheckpointTimelineBackfill;
    yield* captures.upsertRepository({
      repositoryKey,
      commonDirFingerprint: repositoryKey,
      objectFormat: "sha1",
      sidecarRelativePath: `repositories/${repositoryKey}.git`,
      createdAt: now,
      lastUsedAt: now,
    });

    const completeReady = Effect.fn("completeReady")(function* (input: {
      readonly jobId: string;
      readonly snapshotId: string;
      readonly turnId: string;
      readonly providerTurnId: string;
      readonly ordinal: number;
      readonly completedAt: string;
    }) {
      yield* captures.enqueue({
        snapshot: {
          snapshotId: input.snapshotId,
          repositoryKey,
          worktreeKey,
          kind: "turn",
          createdAt: input.completedAt,
          expiresAt: null,
        },
        job: {
          jobId: input.jobId,
          snapshotId: input.snapshotId,
          threadId,
          timelineGeneration: 0,
          turnId: input.turnId,
          providerTurnId: input.providerTurnId,
          turnOrdinal: input.ordinal,
          repositoryKey,
          worktreeKey,
          requestedBoundary: "turn-completed",
          requestedGeneration: 0,
          createdAt: input.completedAt,
        },
      });
      const claimed = yield* captures.claimNext({
        leaseOwner: `repair-${input.jobId}`,
        now: input.completedAt,
        leaseExpiresAt: "2026-07-16T00:10:00.000Z",
      });
      assert.isTrue(Option.isSome(claimed));
      assert.isTrue(
        yield* captures.complete({
          jobId: input.jobId,
          leaseOwner: `repair-${input.jobId}`,
          state: "ready",
          commitOid: "c".repeat(40),
          treeOid: "d".repeat(40),
          errorCode: null,
          completedAt: input.completedAt,
        }),
      );
    });

    yield* completeReady({
      jobId: "repair-job-1",
      snapshotId: "repair-snapshot-1",
      turnId: "repair-turn-1",
      providerTurnId: "repair-provider-turn-1",
      ordinal: 1,
      completedAt: now,
    });
    assert.equal(yield* backfill.run(), 1);
    const initialCursor = Option.getOrThrow(yield* timeline.getCursor({ threadId }));
    assert.equal(initialCursor.currentOrdinal, 1);

    yield* completeReady({
      jobId: "repair-job-2",
      snapshotId: "repair-snapshot-2",
      turnId: "repair-turn-2",
      providerTurnId: "repair-provider-turn-2",
      ordinal: 2,
      completedAt: "2026-07-16T00:00:02.000Z",
    });
    bindingUnavailable = true;
    assert.equal(yield* backfill.run(), 0);
    assert.equal((yield* captures.listReadyWithoutTimelineEntry({ limit: 10 })).length, 1);
    assert.equal((yield* timeline.listGeneration({ threadId, generation: 0 })).length, 1);
    assert.equal(Option.getOrThrow(yield* timeline.getCursor({ threadId })).currentOrdinal, 1);

    // A fresh startup scan has no in-memory dependency on the failed observer attempt.
    bindingUnavailable = false;
    assert.equal(yield* backfill.run(), 1);
    assert.equal(yield* backfill.run(), 0);
    const entries = yield* timeline.listGeneration({ threadId, generation: 0 });
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.providerTurnId, "repair-provider-turn-2");
    assert.equal(entries.filter((entry) => entry.snapshotId === "repair-snapshot-2").length, 1);
    const repairedCursor = Option.getOrThrow(yield* timeline.getCursor({ threadId }));
    assert.equal(repairedCursor.currentOrdinal, 2);
    assert.equal(repairedCursor.forwardTipOrdinal, 2);
    assert.equal(repairedCursor.navigationVersion, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("publishes the provider binding frozen when the capture was enqueued", () =>
  Effect.gen(function* () {
    bindingUnavailable = false;
    const captures = yield* CheckpointCaptureJobRepository;
    const timeline = yield* CheckpointTimelineRepository;
    const backfill = yield* CheckpointTimelineBackfill;
    yield* captures.upsertRepository({
      repositoryKey,
      commonDirFingerprint: repositoryKey,
      objectFormat: "sha1",
      sidecarRelativePath: `repositories/${repositoryKey}.git`,
      createdAt: now,
      lastUsedAt: now,
    });
    const providerBindingJson = yield* encodeOpaqueJson({
      schemaVersion: 1,
      threadId,
      provider: "codex",
      providerInstanceId: "codex",
      payload: { threadId: "native-thread-at-enqueue" },
    });
    const providerCursorJson = yield* encodeOpaqueJson({
      schemaVersion: 1,
      provider: "codex",
      providerInstanceId: "codex",
      providerTurnId: "native-turn-at-enqueue",
    });
    yield* captures.enqueue({
      snapshot: {
        snapshotId: "frozen-binding-snapshot",
        repositoryKey,
        worktreeKey,
        kind: "turn",
        createdAt: now,
        expiresAt: null,
      },
      job: {
        jobId: "frozen-binding-job",
        snapshotId: "frozen-binding-snapshot",
        threadId,
        timelineGeneration: 0,
        turnId: "frozen-binding-turn",
        providerTurnId: "native-turn-at-enqueue",
        providerBindingJson,
        providerCursorJson,
        turnOrdinal: 1,
        repositoryKey,
        worktreeKey,
        requestedBoundary: "turn-completed",
        requestedGeneration: 0,
        createdAt: now,
      },
    });
    assert.isTrue(
      Option.isSome(
        yield* captures.claimNext({
          leaseOwner: "frozen-binding-worker",
          now,
          leaseExpiresAt: "2026-07-16T00:01:00.000Z",
        }),
      ),
    );
    yield* captures.complete({
      jobId: "frozen-binding-job",
      leaseOwner: "frozen-binding-worker",
      state: "ready",
      commitOid: "c".repeat(40),
      treeOid: "d".repeat(40),
      errorCode: null,
      completedAt: now,
    });

    // Simulate the session binding changing or disappearing while Git capture
    // was in flight. Publication must not query the later provider state.
    bindingUnavailable = true;
    assert.equal(yield* backfill.run(), 1);
    const entries = yield* timeline.listGeneration({ threadId, generation: 0 });
    assert.equal(entries[0]?.providerBindingJson, providerBindingJson);
    assert.equal(entries[0]?.providerCursorJson, providerCursorJson);
  }).pipe(Effect.provide(TestLayer)),
);
