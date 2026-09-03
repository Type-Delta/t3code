/**
 * Client-side prompt queue: lets a user line up follow-up prompts while an
 * agent turn is still running, so each fires as its own fresh turn once the
 * previous one finishes. This is deliberately distinct from steering (which
 * injects text INTO the running turn) — a queued prompt always waits for the
 * thread to go idle and then starts a new turn.
 *
 * This module is the pure, framework-free core: the persisted store (web) and
 * any future mobile adoption wrap these reducers so the queueing rules and the
 * idle-dispatch decision stay identical across surfaces.
 */

/** Hard cap on queued prompts per thread. A queue is a convenience, not a
 * batch runner — beyond a handful the user has lost the plot, and an unbounded
 * queue would let a runaway loop stack work indefinitely. */
export const MAX_QUEUED_PROMPTS = 10;

export interface QueuedPrompt {
  /** Stable id used as the React key and the removal handle. */
  readonly id: string;
  /** The prompt text exactly as it will be sent to start the next turn. */
  readonly text: string;
  /** ISO timestamp the prompt was queued, for ordering and display. */
  readonly createdAt: string;
}

export type PromptQueue = ReadonlyArray<QueuedPrompt>;

export type EnqueuePromptResult =
  | { readonly accepted: true; readonly queue: PromptQueue }
  | { readonly accepted: false; readonly reason: "empty" | "full"; readonly queue: PromptQueue };

export function isPromptQueueFull(queue: PromptQueue): boolean {
  return queue.length >= MAX_QUEUED_PROMPTS;
}

/**
 * Appends a prompt to the tail of the queue. Rejects blank prompts (nothing to
 * run) and rejects once the cap is reached rather than silently dropping the
 * oldest — the user should see the queue is full and decide what to cut.
 */
export function enqueuePrompt(queue: PromptQueue, prompt: QueuedPrompt): EnqueuePromptResult {
  if (prompt.text.trim().length === 0) {
    return { accepted: false, reason: "empty", queue };
  }
  if (isPromptQueueFull(queue)) {
    return { accepted: false, reason: "full", queue };
  }
  return { accepted: true, queue: [...queue, prompt] };
}

/**
 * Puts a prompt back at the head of the queue. Used to restore a prompt whose
 * dispatch failed so it keeps its place at the front rather than being lost or
 * shuffled to the tail. Intentionally skips the cap check: it is returning an
 * entry the queue already accounted for.
 */
export function prependPrompt(queue: PromptQueue, prompt: QueuedPrompt): PromptQueue {
  return [prompt, ...queue];
}

export function removeQueuedPrompt(queue: PromptQueue, id: string): PromptQueue {
  const next = queue.filter((entry) => entry.id !== id);
  // Preserve reference identity when nothing matched so store subscribers do
  // not re-render on a no-op removal.
  return next.length === queue.length ? queue : next;
}

/**
 * Pops the head of the queue — the next prompt to run. Returns the remaining
 * queue and the removed head (or null on an empty queue). Callers dispatch the
 * head as a fresh turn only after they have confirmed the thread is idle (see
 * {@link shouldDispatchNextQueuedPrompt}).
 */
export function dequeueHead(queue: PromptQueue): {
  readonly queue: PromptQueue;
  readonly head: QueuedPrompt | null;
} {
  if (queue.length === 0) {
    return { queue, head: null };
  }
  const [head, ...rest] = queue;
  return { queue: rest, head: head ?? null };
}

/** Signals the idle-dispatch decision needs about the thread's current state. */
export interface PromptQueueDispatchSignals {
  /** The thread has a live/starting turn or a send is mid-flight. */
  readonly isWorking: boolean;
  /** The agent is blocked waiting for an approval decision. */
  readonly hasPendingApproval: boolean;
  /** The agent is blocked waiting for a user-input answer. */
  readonly hasPendingUserInput: boolean;
  /** The environment connection is not ready to accept a turn. */
  readonly isConnecting: boolean;
  /** The environment is reachable at all. */
  readonly isEnvironmentAvailable: boolean;
  /** Number of prompts currently queued. */
  readonly queueLength: number;
}

/**
 * Whether the next queued prompt should fire now. The queue only advances into
 * a genuinely idle thread: no running turn, nothing blocked on the user, and a
 * live environment to send to. Blocked-on-you work (an approval or input
 * request) deliberately pauses the queue — the user must clear it first, so we
 * never bury a raised hand under an auto-fired follow-up.
 */
export function shouldDispatchNextQueuedPrompt(signals: PromptQueueDispatchSignals): boolean {
  return (
    signals.queueLength > 0 &&
    !signals.isWorking &&
    !signals.hasPendingApproval &&
    !signals.hasPendingUserInput &&
    !signals.isConnecting &&
    signals.isEnvironmentAvailable
  );
}
