import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  beginSplitThreadDrag,
  endSplitThreadDrag,
  hasSplitThreadDrag,
  readSplitThreadDrag,
  resolveNativeSingleSplitDrop,
  resolvePointerSplitDropTarget,
  setPointerSplitDropTarget,
  subscribePointerSplitDropTarget,
  SPLIT_THREAD_DRAG_MIME_TYPE,
} from "./splitViewDrag";

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

describe("split view thread drag", () => {
  afterEach(() => {
    endSplitThreadDrag();
    setPointerSplitDropTarget(null);
    vi.unstubAllGlobals();
  });

  it("serializes a sidebar thread as the split-workspace drop payload", () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-a"),
      ThreadId.make("thread-a"),
    );
    const dataTransfer = createDataTransfer();

    beginSplitThreadDrag(dataTransfer, threadRef);

    expect(dataTransfer.effectAllowed).toBe("move");
    expect(dataTransfer.getData(SPLIT_THREAD_DRAG_MIME_TYPE)).toBe(
      JSON.stringify({ environmentId: "environment-a", threadId: "thread-a" }),
    );
    expect(hasSplitThreadDrag(dataTransfer)).toBe(true);
    expect(readSplitThreadDrag(dataTransfer)).toEqual(threadRef);
  });

  it("does not classify ordinary file or text drags as split-thread drags", () => {
    const dataTransfer = createDataTransfer();
    dataTransfer.setData("Files", "file.txt");
    dataTransfer.setData("text/plain", "file.txt");

    expect(hasSplitThreadDrag(dataTransfer)).toBe(false);
    expect(readSplitThreadDrag(dataTransfer)).toBeNull();
  });

  it("rejects empty or malformed custom payloads instead of using stale drag state", () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-a"),
      ThreadId.make("thread-a"),
    );
    const dataTransfer = createDataTransfer();

    beginSplitThreadDrag(dataTransfer, threadRef);
    for (const payload of ["", "{", JSON.stringify({ threadId: "thread-b" })]) {
      dataTransfer.setData(SPLIT_THREAD_DRAG_MIME_TYPE, payload);
      expect(readSplitThreadDrag(dataTransfer)).toBeNull();
    }
  });

  it("resolves single-workspace and pane-edge targets from the actual pointer", () => {
    class HitElement {
      constructor(
        readonly matches: Record<string, HitElement | null>,
        private readonly panes: HitElement[] = [],
        private readonly left = 0,
      ) {}
      closest(selector: string) {
        return this.matches[selector] ?? null;
      }
      querySelectorAll() {
        return this.panes;
      }
      getBoundingClientRect() {
        return { left: this.left, top: 100, width: 200, height: 300 };
      }
      getAttribute() {
        return this.left === 100 ? "pane-a" : "pane-b";
      }
    }
    vi.stubGlobal("Element", HitElement);
    const single = new HitElement({}, [], 100);
    single["matches"]["[data-thread-route-workspace]"] = single;
    const paneA = new HitElement({}, [], 100);
    const paneB = new HitElement({}, [], 300);
    const grid = new HitElement({}, [paneA, paneB]);
    paneA["matches"]["[data-split-thread-grid]"] = grid;
    paneA["matches"]["[data-split-thread-pane]"] = paneA;
    paneB["matches"]["[data-split-thread-grid]"] = grid;
    paneB["matches"]["[data-split-thread-pane]"] = paneB;
    const doc = (element: HitElement | null) =>
      ({ elementFromPoint: () => element }) as unknown as Document;

    expect(resolvePointerSplitDropTarget(doc(single), { x: 100, y: 250 })).toEqual({
      kind: "single",
      position: "before",
    });
    expect(resolvePointerSplitDropTarget(doc(single), { x: 250, y: 250 })).toEqual({
      kind: "single",
      position: "after",
    });
    expect(resolvePointerSplitDropTarget(doc(paneA), { x: 150, y: 0 })).toEqual({
      kind: "split",
      paneKey: "pane-a",
      insertionIndex: 0,
      position: "before",
    });
    expect(resolvePointerSplitDropTarget(doc(paneB), { x: 450, y: 0 })).toEqual({
      kind: "split",
      paneKey: "pane-b",
      insertionIndex: 2,
      position: "after",
    });
    expect(resolvePointerSplitDropTarget(doc(null), { x: 0, y: 0 })).toBeNull();
  });

  it("resolves top and bottom quarters as vertical drops on a standalone workspace", () => {
    class Workspace {
      closest(selector: string) {
        return selector === "[data-thread-route-workspace]" ? this : null;
      }
      getBoundingClientRect() {
        return { left: 100, top: 100, width: 200, height: 400 };
      }
    }
    vi.stubGlobal("Element", Workspace);
    const workspace = new Workspace();
    const doc = () => ({ elementFromPoint: () => workspace }) as unknown as Document;

    expect(resolvePointerSplitDropTarget(doc(), { x: 150, y: 150 })).toEqual({
      kind: "single",
      position: "above",
    });
    expect(resolvePointerSplitDropTarget(doc(), { x: 250, y: 450 })).toEqual({
      kind: "single",
      position: "below",
    });
    expect(resolvePointerSplitDropTarget(doc(), { x: 150, y: 300 })).toEqual({
      kind: "single",
      position: "before",
    });
    expect(resolvePointerSplitDropTarget(doc(), { x: 250, y: 300 })).toEqual({
      kind: "single",
      position: "after",
    });
  });

  it("uses the lower third for a stack target only on stackable panes", () => {
    class StackPane {
      readonly matches: Record<string, StackPane | null> = {};
      constructor(private readonly stackable: boolean) {}
      closest(selector: string) {
        return this.matches[selector] ?? null;
      }
      querySelectorAll() {
        return [this];
      }
      getBoundingClientRect() {
        return { left: 100, top: 100, width: 200, height: 300 };
      }
      getAttribute(name: string) {
        if (name === "data-split-thread-pane-can-stack") return this.stackable ? "true" : null;
        return "pane-a";
      }
    }
    vi.stubGlobal("Element", StackPane);
    const stackablePane = new StackPane(true);
    stackablePane.matches["[data-split-thread-grid]"] = stackablePane;
    stackablePane.matches["[data-split-thread-pane]"] = stackablePane;
    const doc = (element: StackPane) =>
      ({ elementFromPoint: () => element }) as unknown as Document;

    expect(resolvePointerSplitDropTarget(doc(stackablePane), { x: 110, y: 350 })).toEqual({
      kind: "split",
      paneKey: "pane-a",
      insertionIndex: 1,
      position: "below",
    });

    const nonStackablePane = new StackPane(false);
    nonStackablePane.matches["[data-split-thread-grid]"] = nonStackablePane;
    nonStackablePane.matches["[data-split-thread-pane]"] = nonStackablePane;
    expect(resolvePointerSplitDropTarget(doc(nonStackablePane), { x: 110, y: 350 })).toEqual({
      kind: "split",
      paneKey: "pane-a",
      insertionIndex: 0,
      position: "before",
    });
  });

  it("resolves top and bottom targets and hides impossible targets at five columns", () => {
    class GridPane {
      grid: { querySelectorAll: () => GridPane[] } | null = null;
      constructor(
        readonly key: string,
        readonly column: number,
        public stackable: boolean,
      ) {}
      closest(selector: string) {
        if (selector === "[data-split-thread-grid]") return this.grid;
        if (selector === "[data-split-thread-pane]") return this;
        return null;
      }
      getBoundingClientRect() {
        return { left: 100, top: 100, width: 200, height: 300 };
      }
      getAttribute(name: string) {
        if (name === "data-split-thread-pane-key") return this.key;
        if (name === "data-split-thread-pane-column") return String(this.column);
        if (name === "data-split-thread-pane-can-stack") return String(this.stackable);
        return null;
      }
    }
    vi.stubGlobal("Element", GridPane);
    const top = new GridPane("top", 0, true);
    const bottom = new GridPane("bottom", 0, false);
    const otherColumns = [1, 2, 3, 4].map(
      (column) => new GridPane(`column-${column}`, column, true),
    );
    const panes = [top, ...otherColumns];
    const grid = { querySelectorAll: () => panes };
    panes.forEach((pane) => (pane.grid = grid));
    const doc = (pane: GridPane) => ({ elementFromPoint: () => pane }) as unknown as Document;

    expect(resolvePointerSplitDropTarget(doc(top), { x: 110, y: 120 })).toEqual({
      kind: "split",
      paneKey: "top",
      insertionIndex: 0,
      position: "above",
    });
    expect(resolvePointerSplitDropTarget(doc(top), { x: 290, y: 380 })).toEqual({
      kind: "split",
      paneKey: "top",
      insertionIndex: 1,
      position: "below",
    });
    expect(resolvePointerSplitDropTarget(doc(top), { x: 110, y: 250 })).toBeNull();
    expect(
      resolvePointerSplitDropTarget(doc(top), { x: 110, y: 250 }, { draggedPaneKey: "top" }),
    ).toEqual({
      kind: "split",
      paneKey: "top",
      insertionIndex: 0,
      position: "before",
    });
    panes.splice(1, 0, bottom);
    bottom.grid = grid;
    top.stackable = false;
    expect(resolvePointerSplitDropTarget(doc(bottom), { x: 110, y: 250 })).toBeNull();
    expect(
      resolvePointerSplitDropTarget(
        doc(bottom),
        { x: 110, y: 250 },
        {
          draggedPaneKey: "bottom",
        },
      ),
    ).toEqual({
      kind: "split",
      paneKey: "bottom",
      insertionIndex: 0,
      position: "before",
    });

    panes.splice(3);
    expect(resolvePointerSplitDropTarget(doc(bottom), { x: 110, y: 250 })).toEqual({
      kind: "split",
      paneKey: "bottom",
      insertionIndex: 0,
      position: "before",
    });
    expect(resolvePointerSplitDropTarget(doc(bottom), { x: 290, y: 250 })).toEqual({
      kind: "split",
      paneKey: "bottom",
      insertionIndex: 2,
      position: "after",
    });
  });

  it("accepts a legacy native thread drop on any edge of a single workspace", () => {
    const currentRef = scopeThreadRef(
      EnvironmentId.make("environment-a"),
      ThreadId.make("thread-a"),
    );
    const draggedRef = scopeThreadRef(
      EnvironmentId.make("environment-a"),
      ThreadId.make("thread-b"),
    );
    const dataTransfer = createDataTransfer();
    beginSplitThreadDrag(dataTransfer, draggedRef);
    const workspace = {
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 400 }),
    } as HTMLElement;

    expect(
      resolveNativeSingleSplitDrop(
        { dataTransfer, clientX: 150, clientY: 300, currentTarget: workspace },
        currentRef,
      ),
    ).toEqual({ threadRef: draggedRef, position: "before", insertionIndex: 0 });
    expect(
      resolveNativeSingleSplitDrop(
        { dataTransfer, clientX: 250, clientY: 300, currentTarget: workspace },
        currentRef,
      ),
    ).toEqual({ threadRef: draggedRef, position: "after", insertionIndex: 1 });
    expect(
      resolveNativeSingleSplitDrop(
        { dataTransfer, clientX: 150, clientY: 150, currentTarget: workspace },
        currentRef,
      ),
    ).toEqual({ threadRef: draggedRef, position: "above", insertionIndex: 0 });
    expect(
      resolveNativeSingleSplitDrop(
        { dataTransfer, clientX: 250, clientY: 450, currentTarget: workspace },
        currentRef,
      ),
    ).toEqual({ threadRef: draggedRef, position: "below", insertionIndex: 1 });
    expect(
      resolveNativeSingleSplitDrop(
        { dataTransfer, clientX: 150, clientY: 150, currentTarget: workspace },
        draggedRef,
      ),
    ).toBeNull();
    expect(
      resolveNativeSingleSplitDrop(
        { dataTransfer, clientX: 150, clientY: 150, currentTarget: workspace },
        null,
      ),
    ).toBeNull();
    const fileTransfer = createDataTransfer();
    fileTransfer.setData("Files", "file.txt");
    expect(
      resolveNativeSingleSplitDrop(
        { dataTransfer: fileTransfer, clientX: 150, clientY: 150, currentTarget: workspace },
        currentRef,
      ),
    ).toBeNull();
  });

  it("sends one target change and clears it after release", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePointerSplitDropTarget(listener);
    setPointerSplitDropTarget({ kind: "single", position: "before" });
    setPointerSplitDropTarget({ kind: "single", position: "before" });
    setPointerSplitDropTarget({ kind: "single", position: "after" });
    setPointerSplitDropTarget(null);
    unsubscribe();
    expect(listener.mock.calls).toEqual([
      [{ kind: "single", position: "before" }],
      [{ kind: "single", position: "after" }],
      [null],
    ]);
  });
});
