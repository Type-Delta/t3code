import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { HTMLAttributes } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
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
  SidebarInset: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />,
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
  useThreadShell: () => null,
  useThreadStatus: () => null,
}));
vi.mock("../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../state/shell", () => ({ environmentShell: { stateAtom: () => null } }));
vi.mock("../threadRoutes", () => ({
  buildThreadRouteParams: () => ({}),
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

function createDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: "none",
    get types() {
      return [...data.keys()];
    },
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => data.set(type, value),
  } as unknown as DataTransfer;
}

describe("ThreadRouteView native split drop", () => {
  beforeEach(() => {
    useSplitViewStore.setState({
      groups: [],
      activeGroupId: null,
      activeThreadKey: null,
      pendingNavigationThreadKey: null,
    });
  });
  afterEach(() => {
    endSplitThreadDrag();
    useSplitViewStore.getState().clearSplit();
    setPointerSplitDropTarget(null);
    vi.unstubAllGlobals();
  });

  it("places a legacy sidebar thread on the hinted side and ignores file drops", async () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal("document", {
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    const currentRef = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("a"));
    const draggedRef = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("b"));
    let renderer: ReactTestRenderer;
    await act(() => {
      renderer = create(<ThreadRouteView target={{ kind: "server", threadRef: currentRef }} />);
    });
    const workspace = renderer!.root.findByProps({ "data-thread-route-workspace": true });
    const dataTransfer = createDataTransfer();
    beginSplitThreadDrag(dataTransfer, draggedRef);
    const event = {
      dataTransfer,
      clientX: 150,
      clientY: 300,
      currentTarget: {
        getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 400 }),
      },
      preventDefault: vi.fn(),
    };

    await act(() => workspace.props.onDragOver(event));
    expect(renderer!.root.findAllByProps({ "data-drop-hint": "before" })).toHaveLength(1);
    await act(() => workspace.props.onDrop(event));
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([draggedRef, currentRef]);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ "data-drop-hint": "before" })).toHaveLength(0);

    const fileTransfer = createDataTransfer();
    fileTransfer.setData("Files", "file.txt");
    await act(() => workspace.props.onDrop({ ...event, dataTransfer: fileTransfer }));
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([draggedRef, currentRef]);

    useSplitViewStore.getState().clearSplit();
    beginSplitThreadDrag(dataTransfer, draggedRef);
    await act(() => workspace.props.onDragOver({ ...event, clientX: 250 }));
    expect(renderer!.root.findAllByProps({ "data-drop-hint": "after" })).toHaveLength(1);
    await act(() => listeners.get("dragend")?.({} as Event));
    expect(renderer!.root.findAllByProps({ "data-drop-hint": "after" })).toHaveLength(0);
    await act(() => workspace.props.onDrop({ ...event, clientX: 250 }));
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([currentRef, draggedRef]);

    useSplitViewStore.getState().clearSplit();
    beginSplitThreadDrag(dataTransfer, draggedRef);
    await act(() => workspace.props.onDragOver({ ...event, clientX: 250, clientY: 150 }));
    expect(renderer!.root.findAllByProps({ "data-drop-hint": "above" })).toHaveLength(1);
    await act(() => workspace.props.onDrop({ ...event, clientX: 250, clientY: 150 }));
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([draggedRef, currentRef]);
    expect(useSplitViewStore.getState().groups[0]?.bottomPaneKeys).toEqual([
      scopedThreadKey(currentRef),
    ]);

    useSplitViewStore.getState().clearSplit();
    beginSplitThreadDrag(dataTransfer, draggedRef);
    await act(() => workspace.props.onDragOver({ ...event, clientX: 150, clientY: 450 }));
    expect(renderer!.root.findAllByProps({ "data-drop-hint": "below" })).toHaveLength(1);
    await act(() => workspace.props.onDrop({ ...event, clientX: 150, clientY: 450 }));
    expect(selectSplitPaneRefs(useSplitViewStore.getState())).toEqual([currentRef, draggedRef]);
    expect(useSplitViewStore.getState().groups[0]?.bottomPaneKeys).toEqual([
      scopedThreadKey(draggedRef),
    ]);

    await act(() => {
      setPointerSplitDropTarget({ kind: "single", position: "above" });
    });
    expect(renderer!.root.findAllByProps({ "data-drop-hint": "above" })).toHaveLength(1);
    await act(() => {
      setPointerSplitDropTarget({ kind: "single", position: "below" });
    });
    expect(renderer!.root.findAllByProps({ "data-drop-hint": "below" })).toHaveLength(1);

    await act(() => renderer!.unmount());
    expect(listeners.size).toBe(0);
  });
});
