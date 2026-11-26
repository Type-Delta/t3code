import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";

import { useThreadCheckpointSummaries } from "../state/entities";

/** A diff needs a captured snapshot: a ready row, or tracked repositories under a plain folder. */
const loadableTurnDiffSummaries = (summaries: ReadonlyArray<ThreadCheckpointSummary>) =>
  summaries.filter((summary) => summary.status === "ready" || summary.repositories !== undefined);

export function selectLoadableTurnDiffSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages"> | null,
) {
  return projection === null
    ? []
    : loadableTurnDiffSummaries(deriveThreadCheckpointSummaries(projection));
}

/** The thread's turn diff summaries for the timeline and DiffPanel, limited to loadable rows. */
export function useTurnDiffSummaries(ref: ScopedThreadRef | null) {
  return loadableTurnDiffSummaries(useThreadCheckpointSummaries(ref));
}
