import {
  DEFAULT_CHECKPOINT_NAVIGATION_STATE,
  ThreadId,
  type OrchestrationCheckpointNavigationState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CheckpointNavigationRepository } from "../persistence/Services/CheckpointNavigation.ts";
import { CheckpointTimelineRepository } from "../persistence/Services/CheckpointTimeline.ts";
import type {
  ThreadCheckpointCursor,
  ThreadCheckpointEntry,
} from "../persistence/Services/CheckpointTimeline.ts";
import type { ProviderConversationNavigationMode } from "../provider/Services/ProviderAdapter.ts";
import { ProviderConversationNavigation } from "../provider/Services/ProviderConversationNavigation.ts";

export interface CheckpointNavigationAvailabilityShape {
  readonly get: (threadId: ThreadId) => Effect.Effect<OrchestrationCheckpointNavigationState>;
}

/**
 * Read-only availability projection with a safe default. Keeping this as a
 * Reference lets snapshot queries decode older databases and run in narrow
 * tests without pulling the navigation mutation saga into their layer graph.
 */
export class CheckpointNavigationAvailability extends Context.Reference<CheckpointNavigationAvailabilityShape>(
  "t3/checkpointing/CheckpointNavigationAvailability",
  {
    defaultValue: () => ({
      get: () => Effect.succeed(DEFAULT_CHECKPOINT_NAVIGATION_STATE),
    }),
  },
) {}

export function computeCheckpointNavigationAvailability(input: {
  readonly capability: ProviderConversationNavigationMode;
  readonly cursor: ThreadCheckpointCursor;
  readonly entries: ReadonlyArray<ThreadCheckpointEntry>;
  readonly isNavigating: boolean;
}): OrchestrationCheckpointNavigationState {
  const entries = input.entries.toSorted((left, right) => left.ordinal - right.ordinal);
  const latestEntry = entries.at(-1);
  const latestCheckpointBlockingStatus =
    latestEntry?.state === "pending" ||
    latestEntry?.state === "contended" ||
    latestEntry?.state === "error"
      ? latestEntry.state
      : null;
  const navigableReadyEntries = entries.filter(
    (entry) => entry.state === "ready" && entry.providerTurnId !== null,
  );
  const hasLegacyReadyCandidate = entries.some(
    (entry) =>
      entry.state === "ready" &&
      entry.providerTurnId === null &&
      (input.cursor.currentOrdinal === null || entry.ordinal !== input.cursor.currentOrdinal),
  );
  const hasUndoTarget = navigableReadyEntries.some(
    (entry) => input.cursor.currentOrdinal !== null && entry.ordinal < input.cursor.currentOrdinal,
  );
  const hasFilesystemUndoTarget = entries.some(
    (entry) =>
      entry.state === "ready" &&
      input.cursor.currentOrdinal !== null &&
      entry.ordinal < input.cursor.currentOrdinal,
  );
  const hasRedoTarget = navigableReadyEntries.some(
    (entry) =>
      (input.cursor.currentOrdinal === null || entry.ordinal > input.cursor.currentOrdinal) &&
      (input.cursor.forwardTipOrdinal === null || entry.ordinal <= input.cursor.forwardTipOrdinal),
  );
  const providerCanBranch = input.capability === "branching";
  const blocked =
    input.isNavigating ||
    latestCheckpointBlockingStatus === "pending" ||
    latestCheckpointBlockingStatus === "contended";
  const canUndo = !blocked && (providerCanBranch ? hasUndoTarget : hasFilesystemUndoTarget);
  const canRedo = providerCanBranch && !blocked && hasRedoTarget;
  const reason = input.isNavigating
    ? "Checkpoint navigation is already in progress."
    : latestCheckpointBlockingStatus === "pending"
      ? "The latest checkpoint is still pending."
      : latestCheckpointBlockingStatus === "contended"
        ? "The latest checkpoint is contended by another workspace mutation."
        : canUndo || canRedo
          ? null
          : latestCheckpointBlockingStatus === "error" &&
              !hasUndoTarget &&
              !hasRedoTarget &&
              !hasFilesystemUndoTarget
            ? "The latest checkpoint capture failed."
            : providerCanBranch && !hasUndoTarget && !hasRedoTarget && hasLegacyReadyCandidate
              ? "Migrated checkpoints without provider conversation metadata cannot be navigated safely."
              : !providerCanBranch && !hasFilesystemUndoTarget
                ? "No earlier ready checkpoint is available for a files-only restore."
                : !hasUndoTarget && !hasRedoTarget
                  ? "No checkpoint navigation target is available."
                  : null;

  return {
    capability: input.capability,
    canUndo,
    canRedo,
    isNavigating: input.isNavigating,
    latestCheckpointBlockingStatus,
    reason,
    cursorVersion: input.cursor.navigationVersion,
    currentOrdinal: input.cursor.currentOrdinal,
    forwardTipOrdinal: input.cursor.forwardTipOrdinal,
  };
}

const makeAvailability = Effect.gen(function* () {
  const timeline = yield* CheckpointTimelineRepository;
  const operations = yield* CheckpointNavigationRepository;
  const provider = yield* ProviderConversationNavigation;

  const get: CheckpointNavigationAvailabilityShape["get"] = Effect.fn(
    "CheckpointNavigationAvailability.get",
  )(
    function* (threadId) {
      const [cursorOption, unresolved, capability] = yield* Effect.all([
        timeline.getCursor({ threadId }),
        operations.getUnresolvedByThread({ threadId }),
        provider.getCapability(threadId),
      ]);
      if (Option.isNone(cursorOption)) {
        return {
          ...DEFAULT_CHECKPOINT_NAVIGATION_STATE,
          capability,
          reason: "No checkpoint timeline is available.",
        };
      }

      const cursor = cursorOption.value;
      const entries = yield* timeline.listGenerationLineage({
        threadId,
        generation: cursor.activeGeneration,
      });
      return computeCheckpointNavigationAvailability({
        capability,
        cursor,
        entries,
        isNavigating: Option.isSome(unresolved),
      });
    },
    Effect.catch((error) =>
      Effect.logWarning("Could not project checkpoint navigation availability.").pipe(
        Effect.annotateLogs({ error }),
        Effect.as(DEFAULT_CHECKPOINT_NAVIGATION_STATE),
      ),
    ),
  );

  return CheckpointNavigationAvailability.of({ get });
});

export const CheckpointNavigationAvailabilityLive = Layer.effect(
  CheckpointNavigationAvailability,
  makeAvailability,
);
