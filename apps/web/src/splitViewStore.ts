import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const MAX_SPLIT_VIEW_PANES = 4;
export const SPLIT_VIEW_STORAGE_KEY = "t3code:split-view:v1";

export type OpenInSplitResult = "opened" | "activated" | "at-capacity";

export interface SplitViewState {
  /** Ordered thread refs that make up the saved split layout. */
  paneRefs: readonly ScopedThreadRef[];
  /** The scoped key of the focused pane, or null when the layout is inactive. */
  activeThreadKey: string | null;
  /** Whether the saved layout is currently rendered as split panes. */
  isSplitModeActive: boolean;
}

interface SplitViewStore extends SplitViewState {
  /** Open a thread beside the current one, or focus it when it is already open. */
  openInSplit: (currentRef: ScopedThreadRef, targetRef: ScopedThreadRef) => OpenInSplitResult;
  /** Insert or move a pane to a specific grid position. */
  placePane: (
    currentRef: ScopedThreadRef,
    targetRef: ScopedThreadRef,
    insertionIndex: number,
  ) => OpenInSplitResult;
  /** Reorder a pane already present in the split layout. */
  movePane: (threadRef: ScopedThreadRef, insertionIndex: number) => void;
  /** Restore a saved split layout and focus the specified pane. */
  resumeSplit: (threadRef: ScopedThreadRef) => void;
  /** Leave split mode while keeping its layout available to restore. */
  exitSplit: () => void;
  /** Focus an existing pane. */
  activatePane: (threadRef: ScopedThreadRef) => void;
  /** Close a pane and return the thread that should remain visible, if split mode exits. */
  detachPane: (threadRef: ScopedThreadRef) => ScopedThreadRef | null;
  /** Forget the saved split layout completely. */
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

function clampInsertionIndex(index: number, paneCount: number): number {
  return Math.max(0, Math.min(Math.trunc(index), paneCount));
}

/** Split mode is meaningful only when at least two distinct panes are open. */
export function isSplitViewActive(paneRefs: readonly ScopedThreadRef[]): boolean {
  return paneRefs.length >= 2;
}

export function selectSplitPaneRefs(state: SplitViewState): readonly ScopedThreadRef[] {
  return state.paneRefs;
}

export function selectIsSplitViewActive(state: SplitViewState): boolean {
  return state.isSplitModeActive && isSplitViewActive(state.paneRefs);
}

export function selectActiveSplitPane(state: SplitViewState): ScopedThreadRef | null {
  if (!selectIsSplitViewActive(state) || state.activeThreadKey === null) {
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
  isSplitModeActive: boolean;
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
      isSplitModeActive: false,
      fallback: paneRefs[0] ?? null,
    };
  }

  const activeThreadKey =
    state.activeThreadKey === threadKey
      ? scopedThreadKey(paneRefs[Math.min(paneIndex, paneRefs.length - 1)]!)
      : state.activeThreadKey;
  return {
    paneRefs,
    activeThreadKey,
    isSplitModeActive: state.isSplitModeActive,
    fallback: null,
  };
}

function parsePersistedPaneRef(value: unknown): ScopedThreadRef | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { environmentId?: unknown; threadId?: unknown };
  if (typeof candidate.environmentId !== "string" || typeof candidate.threadId !== "string") {
    return null;
  }
  return scopeThreadRef(
    EnvironmentId.make(candidate.environmentId),
    ThreadId.make(candidate.threadId),
  );
}

export function migratePersistedSplitViewState(persistedState: unknown): SplitViewState {
  if (!persistedState || typeof persistedState !== "object") {
    return { paneRefs: EMPTY_PANE_REFS, activeThreadKey: null, isSplitModeActive: false };
  }
  const persisted = persistedState as {
    paneRefs?: unknown;
    activeThreadKey?: unknown;
    isSplitModeActive?: unknown;
  };
  const paneRefs = uniquePaneRefs(
    Array.isArray(persisted.paneRefs)
      ? persisted.paneRefs.flatMap((value) => {
          const paneRef = parsePersistedPaneRef(value);
          return paneRef ? [paneRef] : [];
        })
      : [],
  ).slice(0, MAX_SPLIT_VIEW_PANES);
  const activeThreadKey =
    typeof persisted.activeThreadKey === "string" &&
    paneRefs.some((paneRef) => scopedThreadKey(paneRef) === persisted.activeThreadKey)
      ? persisted.activeThreadKey
      : paneRefs.at(-1)
        ? scopedThreadKey(paneRefs.at(-1)!)
        : null;
  const isSplitModeActive = persisted.isSplitModeActive === true && isSplitViewActive(paneRefs);

  return { paneRefs, activeThreadKey, isSplitModeActive };
}

export const useSplitViewStore = create<SplitViewStore>()(
  persist(
    (set, get) => ({
      paneRefs: EMPTY_PANE_REFS,
      activeThreadKey: null,
      isSplitModeActive: false,

      openInSplit: (currentRef, targetRef) => {
        const state = get();
        const targetKey = scopedThreadKey(targetRef);
        if (
          selectIsSplitViewActive(state) &&
          state.paneRefs.some((paneRef) => scopedThreadKey(paneRef) === targetKey)
        ) {
          if (state.activeThreadKey !== targetKey) {
            set({ activeThreadKey: targetKey });
          }
          return "activated";
        }
        return get().placePane(currentRef, targetRef, Number.MAX_SAFE_INTEGER);
      },

      placePane: (currentRef, targetRef, insertionIndex) => {
        const targetKey = scopedThreadKey(targetRef);
        const state = get();
        // A saved-but-inactive layout should not unexpectedly absorb the
        // current normal workspace. Starting a new split intentionally seeds
        // from the current route instead.
        const existingPanes = selectIsSplitViewActive(state)
          ? uniquePaneRefs(state.paneRefs)
          : uniquePaneRefs([currentRef]);
        const existingIndex = existingPanes.findIndex(
          (paneRef) => scopedThreadKey(paneRef) === targetKey,
        );
        if (existingIndex >= 0) {
          const panesWithoutTarget = existingPanes.filter(
            (paneRef) => scopedThreadKey(paneRef) !== targetKey,
          );
          const targetIndex = clampInsertionIndex(insertionIndex, panesWithoutTarget.length);
          panesWithoutTarget.splice(targetIndex, 0, targetRef);
          set({
            paneRefs: panesWithoutTarget,
            activeThreadKey: targetKey,
            isSplitModeActive: isSplitViewActive(panesWithoutTarget),
          });
          return existingIndex === targetIndex ? "activated" : "opened";
        }

        if (existingPanes.length >= MAX_SPLIT_VIEW_PANES) {
          return "at-capacity";
        }

        const targetIndex = clampInsertionIndex(insertionIndex, existingPanes.length);
        const paneRefs = [...existingPanes];
        paneRefs.splice(targetIndex, 0, targetRef);
        if (!isSplitViewActive(paneRefs)) {
          return "activated";
        }
        set({ paneRefs, activeThreadKey: targetKey, isSplitModeActive: true });
        return "opened";
      },

      movePane: (threadRef, insertionIndex) => {
        const state = get();
        const threadKey = scopedThreadKey(threadRef);
        const currentIndex = state.paneRefs.findIndex(
          (paneRef) => scopedThreadKey(paneRef) === threadKey,
        );
        if (currentIndex < 0) return;
        const paneRefs = [...state.paneRefs];
        const [movedPane] = paneRefs.splice(currentIndex, 1);
        if (!movedPane) return;
        const targetIndex = clampInsertionIndex(
          insertionIndex > currentIndex ? insertionIndex - 1 : insertionIndex,
          paneRefs.length,
        );
        paneRefs.splice(targetIndex, 0, movedPane);
        if (paneRefs.every((paneRef, index) => paneRef === state.paneRefs[index])) return;
        set({ paneRefs });
      },

      resumeSplit: (threadRef) => {
        const state = get();
        const threadKey = scopedThreadKey(threadRef);
        if (!state.paneRefs.some((paneRef) => scopedThreadKey(paneRef) === threadKey)) return;
        if (state.isSplitModeActive && state.activeThreadKey === threadKey) return;
        set({ activeThreadKey: threadKey, isSplitModeActive: true });
      },

      exitSplit: () => {
        const state = get();
        if (!state.isSplitModeActive && state.activeThreadKey === null) return;
        set({ activeThreadKey: null, isSplitModeActive: false });
      },

      activatePane: (threadRef) => {
        const threadKey = scopedThreadKey(threadRef);
        const state = get();
        if (
          !selectIsSplitViewActive(state) ||
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
        if (
          next.paneRefs === state.paneRefs &&
          next.activeThreadKey === state.activeThreadKey &&
          next.isSplitModeActive === state.isSplitModeActive
        ) {
          return next.fallback;
        }
        set({
          paneRefs: next.paneRefs,
          activeThreadKey: next.activeThreadKey,
          isSplitModeActive: next.isSplitModeActive,
        });
        return next.fallback;
      },

      clearSplit: () => {
        const state = get();
        if (
          state.paneRefs.length === 0 &&
          state.activeThreadKey === null &&
          !state.isSplitModeActive
        ) {
          return;
        }
        set({ paneRefs: EMPTY_PANE_REFS, activeThreadKey: null, isSplitModeActive: false });
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
    }),
    {
      name: SPLIT_VIEW_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      migrate: (persistedState) => migratePersistedSplitViewState(persistedState),
      partialize: (state) => ({
        paneRefs: state.paneRefs,
        activeThreadKey: state.activeThreadKey,
        isSplitModeActive: state.isSplitModeActive,
      }),
    },
  ),
);
