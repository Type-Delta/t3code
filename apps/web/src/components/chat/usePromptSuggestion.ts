import type { MessageId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

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
  const dismissedKeyRef = useRef<string | null>(null);

  const key =
    input.threadId && input.lastMessage
      ? createPromptSuggestionKey({
          threadId: input.threadId,
          lastMessageId: input.lastMessage.id,
        })
      : null;

  // The dismissal is a ref rather than state: every input that can change it
  // already re-renders the composer, so tracking it separately would only add
  // a render.
  useEffect(() => {
    dismissedKeyRef.current = resolveDismissedPromptSuggestionKey({
      currentKey: key,
      dismissedKey: dismissedKeyRef.current,
      prompt: input.prompt,
    });
  }, [key, input.prompt]);

  const settledAssistantMessage =
    input.lastMessage?.role === "assistant" && !input.lastMessage.streaming
      ? input.lastMessage
      : null;
  const suggestion = settledAssistantMessage?.suggestion?.trim() || null;

  const visible =
    key !== null &&
    suggestion !== null &&
    dismissedKeyRef.current !== key &&
    shouldShowPromptSuggestion({
      enabled: input.enabled,
      disabled: input.disabled,
      threadIdle: input.threadIdle,
      prompt: input.prompt,
      trigger: input.trigger,
    });

  const accept = useCallback((): string | null => {
    if (!visible || key === null || suggestion === null) return null;
    dismissedKeyRef.current = key;
    return suggestion;
  }, [visible, key, suggestion]);

  return { ghostText: visible ? suggestion : null, accept };
}
