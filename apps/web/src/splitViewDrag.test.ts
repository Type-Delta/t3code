import { afterEach, describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  beginSplitThreadDrag,
  endSplitThreadDrag,
  hasSplitThreadDrag,
  readSplitThreadDrag,
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
  afterEach(endSplitThreadDrag);

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
});
