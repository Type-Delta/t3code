import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it.effect("does not inherit another model's capabilities for an unknown custom model", () =>
  Effect.gen(function* () {
    const settings = decodeCodexSettings({ customModels: ["proxy-only-model"] });
    const status = yield* checkCodexProviderStatus(settings, () =>
      Effect.succeed({
        account: {
          account: { type: "apiKey" as const },
          requiresOpenaiAuth: false,
        },
        version: "1.0.0",
        models: [
          {
            slug: "known-model",
            name: "Known Model",
            isCustom: false,
            capabilities: createReasoningCapabilities("medium"),
          },
          {
            slug: "proxy-only-model",
            name: "proxy-only-model",
            isCustom: true,
            capabilities: null,
          },
        ],
        skills: [],
      }),
    );

    assert.strictEqual(
      status.models.find((model) => model.slug === "proxy-only-model")?.capabilities,
      null,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uses gateway metadata and manual reasoning overrides in provider status", () =>
  Effect.gen(function* () {
    const settings = decodeCodexSettings({
      customModels: ["proxy-model"],
      modelOverrides: {
        "proxy-model": {
          contextWindowTokens: 180_000,
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        },
      },
    });
    const status = yield* checkCodexProviderStatus(
      settings,
      () =>
        Effect.succeed({
          account: {
            account: { type: "apiKey" as const },
            requiresOpenaiAuth: false,
          },
          version: "1.0.0",
          models: [],
          skills: [],
        }),
      {},
      {
        source: "network",
        models: [
          {
            slug: "proxy-model",
            name: "Proxy Model",
            metadata: { contextWindowTokens: 200_000, source: "gateway" },
            reasoningEfforts: ["minimal", "medium"],
            defaultReasoningEffort: "medium",
          },
        ],
      },
    );

    const model = status.models.find((candidate) => candidate.slug === "proxy-model");
    assert.strictEqual(model?.metadata?.contextWindowTokens, 180_000);
    assert.strictEqual(model?.metadata?.source, "gateway");
    assert.deepStrictEqual(model?.capabilities?.optionDescriptors, [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
        currentValue: "high",
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

function createReasoningCapabilities(currentValue: string) {
  return {
    optionDescriptors: [
      {
        id: "reasoningEffort" as const,
        label: "Reasoning",
        type: "select" as const,
        options: [{ id: currentValue, label: currentValue, isDefault: true }],
        currentValue,
      },
    ],
  };
}
