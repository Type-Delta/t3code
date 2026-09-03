import { beforeEach, describe, expect, it } from "vite-plus/test";

import { MAX_QUEUED_PROMPTS, usePromptQueueStore } from "./promptQueueStore";

const THREAD = "env-1::thread-1";
const OTHER = "env-1::thread-2";

function reset(): void {
  usePromptQueueStore.setState({ queuesByThreadKey: {} });
}

describe("promptQueueStore", () => {
  beforeEach(reset);

  it("enqueues and reads back in order, scoped per thread", () => {
    const store = usePromptQueueStore.getState();
    expect(store.enqueue(THREAD, "first")).toEqual({ accepted: true });
    expect(store.enqueue(THREAD, "second")).toEqual({ accepted: true });
    expect(store.enqueue(OTHER, "other")).toEqual({ accepted: true });

    expect(
      usePromptQueueStore
        .getState()
        .getQueue(THREAD)
        .map((p) => p.text),
    ).toEqual(["first", "second"]);
    expect(
      usePromptQueueStore
        .getState()
        .getQueue(OTHER)
        .map((p) => p.text),
    ).toEqual(["other"]);
  });

  it("rejects blank prompts and enforces the cap", () => {
    const store = usePromptQueueStore.getState();
    expect(store.enqueue(THREAD, "   ")).toEqual({ accepted: false, reason: "empty" });

    for (let index = 0; index < MAX_QUEUED_PROMPTS; index += 1) {
      expect(store.enqueue(THREAD, `p${index}`).accepted).toBe(true);
    }
    expect(store.enqueue(THREAD, "overflow")).toEqual({ accepted: false, reason: "full" });
    expect(usePromptQueueStore.getState().getQueue(THREAD)).toHaveLength(MAX_QUEUED_PROMPTS);
  });

  it("dequeues the head and drops the key once empty", () => {
    const store = usePromptQueueStore.getState();
    store.enqueue(THREAD, "only");
    const head = usePromptQueueStore.getState().dequeueHead(THREAD);
    expect(head?.text).toBe("only");
    expect(usePromptQueueStore.getState().dequeueHead(THREAD)).toBeNull();
    expect(usePromptQueueStore.getState().queuesByThreadKey[THREAD]).toBeUndefined();
  });

  it("removes a specific queued prompt by id", () => {
    const store = usePromptQueueStore.getState();
    store.enqueue(THREAD, "keep");
    store.enqueue(THREAD, "drop");
    const dropId = usePromptQueueStore.getState().getQueue(THREAD)[1]!.id;
    usePromptQueueStore.getState().removePrompt(THREAD, dropId);
    expect(
      usePromptQueueStore
        .getState()
        .getQueue(THREAD)
        .map((p) => p.text),
    ).toEqual(["keep"]);
  });
});
