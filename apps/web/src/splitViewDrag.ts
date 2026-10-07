import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

export const SPLIT_THREAD_DRAG_MIME_TYPE = "application/x-t3code-thread-ref";

type SerializedThreadRef = {
  environmentId: string;
  threadId: string;
};

function isSerializedThreadRef(value: unknown): value is SerializedThreadRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SerializedThreadRef>;
  return typeof candidate.environmentId === "string" && typeof candidate.threadId === "string";
}

/** Write the smallest cross-surface payload needed to identify a thread. */
export function beginSplitThreadDrag(dataTransfer: DataTransfer, threadRef: ScopedThreadRef): void {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(
    SPLIT_THREAD_DRAG_MIME_TYPE,
    JSON.stringify({ environmentId: threadRef.environmentId, threadId: threadRef.threadId }),
  );
  // A text fallback makes the drag interoperable with browser implementations
  // that omit custom MIME types from drag previews.
  dataTransfer.setData("text/plain", threadRef.threadId);
}

export function hasSplitThreadDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(SPLIT_THREAD_DRAG_MIME_TYPE);
}

export function readSplitThreadDrag(dataTransfer: DataTransfer): ScopedThreadRef | null {
  try {
    const serialized = dataTransfer.getData(SPLIT_THREAD_DRAG_MIME_TYPE);
    if (!serialized) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (!isSerializedThreadRef(parsed)) return null;
    return scopeThreadRef(EnvironmentId.make(parsed.environmentId), ThreadId.make(parsed.threadId));
  } catch {
    return null;
  }
}

export function endSplitThreadDrag(): void {
  // Keep a lifecycle hook for existing drag sources; the payload lives in DataTransfer.
}

export type SplitPaneDropPosition = "before" | "after" | "above" | "below";

export function resolveSplitPaneDropPosition(
  point: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number },
  options: { canStackVertically: boolean; canInsertColumn: boolean },
): SplitPaneDropPosition | null {
  if (options.canStackVertically) {
    if (point.y < bounds.top + bounds.height / 4) return "above";
    if (point.y >= bounds.top + (bounds.height * 3) / 4) return "below";
  }
  if (!options.canInsertColumn) return null;
  return point.x < bounds.left + bounds.width / 2 ? "before" : "after";
}

export function splitPaneInsertionIndex(
  columns: readonly number[],
  paneIndex: number,
  position: SplitPaneDropPosition,
): number {
  const column = columns[paneIndex];
  const first = columns.indexOf(column!);
  if (position === "before" || position === "above") return first;
  if (position === "below") return first + 1;
  return columns.lastIndexOf(column!) + 1;
}

/** Resolve a native sidebar drag over a standalone thread workspace. */
export function resolveNativeSingleSplitDrop(
  event: {
    dataTransfer: DataTransfer;
    clientX: number;
    clientY: number;
    currentTarget: Pick<HTMLElement, "getBoundingClientRect">;
  },
  currentRef: ScopedThreadRef | null,
): {
  threadRef: ScopedThreadRef;
  position: SplitPaneDropPosition;
  insertionIndex: number;
} | null {
  if (!currentRef || !hasSplitThreadDrag(event.dataTransfer)) return null;
  const threadRef = readSplitThreadDrag(event.dataTransfer);
  if (!threadRef || scopedThreadKey(threadRef) === scopedThreadKey(currentRef)) return null;
  const bounds = event.currentTarget.getBoundingClientRect();
  const position = resolveSplitPaneDropPosition({ x: event.clientX, y: event.clientY }, bounds, {
    canStackVertically: true,
    canInsertColumn: true,
  });
  if (!position) return null;
  return {
    threadRef,
    position,
    insertionIndex: position === "before" || position === "above" ? 0 : 1,
  };
}

export type PointerSplitDropTarget =
  | { kind: "single"; position: SplitPaneDropPosition }
  | {
      kind: "split";
      paneKey: string | null;
      insertionIndex: number;
      position: SplitPaneDropPosition | null;
    };

/** Read the destination under the pointer, independent of dnd-kit's sidebar collision list. */
export function resolvePointerSplitDropTarget(
  document: Pick<Document, "elementFromPoint">,
  point: { x: number; y: number },
  options: { draggedPaneKey?: string } = {},
): PointerSplitDropTarget | null {
  const element = document.elementFromPoint(point.x, point.y);
  if (!(element instanceof Element)) return null;
  const grid = element.closest("[data-split-thread-grid]");
  if (grid) {
    const panes = [...grid.querySelectorAll<HTMLElement>("[data-split-thread-pane]")];
    const pane = element.closest<HTMLElement>("[data-split-thread-pane]");
    const paneIndex = pane ? panes.indexOf(pane) : -1;
    if (paneIndex < 0) {
      return { kind: "split", paneKey: null, insertionIndex: panes.length, position: null };
    }
    const measuredColumns = panes.map((candidate) =>
      candidate.getAttribute("data-split-thread-pane-column") === null
        ? Number.NaN
        : Number(candidate.getAttribute("data-split-thread-pane-column")),
    );
    const columns = measuredColumns.every(Number.isFinite)
      ? measuredColumns
      : panes.map((_, index) => index);
    const position = resolveSplitPaneDropPosition(point, pane!.getBoundingClientRect(), {
      canStackVertically: pane!.getAttribute("data-split-thread-pane-can-stack") === "true",
      canInsertColumn:
        new Set(columns).size < 5 ||
        (options.draggedPaneKey !== undefined &&
          panes.some(
            (candidate) =>
              candidate.getAttribute("data-split-thread-pane-key") === options.draggedPaneKey,
          )),
    });
    if (!position) return null;
    return {
      kind: "split",
      paneKey: pane!.getAttribute("data-split-thread-pane-key"),
      insertionIndex: splitPaneInsertionIndex(columns, paneIndex, position),
      position,
    };
  }
  const workspace = element.closest<HTMLElement>("[data-thread-route-workspace]");
  if (!workspace) return null;
  const bounds = workspace.getBoundingClientRect();
  const position = resolveSplitPaneDropPosition(point, bounds, {
    canStackVertically: true,
    canInsertColumn: true,
  });
  if (!position) return null;
  return {
    kind: "single",
    position,
  };
}

let pointerTarget: PointerSplitDropTarget | null = null;
const pointerTargetListeners = new Set<(target: PointerSplitDropTarget | null) => void>();

export function subscribePointerSplitDropTarget(
  listener: (target: PointerSplitDropTarget | null) => void,
): () => void {
  pointerTargetListeners.add(listener);
  return () => pointerTargetListeners.delete(listener);
}

export function setPointerSplitDropTarget(target: PointerSplitDropTarget | null): void {
  if (JSON.stringify(pointerTarget) === JSON.stringify(target)) return;
  pointerTarget = target;
  for (const listener of pointerTargetListeners) listener(target);
}
