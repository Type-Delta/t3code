import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findTaggedPromptSuggestion } from "./promptSuggestion.logic";

const RUN = RunId.make("run-1");
const reply = (fields: { suggestion?: string; streaming?: boolean; runId?: RunId | null }) =>
  ({
    item: {
      type: "assistant_message",
      runId: fields.runId === undefined ? RUN : fields.runId,
      streaming: fields.streaming ?? false,
      ...(fields.suggestion === undefined ? {} : { suggestion: fields.suggestion }),
    },
  }) as ThreadStructureVisibleTurnItem;
const user = { item: { type: "user_message", runId: RUN } } as ThreadStructureVisibleTurnItem;
const reasoning = { item: { type: "reasoning", runId: RUN } } as ThreadStructureVisibleTurnItem;

describe("findTaggedPromptSuggestion", () => {
  it("takes the suggestion of a settled last reply, skipping later non-message rows", () => {
    expect(
      findTaggedPromptSuggestion([user, reply({ suggestion: " Run tests " }), reasoning]),
    ).toEqual({ runId: RUN, text: "Run tests" });
  });

  it.each([
    { name: "a newer user message", rows: [reply({ suggestion: "Run tests" }), user] },
    { name: "a streaming reply", rows: [reply({ suggestion: "Run tests", streaming: true })] },
    { name: "a reply without a run", rows: [reply({ suggestion: "Run tests", runId: null })] },
    { name: "a newer reply without one", rows: [reply({ suggestion: "Run tests" }), reply({})] },
    { name: "an empty thread", rows: [] },
  ])("offers none after $name", ({ rows }) => {
    expect(findTaggedPromptSuggestion(rows)).toBeNull();
  });
});
