import type { ComposerTrigger } from "./composer-logic";

/**
 * A prompt suggestion is a whole next message, not a continuation of what the
 * user is writing, so it is only shown while the composer is empty and nothing
 * else is competing for the composer (menus, approvals, a running turn).
 */
export function shouldShowPromptSuggestion(input: {
  enabled: boolean;
  disabled: boolean;
  threadIdle: boolean;
  prompt: string;
  trigger: ComposerTrigger | null;
}): boolean {
  if (!input.enabled || input.disabled || !input.threadIdle) return false;
  if (input.trigger !== null) return false;
  return input.prompt.length === 0;
}

/** Suggestions belong to the message that carried them, so a new message invalidates them. */
export function createPromptSuggestionKey(input: {
  threadId: string;
  lastMessageId: string;
}): string {
  return `${input.threadId}:${input.lastMessageId}`;
}

/**
 * Typing dismisses the suggestion for the current message, and the dismissal
 * survives erasing that text. A new key (new message or thread) clears it.
 */
export function resolveDismissedPromptSuggestionKey(input: {
  currentKey: string | null;
  dismissedKey: string | null;
  prompt: string;
}): string | null {
  if (input.currentKey === null) return null;
  if (input.prompt.length > 0) return input.currentKey;
  return input.dismissedKey === input.currentKey ? input.dismissedKey : null;
}
