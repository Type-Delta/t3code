import type { EnvironmentId, MessageId, ModelSelection, ThreadId } from "@t3tools/contracts";
import { useAtomCommand } from "~/state/use-atom-command";
import { composerSuggestion } from "~/state/composerSuggestion";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ComposerTrigger } from "../../composer-logic";
import {
  COMPOSER_SUGGESTION_DELAY_MS,
  createComposerSuggestionKey,
  isComposerSuggestionCurrent,
  normalizeComposerSuggestion,
  resolveDismissedComposerSuggestionKey,
  shouldRequestComposerSuggestion,
} from "../../composerSuggestion.logic";

/**
 * Asks the active model what the user would plausibly send next, once the
 * thread has gone idle after an assistant reply.
 */
export function useComposerSuggestion(input: {
  enabled: boolean;
  disabled: boolean;
  threadIdle: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  lastMessageId: MessageId | null;
  hasAssistantReply: boolean;
  prompt: string;
  trigger: ComposerTrigger | null;
  modelSelection: ModelSelection;
}) {
  const requestSuggestion = useAtomCommand(composerSuggestion, {
    reportFailure: false,
    reportDefect: false,
  });
  const [suggestion, setSuggestion] = useState<{ text: string; key: string } | null>(null);
  const generationRef = useRef(0);
  const dismissedKeyRef = useRef<string | null>(null);

  const key =
    input.threadId && input.lastMessageId
      ? createComposerSuggestionKey({
          threadId: input.threadId,
          lastMessageId: input.lastMessageId,
          instanceId: input.modelSelection.instanceId,
          model: input.modelSelection.model,
        })
      : null;

  const eligible =
    key !== null &&
    input.threadId !== null &&
    shouldRequestComposerSuggestion({
      enabled: input.enabled,
      disabled: input.disabled,
      threadIdle: input.threadIdle,
      prompt: input.prompt,
      hasAssistantReply: input.hasAssistantReply,
      trigger: input.trigger,
    });

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setSuggestion(null);
    dismissedKeyRef.current = resolveDismissedComposerSuggestionKey({
      currentKey: key,
      dismissedKey: dismissedKeyRef.current,
      prompt: input.prompt,
    });
    if (!eligible || key === null || input.threadId === null || input.lastMessageId === null) {
      return;
    }
    if (dismissedKeyRef.current === key) return;
    const threadId = input.threadId;
    const lastMessageId = input.lastMessageId;

    const timer = window.setTimeout(() => {
      void requestSuggestion({
        environmentId: input.environmentId,
        input: { threadId, lastMessageId, modelSelection: input.modelSelection },
      }).then((result) => {
        if (generationRef.current !== generation || result._tag !== "Success") return;
        if (result.value.kind !== "suggestion") return;
        const text = normalizeComposerSuggestion(result.value.text);
        if (!text) return;
        setSuggestion({ text, key });
      });
    }, COMPOSER_SUGGESTION_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    eligible,
    input.environmentId,
    input.lastMessageId,
    input.modelSelection,
    input.prompt,
    input.threadId,
    key,
    requestSuggestion,
  ]);

  const accept = useCallback((): string | null => {
    if (
      !suggestion ||
      key === null ||
      !isComposerSuggestionCurrent({
        suggestionKey: suggestion.key,
        currentKey: key,
        prompt: input.prompt,
      })
    ) {
      return null;
    }
    dismissedKeyRef.current = key;
    setSuggestion(null);
    return suggestion.text;
  }, [input.prompt, key, suggestion]);

  return {
    ghostText: suggestion && key !== null && suggestion.key === key ? suggestion.text : null,
    accept,
  };
}
