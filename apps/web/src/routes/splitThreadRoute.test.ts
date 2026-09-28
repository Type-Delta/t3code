import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectIsSplitViewActive, useSplitViewStore } from "../splitViewStore";
import { reconcileSplitViewThreadRoute } from "./_chat.$environmentId.$threadId";

const environmentId = EnvironmentId.make("environment-a");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));
const threadC = scopeThreadRef(environmentId, ThreadId.make("thread-c"));

function createThreadRouter(initialEntry = "/environment-a/thread-a") {
  const root = createRootRoute();
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    beforeLoad: ({ params, preload }) => reconcileSplitViewThreadRoute(params, preload),
  });
  return createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

beforeEach(() => {
  useSplitViewStore.setState({
    groups: [],
    activeGroupId: null,
    activeThreadKey: null,
    pendingNavigationThreadKey: null,
  });
});

describe("saved split group route entry", () => {
  it("restores a saved group on browser Back after visiting a standalone thread", async () => {
    const router = createThreadRouter();
    await router.load();
    useSplitViewStore.getState().openInSplit(threadA, threadB);
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: threadB.threadId },
    });
    useSplitViewStore.getState().confirmNavigation(threadB);
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: threadC.threadId },
    });
    expect(selectIsSplitViewActive(useSplitViewStore.getState())).toBe(false);

    router.history.back();
    await router.load();
    const state = useSplitViewStore.getState();
    expect(selectIsSplitViewActive(state)).toBe(true);
    expect(state.activeThreadKey).toBe(scopedThreadKey(threadB));
  });

  it("restores a saved group on direct entry without changing state during preload", async () => {
    useSplitViewStore.getState().openInSplit(threadA, threadB);
    useSplitViewStore.getState().exitSplit();
    const router = createThreadRouter("/environment-a/thread-b");

    await router.preloadRoute({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: threadB.threadId },
    });
    expect(selectIsSplitViewActive(useSplitViewStore.getState())).toBe(false);

    await router.load();
    const state = useSplitViewStore.getState();
    expect(selectIsSplitViewActive(state)).toBe(true);
    expect(state.activeThreadKey).toBe(scopedThreadKey(threadB));
  });

  it("keeps an in-flight pane switch when an older route reloads", async () => {
    useSplitViewStore.getState().openInSplit(threadA, threadB);
    const router = createThreadRouter("/environment-a/thread-a");

    await router.load();
    const state = useSplitViewStore.getState();
    expect(state.activeThreadKey).toBe(scopedThreadKey(threadB));
    expect(state.pendingNavigationThreadKey).toBe(scopedThreadKey(threadB));
  });

  it("reopens a saved group when a citation navigates to the same thread with a hash", async () => {
    useSplitViewStore.getState().openInSplit(threadA, threadB);
    useSplitViewStore.getState().exitSplit();
    const router = createThreadRouter("/environment-a/thread-b");
    await router.load();
    useSplitViewStore.getState().exitSplit();

    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: threadB.threadId },
      hash: "source-anchor",
    });
    const state = useSplitViewStore.getState();
    expect(selectIsSplitViewActive(state)).toBe(true);
    expect(state.activeThreadKey).toBe(scopedThreadKey(threadB));
  });
});
