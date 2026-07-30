import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  findSplitViewGroupForThread,
  MAX_SPLIT_VIEW_PANES,
  migratePersistedSplitViewState,
  selectActiveSplitPane,
  selectIsSplitViewActive,
  selectSplitPaneRefs,
  splitViewGroupChroma,
  useSplitViewStore,
} from "./splitViewStore";

const THREAD_A = scopeThreadRef("environment-a" as never, ThreadId.make("thread-a"));
const THREAD_B = scopeThreadRef("environment-a" as never, ThreadId.make("thread-b"));
const THREAD_C = scopeThreadRef("environment-a" as never, ThreadId.make("thread-c"));
const THREAD_D = scopeThreadRef("environment-a" as never, ThreadId.make("thread-d"));
const THREAD_E = scopeThreadRef("environment-a" as never, ThreadId.make("thread-e"));
const THREAD_A_IN_OTHER_ENVIRONMENT = scopeThreadRef(
  "environment-b" as never,
  ThreadId.make("thread-a"),
);

function paneKeys(): string[] {
  return selectSplitPaneRefs(useSplitViewStore.getState()).map(scopedThreadKey);
}

describe("splitViewGroupChroma", () => {
  it("leaves red and blue at full chroma", () => {
    // These already sit near the sRGB edge, so they render weaker than their
    // number suggests and need no easing.
    expect(splitViewGroupChroma(20)).toBeCloseTo(0.19, 5);
    expect(splitViewGroupChroma(264)).toBeCloseTo(0.19, 5);
    expect(splitViewGroupChroma(315)).toBeCloseTo(0.19, 5);
  });

  it("eases yellow-green down so it stops shouting over the rest", () => {
    const yellowGreen = splitViewGroupChroma(120);

    expect(yellowGreen).toBeLessThan(splitViewGroupChroma(264));
    expect(yellowGreen).toBeCloseTo(0.19 * 0.68, 4);
    // Neighbours fall off smoothly rather than stepping at a band edge.
    expect(splitViewGroupChroma(75)).toBeGreaterThan(yellowGreen);
    expect(splitViewGroupChroma(150)).toBeGreaterThan(yellowGreen);
  });

  it("stays positive and within the base chroma across the whole wheel", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const chroma = splitViewGroupChroma(hue);
      expect(chroma).toBeGreaterThan(0);
      expect(chroma).toBeLessThanOrEqual(0.19);
    }
  });
});

describe("splitViewStore", () => {
  beforeEach(() => {
    useSplitViewStore.setState({
      groups: [],
      activeGroupId: null,
      activeThreadKey: null,
      pendingNavigationThreadKey: null,
    });
  });

  it("returns a stable empty pane collection while split mode is inactive", () => {
    const state = useSplitViewStore.getState();

    expect(selectSplitPaneRefs(state)).toBe(selectSplitPaneRefs(state));
    expect(selectSplitPaneRefs(state)).toEqual([]);
  });

  it("opens a target beside the current thread and focuses it", () => {
    const result = useSplitViewStore.getState().openInSplit(THREAD_A, THREAD_B);

    const state = useSplitViewStore.getState();
    expect(result).toBe("opened");
    expect(paneKeys()).toEqual([scopedThreadKey(THREAD_A), scopedThreadKey(THREAD_B)]);
    expect(state.activeThreadKey).toBe(scopedThreadKey(THREAD_B));
    expect(selectIsSplitViewActive(state)).toBe(true);
    expect(selectActiveSplitPane(state)).toEqual(THREAD_B);
  });

  it("uses scoped identity and activates an already open pane without duplicating it", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_A_IN_OTHER_ENVIRONMENT);

    expect(store.openInSplit(THREAD_A_IN_OTHER_ENVIRONMENT, THREAD_A)).toBe("activated");
    expect(paneKeys()).toEqual([
      scopedThreadKey(THREAD_A),
      scopedThreadKey(THREAD_A_IN_OTHER_ENVIRONMENT),
    ]);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(THREAD_A));
  });

  it("activates only a pane in the displayed group", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    store.activatePane(THREAD_A);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(THREAD_A));

    store.activatePane(THREAD_C);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(THREAD_A));
  });

  it("caps new panes while still allowing existing panes to be focused", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.openInSplit(THREAD_B, THREAD_C);
    store.openInSplit(THREAD_C, THREAD_D);

    expect(paneKeys()).toHaveLength(MAX_SPLIT_VIEW_PANES);
    expect(store.openInSplit(THREAD_D, THREAD_E)).toBe("at-capacity");
    expect(store.openInSplit(THREAD_D, THREAD_B)).toBe("activated");
    expect(paneKeys()).toHaveLength(MAX_SPLIT_VIEW_PANES);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(THREAD_B));
  });

  it("selects the next pane when detaching the active pane", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.openInSplit(THREAD_B, THREAD_C);

    expect(store.detachPane(THREAD_C)).toBeNull();
    expect(paneKeys()).toEqual([scopedThreadKey(THREAD_A), scopedThreadKey(THREAD_B)]);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(THREAD_B));
  });

  it("removes a group and returns its standalone thread when detaching from two", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    expect(store.detachPane(THREAD_B)).toEqual(THREAD_A);
    const state = useSplitViewStore.getState();
    expect(state.groups).toEqual([]);
    expect(state.activeGroupId).toBeNull();
    expect(state.activeThreadKey).toBeNull();
    expect(selectIsSplitViewActive(state)).toBe(false);
  });

  it("keeps multiple saved groups with distinct colors and opens either group from any member", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.exitSplit();
    store.openInSplit(THREAD_C, THREAD_D);

    const stateWithTwoGroups = useSplitViewStore.getState();
    expect(stateWithTwoGroups.groups).toHaveLength(2);
    expect(new Set(stateWithTwoGroups.groups.map((group) => group.colorHue)).size).toBe(2);

    store.resumeSplit(THREAD_B);
    expect(paneKeys()).toEqual([scopedThreadKey(THREAD_A), scopedThreadKey(THREAD_B)]);
    expect(selectActiveSplitPane(useSplitViewStore.getState())).toEqual(THREAD_B);
    expect(useSplitViewStore.getState().pendingNavigationThreadKey).toBe(scopedThreadKey(THREAD_B));
    store.confirmNavigation(THREAD_B);
    expect(useSplitViewStore.getState().pendingNavigationThreadKey).toBeNull();

    store.resumeSplit(THREAD_C);
    expect(paneKeys()).toEqual([scopedThreadKey(THREAD_C), scopedThreadKey(THREAD_D)]);
    expect(selectActiveSplitPane(useSplitViewStore.getState())).toEqual(THREAD_C);
  });

  it("moves a thread between groups without leaving duplicate membership", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.exitSplit();
    store.openInSplit(THREAD_C, THREAD_D);

    expect(store.placePane(THREAD_C, THREAD_A, 1)).toBe("opened");
    expect(paneKeys()).toEqual([
      scopedThreadKey(THREAD_C),
      scopedThreadKey(THREAD_A),
      scopedThreadKey(THREAD_D),
    ]);
    expect(useSplitViewStore.getState().groups).toHaveLength(1);
    expect(findSplitViewGroupForThread(useSplitViewStore.getState(), THREAD_B)).toBeNull();
  });

  it("removes deleted threads and reconciles every saved group", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.exitSplit();
    store.openInSplit(THREAD_C, THREAD_D);

    expect(store.reconcilePanes([THREAD_A, THREAD_C, THREAD_D])).toBeNull();
    expect(findSplitViewGroupForThread(useSplitViewStore.getState(), THREAD_A)).toBeNull();
    expect(paneKeys()).toEqual([scopedThreadKey(THREAD_C), scopedThreadKey(THREAD_D)]);

    expect(store.reconcilePanes([THREAD_C])).toEqual(THREAD_C);
    expect(useSplitViewStore.getState()).toMatchObject({
      groups: [],
      activeGroupId: null,
      activeThreadKey: null,
    });
  });

  it("keeps saved groups when leaving split mode and clears them only on request", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    store.exitSplit();
    expect(selectIsSplitViewActive(useSplitViewStore.getState())).toBe(false);
    expect(useSplitViewStore.getState().groups).toHaveLength(1);

    store.resumeSplit(THREAD_A);
    expect(selectActiveSplitPane(useSplitViewStore.getState())).toEqual(THREAD_A);

    store.clearSplit();
    expect(useSplitViewStore.getState()).toMatchObject({
      groups: [],
      activeGroupId: null,
      activeThreadKey: null,
    });
  });

  it("places new panes and moves existing panes at the requested insertion index", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    expect(store.placePane(THREAD_A, THREAD_C, 0)).toBe("opened");
    expect(paneKeys()).toEqual([
      scopedThreadKey(THREAD_C),
      scopedThreadKey(THREAD_A),
      scopedThreadKey(THREAD_B),
    ]);

    store.movePane(THREAD_B, 0);
    expect(paneKeys()).toEqual([
      scopedThreadKey(THREAD_B),
      scopedThreadKey(THREAD_C),
      scopedThreadKey(THREAD_A),
    ]);
  });

  it("migrates the previous single-layout state into a valid group", () => {
    const migrated = migratePersistedSplitViewState({
      paneRefs: [
        { environmentId: "environment-a", threadId: "thread-a" },
        { environmentId: "environment-a", threadId: "thread-b" },
        { environmentId: 5, threadId: "bad" },
      ],
      activeThreadKey: scopedThreadKey(THREAD_B),
      isSplitModeActive: true,
    });

    expect(migrated.groups).toHaveLength(1);
    expect(migrated.groups[0]?.paneRefs).toEqual([THREAD_A, THREAD_B]);
    expect(migrated.activeGroupId).toBe(migrated.groups[0]?.id);
    expect(migrated.activeThreadKey).toBe(scopedThreadKey(THREAD_B));

    expect(
      migratePersistedSplitViewState({
        paneRefs: [{ environmentId: "environment-a", threadId: "thread-a" }],
        isSplitModeActive: true,
      }),
    ).toEqual({ groups: [], activeGroupId: null, activeThreadKey: null });
  });
});
