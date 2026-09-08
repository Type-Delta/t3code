import { describe, expect, it } from "vite-plus/test";
import { extractPromptSuggestion, promptSuggestionHoldbackLength } from "./promptSuggestion.ts";

describe("extractPromptSuggestion", () => {
  it.each([
    ["Done.\n<t3_prompt_suggestion>Run tests</t3_prompt_suggestion>", "Done.", "Run tests"],
    ["Before <t3_prompt_suggestion>Next</t3_prompt_suggestion> after", "Before\n\nafter", "Next"],
    ["Done. <t3_prompt_suggestion>unfinished", "Done.", undefined],
    ["Done.<t3_prompt_suggestion>one\ntwo</t3_prompt_suggestion>", "Done.", undefined],
    ["  Plain reply.\n", "  Plain reply.\n", undefined],
    ["Done.<t3_prompt_sug", "Done.", undefined],
    [
      "A <t3_prompt_suggestion>first</t3_prompt_suggestion> B <t3_prompt_suggestion>second</t3_prompt_suggestion>",
      "A\n\nB",
      "first",
    ],
  ])("extracts %j", (raw, text, suggestion) => {
    expect(extractPromptSuggestion(raw!)).toEqual({ text, suggestion });
  });
});

describe("promptSuggestionHoldbackLength", () => {
  it("holds partial and complete opening tags until finalization", () => {
    expect(promptSuggestionHoldbackLength("Done.<t3_prompt_sug")).toBe(14);
    const tag = "<t3_prompt_suggestion>Next</t3_prompt_suggestion>";
    expect(promptSuggestionHoldbackLength(`Done.${tag}`)).toBe(tag.length);
    expect(promptSuggestionHoldbackLength(`Done.${tag} more ${tag}`)).toBe(
      `${tag} more ${tag}`.length,
    );
    expect(promptSuggestionHoldbackLength("Plain reply.")).toBe(0);
  });
});
