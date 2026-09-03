import {
  dequeueHead as dequeueHeadCore,
  enqueuePrompt as enqueuePromptCore,
  prependPrompt as prependPromptCore,
  removeQueuedPrompt as removeQueuedPromptCore,
  type PromptQueue,
  type QueuedPrompt,
} from "@t3tools/client-runtime/state/prompt-queue";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

export { MAX_QUEUED_PROMPTS, type QueuedPrompt } from "@t3tools/client-runtime/state/prompt-queue";

export const PROMPT_QUEUE_STORAGE_KEY = "t3code:prompt-queue:v1";
const PROMPT_QUEUE_STORAGE_VERSION = 1;

/** Stable empty queue so a thread with nothing queued never churns subscribers. */
const EMPTY_QUEUE: PromptQueue = Object.freeze([]);

export type EnqueueOutcome =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "empty" | "full" };

interface PromptQueueStoreState {
  /** Queued prompts keyed by the composer target key (a `ScopedThreadRef`). */
  queuesByThreadKey: Record<string, PromptQueue>;
  getQueue: (threadKey: string) => PromptQueue;
  /** Appends a prompt to the thread's queue, honoring the per-thread cap. */
  enqueue: (threadKey: string, text: string) => EnqueueOutcome;
  removePrompt: (threadKey: string, id: string) => void;
  /** Pops and returns the next prompt to run, or null when the queue is empty. */
  dequeueHead: (threadKey: string) => QueuedPrompt | null;
  /** Puts a prompt back at the head after a failed dispatch. */
  restoreHead: (threadKey: string, prompt: QueuedPrompt) => void;
  clearQueue: (threadKey: string) => void;
}

function withQueue(
  state: PromptQueueStoreState,
  threadKey: string,
  next: PromptQueue,
): Pick<PromptQueueStoreState, "queuesByThreadKey"> {
  if (next.length === 0) {
    if (state.queuesByThreadKey[threadKey] === undefined) {
      return { queuesByThreadKey: state.queuesByThreadKey };
    }
    const { [threadKey]: _removed, ...rest } = state.queuesByThreadKey;
    return { queuesByThreadKey: rest };
  }
  return { queuesByThreadKey: { ...state.queuesByThreadKey, [threadKey]: next } };
}

export const usePromptQueueStore = create<PromptQueueStoreState>()(
  persist(
    (set, get) => ({
      queuesByThreadKey: {},
      getQueue: (threadKey) => get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE,
      enqueue: (threadKey, text) => {
        const current = get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
        const prompt: QueuedPrompt = {
          id: randomUUID(),
          text,
          createdAt: new Date().toISOString(),
        };
        const result = enqueuePromptCore(current, prompt);
        if (!result.accepted) {
          return { accepted: false, reason: result.reason };
        }
        set((state) => withQueue(state, threadKey, result.queue));
        return { accepted: true };
      },
      removePrompt: (threadKey, id) => {
        const current = get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
        const next = removeQueuedPromptCore(current, id);
        if (next === current) {
          return;
        }
        set((state) => withQueue(state, threadKey, next));
      },
      dequeueHead: (threadKey) => {
        const current = get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
        const { head, queue } = dequeueHeadCore(current);
        if (head === null) {
          return null;
        }
        set((state) => withQueue(state, threadKey, queue));
        return head;
      },
      restoreHead: (threadKey, prompt) => {
        const current = get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
        set((state) => withQueue(state, threadKey, prependPromptCore(current, prompt)));
      },
      clearQueue: (threadKey) => {
        if (get().queuesByThreadKey[threadKey] === undefined) {
          return;
        }
        set((state) => withQueue(state, threadKey, EMPTY_QUEUE));
      },
    }),
    {
      name: PROMPT_QUEUE_STORAGE_KEY,
      version: PROMPT_QUEUE_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
      ),
      partialize: (state) => ({ queuesByThreadKey: state.queuesByThreadKey }),
    },
  ),
);

/** Reactive read of one thread's queued prompts. */
export function usePromptQueue(threadKey: string | null | undefined): PromptQueue {
  return usePromptQueueStore((state) =>
    threadKey ? (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
  );
}
