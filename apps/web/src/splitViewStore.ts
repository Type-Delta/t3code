import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const MAX_SPLIT_VIEW_PANES = 10;
export const SPLIT_VIEW_STORAGE_KEY = "t3code:split-view:v1";
export const SPLIT_VIEW_STORAGE_VERSION = 2;

export type OpenInSplitResult = "opened" | "activated" | "at-capacity";

export interface SplitViewGroup {
  /** Stable persisted identity used to switch between saved layouts. */
  id: string;
  /** OKLCH hue used by the sidebar membership indicator. */
  colorHue: number;
  /** Ordered thread refs rendered from left to right. */
  paneRefs: readonly ScopedThreadRef[];
  /**
   * Pane keys that sit in the bottom row. A bottom pane belongs to the column
   * of the nearest preceding top pane, so the flat order still describes the
   * whole layout and a column keeps its full height until something is
   * actually stacked under it.
   */
  bottomPaneKeys?: readonly string[];
}

export interface SplitViewState {
  /** Every saved split layout. Threads belong to at most one group. */
  groups: readonly SplitViewGroup[];
  /** The group currently rendered, or null for a normal single-thread workspace. */
  activeGroupId: string | null;
  /** The focused pane in the active group. */
  activeThreadKey: string | null;
}

interface SplitViewStore extends SplitViewState {
  /** Ephemeral route target used to disambiguate group switches from browser navigation. */
  pendingNavigationThreadKey: string | null;
  /** Open a thread beside the current one, or focus it when it is already grouped. */
  openInSplit: (currentRef: ScopedThreadRef, targetRef: ScopedThreadRef) => OpenInSplitResult;
  /** Insert or move a pane to a specific position in the current thread's group. */
  placePane: (
    currentRef: ScopedThreadRef,
    targetRef: ScopedThreadRef,
    insertionIndex: number,
    stackUnderColumn?: boolean,
  ) => OpenInSplitResult;
  /** Reorder a pane in the active split group. */
  movePane: (
    threadRef: ScopedThreadRef,
    insertionIndex: number,
    stackUnderColumn?: boolean,
  ) => void;
  /** Open the saved group containing this thread and focus the requested pane. */
  resumeSplit: (threadRef: ScopedThreadRef) => void;
  /** Switch to a normal thread while retaining every saved group. */
  exitSplit: () => void;
  /** Focus an existing pane in the active group. */
  activatePane: (threadRef: ScopedThreadRef) => void;
  /** Clear a pending target after the browser URL reaches it. */
  confirmNavigation: (threadRef: ScopedThreadRef) => void;
  /** Remove a thread from its group and return a standalone fallback when needed. */
  detachPane: (threadRef: ScopedThreadRef) => ScopedThreadRef | null;
  /** Forget every saved split group. */
  clearSplit: () => void;
  /** Remove a deleted thread from its group and return a fallback when needed. */
  removeThread: (threadRef: ScopedThreadRef) => ScopedThreadRef | null;
  /** Reconcile every saved group against the authoritative thread list. */
  reconcilePanes: (availableRefs: readonly ScopedThreadRef[]) => ScopedThreadRef | null;
}

const EMPTY_GROUPS: readonly SplitViewGroup[] = Object.freeze([]);
const EMPTY_PANE_REFS: readonly ScopedThreadRef[] = Object.freeze([]);
const GROUP_COLOR_HUES = [264, 205, 150, 75, 20, 315, 120, 345, 185, 45, 285, 235] as const;
const GROUP_BASE_CHROMA = 0.19;
/** Hue the chroma easing is centered on, and how much chroma it removes there. */
const GROUP_CHROMA_EASE_HUE = 120;
const GROUP_CHROMA_EASE_DEPTH = 0.32;
let splitGroupSequence = 0;

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

function nextGroupId(groups: readonly SplitViewGroup[]): string {
  const existingIds = new Set(groups.map((group) => group.id));
  let id: string;
  do {
    splitGroupSequence += 1;
    id = `split-group-${Date.now().toString(36)}-${splitGroupSequence.toString(36)}`;
  } while (existingIds.has(id));
  return id;
}

function circularHueDistance(left: number, right: number): number {
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}

function nextGroupColorHue(groups: readonly SplitViewGroup[]): number {
  const usedHues = groups.map((group) => group.colorHue);
  const predefined = GROUP_COLOR_HUES.find((hue) =>
    usedHues.every((usedHue) => circularHueDistance(hue, usedHue) >= 18),
  );
  if (predefined !== undefined) return predefined;

  // Golden-angle stepping keeps additional groups distinct without imposing a
  // hard group limit. The color is supplemented by accessible group metadata.
  for (let index = 0; index < 360; index += 1) {
    const hue = Math.round((264 + index * 137.508) % 360);
    if (usedHues.every((usedHue) => circularHueDistance(hue, usedHue) >= 1)) return hue;
  }
  return 264;
}

/** Chroma to pair with a group hue. One chroma across the wheel does not read
    as one saturation: yellow-green sits well inside sRGB at these lightnesses
    and renders at full strength, while red and blue are near the gamut edge
    and get clipped on the way out — so a flat 0.19 leaves the greens shouting
    over the reds and blues. Easing chroma down around yellow-green evens them
    up, and hues a quarter-turn away keep the base chroma untouched. */
export function splitViewGroupChroma(colorHue: number): number {
  const towardYellowGreen = Math.max(
    0,
    Math.cos(((colorHue - GROUP_CHROMA_EASE_HUE) * Math.PI) / 180),
  );
  return Number((GROUP_BASE_CHROMA * (1 - GROUP_CHROMA_EASE_DEPTH * towardYellowGreen)).toFixed(4));
}

/** Split mode is meaningful only when at least two distinct panes are open. */
export function isSplitViewActive(paneRefs: readonly ScopedThreadRef[]): boolean {
  return paneRefs.length >= 2;
}

export const SPLIT_VIEW_MAX_COLUMNS = 5;

export interface SplitPaneSlot {
  readonly paneRef: ScopedThreadRef;
  /** Zero-based grid column. */
  readonly column: number;
  /** Zero-based grid row: 0 is the top row, 1 the stacked one. */
  readonly row: 0 | 1;
  /** True while nothing is stacked under this pane, so it fills both rows. */
  readonly spansBothRows: boolean;
}

/**
 * Place every pane on the 5x2 grid. Panes flagged bottom stack under the column
 * opened by the nearest preceding top pane; a top pane with nothing under it
 * keeps both of its cells. Panes past the fifth column fall into the leftmost
 * free bottom cell, which is what the plain "add another pane" path relies on.
 */
export function resolveSplitPaneSlots(
  paneRefs: readonly ScopedThreadRef[],
  bottomPaneKeys: readonly string[] = [],
): readonly SplitPaneSlot[] {
  const stacked = new Set(bottomPaneKeys);
  const bottomByColumn = new Map<number, number>();
  const slots: Array<{ paneRef: ScopedThreadRef; column: number; row: 0 | 1 }> = [];
  let column = -1;

  const takeFreeBottomColumn = (): number | null => {
    for (let candidate = 0; candidate <= column; candidate += 1) {
      if (!bottomByColumn.has(candidate)) return candidate;
    }
    return null;
  };

  for (const paneRef of paneRefs) {
    const key = scopedThreadKey(paneRef);
    const wantsBottom = stacked.has(key) && column >= 0 && !bottomByColumn.has(column);
    if (wantsBottom) {
      bottomByColumn.set(column, slots.length);
      slots.push({ paneRef, column, row: 1 });
      continue;
    }
    if (column + 1 < SPLIT_VIEW_MAX_COLUMNS) {
      column += 1;
      slots.push({ paneRef, column, row: 0 });
      continue;
    }
    const overflowColumn = takeFreeBottomColumn();
    if (overflowColumn === null) continue;
    bottomByColumn.set(overflowColumn, slots.length);
    slots.push({ paneRef, column: overflowColumn, row: 1 });
  }

  return slots.map((slot) => ({
    ...slot,
    spansBothRows: slot.row === 0 && !bottomByColumn.has(slot.column),
  }));
}

/** Whether another pane can be stacked under the column this pane opens. */
export function canStackUnderSplitPane(
  paneRefs: readonly ScopedThreadRef[],
  bottomPaneKeys: readonly string[] | undefined,
  paneIndex: number,
): boolean {
  const slots = resolveSplitPaneSlots(paneRefs, bottomPaneKeys ?? []);
  const slot = slots[paneIndex];
  return slot !== undefined && slot.row === 0 && slot.spansBothRows;
}

function retainBottomPaneKeys(
  paneRefs: readonly ScopedThreadRef[],
  bottomPaneKeys: readonly string[] | undefined,
): readonly string[] {
  if (!bottomPaneKeys || bottomPaneKeys.length === 0) return [];
  const paneKeys = new Set(paneRefs.map(scopedThreadKey));
  return bottomPaneKeys.filter((key) => paneKeys.has(key));
}

export function selectSplitViewGroups(state: SplitViewState): readonly SplitViewGroup[] {
  return state.groups;
}

export function selectActiveSplitGroup(state: SplitViewState): SplitViewGroup | null {
  if (state.activeGroupId === null) return null;
  const group = state.groups.find((candidate) => candidate.id === state.activeGroupId) ?? null;
  return group && isSplitViewActive(group.paneRefs) ? group : null;
}

export function selectSplitPaneRefs(state: SplitViewState): readonly ScopedThreadRef[] {
  return selectActiveSplitGroup(state)?.paneRefs ?? EMPTY_PANE_REFS;
}

export function selectIsSplitViewActive(state: SplitViewState): boolean {
  return selectActiveSplitGroup(state) !== null;
}

export function selectActiveSplitPane(state: SplitViewState): ScopedThreadRef | null {
  const activeGroup = selectActiveSplitGroup(state);
  if (!activeGroup || state.activeThreadKey === null) return null;
  return (
    activeGroup.paneRefs.find((paneRef) => scopedThreadKey(paneRef) === state.activeThreadKey) ??
    null
  );
}

export function findSplitViewGroupForThread(
  state: SplitViewState,
  threadRefOrKey: ScopedThreadRef | string,
): SplitViewGroup | null {
  const threadKey =
    typeof threadRefOrKey === "string" ? threadRefOrKey : scopedThreadKey(threadRefOrKey);
  return (
    state.groups.find((group) =>
      group.paneRefs.some((paneRef) => scopedThreadKey(paneRef) === threadKey),
    ) ?? null
  );
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

function parsePersistedPaneRefs(value: unknown): ScopedThreadRef[] {
  return uniquePaneRefs(
    Array.isArray(value)
      ? value.flatMap((candidate) => {
          const paneRef = parsePersistedPaneRef(candidate);
          return paneRef ? [paneRef] : [];
        })
      : [],
  ).slice(0, MAX_SPLIT_VIEW_PANES);
}

export function migratePersistedSplitViewState(persistedState: unknown): SplitViewState {
  if (!persistedState || typeof persistedState !== "object") {
    return { groups: EMPTY_GROUPS, activeGroupId: null, activeThreadKey: null };
  }

  const persisted = persistedState as {
    groups?: unknown;
    activeGroupId?: unknown;
    activeThreadKey?: unknown;
    paneRefs?: unknown;
    isSplitModeActive?: unknown;
  };

  // Version 1 stored one pane list. Preserve it as the first saved group.
  const rawGroups = Array.isArray(persisted.groups)
    ? persisted.groups
    : persisted.paneRefs
      ? [
          {
            id: "split-group-legacy",
            colorHue: GROUP_COLOR_HUES[0],
            paneRefs: persisted.paneRefs,
          },
        ]
      : [];

  const usedThreadKeys = new Set<string>();
  const usedGroupIds = new Set<string>();
  const groups: SplitViewGroup[] = [];
  for (const [index, rawGroup] of rawGroups.entries()) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const candidate = rawGroup as {
      id?: unknown;
      colorHue?: unknown;
      paneRefs?: unknown;
      bottomPaneKeys?: unknown;
    };
    const paneRefs = parsePersistedPaneRefs(candidate.paneRefs).filter(
      (paneRef) => !usedThreadKeys.has(scopedThreadKey(paneRef)),
    );
    if (!isSplitViewActive(paneRefs)) continue;
    paneRefs.forEach((paneRef) => usedThreadKeys.add(scopedThreadKey(paneRef)));

    const requestedId = typeof candidate.id === "string" && candidate.id ? candidate.id : null;
    let id =
      requestedId && !usedGroupIds.has(requestedId) ? requestedId : `split-group-${index + 1}`;
    while (usedGroupIds.has(id)) id = `${id}-migrated`;
    usedGroupIds.add(id);
    const requestedColorHue =
      typeof candidate.colorHue === "number" && Number.isFinite(candidate.colorHue)
        ? ((candidate.colorHue % 360) + 360) % 360
        : null;
    const colorHue =
      requestedColorHue !== null &&
      groups.every((group) => circularHueDistance(group.colorHue, requestedColorHue) >= 1)
        ? requestedColorHue
        : nextGroupColorHue(groups);
    const bottomPaneKeys = retainBottomPaneKeys(
      paneRefs,
      Array.isArray(candidate.bottomPaneKeys)
        ? candidate.bottomPaneKeys.filter((key): key is string => typeof key === "string")
        : [],
    );
    groups.push({ id, colorHue, paneRefs, bottomPaneKeys });
  }

  const legacyGroupId =
    !Array.isArray(persisted.groups) && persisted.isSplitModeActive === true
      ? (groups[0]?.id ?? null)
      : null;
  const requestedActiveGroupId =
    typeof persisted.activeGroupId === "string" ? persisted.activeGroupId : legacyGroupId;
  const activeGroup = groups.find((group) => group.id === requestedActiveGroupId) ?? null;
  const requestedActiveThreadKey =
    typeof persisted.activeThreadKey === "string" ? persisted.activeThreadKey : null;
  const activeThreadKey = activeGroup
    ? activeGroup.paneRefs.some((paneRef) => scopedThreadKey(paneRef) === requestedActiveThreadKey)
      ? requestedActiveThreadKey
      : scopedThreadKey(activeGroup.paneRefs[0]!)
    : null;

  return {
    groups: groups.length > 0 ? groups : EMPTY_GROUPS,
    activeGroupId: activeGroup?.id ?? null,
    activeThreadKey,
  };
}

export const useSplitViewStore = create<SplitViewStore>()(
  persist(
    (set, get) => ({
      groups: EMPTY_GROUPS,
      activeGroupId: null,
      activeThreadKey: null,
      pendingNavigationThreadKey: null,

      openInSplit: (currentRef, targetRef) => {
        const state = get();
        const currentGroup = findSplitViewGroupForThread(state, currentRef);
        const targetGroup = findSplitViewGroupForThread(state, targetRef);
        if (currentGroup && currentGroup.id === targetGroup?.id) {
          const targetKey = scopedThreadKey(targetRef);
          set({
            activeGroupId: currentGroup.id,
            activeThreadKey: targetKey,
            pendingNavigationThreadKey: targetKey,
          });
          return "activated";
        }
        return get().placePane(currentRef, targetRef, Number.MAX_SAFE_INTEGER);
      },

      placePane: (currentRef, targetRef, insertionIndex, stackUnderColumn = false) => {
        const state = get();
        const currentKey = scopedThreadKey(currentRef);
        const targetKey = scopedThreadKey(targetRef);
        if (currentKey === targetKey) {
          const currentGroup = findSplitViewGroupForThread(state, currentKey);
          if (currentGroup) {
            set({
              activeGroupId: currentGroup.id,
              activeThreadKey: currentKey,
              pendingNavigationThreadKey: currentKey,
            });
          }
          return "activated";
        }

        const activeGroup = selectActiveSplitGroup(state);
        const currentGroup = findSplitViewGroupForThread(state, currentKey);
        const destinationGroup = activeGroup?.paneRefs.some(
          (paneRef) => scopedThreadKey(paneRef) === currentKey,
        )
          ? activeGroup
          : currentGroup;
        const destinationPaneRefs = destinationGroup
          ? uniquePaneRefs(destinationGroup.paneRefs)
          : [currentRef];
        const existingIndex = destinationPaneRefs.findIndex(
          (paneRef) => scopedThreadKey(paneRef) === targetKey,
        );
        if (existingIndex < 0 && destinationPaneRefs.length >= MAX_SPLIT_VIEW_PANES) {
          return "at-capacity";
        }

        const panesWithoutTarget = destinationPaneRefs.filter(
          (paneRef) => scopedThreadKey(paneRef) !== targetKey,
        );
        const targetIndex = clampInsertionIndex(insertionIndex, panesWithoutTarget.length);
        panesWithoutTarget.splice(targetIndex, 0, targetRef);
        if (!isSplitViewActive(panesWithoutTarget)) return "activated";

        const destinationId = destinationGroup?.id ?? nextGroupId(state.groups);
        const destinationColorHue = destinationGroup?.colorHue ?? nextGroupColorHue(state.groups);
        const nextBottomPaneKeys = (() => {
          const inherited = retainBottomPaneKeys(
            panesWithoutTarget,
            destinationGroup?.bottomPaneKeys,
          ).filter((key) => key !== targetKey);
          return stackUnderColumn ? [...inherited, targetKey] : inherited;
        })();
        const groups: SplitViewGroup[] = [];
        for (const group of state.groups) {
          if (group.id === destinationId) {
            groups.push({
              ...group,
              paneRefs: panesWithoutTarget,
              bottomPaneKeys: nextBottomPaneKeys,
            });
            continue;
          }
          const filteredPaneRefs = group.paneRefs.filter(
            (paneRef) => scopedThreadKey(paneRef) !== targetKey,
          );
          if (isSplitViewActive(filteredPaneRefs)) {
            groups.push(
              filteredPaneRefs.length === group.paneRefs.length
                ? group
                : {
                    ...group,
                    paneRefs: filteredPaneRefs,
                    bottomPaneKeys: retainBottomPaneKeys(filteredPaneRefs, group.bottomPaneKeys),
                  },
            );
          }
        }
        if (!destinationGroup) {
          groups.push({
            id: destinationId,
            colorHue: destinationColorHue,
            paneRefs: panesWithoutTarget,
            bottomPaneKeys: nextBottomPaneKeys,
          });
        }

        set({
          groups,
          activeGroupId: destinationId,
          activeThreadKey: targetKey,
          pendingNavigationThreadKey: targetKey,
        });
        return existingIndex === targetIndex ? "activated" : "opened";
      },

      movePane: (threadRef, insertionIndex, stackUnderColumn = false) => {
        const state = get();
        const activeGroup = selectActiveSplitGroup(state);
        if (!activeGroup) return;
        const threadKey = scopedThreadKey(threadRef);
        const currentIndex = activeGroup.paneRefs.findIndex(
          (paneRef) => scopedThreadKey(paneRef) === threadKey,
        );
        if (currentIndex < 0) return;
        const paneRefs = [...activeGroup.paneRefs];
        const [movedPane] = paneRefs.splice(currentIndex, 1);
        if (!movedPane) return;
        const targetIndex = clampInsertionIndex(
          insertionIndex > currentIndex ? insertionIndex - 1 : insertionIndex,
          paneRefs.length,
        );
        paneRefs.splice(targetIndex, 0, movedPane);
        const bottomPaneKeys = (() => {
          const inherited = retainBottomPaneKeys(paneRefs, activeGroup.bottomPaneKeys).filter(
            (key) => key !== threadKey,
          );
          return stackUnderColumn ? [...inherited, threadKey] : inherited;
        })();
        const wasStacked = (activeGroup.bottomPaneKeys ?? []).includes(threadKey);
        if (
          wasStacked === stackUnderColumn &&
          paneRefs.every(
            (paneRef, index) =>
              scopedThreadKey(paneRef) === scopedThreadKey(activeGroup.paneRefs[index]!),
          )
        ) {
          return;
        }
        set({
          groups: state.groups.map((group) =>
            group.id === activeGroup.id ? { ...group, paneRefs, bottomPaneKeys } : group,
          ),
        });
      },

      resumeSplit: (threadRef) => {
        const state = get();
        const group = findSplitViewGroupForThread(state, threadRef);
        if (!group) return;
        const threadKey = scopedThreadKey(threadRef);
        if (state.activeGroupId === group.id && state.activeThreadKey === threadKey) return;
        set({
          activeGroupId: group.id,
          activeThreadKey: threadKey,
          pendingNavigationThreadKey: threadKey,
        });
      },

      exitSplit: () => {
        const state = get();
        if (state.activeGroupId === null && state.activeThreadKey === null) return;
        set({
          activeGroupId: null,
          activeThreadKey: null,
          pendingNavigationThreadKey: null,
        });
      },

      activatePane: (threadRef) => {
        const state = get();
        const activeGroup = selectActiveSplitGroup(state);
        const threadKey = scopedThreadKey(threadRef);
        if (
          !activeGroup ||
          state.activeThreadKey === threadKey ||
          !activeGroup.paneRefs.some((paneRef) => scopedThreadKey(paneRef) === threadKey)
        ) {
          return;
        }
        set({ activeThreadKey: threadKey, pendingNavigationThreadKey: threadKey });
      },

      confirmNavigation: (threadRef) => {
        const threadKey = scopedThreadKey(threadRef);
        if (get().pendingNavigationThreadKey !== threadKey) return;
        set({ pendingNavigationThreadKey: null });
      },

      detachPane: (threadRef) => {
        const state = get();
        const threadKey = scopedThreadKey(threadRef);
        const group = findSplitViewGroupForThread(state, threadKey);
        if (!group) return null;
        const paneIndex = group.paneRefs.findIndex(
          (paneRef) => scopedThreadKey(paneRef) === threadKey,
        );
        const paneRefs = group.paneRefs.filter((paneRef) => scopedThreadKey(paneRef) !== threadKey);
        const isActiveGroup = state.activeGroupId === group.id;

        if (!isSplitViewActive(paneRefs)) {
          set({
            groups: state.groups.filter((candidate) => candidate.id !== group.id),
            ...(isActiveGroup
              ? {
                  activeGroupId: null,
                  activeThreadKey: null,
                  pendingNavigationThreadKey: null,
                }
              : {}),
          });
          return isActiveGroup ? (paneRefs[0] ?? null) : null;
        }

        const activeThreadKey =
          isActiveGroup && state.activeThreadKey === threadKey
            ? scopedThreadKey(paneRefs[Math.min(paneIndex, paneRefs.length - 1)]!)
            : state.activeThreadKey;
        set({
          groups: state.groups.map((candidate) =>
            candidate.id === group.id
              ? {
                  ...candidate,
                  paneRefs,
                  bottomPaneKeys: retainBottomPaneKeys(paneRefs, candidate.bottomPaneKeys),
                }
              : candidate,
          ),
          ...(isActiveGroup
            ? { activeThreadKey, pendingNavigationThreadKey: activeThreadKey }
            : {}),
        });
        return null;
      },

      clearSplit: () => {
        const state = get();
        if (
          state.groups.length === 0 &&
          state.activeGroupId === null &&
          state.activeThreadKey === null
        ) {
          return;
        }
        set({
          groups: EMPTY_GROUPS,
          activeGroupId: null,
          activeThreadKey: null,
          pendingNavigationThreadKey: null,
        });
      },

      removeThread: (threadRef) => get().detachPane(threadRef),

      reconcilePanes: (availableRefs) => {
        const availableKeys = new Set(availableRefs.map(scopedThreadKey));
        const groups = get().groups;
        let fallback: ScopedThreadRef | null = null;
        for (const group of groups) {
          for (const paneRef of group.paneRefs) {
            if (!availableKeys.has(scopedThreadKey(paneRef))) {
              const nextFallback = get().detachPane(paneRef);
              fallback ??= nextFallback;
            }
          }
        }
        return fallback;
      },
    }),
    {
      name: SPLIT_VIEW_STORAGE_KEY,
      version: SPLIT_VIEW_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      migrate: (persistedState) => migratePersistedSplitViewState(persistedState),
      partialize: (state) => ({
        groups: state.groups,
        activeGroupId: state.activeGroupId,
        activeThreadKey: state.activeThreadKey,
      }),
    },
  ),
);
