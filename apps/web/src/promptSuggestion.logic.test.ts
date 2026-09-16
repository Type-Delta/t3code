import { describe, expect, it } from "vite-plus/test";

import {
  createPromptSuggestionKey,
  resolveDismissedPromptSuggestionKey,
  shouldShowPromptSuggestion,
} from "./promptSuggestion.logic";

const idleEmptyComposer = {
  enabled: true,
  disabled: false,
  threadIdle: true,
  prompt: "",
  trigger: null,
};

describe("prompt suggestion", () => {
  it("only shows on an idle thread with an empty composer", () => {
    expect(shouldShowPromptSuggestion(idleEmptyComposer)).toBe(true);
    expect(shouldShowPromptSuggestion({ ...idleEmptyComposer, enabled: false })).toBe(false);
    expect(shouldShowPromptSuggestion({ ...idleEmptyComposer, threadIdle: false })).toBe(false);
    expect(shouldShowPromptSuggestion({ ...idleEmptyComposer, disabled: true })).toBe(false);
    expect(shouldShowPromptSuggestion({ ...idleEmptyComposer, prompt: "run tests" })).toBe(false);
    expect(shouldShowPromptSuggestion({ ...idleEmptyComposer, prompt: " " })).toBe(false);
  });

  it.each([
    { kind: "slash-command", query: "m", rangeStart: 0, rangeEnd: 2 },
    { kind: "skill", query: "review", rangeStart: 0, rangeEnd: 7 },
    { kind: "path", query: "src", rangeStart: 0, rangeEnd: 4 },
  ] as const)("stays out of the way of the $kind menu", (trigger) => {
    expect(shouldShowPromptSuggestion({ ...idleEmptyComposer, trigger })).toBe(false);
  });

  it("keys a suggestion to the message that carried it", () => {
    expect(
      createPromptSuggestionKey({ threadId: "thread-a", lastMessageId: "message-1" }),
    ).not.toBe(createPromptSuggestionKey({ threadId: "thread-a", lastMessageId: "message-2" }));
    expect(createPromptSuggestionKey({ threadId: "thread-a", lastMessageId: "message-1" })).toBe(
      createPromptSuggestionKey({ threadId: "thread-a", lastMessageId: "message-1" }),
    );
  });

  it("keeps a message dismissed after typing is erased and resets for a new message", () => {
    const firstKey = createPromptSuggestionKey({
      threadId: "thread-a",
      lastMessageId: "message-1",
    });
    const secondKey = createPromptSuggestionKey({
      threadId: "thread-a",
      lastMessageId: "message-2",
    });

    const afterTyping = resolveDismissedPromptSuggestionKey({
      currentKey: firstKey,
      dismissedKey: null,
      prompt: " ",
    });
    expect(afterTyping).toBe(firstKey);
    expect(
      resolveDismissedPromptSuggestionKey({
        currentKey: firstKey,
        dismissedKey: afterTyping,
        prompt: "",
      }),
    ).toBe(firstKey);
    expect(
      resolveDismissedPromptSuggestionKey({
        currentKey: secondKey,
        dismissedKey: afterTyping,
        prompt: "",
      }),
    ).toBeNull();
  });

  it("has nothing to dismiss without a thread or message", () => {
    expect(
      resolveDismissedPromptSuggestionKey({
        currentKey: null,
        dismissedKey: "thread-a:message-1",
        prompt: "typing",
      }),
    ).toBeNull();
  });
});
