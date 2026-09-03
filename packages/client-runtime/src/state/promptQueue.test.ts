import { describe, expect, it } from "vite-plus/test";

import {
  MAX_QUEUED_PROMPTS,
  dequeueHead,
  enqueuePrompt,
  isPromptQueueFull,
  prependPrompt,
  removeQueuedPrompt,
  shouldDispatchNextQueuedPrompt,
  type PromptQueue,
  type PromptQueueDispatchSignals,
} from "./promptQueue.ts";

function prompt(
  id: string,
  text = `prompt ${id}`,
): { id: string; text: string; createdAt: string } {
  return { id, text, createdAt: `2026-01-01T00:00:0${id}.000Z` };
}

function fill(count: number): PromptQueue {
  return Array.from({ length: count }, (_, index) => prompt(String(index)));
}

const IDLE_SIGNALS: PromptQueueDispatchSignals = {
  isWorking: false,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  isConnecting: false,
  isEnvironmentAvailable: true,
  queueLength: 1,
};

describe("enqueuePrompt", () => {
  it("appends to the tail preserving order", () => {
    const result = enqueuePrompt([prompt("0")], prompt("1"));
    expect(result.accepted).toBe(true);
    expect(result.queue.map((entry) => entry.id)).toEqual(["0", "1"]);
  });

  it("rejects blank prompts", () => {
    const result = enqueuePrompt([], prompt("0", "   \n\t "));
    expect(result).toMatchObject({ accepted: false, reason: "empty" });
    expect(result.queue).toEqual([]);
  });

  it("rejects once the cap is reached", () => {
    const full = fill(MAX_QUEUED_PROMPTS);
    expect(isPromptQueueFull(full)).toBe(true);
    const result = enqueuePrompt(full, prompt("extra"));
    expect(result).toMatchObject({ accepted: false, reason: "full" });
    expect(result.queue).toBe(full);
  });

  it("accepts up to exactly the cap", () => {
    let queue: PromptQueue = [];
    for (let index = 0; index < MAX_QUEUED_PROMPTS; index += 1) {
      const result = enqueuePrompt(queue, prompt(String(index)));
      expect(result.accepted).toBe(true);
      queue = result.queue;
    }
    expect(queue).toHaveLength(MAX_QUEUED_PROMPTS);
  });
});

describe("removeQueuedPrompt", () => {
  it("removes the matching entry", () => {
    const queue = [prompt("0"), prompt("1"), prompt("2")];
    expect(removeQueuedPrompt(queue, "1").map((entry) => entry.id)).toEqual(["0", "2"]);
  });

  it("returns the same reference when nothing matched", () => {
    const queue = [prompt("0")];
    expect(removeQueuedPrompt(queue, "missing")).toBe(queue);
  });
});

describe("prependPrompt", () => {
  it("restores a prompt to the head, keeping order", () => {
    const restored = prependPrompt([prompt("1"), prompt("2")], prompt("0"));
    expect(restored.map((entry) => entry.id)).toEqual(["0", "1", "2"]);
  });

  it("dequeue then prepend round-trips the queue", () => {
    const original: PromptQueue = [prompt("0"), prompt("1")];
    const { head, queue } = dequeueHead(original);
    expect(prependPrompt(queue, head!).map((entry) => entry.id)).toEqual(["0", "1"]);
  });
});

describe("dequeueHead", () => {
  it("pops the head and returns the rest", () => {
    const { head, queue } = dequeueHead([prompt("0"), prompt("1")]);
    expect(head?.id).toBe("0");
    expect(queue.map((entry) => entry.id)).toEqual(["1"]);
  });

  it("returns null head on an empty queue", () => {
    const { head, queue } = dequeueHead([]);
    expect(head).toBeNull();
    expect(queue).toEqual([]);
  });
});

describe("shouldDispatchNextQueuedPrompt", () => {
  it("dispatches into a genuinely idle thread", () => {
    expect(shouldDispatchNextQueuedPrompt(IDLE_SIGNALS)).toBe(true);
  });

  it("does not dispatch an empty queue", () => {
    expect(shouldDispatchNextQueuedPrompt({ ...IDLE_SIGNALS, queueLength: 0 })).toBe(false);
  });

  it("waits while the thread is working", () => {
    expect(shouldDispatchNextQueuedPrompt({ ...IDLE_SIGNALS, isWorking: true })).toBe(false);
  });

  it("pauses on a pending approval", () => {
    expect(shouldDispatchNextQueuedPrompt({ ...IDLE_SIGNALS, hasPendingApproval: true })).toBe(
      false,
    );
  });

  it("pauses on a pending user-input request", () => {
    expect(shouldDispatchNextQueuedPrompt({ ...IDLE_SIGNALS, hasPendingUserInput: true })).toBe(
      false,
    );
  });

  it("waits while connecting", () => {
    expect(shouldDispatchNextQueuedPrompt({ ...IDLE_SIGNALS, isConnecting: true })).toBe(false);
  });

  it("waits while the environment is unavailable", () => {
    expect(shouldDispatchNextQueuedPrompt({ ...IDLE_SIGNALS, isEnvironmentAvailable: false })).toBe(
      false,
    );
  });
});
