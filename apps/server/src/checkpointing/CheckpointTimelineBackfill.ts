import { ThreadId, type OrchestrationThread } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointCaptureJobRepository } from "../persistence/Services/CheckpointCaptureJobs.ts";
import { CheckpointTimelineRepository } from "../persistence/Services/CheckpointTimeline.ts";
import { ProviderConversationNavigation } from "../provider/Services/ProviderConversationNavigation.ts";
import { sidecarSnapshotId } from "./SidecarCheckpointRepository.ts";
import { publishCheckpointTimelineEntry } from "./CheckpointTimelinePublication.ts";

export class CheckpointTimelineBackfill extends Context.Service<
  CheckpointTimelineBackfill,
  { readonly run: () => Effect.Effect<number> }
>()("t3/checkpointing/CheckpointTimelineBackfill") {}

const encodeOpaqueJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;
  const captures = yield* CheckpointCaptureJobRepository;
  const timeline = yield* CheckpointTimelineRepository;
  const provider = yield* ProviderConversationNavigation;

  const repairReadyCaptures = Effect.fn("CheckpointTimelineBackfill.repairReadyCaptures")(
    function* (threads: ReadonlyArray<OrchestrationThread>) {
      const jobs = yield* captures.listReadyWithoutTimelineEntry({ limit: 1_000 });
      let repaired = 0;
      for (const job of jobs) {
        const thread = threads.find((candidate) => candidate.id === job.threadId);
        const assistantMessageId =
          (thread?.messages ?? [])
            .toReversed()
            .find((message) => message.role === "assistant" && message.turnId === job.turnId)?.id ??
          null;
        const published = yield* publishCheckpointTimelineEntry({
          job,
          assistantMessageId,
          providerNavigation: provider,
          timeline,
        }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Ready checkpoint timeline repair deferred", {
              threadId: job.threadId,
              jobId: job.jobId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (published) repaired += 1;
      }
      return repaired;
    },
  );

  const backfillThread = Effect.fn("CheckpointTimelineBackfill.backfillThread")(function* (
    thread: OrchestrationThread,
  ) {
    if (Option.isSome(yield* timeline.getCursor({ threadId: thread.id }))) return false;
    const candidates = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.status !== "ready") continue;
      const snapshotId = sidecarSnapshotId(checkpoint.checkpointRef);
      if (snapshotId === undefined) continue;
      const snapshot = yield* captures.getSnapshot({ snapshotId });
      if (Option.isNone(snapshot) || snapshot.value.state !== "ready") continue;
      candidates.push({ checkpoint, snapshotId });
    }
    if (candidates.length === 0) return false;

    const binding = yield* provider.getBinding(ThreadId.make(thread.id));
    const providerBindingJson = yield* encodeOpaqueJson(binding);
    const ordered = candidates.toSorted(
      (left, right) => left.checkpoint.checkpointTurnCount - right.checkpoint.checkpointTurnCount,
    );
    yield* timeline.createGeneration({
      threadId: thread.id,
      generation: 0,
      parentGeneration: null,
      forkedFromEntryId: null,
      state: "active",
      createdAt: ordered[0]!.checkpoint.completedAt,
      abandonedAt: null,
      deleteAfter: null,
    });
    let latestEntryId: string | null = null;
    let latestOrdinal: number | null = null;
    for (const { checkpoint, snapshotId } of ordered) {
      const entry = yield* timeline.appendEntry({
        entryId: `entry-backfill-${snapshotId}`,
        threadId: thread.id,
        timelineGeneration: 0,
        ordinal: checkpoint.checkpointTurnCount,
        turnId: checkpoint.turnId,
        providerTurnId: null,
        snapshotId,
        providerBindingJson,
        providerCursorJson: yield* encodeOpaqueJson({
          schemaVersion: 1,
          provider: binding.provider,
          providerInstanceId: binding.providerInstanceId,
          providerTurnId: null,
        }),
        assistantMessageId: checkpoint.assistantMessageId,
        completedAt: checkpoint.completedAt,
        state: "ready",
        createdAt: checkpoint.completedAt,
      });
      latestEntryId = entry.entryId;
      latestOrdinal = entry.ordinal;
    }
    const updatedAt = ordered.at(-1)!.checkpoint.completedAt;
    const cursor = yield* timeline.initializeCursor({
      threadId: thread.id,
      activeGeneration: 0,
      currentEntryId: latestEntryId,
      currentOrdinal: latestOrdinal,
      forwardTipEntryId: latestEntryId,
      forwardTipOrdinal: latestOrdinal,
      navigationVersion: 0,
      updatedAt,
    });
    yield* timeline.upsertProviderBinding({
      threadId: thread.id,
      providerBindingJson,
      bindingVersion: cursor.navigationVersion,
      updatedAt,
    });
    return true;
  });

  const run = Effect.fn("CheckpointTimelineBackfill.run")(
    function* () {
      const snapshot = yield* projections.getSnapshot();
      let completed = yield* repairReadyCaptures(snapshot.threads);
      for (const thread of snapshot.threads) {
        const result = yield* backfillThread(thread).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Checkpoint timeline backfill skipped a thread", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (result) completed += 1;
      }
      return completed;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Checkpoint timeline backfill failed", { cause }).pipe(Effect.as(0)),
    ),
  );

  return CheckpointTimelineBackfill.of({ run });
});

export const layer = Layer.effect(CheckpointTimelineBackfill, make);
