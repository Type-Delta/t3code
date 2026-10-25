import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  nextProviderEnvironmentWithFieldValue,
  readConfigModelOverrides,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [{ slug: "kept-custom", name: "kept-custom", capabilities: null }],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("prefers the entry's name and capabilities over the stale live custom row", () => {
    const liveCapabilities = { optionDescriptors: [] };
    const customCapabilities = {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: [{ id: "high", label: "High", isDefault: true }],
          currentValue: "high",
        },
      ],
    };
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      { slug: "bare", name: "bare", isCustom: true, capabilities: liveCapabilities },
      { slug: "named", name: "named", isCustom: true, capabilities: liveCapabilities },
    ];

    const display = deriveProviderModelsForDisplay({
      liveModels,
      customModels: [
        { slug: "bare", name: "bare", capabilities: null },
        { slug: "named", name: "My Model", capabilities: customCapabilities },
      ],
    });

    expect(display[0]).toEqual({
      slug: "bare",
      name: "bare",
      isCustom: true,
      capabilities: liveCapabilities,
    });
    expect(display[1]).toEqual({
      slug: "named",
      name: "My Model",
      isCustom: true,
      capabilities: customCapabilities,
    });
  });

  it("keeps gateway-discovered rows without reviving stale configured custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "gateway-model",
        name: "Gateway Model",
        isCustom: true,
        capabilities: null,
        metadata: { contextWindowTokens: 200_000, source: "gateway" },
      },
      {
        slug: "list-only-gateway-model",
        name: "List-only Gateway Model",
        isCustom: true,
        capabilities: null,
        metadata: { source: "gateway" },
      },
      { slug: "stale-custom", name: "Stale Custom", isCustom: true, capabilities: null },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [],
        includeDiscoveredModels: true,
      }).map((model) => model.slug),
    ).toEqual(["gateway-model", "list-only-gateway-model"]);
    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [],
        includeDiscoveredModels: false,
      }).map((model) => model.slug),
    ).toEqual([]);
    expect(
      deriveProviderModelsForDisplay({
        liveModels: [
          { ...liveModels[0]!, metadata: { contextWindowTokens: 180_000, source: "manual" } },
        ],
        customModels: [],
        includeDiscoveredModels: true,
        modelOverrides: { "gateway-model": { contextWindowTokens: 180_000 } },
      }).map((model) => model.slug),
    ).toEqual(["gateway-model"]);
  });

  it("reads only the model override record from provider config", () => {
    expect(
      readConfigModelOverrides({
        customModels: ["custom"],
        modelOverrides: {
          custom: { displayName: "Custom Model", contextWindowTokens: 200_000 },
        },
      }),
    ).toEqual({
      custom: { displayName: "Custom Model", contextWindowTokens: 200_000 },
    });
    expect(readConfigModelOverrides({ modelOverrides: [] })).toEqual({});
    expect(readConfigModelOverrides(undefined)).toEqual({});
  });
});

describe("provider environment helpers", () => {
  const cursorApiKeyField = {
    name: "CURSOR_API_KEY",
    label: "Cursor API key",
    sensitive: true,
  };

  it("writes dedicated provider secrets as sensitive environment variables", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "EXTRA_FLAG", value: "1", sensitive: false }],
        cursorApiKeyField,
        "  cursor-key  ",
      ),
    ).toEqual([
      { name: "EXTRA_FLAG", value: "1", sensitive: false },
      { name: "CURSOR_API_KEY", value: "cursor-key", sensitive: true },
    ]);
  });

  it("replaces redacted provider secrets without preserving redaction markers", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [
          {
            name: "CURSOR_API_KEY",
            value: "",
            sensitive: true,
            valueRedacted: true,
          },
        ],
        cursorApiKeyField,
        "new-key",
      ),
    ).toEqual([{ name: "CURSOR_API_KEY", value: "new-key", sensitive: true }]);
  });

  it("applies the secure field default when replacing an existing non-sensitive value", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "OPENAI_API_KEY", value: "old-key", sensitive: false }],
        {
          name: "OPENAI_API_KEY",
          label: "OpenAI API key",
        },
        "new-key",
      ),
    ).toEqual([{ name: "OPENAI_API_KEY", value: "new-key", sensitive: true }]);
  });
});
