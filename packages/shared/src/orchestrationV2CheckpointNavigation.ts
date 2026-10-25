import type {
  OrchestrationV2CheckpointNavigationState,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/** Derive the compact navigation state sent with a complete thread projection. */
export function checkpointNavigationState(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "checkpoints" | "providerThreads" | "thread" | "checkpointNavigation"
  >,
  isNavigating = projection.checkpointNavigation?.isNavigating ?? false,
): OrchestrationV2CheckpointNavigationState {
  const ready = projection.checkpoints
    .filter((checkpoint) => checkpoint.status === "ready")
    .sort((left, right) => {
      const leftOrdinal = left.appRunOrdinal ?? 0;
      const rightOrdinal = right.appRunOrdinal ?? 0;
      return leftOrdinal - rightOrdinal || left.ordinalWithinScope - right.ordinalWithinScope;
    });
  const active = projection.providerThreads.find(
    (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
  );
  const currentOrdinal = active?.lastRunOrdinal ?? 0;
  const currentIndex = ready.reduce(
    (index, checkpoint, candidateIndex) =>
      (checkpoint.appRunOrdinal ?? 0) <= currentOrdinal ? candidateIndex : index,
    -1,
  );
  const current = currentIndex < 0 ? undefined : ready[currentIndex];
  const tip = ready.at(-1);
  return {
    capability: "branching",
    canUndo: currentIndex > 0,
    canRedo: currentIndex >= 0 && currentIndex < ready.length - 1,
    isNavigating,
    latestCheckpointBlockingStatus: null,
    reason: ready.length === 0 ? "No checkpoints are available." : null,
    cursorVersion: currentIndex < 0 ? 0 : currentIndex,
    currentEntryId: current?.id ?? null,
    currentOrdinal: current?.appRunOrdinal ?? null,
    forwardTipEntryId: tip?.id ?? null,
    forwardTipOrdinal: tip?.appRunOrdinal ?? null,
  };
}
