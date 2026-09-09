import type { ComposerTrigger } from "./composer-logic";

export const COMPOSER_SUGGESTION_DELAY_MS = 600;

/**
 * A post-turn suggestion is only useful while the composer is empty: it is a
 * whole next prompt, not a continuation of whatever the user is typing.
 */
export function shouldRequestComposerSuggestion(input: {
  enabled: boolean;
  disabled: boolean;
  threadIdle: boolean;
  prompt: string;
  hasAssistantReply: boolean;
  trigger: ComposerTrigger | null;
}): boolean {
  if (!input.enabled || input.disabled || !input.threadIdle) return false;
  if (input.trigger !== null) return false;
  if (!input.hasAssistantReply) return false;
  return input.prompt.length === 0;
}

export function normalizeComposerSuggestion(text: string, maxLength = 200): string | null {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized || normalized.length > maxLength) return null;
  if (normalized.includes("\n") || normalized.includes("```")) return null;
  return normalized;
}

export function resolveDismissedComposerSuggestionKey(input: {
  currentKey: string | null;
  dismissedKey: string | null;
  prompt: string;
}): string | null {
  if (input.currentKey === null) return null;
  if (input.prompt.length > 0) return input.currentKey;
  return input.dismissedKey === input.currentKey ? input.dismissedKey : null;
}

/** Suggestions are keyed to the turn that produced them, so a new turn invalidates them. */
export function createComposerSuggestionKey(input: {
  threadId: string;
  lastMessageId: string;
  instanceId: string;
  model: string;
}): string {
  return `${input.threadId}:${input.lastMessageId}:${input.instanceId}:${input.model}`;
}

export function isComposerSuggestionCurrent(input: {
  suggestionKey: string | null;
  currentKey: string;
  prompt: string;
}): boolean {
  return input.suggestionKey === input.currentKey && input.prompt.length === 0;
}
