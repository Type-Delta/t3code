import { useMemo } from "react";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { inferCheckpointTurnCountByRunId } from "../session-logic";
import type { TurnDiffSummary } from "../types";

/** Turn diffs that can load: only a captured checkpoint has a snapshot to compare. */
export function selectLoadableTurnDiffSummaries(
  projection: OrchestrationV2ThreadProjection | null,
): ReadonlyArray<TurnDiffSummary> {
  if (projection === null) return [];
  return deriveThreadCheckpointSummaries(projection).filter(
    (summary) => summary.status === "ready",
  );
}

export function useTurnDiffSummaries(projection: OrchestrationV2ThreadProjection | null) {
  const turnDiffSummaries = useMemo(
    () => selectLoadableTurnDiffSummaries(projection),
    [projection],
  );

  const inferredCheckpointTurnCountByRunId = useMemo(
    () => inferCheckpointTurnCountByRunId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByRunId };
}
