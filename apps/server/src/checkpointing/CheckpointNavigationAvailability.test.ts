import { describe, expect, it } from "vite-plus/test";

import type {
  ThreadCheckpointCursor,
  ThreadCheckpointEntry,
} from "../persistence/Services/CheckpointTimeline.ts";
import { computeCheckpointNavigationAvailability } from "./CheckpointNavigationAvailability.ts";

const cursor: ThreadCheckpointCursor = {
  threadId: "thread-1",
  activeGeneration: 0,
  currentEntryId: "entry-2",
  currentOrdinal: 2,
  forwardTipEntryId: "entry-3",
  forwardTipOrdinal: 3,
  navigationVersion: 4,
  updatedAt: "2026-07-16T00:00:00.000Z",
};

const entry = (
  ordinal: number,
  state: ThreadCheckpointEntry["state"],
  providerTurnId: string | null = `provider-turn-${ordinal}`,
): ThreadCheckpointEntry => ({
  entryId: `entry-${ordinal}`,
  threadId: "thread-1",
  timelineGeneration: 0,
  ordinal,
  turnId: `turn-${ordinal}`,
  providerTurnId,
  snapshotId: `snapshot-${ordinal}`,
  providerBindingJson: "{}",
  providerCursorJson: "{}",
  assistantMessageId: `message-${ordinal}`,
  completedAt: "2026-07-16T00:00:00.000Z",
  state,
  createdAt: "2026-07-16T00:00:00.000Z",
});

describe("computeCheckpointNavigationAvailability", () => {
  it("projects undo and redo targets around the durable cursor", () => {
    expect(
      computeCheckpointNavigationAvailability({
        capability: "branching",
        cursor,
        entries: [entry(1, "ready"), entry(2, "ready"), entry(3, "ready")],
        isNavigating: false,
      }),
    ).toEqual({
      capability: "branching",
      canUndo: true,
      canRedo: true,
      isNavigating: false,
      latestCheckpointBlockingStatus: null,
      reason: null,
      cursorVersion: 4,
      currentOrdinal: 2,
      forwardTipOrdinal: 3,
    });
  });

  it("blocks navigation while the latest checkpoint is pending", () => {
    expect(
      computeCheckpointNavigationAvailability({
        capability: "branching",
        cursor,
        entries: [entry(1, "ready"), entry(2, "ready"), entry(3, "pending")],
        isNavigating: false,
      }),
    ).toMatchObject({
      canUndo: false,
      canRedo: false,
      latestCheckpointBlockingStatus: "pending",
      reason: "The latest checkpoint is still pending.",
    });
  });

  it("represents a failed latest capture without hiding earlier safe targets", () => {
    expect(
      computeCheckpointNavigationAvailability({
        capability: "branching",
        cursor,
        entries: [entry(1, "ready"), entry(2, "ready"), entry(3, "error")],
        isNavigating: false,
      }),
    ).toMatchObject({
      canUndo: true,
      canRedo: false,
      latestCheckpointBlockingStatus: "error",
      reason: null,
    });
  });

  it("offers confirmed files-only undo but never redo for rollback-only providers", () => {
    expect(
      computeCheckpointNavigationAvailability({
        capability: "rollback-only",
        cursor,
        entries: [entry(1, "ready"), entry(2, "ready"), entry(3, "ready")],
        isNavigating: false,
      }),
    ).toMatchObject({
      canUndo: true,
      canRedo: false,
      reason: null,
    });
  });

  it("offers files-only undo for unsupported providers without provider turn metadata", () => {
    expect(
      computeCheckpointNavigationAvailability({
        capability: "unsupported",
        cursor,
        entries: [entry(1, "ready", null), entry(2, "ready", null)],
        isNavigating: false,
      }),
    ).toMatchObject({
      canUndo: true,
      canRedo: false,
      reason: null,
    });
  });

  it("does not advertise migrated entries without provider turn metadata", () => {
    expect(
      computeCheckpointNavigationAvailability({
        capability: "branching",
        cursor,
        entries: [entry(1, "ready", null), entry(2, "ready"), entry(3, "ready", null)],
        isNavigating: false,
      }),
    ).toMatchObject({
      canUndo: false,
      canRedo: false,
      reason:
        "Migrated checkpoints without provider conversation metadata cannot be navigated safely.",
    });
  });
});
