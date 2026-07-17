import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export const MAX_SPLIT_VIEW_PANES = 4;

export type OpenInSplitResult = "opened" | "activated" | "at-capacity";

export interface SplitViewState {
  /** Ordered thread refs rendered in the split view. */
  paneRefs: readonly ScopedThreadRef[];
  /** The scoped key of the focused pane, or null outside split mode. */
  activeThreadKey: string | null;
}

interface SplitViewStore extends SplitViewState {
  /** Open a thread beside the current one, or focus it when it is already open. */
  openInSplit: (currentRef: ScopedThreadRef, targetRef: ScopedThreadRef) => OpenInSplitResult;
  /** Focus an existing pane. */
  activatePane: (threadRef: ScopedThreadRef) => void;
  /** Close a pane and return the thread that should remain visible, if split mode exits. */
  detachPane: (threadRef: ScopedThreadRef) => ScopedThreadRef | null;
  /** Exit split mode without choosing a replacement thread. */
  clearSplit: () => void;
  /** Remove a deleted thread from split mode and return a fallback when needed. */
  removeThread: (threadRef: ScopedThreadRef) => ScopedThreadRef | null;
  /**
   * Remove panes missing from the authoritative thread list. Returns a fallback
   * when reconciliation exits split mode.
   */
  reconcilePanes: (availableRefs: readonly ScopedThreadRef[]) => ScopedThreadRef | null;
}

const EMPTY_PANE_REFS: readonly ScopedThreadRef[] = Object.freeze([]);

function uniquePaneRefs(paneRefs: readonly ScopedThreadRef[]): ScopedThreadRef[] {
  const unique: ScopedThreadRef[] = [];
  const seen = new Set<string>();
  for (const paneRef of paneRefs) {
    const key = scopedThreadKey(paneRef);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(paneRef);
  }
  return unique;
}

/** Split mode is meaningful only when at least two distinct panes are open. */
export function isSplitViewActive(paneRefs: readonly ScopedThreadRef[]): boolean {
  return paneRefs.length >= 2;
}

export function selectSplitPaneRefs(state: SplitViewState): readonly ScopedThreadRef[] {
  return state.paneRefs;
}

export function selectIsSplitViewActive(state: SplitViewState): boolean {
  return isSplitViewActive(state.paneRefs);
}

export function selectActiveSplitPane(state: SplitViewState): ScopedThreadRef | null {
  if (!isSplitViewActive(state.paneRefs) || state.activeThreadKey === null) {
    return null;
  }
  return (
    state.paneRefs.find((paneRef) => scopedThreadKey(paneRef) === state.activeThreadKey) ?? null
  );
}

function nextStateAfterRemovingPane(
  state: SplitViewState,
  threadRef: ScopedThreadRef,
): {
  paneRefs: readonly ScopedThreadRef[];
  activeThreadKey: string | null;
  fallback: ScopedThreadRef | null;
} {
  const threadKey = scopedThreadKey(threadRef);
  const paneIndex = state.paneRefs.findIndex((paneRef) => scopedThreadKey(paneRef) === threadKey);
  if (paneIndex < 0) {
    return { ...state, fallback: null };
  }

  const paneRefs = state.paneRefs.filter((paneRef) => scopedThreadKey(paneRef) !== threadKey);
  if (!isSplitViewActive(paneRefs)) {
    return {
      paneRefs: EMPTY_PANE_REFS,
      activeThreadKey: null,
      fallback: paneRefs[0] ?? null,
    };
  }

  const activeThreadKey =
    state.activeThreadKey === threadKey
      ? scopedThreadKey(paneRefs[Math.min(paneIndex, paneRefs.length - 1)]!)
      : state.activeThreadKey;
  return { paneRefs, activeThreadKey, fallback: null };
}

export const useSplitViewStore = create<SplitViewStore>((set, get) => ({
  paneRefs: EMPTY_PANE_REFS,
  activeThreadKey: null,

  openInSplit: (currentRef, targetRef) => {
    const targetKey = scopedThreadKey(targetRef);
    const state = get();
    const existingTarget = state.paneRefs.some((paneRef) => scopedThreadKey(paneRef) === targetKey);
    if (existingTarget) {
      if (state.activeThreadKey !== targetKey) {
        set({ activeThreadKey: targetKey });
      }
      return "activated";
    }

    const paneRefs = uniquePaneRefs(state.paneRefs);
    if (isSplitViewActive(paneRefs) && paneRefs.length >= MAX_SPLIT_VIEW_PANES) {
      return "at-capacity";
    }

    const currentKey = scopedThreadKey(currentRef);
    const nextPaneRefs = isSplitViewActive(paneRefs)
      ? [...paneRefs, targetRef]
      : uniquePaneRefs([currentRef, targetRef]);
    if (!isSplitViewActive(nextPaneRefs)) {
      if (state.paneRefs.length > 0 || state.activeThreadKey !== null) {
        set({ paneRefs: EMPTY_PANE_REFS, activeThreadKey: null });
      }
      return "activated";
    }

    set({ paneRefs: nextPaneRefs, activeThreadKey: targetKey });
    return currentKey === targetKey ? "activated" : "opened";
  },

  activatePane: (threadRef) => {
    const threadKey = scopedThreadKey(threadRef);
    const state = get();
    if (
      !isSplitViewActive(state.paneRefs) ||
      state.activeThreadKey === threadKey ||
      !state.paneRefs.some((paneRef) => scopedThreadKey(paneRef) === threadKey)
    ) {
      return;
    }
    set({ activeThreadKey: threadKey });
  },

  detachPane: (threadRef) => {
    const state = get();
    const next = nextStateAfterRemovingPane(state, threadRef);
    if (next.paneRefs === state.paneRefs && next.activeThreadKey === state.activeThreadKey) {
      return next.fallback;
    }
    set({ paneRefs: next.paneRefs, activeThreadKey: next.activeThreadKey });
    return next.fallback;
  },

  clearSplit: () => {
    const state = get();
    if (state.paneRefs.length === 0 && state.activeThreadKey === null) return;
    set({ paneRefs: EMPTY_PANE_REFS, activeThreadKey: null });
  },

  removeThread: (threadRef) => get().detachPane(threadRef),

  reconcilePanes: (availableRefs) => {
    const availableKeys = new Set(availableRefs.map(scopedThreadKey));
    const paneRefs = get().paneRefs;
    let fallback: ScopedThreadRef | null = null;
    for (const paneRef of paneRefs) {
      if (!availableKeys.has(scopedThreadKey(paneRef))) {
        const nextFallback = get().detachPane(paneRef);
        fallback ??= nextFallback;
      }
    }
    return fallback;
  },
}));
