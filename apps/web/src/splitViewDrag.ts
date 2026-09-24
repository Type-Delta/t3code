import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

export const SPLIT_THREAD_DRAG_MIME_TYPE = "application/x-t3code-thread-ref";

type SerializedThreadRef = {
  environmentId: string;
  threadId: string;
};

let activeSplitThreadRef: ScopedThreadRef | null = null;

function isSerializedThreadRef(value: unknown): value is SerializedThreadRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SerializedThreadRef>;
  return typeof candidate.environmentId === "string" && typeof candidate.threadId === "string";
}

/** Write the smallest cross-surface payload needed to identify a thread. */
export function beginSplitThreadDrag(dataTransfer: DataTransfer, threadRef: ScopedThreadRef): void {
  activeSplitThreadRef = threadRef;
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
    const parsed: unknown = JSON.parse(dataTransfer.getData(SPLIT_THREAD_DRAG_MIME_TYPE));
    if (!isSerializedThreadRef(parsed)) return activeSplitThreadRef;
    return scopeThreadRef(EnvironmentId.make(parsed.environmentId), ThreadId.make(parsed.threadId));
  } catch {
    return activeSplitThreadRef;
  }
}

export function endSplitThreadDrag(): void {
  activeSplitThreadRef = null;
}

export type PointerSplitDropTarget =
  | { kind: "single" }
  | {
      kind: "split";
      paneKey: string | null;
      insertionIndex: number;
      position: "before" | "after" | null;
    };

/** Read the destination under the pointer, independent of dnd-kit's sidebar collision list. */
export function resolvePointerSplitDropTarget(
  document: Pick<Document, "elementFromPoint">,
  point: { x: number; y: number },
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
    const bounds = pane!.getBoundingClientRect();
    const position = point.x < bounds.left + bounds.width / 2 ? "before" : "after";
    return {
      kind: "split",
      paneKey: pane!.getAttribute("data-split-thread-pane-key"),
      insertionIndex: paneIndex + (position === "after" ? 1 : 0),
      position,
    };
  }
  return element.closest("[data-thread-route-workspace]") ? { kind: "single" } : null;
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
