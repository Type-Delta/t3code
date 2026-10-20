import type { MessageId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import type { ComposerTrigger } from "../../composer-logic";
import {
  createPromptSuggestionKey,
  resolveDismissedPromptSuggestionKey,
  shouldShowPromptSuggestion,
} from "../../promptSuggestion.logic";

interface PromptSuggestionMessage {
  readonly id: MessageId;
  readonly role: string;
  readonly streaming: boolean;
  readonly suggestion?: string | undefined;
}

/**
 * Surfaces the suggestion the server attached to the settled assistant reply as
 * composer ghost text. Nothing is requested here: the text already arrived with
 * the message, so this only decides whether it is still relevant.
 */
export function usePromptSuggestion(input: {
  enabled: boolean;
  disabled: boolean;
  threadIdle: boolean;
  threadId: ThreadId | null;
  lastMessage: PromptSuggestionMessage | null;
  prompt: string;
  trigger: ComposerTrigger | null;
}): { ghostText: string | null; accept: () => string | null } {
  const [storedDismissedKey, setDismissedKey] = useState<string | null>(null);

  const key =
    input.threadId && input.lastMessage
      ? createPromptSuggestionKey({
          threadId: input.threadId,
          lastMessageId: input.lastMessage.id,
        })
      : null;

  // Typing dismisses the current suggestion and a new key clears it, so the
  // stored dismissal is reconciled during render rather than in an effect.
  const dismissedKey = resolveDismissedPromptSuggestionKey({
    currentKey: key,
    dismissedKey: storedDismissedKey,
    prompt: input.prompt,
  });
  if (dismissedKey !== storedDismissedKey) {
    setDismissedKey(dismissedKey);
  }

  const settledAssistantMessage =
    input.lastMessage?.role === "assistant" && !input.lastMessage.streaming
      ? input.lastMessage
      : null;
  const suggestion = settledAssistantMessage?.suggestion?.trim() || null;

  const visible =
    key !== null &&
    suggestion !== null &&
    dismissedKey !== key &&
    shouldShowPromptSuggestion({
      enabled: input.enabled,
      disabled: input.disabled,
      threadIdle: input.threadIdle,
      prompt: input.prompt,
      trigger: input.trigger,
    });

  const accept = (): string | null => {
    if (!visible || key === null || suggestion === null) return null;
    setDismissedKey(key);
    return suggestion;
  };

  return { ghostText: visible ? suggestion : null, accept };
}
