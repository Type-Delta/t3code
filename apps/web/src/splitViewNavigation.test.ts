import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { prepareSplitViewThreadNavigation } from "./splitViewNavigation";
import { selectIsSplitViewActive, useSplitViewStore } from "./splitViewStore";

const environmentId = EnvironmentId.make("environment-a");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));
const standaloneThread = scopeThreadRef(environmentId, ThreadId.make("standalone"));

beforeEach(() => {
  useSplitViewStore.setState({
    groups: [],
    activeGroupId: null,
    activeThreadKey: null,
    pendingNavigationThreadKey: null,
  });
});

describe("thread navigation into saved split groups", () => {
  it("restores a saved group from a single-thread view and focuses the requested pane", () => {
    useSplitViewStore.getState().openInSplit(threadA, threadB);
    useSplitViewStore.getState().exitSplit();

    expect(prepareSplitViewThreadNavigation(threadB)).toBe(false);
    const state = useSplitViewStore.getState();
    expect(selectIsSplitViewActive(state)).toBe(true);
    expect(state.activeThreadKey).toBe(scopedThreadKey(threadB));
    expect(state.pendingNavigationThreadKey).toBe(scopedThreadKey(threadB));
  });

  it("replaces history when switching panes in the current group and exits for standalone threads", () => {
    useSplitViewStore.getState().openInSplit(threadA, threadB);

    expect(prepareSplitViewThreadNavigation(threadA)).toBe(true);
    expect(useSplitViewStore.getState().activeThreadKey).toBe(scopedThreadKey(threadA));

    expect(prepareSplitViewThreadNavigation(standaloneThread)).toBe(false);
    const state = useSplitViewStore.getState();
    expect(selectIsSplitViewActive(state)).toBe(false);
    expect(state.groups).toHaveLength(1);
  });
});
