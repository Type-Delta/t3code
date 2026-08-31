import type { ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderModelDetails, formatModelTokenCount } from "./providerModelDetails";

const model = (overrides: Partial<ServerProviderModel> = {}): ServerProviderModel => ({
  slug: "model-1",
  name: "Model One",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("provider model details", () => {
  it("formats exact and compact token counts", () => {
    expect(formatModelTokenCount(200_000)).toBe("200,000 tokens (200k)");
    expect(formatModelTokenCount(1_000_000)).toBe("1,000,000 tokens (1m)");
  });

  it("shows detected gateway metadata and reasoning choices", () => {
    expect(
      deriveProviderModelDetails({
        model: model({
          metadata: {
            contextWindowTokens: 200_000,
            maxContextWindowTokens: 1_000_000,
            maxOutputTokens: 32_768,
            source: "gateway",
          },
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                currentValue: "medium",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        }),
        capabilityLabels: ["Reasoning"],
      }),
    ).toEqual([
      { label: "Model ID", value: "model-1" },
      { label: "Source", value: "Gateway catalog" },
      { label: "Usable context", value: "200,000 tokens (200k)" },
      { label: "Maximum context", value: "1,000,000 tokens (1m)" },
      { label: "Maximum output", value: "32,768 tokens (33k)" },
      { label: "Reasoning levels", value: "low, medium, high" },
      { label: "Default reasoning", value: "medium" },
      { label: "Capabilities", value: "Reasoning" },
    ]);
  });

  it("does not invent unknown metadata and identifies mixed detected and manual values", () => {
    expect(deriveProviderModelDetails({ model: model(), capabilityLabels: [] })).toEqual([
      { label: "Model ID", value: "model-1" },
    ]);

    expect(
      deriveProviderModelDetails({
        model: model({ metadata: { contextWindowTokens: 200_000, source: "harness" } }),
        override: {
          contextWindowTokens: 180_000,
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        },
        capabilityLabels: [],
      }),
    ).toEqual([
      { label: "Model ID", value: "model-1" },
      { label: "Source", value: "Manual override + Provider harness" },
      { label: "Usable context", value: "180,000 tokens (180k)" },
      { label: "Reasoning levels", value: "low, high" },
      { label: "Default reasoning", value: "high" },
    ]);

    expect(
      deriveProviderModelDetails({
        model: model({
          metadata: {
            contextWindowTokens: 200_000,
            maxOutputTokens: 32_768,
            source: "gateway",
          },
        }),
        override: { displayName: "Friendly name" },
        capabilityLabels: [],
      }),
    ).toEqual([
      { label: "Model ID", value: "model-1" },
      { label: "Source", value: "Manual override + Gateway catalog" },
      { label: "Usable context", value: "200,000 tokens (200k)" },
      { label: "Maximum output", value: "32,768 tokens (33k)" },
    ]);
  });

  it("shows manual provenance once when detected metadata is already manual", () => {
    expect(
      deriveProviderModelDetails({
        model: model({ metadata: { contextWindowTokens: 180_000, source: "manual" } }),
        override: { contextWindowTokens: 180_000 },
        capabilityLabels: [],
      }),
    ).toEqual([
      { label: "Model ID", value: "model-1" },
      { label: "Source", value: "Manual override" },
      { label: "Usable context", value: "180,000 tokens (180k)" },
    ]);
  });
});
