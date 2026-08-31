import { describe, expect, it } from "vite-plus/test";

import { buildModelMetadataOverride } from "./CustomModelMetadataDialog";

describe("buildModelMetadataOverride", () => {
  it("normalizes optional metadata and reasoning efforts", () => {
    expect(
      buildModelMetadataOverride({
        displayName: " Claude Opus Proxy ",
        contextWindowTokens: "200000",
        maxContextWindowTokens: "1000000",
        maxOutputTokens: "32768",
        reasoningEfforts: " low, medium, high, medium ",
        defaultReasoningEffort: " medium ",
      }),
    ).toEqual({
      displayName: "Claude Opus Proxy",
      contextWindowTokens: 200_000,
      maxContextWindowTokens: 1_000_000,
      maxOutputTokens: 32_768,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    });
  });

  it("keeps unknown values absent", () => {
    expect(
      buildModelMetadataOverride({
        displayName: "",
        contextWindowTokens: "",
        maxContextWindowTokens: "",
        maxOutputTokens: "",
        reasoningEfforts: "",
        defaultReasoningEffort: "",
      }),
    ).toEqual({});
  });

  it("rejects an unusable maximum and an unsupported default effort", () => {
    expect(() =>
      buildModelMetadataOverride({
        displayName: "",
        contextWindowTokens: "1000000",
        maxContextWindowTokens: "200000",
        maxOutputTokens: "",
        reasoningEfforts: "low, high",
        defaultReasoningEffort: "low",
      }),
    ).toThrow("Maximum context window cannot be smaller");

    expect(() =>
      buildModelMetadataOverride({
        displayName: "",
        contextWindowTokens: "",
        maxContextWindowTokens: "",
        maxOutputTokens: "",
        reasoningEfforts: "low, high",
        defaultReasoningEffort: "medium",
      }),
    ).toThrow("must appear in the supported effort list");
  });
});
