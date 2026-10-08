import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  checkClaudeProviderStatus,
  claudeModelsFromSettings,
  makePendingClaudeProvider,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("Claude gateway model metadata", (it) => {
  it("merges discovered models and manual metadata per provider instance", () => {
    const settings = decodeClaudeSettings({
      customModels: ["claude-private"],
      modelOverrides: {
        "claude-private": {
          displayName: "Private Claude",
          contextWindowTokens: 300_000,
          reasoningEfforts: ["low", "max"],
          defaultReasoningEffort: "max",
        },
      },
    });
    const models = claudeModelsFromSettings(settings, {
      source: "network",
      models: [
        {
          slug: "claude-private",
          name: "Gateway Claude",
          metadata: { contextWindowTokens: 200_000, source: "gateway" },
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("Private Claude");
    expect(models[0]?.metadata).toEqual({
      contextWindowTokens: 300_000,
      source: "gateway",
    });
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "effort",
      currentValue: "max",
      options: [
        { id: "low", label: "Low" },
        { id: "max", label: "Max", isDefault: true },
      ],
    });
  });

  it.each([
    { contextWindowTokens: 200_000, expectedApiModel: "claude-opus-4-6" },
    { contextWindowTokens: 300_000, expectedApiModel: "claude-opus-4-6[1m]" },
  ])(
    "uses a $contextWindowTokens-token manual context without exposing the built-in selector",
    ({ contextWindowTokens, expectedApiModel }) => {
      const settings = decodeClaudeSettings({
        modelOverrides: {
          "claude-opus-4-6": { contextWindowTokens },
        },
      });
      const model = claudeModelsFromSettings(settings).find(
        (candidate) => candidate.slug === "claude-opus-4-6",
      );

      expect(model?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
        "effort",
        "fastMode",
      ]);
      expect(
        resolveClaudeApiModelId(
          {
            instanceId: ProviderInstanceId.make("claude_gateway"),
            model: "claude-opus-4-6",
            options: [
              {
                id: "contextWindow",
                value: contextWindowTokens > 200_000 ? "200k" : "1m",
              },
            ],
          },
          model,
        ),
      ).toBe(expectedApiModel);
    },
  );

  it("maps only usable contexts above 200k to Claude's 1m model variant", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("claude_gateway"),
      model: "claude-opus-4-6",
      options: [{ id: "contextWindow", value: "1m" }],
    } as const;

    expect(
      resolveClaudeApiModelId(selection, {
        slug: selection.model,
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: null,
        metadata: { contextWindowTokens: 200_000, maxContextWindowTokens: 1_000_000 },
      }),
    ).toBe("claude-opus-4-6");
    expect(
      resolveClaudeApiModelId(selection, {
        slug: selection.model,
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: null,
        metadata: { contextWindowTokens: 300_000, maxContextWindowTokens: 1_000_000 },
      }),
    ).toBe("claude-opus-4-6[1m]");
  });

  it("preserves advertised xhigh for gateway and manually configured models", () => {
    const xhighCapabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select" as const,
          options: [{ id: "xhigh", label: "Extra High" }],
        },
      ],
    };

    expect(
      normalizeClaudeCliEffort("xhigh", "claude-opus-4-7", {
        slug: "claude-opus-4-7",
        name: "Gateway Opus",
        isCustom: false,
        capabilities: xhighCapabilities,
        metadata: { source: "gateway" },
      }),
    ).toBe("xhigh");
    expect(
      normalizeClaudeCliEffort("xhigh", "claude-private", {
        slug: "claude-private",
        name: "Private Claude",
        isCustom: true,
        capabilities: xhighCapabilities,
      }),
    ).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-4-7")).toBe("max");
  });

  it.effect("marks cached and network gateway inventories as authoritative, including empty", () =>
    Effect.gen(function* () {
      const settings = decodeClaudeSettings({ enabled: false });

      for (const source of ["cache", "network"] as const) {
        const catalog = { source, models: [] } as const;
        const pending = yield* makePendingClaudeProvider(settings, catalog);
        const checked = yield* checkClaudeProviderStatus(
          settings,
          undefined,
          undefined,
          undefined,
          catalog,
        );

        expect(pending.models).toEqual([]);
        expect(pending.modelsAuthoritative).toBe(true);
        expect(checked.models).toEqual([]);
        expect(checked.modelsAuthoritative).toBe(true);
      }

      const pendingWithoutCatalog = yield* makePendingClaudeProvider(settings, {
        source: "none",
        models: [],
      });
      expect(pendingWithoutCatalog.modelsAuthoritative).toBeUndefined();
    }),
  );
});
