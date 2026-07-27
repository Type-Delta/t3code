import { useMemo } from "react";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread, TurnDiffSummary } from "../types";

export function selectLoadableTurnDiffSummaries(
  activeThread: Thread | null | undefined,
): ReadonlyArray<TurnDiffSummary> {
  return activeThread?.checkpoints.filter((checkpoint) => checkpoint.status === "ready") ?? [];
}

export function useTurnDiffSummaries(activeThread: Thread | null | undefined) {
  const turnDiffSummaries = useMemo<ReadonlyArray<TurnDiffSummary>>(() => {
    return selectLoadableTurnDiffSummaries(activeThread);
  }, [activeThread]);

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
