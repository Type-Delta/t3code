import {
  CheckpointRef,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Thread } from "../types";
import { selectLoadableTurnDiffSummaries } from "./useTurnDiffSummaries";

function makeThread(): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    session: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [
      {
        turnId: TurnId.make("turn-stale"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("provider-file-change:stale"),
        status: "missing",
        files: [{ path: "unrelated.txt", kind: "modified", additions: 1, deletions: 0 }],
        assistantMessageId: null,
        completedAt: "2026-07-22T00:00:00.000Z",
      },
      {
        turnId: TurnId.make("turn-ready"),
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.make("sidecar:ready"),
        status: "ready",
        files: [{ path: "actual.txt", kind: "modified", additions: 1, deletions: 0 }],
        assistantMessageId: null,
        completedAt: "2026-07-22T00:01:00.000Z",
      },
    ],
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
}

describe("useTurnDiffSummaries", () => {
  it("exposes only ready checkpoints with loadable diffs", () => {
    const thread = makeThread();
    const summaries = selectLoadableTurnDiffSummaries(thread);

    expect(summaries.map((checkpoint) => checkpoint.turnId)).toEqual([TurnId.make("turn-ready")]);
  });
});
