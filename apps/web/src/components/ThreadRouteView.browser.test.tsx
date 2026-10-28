import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type HTMLAttributes } from "react";
import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../state/threads", () => ({ useEnvironmentThread: () => null }));
vi.mock("./ChatView", () => ({ default: () => null }));
vi.mock("./ChatView.logic", () => ({
  resolveDraftPromotionNavigationTarget: () => null,
  threadHasStarted: () => false,
}));
vi.mock("./chat/draftHeroTransition", () => ({
  waitForDraftHeroTransition: () => Promise.resolve(),
}));
vi.mock("./SplitPaneDropHint", () => ({
  SplitPaneDropHint: ({ position }: { position: string }) => <div data-drop-hint={position} />,
}));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: (props: HTMLAttributes<HTMLDivElement>) => (
    <div {...props} style={{ position: "fixed", left: 100, top: 100, width: 200, height: 400 }} />
  ),
}));
vi.mock("../composerDraftStore", () => ({
  useBackgroundDraftSubmissionPending: () => false,
  useComposerDraftStore: (select: (state: object) => unknown) =>
    select({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      getDraftIdByRef: () => null,
      hasDraftThreadsInEnvironment: () => false,
    }),
  finalizePromotedDraftThreadByRef: vi.fn(),
  markPromotedDraftThreadByRef: vi.fn(),
}));
vi.mock("../sidebarPendingFileDropStore", () => ({
  useSidebarPendingFileDropStore: { getState: () => ({ clearPendingFileDropsForThread: vi.fn() }) },
}));
vi.mock("../state/entities", () => ({
  useEnvironmentThreadRefs: () => [],
  useThread: () => null,
  useThreadDetail: () => null,
  useThreadRefs: () => [],
  useQuietThreadShell: () => null,
  useThreadStatus: () => null,
}));
vi.mock("../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../state/shell", () => ({ useEnvironmentShellStatus: () => null }));
vi.mock("../threadRoutes", () => ({
  buildThreadRouteParams: () => ({}),
  isThreadRouteSnapshotAuthoritative: () => false,
  resolveThreadRouteRenderState: () => "loading",
}));
vi.mock("../threadSync", () => ({ resolveThreadSyncPhase: () => "loading" }));

import {
  beginSplitThreadDrag,
  endSplitThreadDrag,
  setPointerSplitDropTarget,
} from "../splitViewDrag";
import { selectSplitPaneRefs, useSplitViewStore } from "../splitViewStore";
import { ThreadRouteView } from "./ThreadRouteView";

function dispatchDrag(
  target: Element,
  type: "dragover" | "drop",
  dataTransfer: DataTransfer,
  clientX: number,
  clientY: number,
) {
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    dataTransfer,
  });
  target.dispatchEvent(event);
  return event;
}

describe("ThreadRouteView native split drop", () => {
  function setup() {
    useSplitViewStore.setState({
      groups: [],
      activeGroupId: null,
      activeThreadKey: null,
      pendingNavigationThreadKey: null,
    });
    return {
      [Symbol.dispose]() {
        endSplitThreadDrag();
        useSplitViewStore.getState().clearSplit();
        setPointerSplitDropTarget(null);
      },
    };
  }

  it("places a legacy sidebar thread on the hinted side and ignores file drops", async () => {
    using _split = setup();
    const currentRef = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("a"));
    const draggedRef = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("b"));
    const container = document.createElement("div");
    await using _screen = await render(
      <ThreadRouteView target={{ kind: "server", threadRef: currentRef }} />,
      { container, router: false },
    );
    const hints = (position: string) =>
      container.querySelectorAll(`[data-drop-hint="${position}"]`).length;

    const workspace = container.querySelector("[data-thread-route-workspace]")!;
    const dataTransfer = new DataTransfer();
    beginSplitThreadDrag(dataTransfer, draggedRef);

    await act(async () => {
      dispatchDrag(workspace, "dragover", dataTransfer, 150, 300);
    });
    expect(hints("before")).toBe(1);
    let drop!: DragEvent;
    await act(async () => {
      drop = dispatchDrag(workspace, "drop", dataTransfer, 150, 300);
    });
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([draggedRef, currentRef]);
    expect(drop.defaultPrevented).toBe(true);
    expect(hints("before")).toBe(0);

    const fileTransfer = new DataTransfer();
    fileTransfer.items.add(new File(["x"], "file.txt"));
    await act(async () => {
      dispatchDrag(workspace, "drop", fileTransfer, 150, 300);
    });
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([draggedRef, currentRef]);

    useSplitViewStore.getState().clearSplit();
    beginSplitThreadDrag(dataTransfer, draggedRef);
    await act(async () => {
      dispatchDrag(workspace, "dragover", dataTransfer, 250, 300);
    });
    expect(hints("after")).toBe(1);
    await act(async () => {
      document.dispatchEvent(new Event("dragend"));
    });
    expect(hints("after")).toBe(0);
    await act(async () => {
      dispatchDrag(workspace, "drop", dataTransfer, 250, 300);
    });
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([currentRef, draggedRef]);

    useSplitViewStore.getState().clearSplit();
    beginSplitThreadDrag(dataTransfer, draggedRef);
    await act(async () => {
      dispatchDrag(workspace, "dragover", dataTransfer, 250, 150);
    });
    expect(hints("above")).toBe(1);
    await act(async () => {
      dispatchDrag(workspace, "drop", dataTransfer, 250, 150);
    });
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([draggedRef, currentRef]);
    expect(useSplitViewStore.getState().groups[0]?.bottomPaneKeys).toEqual([
      scopedThreadKey(currentRef),
    ]);

    useSplitViewStore.getState().clearSplit();
    beginSplitThreadDrag(dataTransfer, draggedRef);
    await act(async () => {
      dispatchDrag(workspace, "dragover", dataTransfer, 150, 450);
    });
    expect(hints("below")).toBe(1);
    await act(async () => {
      dispatchDrag(workspace, "drop", dataTransfer, 150, 450);
    });
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([currentRef, draggedRef]);
    expect(useSplitViewStore.getState().groups[0]?.bottomPaneKeys).toEqual([
      scopedThreadKey(draggedRef),
    ]);

    await act(async () => {
      setPointerSplitDropTarget({ kind: "single", position: "above" });
    });
    expect(hints("above")).toBe(1);
    await act(async () => {
      setPointerSplitDropTarget({ kind: "single", position: "below" });
    });
    expect(hints("below")).toBe(1);
  });
});
