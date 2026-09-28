import type { ScopedThreadRef } from "@t3tools/contracts";

import { findSplitViewGroupForThread, useSplitViewStore } from "./splitViewStore";

/** Apply the saved layout before routing to a thread. Return whether this pane switch replaces history. */
export function prepareSplitViewThreadNavigation(threadRef: ScopedThreadRef): boolean {
  const state = useSplitViewStore.getState();
  const group = findSplitViewGroupForThread(state, threadRef);
  const switchingWithinActiveGroup = group?.id === state.activeGroupId;
  if (group) {
    state.resumeSplit(threadRef);
  } else {
    state.exitSplit();
  }
  return switchingWithinActiveGroup;
}
