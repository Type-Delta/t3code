import { describe, expect, it } from "vite-plus/test";

import {
  createComposerSuggestionKey,
  isComposerSuggestionCurrent,
  normalizeComposerSuggestion,
  resolveDismissedComposerSuggestionKey,
  shouldRequestComposerSuggestion,
} from "./composerSuggestion.logic";

const idleAfterReply = {
  enabled: true,
  disabled: false,
  threadIdle: true,
  prompt: "",
  hasAssistantReply: true,
  trigger: null,
};

describe("composer next-prompt suggestion", () => {
  it("only asks once the thread is idle after an assistant reply and the composer is empty", () => {
    expect(shouldRequestComposerSuggestion(idleAfterReply)).toBe(true);
    expect(shouldRequestComposerSuggestion({ ...idleAfterReply, threadIdle: false })).toBe(false);
    expect(shouldRequestComposerSuggestion({ ...idleAfterReply, hasAssistantReply: false })).toBe(
      false,
    );
    expect(shouldRequestComposerSuggestion({ ...idleAfterReply, prompt: "run tests" })).toBe(false);
    expect(shouldRequestComposerSuggestion({ ...idleAfterReply, prompt: "   " })).toBe(false);
    expect(shouldRequestComposerSuggestion({ ...idleAfterReply, disabled: true })).toBe(false);
  });

  it.each([
    { kind: "slash-command", query: "m", rangeStart: 0, rangeEnd: 2 },
    { kind: "skill", query: "review", rangeStart: 0, rangeEnd: 7 },
    { kind: "path", query: "src", rangeStart: 0, rangeEnd: 4 },
  ] as const)("stays out of the way of the $kind menu", (trigger) => {
    expect(shouldRequestComposerSuggestion({ ...idleAfterReply, trigger })).toBe(false);
  });

  it("keeps a turn dismissed after typing is erased and resets for a new turn", () => {
    const firstKey = createComposerSuggestionKey({
      threadId: "thread-a",
      lastMessageId: "message-1",
      instanceId: "codex",
      model: "gpt-5.4",
    });
    const secondKey = createComposerSuggestionKey({
      threadId: "thread-a",
      lastMessageId: "message-2",
      instanceId: "codex",
      model: "gpt-5.4",
    });

    const afterTyping = resolveDismissedComposerSuggestionKey({
      currentKey: firstKey,
      dismissedKey: null,
      prompt: " ",
    });
    expect(afterTyping).toBe(firstKey);
    expect(
      resolveDismissedComposerSuggestionKey({
        currentKey: firstKey,
        dismissedKey: afterTyping,
        prompt: "",
      }),
    ).toBe(firstKey);
    expect(
      resolveDismissedComposerSuggestionKey({
        currentKey: secondKey,
        dismissedKey: afterTyping,
        prompt: "",
      }),
    ).toBeNull();
  });

  it("invalidates a suggestion once a new message or typing arrives", () => {
    const key = createComposerSuggestionKey({
      threadId: "thread-a",
      lastMessageId: "message-1",
      instanceId: "codex",
      model: "gpt-5.4",
    });
    expect(isComposerSuggestionCurrent({ suggestionKey: key, currentKey: key, prompt: "" })).toBe(
      true,
    );
    expect(
      isComposerSuggestionCurrent({ suggestionKey: key, currentKey: key, prompt: "typed" }),
    ).toBe(false);
    expect(
      isComposerSuggestionCurrent({
        suggestionKey: key,
        currentKey: createComposerSuggestionKey({
          threadId: "thread-a",
          lastMessageId: "message-2",
          instanceId: "codex",
          model: "gpt-5.4",
        }),
        prompt: "",
      }),
    ).toBe(false);
  });

  it("rejects multi-line or fenced model output", () => {
    expect(normalizeComposerSuggestion("  Run the focused tests  ")).toBe("Run the focused tests");
    expect(normalizeComposerSuggestion("first\nsecond")).toBeNull();
    expect(normalizeComposerSuggestion("```sh")).toBeNull();
    expect(normalizeComposerSuggestion("")).toBeNull();
  });
});
