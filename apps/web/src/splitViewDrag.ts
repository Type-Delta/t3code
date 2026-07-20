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
