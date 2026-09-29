import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  canStackUnderSplitPane,
  findSplitViewGroupForThread,
  MAX_SPLIT_VIEW_PANES,
  migratePersistedSplitViewState,
  resolveSplitPaneSlots,
  selectActiveSplitPane,
  selectIsSplitViewActive,
  selectSplitPaneRefs,
  SPLIT_VIEW_MAX_COLUMNS,
  splitViewGroupChroma,
  useSplitViewStore,
} from "./splitViewStore";

const THREAD_A = scopeThreadRef("environment-a" as never, ThreadId.make("thread-a"));
const THREAD_B = scopeThreadRef("environment-a" as never, ThreadId.make("thread-b"));
const THREAD_C = scopeThreadRef("environment-a" as never, ThreadId.make("thread-c"));
const THREAD_D = scopeThreadRef("environment-a" as never, ThreadId.make("thread-d"));
const THREAD_F = scopeThreadRef("environment-a" as never, ThreadId.make("thread-f"));
const CAPACITY_THREADS = Array.from({ length: MAX_SPLIT_VIEW_PANES + 1 }, (_, index) =>
  scopeThreadRef("environment-a" as never, ThreadId.make(`capacity-thread-${index + 1}`)),
);
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

  it("resolves five, six, and ten panes into the five by two grid", () => {
    expect(MAX_SPLIT_VIEW_PANES).toBe(10);
    expect(SPLIT_VIEW_MAX_COLUMNS).toBe(5);

    const fivePaneSlots = resolveSplitPaneSlots(CAPACITY_THREADS.slice(0, 5));
    expect(
      fivePaneSlots.map(({ column, row, spansBothRows }) => [column, row, spansBothRows]),
    ).toEqual([
      [0, 0, true],
      [1, 0, true],
      [2, 0, true],
      [3, 0, true],
      [4, 0, true],
    ]);

    const sixPaneSlots = resolveSplitPaneSlots(CAPACITY_THREADS.slice(0, 6));
    expect(
      sixPaneSlots.map(({ column, row, spansBothRows }) => [column, row, spansBothRows]),
    ).toEqual([
      [0, 0, false],
      [1, 0, true],
      [2, 0, true],
      [3, 0, true],
      [4, 0, true],
      [0, 1, false],
    ]);

    const tenPaneSlots = resolveSplitPaneSlots(CAPACITY_THREADS.slice(0, 10));
    expect(tenPaneSlots.map(({ column, row }) => [column, row])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
  });

  it("stacks an explicitly marked pane and reports which top panes can accept one", () => {
    const paneRefs = [THREAD_A, THREAD_B, THREAD_C];
    const bottomPaneKeys = [scopedThreadKey(THREAD_B)];
    const slots = resolveSplitPaneSlots(paneRefs, bottomPaneKeys);

    expect(slots.map(({ column, row, spansBothRows }) => [column, row, spansBothRows])).toEqual([
      [0, 0, false],
      [0, 1, false],
      [1, 0, true],
    ]);
    expect(canStackUnderSplitPane(paneRefs, bottomPaneKeys, 0)).toBe(false);
    expect(canStackUnderSplitPane(paneRefs, bottomPaneKeys, 1)).toBe(false);
    expect(canStackUnderSplitPane(paneRefs, bottomPaneKeys, 2)).toBe(true);
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
    const [firstThread, secondThread, ...remainingThreads] = CAPACITY_THREADS;
    expect(firstThread).toBeDefined();
    expect(secondThread).toBeDefined();
    store.openInSplit(firstThread!, secondThread!);
    for (const threadRef of remainingThreads.slice(0, MAX_SPLIT_VIEW_PANES - 2)) {
      const currentRef = selectActiveSplitPane(useSplitViewStore.getState());
      expect(currentRef).not.toBeNull();
      store.openInSplit(currentRef!, threadRef);
    }

    expect(paneKeys()).toHaveLength(MAX_SPLIT_VIEW_PANES);
    const activeRef = selectActiveSplitPane(useSplitViewStore.getState());
    const overflowThread = remainingThreads[MAX_SPLIT_VIEW_PANES - 2];
    expect(activeRef).not.toBeNull();
    expect(overflowThread).toBeDefined();
    expect(store.openInSplit(activeRef!, overflowThread!)).toBe("at-capacity");
    expect(store.openInSplit(activeRef!, secondThread!)).toBe("activated");
    expect(paneKeys()).toHaveLength(MAX_SPLIT_VIEW_PANES);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(secondThread!));
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

  it("dissolves only the active group and returns its selected pane", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.exitSplit();
    store.openInSplit(THREAD_C, THREAD_D);
    store.resumeSplit(THREAD_A);
    store.activatePane(THREAD_B);
    const unrelatedGroup = findSplitViewGroupForThread(useSplitViewStore.getState(), THREAD_C);

    expect(store.detachGroup(THREAD_A)).toEqual(THREAD_B);
    expect(useSplitViewStore.getState()).toMatchObject({
      groups: [unrelatedGroup],
      activeGroupId: null,
      activeThreadKey: null,
      pendingNavigationThreadKey: null,
    });
  });

  it("removes an inactive saved group without changing the current split view", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.exitSplit();
    store.openInSplit(THREAD_C, THREAD_D);
    const before = useSplitViewStore.getState();
    const currentGroup = findSplitViewGroupForThread(before, THREAD_C);

    expect(store.detachGroup(THREAD_A)).toBeNull();
    expect(useSplitViewStore.getState()).toMatchObject({
      groups: [currentGroup],
      activeGroupId: before.activeGroupId,
      activeThreadKey: before.activeThreadKey,
      pendingNavigationThreadKey: before.pendingNavigationThreadKey,
    });
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

  it("does not return a fallback when reconciliation removes every pane", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    expect(store.reconcilePanes([])).toBeNull();
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

  it("sets and clears bottom-row placement while placing and moving panes", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    expect(store.placePane(THREAD_A, THREAD_C, 1, scopedThreadKey(THREAD_C))).toBe("opened");
    let activeGroup = useSplitViewStore.getState().groups[0];
    expect(activeGroup?.paneRefs).toEqual([THREAD_A, THREAD_C, THREAD_B]);
    expect(activeGroup?.bottomPaneKeys).toEqual([scopedThreadKey(THREAD_C)]);
    expect(
      resolveSplitPaneSlots(activeGroup!.paneRefs, activeGroup!.bottomPaneKeys).map(
        ({ column, row }) => [column, row],
      ),
    ).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);

    store.movePane(THREAD_C, 3);
    activeGroup = useSplitViewStore.getState().groups[0];
    expect(activeGroup?.paneRefs).toEqual([THREAD_A, THREAD_B, THREAD_C]);
    expect(activeGroup?.bottomPaneKeys).toEqual([]);

    store.movePane(THREAD_C, 1, scopedThreadKey(THREAD_C));
    activeGroup = useSplitViewStore.getState().groups[0];
    expect(activeGroup?.paneRefs).toEqual([THREAD_A, THREAD_C, THREAD_B]);
    expect(activeGroup?.bottomPaneKeys).toEqual([scopedThreadKey(THREAD_C)]);

    store.movePane(THREAD_B, 0);
    activeGroup = useSplitViewStore.getState().groups[0];
    expect(activeGroup?.paneRefs).toEqual([THREAD_B, THREAD_A, THREAD_C]);
    expect(activeGroup?.bottomPaneKeys).toEqual([scopedThreadKey(THREAD_C)]);
    expect(
      resolveSplitPaneSlots(activeGroup!.paneRefs, activeGroup!.bottomPaneKeys).map(
        ({ column, row }) => [column, row],
      ),
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it("places a thread above an unstacked pane by moving that pane to the bottom row", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    expect(store.placePane(THREAD_A, THREAD_C, 0, scopedThreadKey(THREAD_A))).toBe("opened");
    let activeGroup = useSplitViewStore.getState().groups[0];
    expect(activeGroup?.paneRefs).toEqual([THREAD_C, THREAD_A, THREAD_B]);
    expect(activeGroup?.bottomPaneKeys).toEqual([scopedThreadKey(THREAD_A)]);
    expect(
      resolveSplitPaneSlots(activeGroup!.paneRefs, activeGroup!.bottomPaneKeys).map(
        ({ column, row }) => [column, row],
      ),
    ).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);

    store.movePane(THREAD_B, 0, scopedThreadKey(THREAD_C));
    activeGroup = useSplitViewStore.getState().groups[0];
    expect(activeGroup?.paneRefs).toEqual([THREAD_B, THREAD_C, THREAD_A]);
    expect(activeGroup?.bottomPaneKeys).toEqual([scopedThreadKey(THREAD_C)]);
  });

  it("drops a bottom marker when its pane is moved into the first column", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.placePane(THREAD_A, THREAD_C, 1, scopedThreadKey(THREAD_C));

    store.movePane(THREAD_A, 3);
    let activeGroup = useSplitViewStore.getState().groups[0];
    expect(activeGroup?.paneRefs).toEqual([THREAD_C, THREAD_B, THREAD_A]);
    expect(activeGroup?.bottomPaneKeys).toEqual([]);

    store.movePane(THREAD_B, 0);
    activeGroup = useSplitViewStore.getState().groups[0];
    expect(activeGroup?.paneRefs).toEqual([THREAD_B, THREAD_C, THREAD_A]);
    expect(activeGroup?.bottomPaneKeys).toEqual([]);
    expect(resolveSplitPaneSlots(activeGroup!.paneRefs, activeGroup!.bottomPaneKeys)).toEqual([
      expect.objectContaining({ paneRef: THREAD_B, column: 0, row: 0 }),
      expect.objectContaining({ paneRef: THREAD_C, column: 1, row: 0 }),
      expect.objectContaining({ paneRef: THREAD_A, column: 2, row: 0 }),
    ]);
  });

  it("clears moved bottom-pane membership in the source group and retains other layout state", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.placePane(THREAD_A, THREAD_C, 1, scopedThreadKey(THREAD_C));
    store.exitSplit();
    store.openInSplit(THREAD_D, THREAD_F);

    expect(store.placePane(THREAD_D, THREAD_C, 1)).toBe("opened");
    const state = useSplitViewStore.getState();
    const sourceGroup = findSplitViewGroupForThread(state, THREAD_A);
    const destinationGroup = findSplitViewGroupForThread(state, THREAD_D);
    expect(sourceGroup?.paneRefs).toEqual([THREAD_A, THREAD_B]);
    expect(sourceGroup?.bottomPaneKeys).toEqual([]);
    expect(destinationGroup?.paneRefs).toEqual([THREAD_D, THREAD_C, THREAD_F]);
    expect(destinationGroup?.bottomPaneKeys).toEqual([]);
    expect(findSplitViewGroupForThread(state, THREAD_C)).toBe(destinationGroup);
  });

  it("drops a detached or reconciled pane's bottom-row marker", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.placePane(THREAD_A, THREAD_C, 1, scopedThreadKey(THREAD_C));

    expect(store.detachPane(THREAD_C)).toBeNull();
    expect(useSplitViewStore.getState().groups[0]?.bottomPaneKeys).toEqual([]);

    store.placePane(THREAD_A, THREAD_C, 1, scopedThreadKey(THREAD_C));
    expect(store.reconcilePanes([THREAD_A, THREAD_B])).toBeNull();
    expect(useSplitViewStore.getState().groups[0]?.paneRefs).toEqual([THREAD_A, THREAD_B]);
    expect(useSplitViewStore.getState().groups[0]?.bottomPaneKeys).toEqual([]);
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

  it("migrates, sanitizes, and persists optional bottom-pane keys with ten panes", () => {
    const paneRefs = CAPACITY_THREADS.slice(0, MAX_SPLIT_VIEW_PANES).map((paneRef) => ({
      environmentId: paneRef.environmentId,
      threadId: paneRef.threadId,
    }));
    const bottomKey = scopedThreadKey(CAPACITY_THREADS[5]!);
    const migrated = migratePersistedSplitViewState({
      groups: [
        {
          id: "five-by-two",
          colorHue: 264,
          paneRefs,
          bottomPaneKeys: [bottomKey, bottomKey, "missing-pane-key", 5],
        },
      ],
      activeGroupId: "five-by-two",
      activeThreadKey: bottomKey,
    });

    expect(migrated.groups[0]?.paneRefs).toHaveLength(MAX_SPLIT_VIEW_PANES);
    expect(migrated.groups[0]?.bottomPaneKeys).toEqual([bottomKey]);
    expect(migrated.activeThreadKey).toBe(bottomKey);
    const persisted = useSplitViewStore.persist.getOptions().partialize?.({
      ...migrated,
      pendingNavigationThreadKey: null,
    } as ReturnType<typeof useSplitViewStore.getState>);
    expect(persisted).toMatchObject({
      groups: [{ bottomPaneKeys: [bottomKey] }],
      activeGroupId: "five-by-two",
      activeThreadKey: bottomKey,
    });
    expect(
      migratePersistedSplitViewState(JSON.parse(JSON.stringify(persisted))).groups[0]
        ?.bottomPaneKeys,
    ).toEqual([bottomKey]);
  });
});
