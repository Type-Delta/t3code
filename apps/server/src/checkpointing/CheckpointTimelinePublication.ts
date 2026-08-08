// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { ThreadId, type MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CheckpointCaptureJob } from "../persistence/Services/CheckpointCaptureJobs.ts";
import type { CheckpointTimelineRepository } from "../persistence/Services/CheckpointTimeline.ts";
import type { ProviderConversationNavigation } from "../provider/Services/ProviderConversationNavigation.ts";

export class CheckpointTimelinePublicationError extends Schema.TaggedErrorClass<CheckpointTimelinePublicationError>()(
  "CheckpointTimelinePublicationError",
  {
    code: Schema.String,
    threadId: Schema.String,
    jobId: Schema.String,
  },
) {}

const encodeOpaqueJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const checkpointEntryIdFor = (snapshotId: string) =>
  `snapshot-${NodeCrypto.createHash("sha256").update(`entry\0${snapshotId}`).digest("hex")}`;

/** Idempotently publishes one durable ready capture into the navigable timeline. */
export const publishCheckpointTimelineEntry = Effect.fn("publishCheckpointTimelineEntry")(
  function* (input: {
    readonly job: CheckpointCaptureJob;
    readonly assistantMessageId: MessageId | null;
    readonly providerNavigation: ProviderConversationNavigation["Service"] | undefined;
    readonly timeline: CheckpointTimelineRepository["Service"];
  }) {
    const { job, timeline } = input;
    const threadId = ThreadId.make(job.threadId);
    if (
      input.providerNavigation === undefined &&
      (job.providerBindingJson === null || job.providerCursorJson === null)
    ) {
      return yield* new CheckpointTimelinePublicationError({
        code: "provider-navigation-unavailable",
        threadId: job.threadId,
        jobId: job.jobId,
      });
    }

    const [providerBindingJson, providerCursorJson] =
      job.providerBindingJson !== null && job.providerCursorJson !== null
        ? [job.providerBindingJson, job.providerCursorJson]
        : yield* input.providerNavigation!.getBinding(threadId).pipe(
            Effect.flatMap((binding) =>
              Effect.all([
                encodeOpaqueJson(binding),
                encodeOpaqueJson({
                  schemaVersion: 1,
                  provider: binding.provider,
                  providerInstanceId: binding.providerInstanceId,
                  providerTurnId: job.providerTurnId,
                }),
              ]),
            ),
          );

    const generation = yield* timeline.getGeneration({
      threadId: job.threadId,
      generation: job.timelineGeneration,
    });
    if (Option.isNone(generation)) {
      if (job.timelineGeneration !== 0) {
        return yield* new CheckpointTimelinePublicationError({
          code: "timeline-generation-missing",
          threadId: job.threadId,
          jobId: job.jobId,
        });
      }
      yield* timeline.createGeneration({
        threadId: job.threadId,
        generation: 0,
        parentGeneration: null,
        forkedFromEntryId: null,
        state: "active",
        createdAt: job.createdAt,
        abandonedAt: null,
        deleteAfter: null,
      });
    }

    const entry = yield* timeline.appendEntry({
      entryId: checkpointEntryIdFor(job.snapshotId),
      threadId: job.threadId,
      timelineGeneration: job.timelineGeneration,
      ordinal: job.turnOrdinal,
      turnId: job.turnId,
      providerTurnId: job.providerTurnId,
      snapshotId: job.snapshotId,
      providerBindingJson,
      providerCursorJson,
      assistantMessageId: input.assistantMessageId,
      completedAt: job.completedAt ?? job.createdAt,
      state: "ready",
      createdAt: job.createdAt,
    });
    const cursorOption = yield* timeline.getCursor({ threadId: job.threadId });
    if (Option.isNone(cursorOption)) {
      yield* timeline.initializeCursor({
        threadId: job.threadId,
        activeGeneration: job.timelineGeneration,
        currentEntryId: entry.entryId,
        currentOrdinal: entry.ordinal,
        forwardTipEntryId: entry.entryId,
        forwardTipOrdinal: entry.ordinal,
        navigationVersion: 0,
        updatedAt: job.completedAt ?? job.createdAt,
      });
    } else {
      const cursor = cursorOption.value;
      if (
        cursor.activeGeneration === job.timelineGeneration &&
        cursor.currentOrdinal === cursor.forwardTipOrdinal &&
        cursor.forwardTipEntryId !== entry.entryId &&
        (cursor.forwardTipOrdinal === null || entry.ordinal >= cursor.forwardTipOrdinal)
      ) {
        yield* timeline.moveCursor({
          threadId: job.threadId,
          expectedNavigationVersion: cursor.navigationVersion,
          activeGeneration: cursor.activeGeneration,
          currentEntryId: entry.entryId,
          currentOrdinal: entry.ordinal,
          forwardTipEntryId: entry.entryId,
          forwardTipOrdinal: entry.ordinal,
          updatedAt: job.completedAt ?? job.createdAt,
        });
      }
    }
    const publishedCursor = yield* timeline.getCursor({ threadId: job.threadId });
    yield* timeline.upsertProviderBinding({
      threadId: job.threadId,
      providerBindingJson,
      bindingVersion: Option.match(publishedCursor, {
        onNone: () => 0,
        onSome: (cursor) => cursor.navigationVersion,
      }),
      updatedAt: job.completedAt ?? job.createdAt,
    });
    return entry;
  },
);
