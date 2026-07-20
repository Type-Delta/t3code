import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_SPLIT_VIEW_PANES,
  migratePersistedSplitViewState,
  selectActiveSplitPane,
  selectIsSplitViewActive,
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
  return useSplitViewStore.getState().paneRefs.map(scopedThreadKey);
}

describe("splitViewStore", () => {
  beforeEach(() => {
    useSplitViewStore.setState({
      paneRefs: [],
      activeThreadKey: null,
      isSplitModeActive: false,
    });
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

  it("activates only an open pane", () => {
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

  it("exits split mode cleanly and returns the remaining thread when detaching from two", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    expect(store.detachPane(THREAD_B)).toEqual(THREAD_A);
    const state = useSplitViewStore.getState();
    expect(state.paneRefs).toEqual([]);
    expect(state.activeThreadKey).toBeNull();
    expect(selectIsSplitViewActive(state)).toBe(false);
    expect(selectActiveSplitPane(state)).toBeNull();
  });

  it("removes deleted threads and reconciles panes against authoritative thread refs", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.openInSplit(THREAD_B, THREAD_C);

    expect(store.removeThread(THREAD_B)).toBeNull();
    expect(paneKeys()).toEqual([scopedThreadKey(THREAD_A), scopedThreadKey(THREAD_C)]);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(THREAD_C));

    expect(store.reconcilePanes([THREAD_A])).toEqual(THREAD_A);
    expect(useSplitViewStore.getState()).toMatchObject({
      paneRefs: [],
      activeThreadKey: null,
    });
  });

  it("clears split state", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);
    store.clearSplit();

    expect(useSplitViewStore.getState()).toMatchObject({
      paneRefs: [],
      activeThreadKey: null,
      isSplitModeActive: false,
    });
  });

  it("keeps a saved layout when leaving split mode and restores it on a pane click", () => {
    const store = useSplitViewStore.getState();
    store.openInSplit(THREAD_A, THREAD_B);

    store.exitSplit();
    expect(selectIsSplitViewActive(useSplitViewStore.getState())).toBe(false);
    expect(paneKeys()).toEqual([scopedThreadKey(THREAD_A), scopedThreadKey(THREAD_B)]);

    store.resumeSplit(THREAD_A);
    expect(selectIsSplitViewActive(useSplitViewStore.getState())).toBe(true);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(THREAD_A));
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

  it("restores only valid persisted panes and never reactivates an incomplete layout", () => {
    expect(
      migratePersistedSplitViewState({
        paneRefs: [
          { environmentId: "environment-a", threadId: "thread-a" },
          { environmentId: "environment-a", threadId: "thread-b" },
          { environmentId: 5, threadId: "bad" },
        ],
        activeThreadKey: scopedThreadKey(THREAD_B),
        isSplitModeActive: true,
      }),
    ).toMatchObject({
      paneRefs: [THREAD_A, THREAD_B],
      activeThreadKey: scopedThreadKey(THREAD_B),
      isSplitModeActive: true,
    });

    expect(
      migratePersistedSplitViewState({
        paneRefs: [{ environmentId: "environment-a", threadId: "thread-a" }],
        isSplitModeActive: true,
      }),
    ).toMatchObject({
      paneRefs: [THREAD_A],
      activeThreadKey: scopedThreadKey(THREAD_A),
      isSplitModeActive: false,
    });
  });
});
