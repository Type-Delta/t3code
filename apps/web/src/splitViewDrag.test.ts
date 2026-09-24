import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  beginSplitThreadDrag,
  endSplitThreadDrag,
  hasSplitThreadDrag,
  readSplitThreadDrag,
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
        return { left: this.left, width: 200 };
      }
      getAttribute() {
        return this.left === 100 ? "pane-a" : "pane-b";
      }
    }
    vi.stubGlobal("Element", HitElement);
    const single = new HitElement({});
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

    expect(resolvePointerSplitDropTarget(doc(single), { x: 100, y: 0 })).toEqual({
      kind: "single",
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

  it("sends one target change and clears it after release", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePointerSplitDropTarget(listener);
    setPointerSplitDropTarget({ kind: "single" });
    setPointerSplitDropTarget({ kind: "single" });
    setPointerSplitDropTarget(null);
    unsubscribe();
    expect(listener.mock.calls).toEqual([[{ kind: "single" }], [null]]);
  });
});
