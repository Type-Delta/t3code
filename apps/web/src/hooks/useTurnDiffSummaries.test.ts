import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  RunId,
  type OrchestrationV2Checkpoint,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../test-fixtures";
import { selectLoadableTurnDiffSummaries } from "./useTurnDiffSummaries";

function checkpoint(
  ordinal: number,
  status: OrchestrationV2Checkpoint["status"],
  path: string,
): OrchestrationV2Checkpoint {
  const projection = makeThreadProjectionFixture();
  return {
    id: CheckpointId.make(`checkpoint-${ordinal}`),
    threadId: projection.thread.id,
    scopeId: CheckpointScopeId.make("scope-root"),
    runId: RunId.make(`run-${ordinal}`),
    nodeId: NodeId.make(`node-${ordinal}`),
    parentCheckpointId: null,
    ordinalWithinScope: ordinal,
    appRunOrdinal: ordinal,
    ref: CheckpointRef.make(`t3-sidecar:v1:${status}-${ordinal}`),
    status,
    files: [{ path, kind: "modified", additions: 1, deletions: 0 }],
    capturedAt: DateTime.makeUnsafe("2026-10-15T00:00:00.000Z"),
  };
}

describe("selectLoadableTurnDiffSummaries", () => {
  it("exposes only ready checkpoints with loadable diffs", () => {
    const projection = {
      ...makeThreadProjectionFixture(),
      checkpoints: [
        checkpoint(1, "missing", "unrelated.txt"),
        checkpoint(2, "ready", "actual.txt"),
        checkpoint(3, "error", "failed.txt"),
      ],
    };

    const summaries = selectLoadableTurnDiffSummaries(projection);

    expect(
      summaries.map((summary) => [summary.checkpointTurnCount, summary.files[0]?.path]),
    ).toEqual([[2, "actual.txt"]]);
  });
});
