import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay, readConfigModelOverrides } from "./ProviderInstanceCard";

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
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
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
      {
        slug: "stale-custom",
        name: "Stale Custom",
        isCustom: true,
        capabilities: null,
      },
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
          {
            ...liveModels[0]!,
            metadata: { contextWindowTokens: 180_000, source: "manual" },
          },
        ],
        customModels: [],
        includeDiscoveredModels: true,
        modelOverrides: { "gateway-model": { contextWindowTokens: 180_000 } },
      }).map((model) => model.slug),
    ).toEqual(["gateway-model"]);
  });
});

describe("readConfigModelOverrides", () => {
  it("reads only the model override record from provider config", () => {
    expect(
      readConfigModelOverrides({
        customModels: ["custom"],
        modelOverrides: {
          custom: {
            displayName: "Custom Model",
            contextWindowTokens: 200_000,
          },
        },
      }),
    ).toEqual({
      custom: {
        displayName: "Custom Model",
        contextWindowTokens: 200_000,
      },
    });
    expect(readConfigModelOverrides({ modelOverrides: [] })).toEqual({});
    expect(readConfigModelOverrides(undefined)).toEqual({});
  });
});
