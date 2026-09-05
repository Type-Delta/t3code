import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApiGatewaySettings, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import {
  makeGatewayModelCatalog,
  mergeGatewayModelCatalog,
  parseGatewayModelCatalog,
  type GatewayCatalogSnapshot,
  usableModelContextWindows,
} from "./GatewayModelCatalog.ts";

const decodeGatewaySettings = Schema.decodeSync(ApiGatewaySettings);

const httpClientLayer = (handler: (request: Request) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          handler(new Request(request.url.toString(), { method: request.method })),
        ),
      ),
    ),
  );

const gatewayTestLayer = (handler: (request: Request) => Response) =>
  ServerConfig.layerTest(process.cwd(), { prefix: "gateway-model-catalog-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(httpClientLayer(handler)),
  );

describe("gateway model catalog parsing", () => {
  it("reads the rich Codex catalog used by CLIProxyAPI", () => {
    const catalog = parseGatewayModelCatalog({
      models: [
        {
          slug: "gpt-private",
          display_name: "GPT Private",
          description: "Private routed model",
          context_window: 200_000,
          max_context_window: 1_000_000,
          max_tokens: 64_000,
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "high", description: "Deep" },
          ],
        },
        { slug: "hidden", display_name: "Hidden", visibility: "hide" },
      ],
    });

    expect(catalog?.format).toBe("codex");
    expect(catalog?.models).toEqual([
      {
        slug: "gpt-private",
        name: "GPT Private",
        description: "Private routed model",
        metadata: {
          contextWindowTokens: 200_000,
          maxContextWindowTokens: 1_000_000,
          maxOutputTokens: 64_000,
          source: "gateway",
        },
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
    ]);
    expect(catalog?.rawCodexCatalog).toBeDefined();
  });

  it("reads Anthropic and extended OpenAI metadata", () => {
    expect(
      parseGatewayModelCatalog(
        {
          data: [
            {
              id: "claude-private",
              display_name: "Claude Private",
              max_input_tokens: 200_000,
              max_tokens: 32_000,
            },
          ],
        },
        "anthropic",
      )?.models[0],
    ).toMatchObject({
      slug: "claude-private",
      metadata: {
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
    });

    expect(
      parseGatewayModelCatalog(
        {
          data: [
            {
              id: "openai-private",
              context_length: 128_000,
              max_context_length: 256_000,
              max_completion_tokens: 16_000,
              thinking: { levels: ["minimal", "high"] },
            },
          ],
        },
        "openai",
      )?.models[0],
    ).toMatchObject({
      slug: "openai-private",
      reasoningEfforts: ["minimal", "high"],
      metadata: {
        contextWindowTokens: 128_000,
        maxContextWindowTokens: 256_000,
        maxOutputTokens: 16_000,
      },
    });
  });

  it("reads supported Anthropic effort capabilities for an unknown model", () => {
    expect(
      parseGatewayModelCatalog(
        {
          data: [
            {
              id: "claude-gateway-private",
              display_name: "Claude Gateway Private",
              max_input_tokens: 200_000,
              capabilities: {
                effort: {
                  low: { supported: true },
                  medium: { supported: false },
                  high: { supported: true, is_default: true },
                  max: { supported: true },
                },
              },
            },
          ],
        },
        "anthropic",
      )?.models[0],
    ).toMatchObject({
      slug: "claude-gateway-private",
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    });
  });
});

describe("gateway model catalog merging", () => {
  it("uses gateway inventory and applies manual metadata last", () => {
    const catalog: GatewayCatalogSnapshot = {
      source: "network",
      models: [
        {
          slug: "model-a",
          name: "Gateway A",
          metadata: { contextWindowTokens: 200_000, source: "gateway" },
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
        },
      ],
    };
    const merged = mergeGatewayModelCatalog({
      baseModels: [
        {
          slug: "model-a",
          name: "Built-in A",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              { id: "fastMode", label: "Fast Mode", type: "boolean" },
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "medium", label: "Medium", isDefault: true }],
              },
            ],
          },
        },
        { slug: "not-routed", name: "Not Routed", isCustom: false, capabilities: null },
      ],
      catalog,
      customModels: ["manual-only"],
      modelOverrides: {
        "model-a": {
          displayName: "Manual A",
          contextWindowTokens: 300_000,
          reasoningEfforts: ["high", "max"],
          defaultReasoningEffort: "max",
        },
      },
      reasoningOptionId: "effort",
      emptyCustomCapabilities: { optionDescriptors: [] },
    });

    expect(merged.map((model) => model.slug)).toEqual(["model-a", "manual-only"]);
    expect(merged[0]?.name).toBe("Manual A");
    expect(merged[0]?.metadata).toEqual({
      contextWindowTokens: 300_000,
      source: "gateway",
    });
    expect(merged[0]?.capabilities?.optionDescriptors).toEqual([
      { id: "fastMode", label: "Fast Mode", type: "boolean" },
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "high", label: "High" },
          { id: "max", label: "Max", isDefault: true },
        ],
        currentValue: "max",
      },
    ]);
  });

  it("treats successful empty catalogs as authoritative", () => {
    const baseModels = [
      { slug: "built-in", name: "Built-in", isCustom: false, capabilities: null },
    ];
    const input = {
      baseModels,
      customModels: [],
      modelOverrides: {},
      reasoningOptionId: "effort",
    };

    expect(
      mergeGatewayModelCatalog({
        ...input,
        catalog: { source: "network", models: [] },
      }),
    ).toEqual([]);
    expect(
      mergeGatewayModelCatalog({
        ...input,
        catalog: { source: "cache", models: [] },
      }),
    ).toEqual([]);
    expect(
      mergeGatewayModelCatalog({
        ...input,
        catalog: { source: "none", models: [] },
      }),
    ).toEqual(baseModels);
    expect(
      mergeGatewayModelCatalog({
        ...input,
        catalog: { source: "disabled", models: [] },
      }),
    ).toEqual(baseModels);
  });

  it("keeps detected provenance for display and reasoning-only overrides", () => {
    const catalog: GatewayCatalogSnapshot = {
      source: "network",
      models: [
        {
          slug: "display-only",
          name: "Detected display",
          metadata: { contextWindowTokens: 200_000, source: "gateway" },
        },
        {
          slug: "reasoning-only",
          name: "Detected reasoning",
          metadata: { contextWindowTokens: 180_000, source: "gateway" },
          reasoningEfforts: ["low", "high"],
        },
      ],
    };

    const merged = mergeGatewayModelCatalog({
      baseModels: [],
      catalog,
      customModels: [],
      modelOverrides: {
        "display-only": { displayName: "Manual display" },
        "reasoning-only": {
          reasoningEfforts: ["medium", "high"],
          defaultReasoningEffort: "high",
        },
      },
      reasoningOptionId: "effort",
    });

    expect(merged[0]?.metadata).toEqual({
      contextWindowTokens: 200_000,
      source: "gateway",
    });
    expect(merged[1]?.metadata).toEqual({
      contextWindowTokens: 180_000,
      source: "gateway",
    });
  });

  it("marks list-only catalog models as gateway sourced without inventing limits", () => {
    const merged = mergeGatewayModelCatalog({
      baseModels: [],
      catalog: {
        source: "network",
        models: [{ slug: "list-only", name: "List only" }],
      },
      customModels: [],
      modelOverrides: {},
      reasoningOptionId: "effort",
    });

    expect(merged[0]?.metadata).toEqual({ source: "gateway" });
  });

  it("does not duplicate manual provenance for an otherwise unknown model", () => {
    const [model] = mergeGatewayModelCatalog({
      baseModels: [],
      catalog: { source: "none", models: [] },
      customModels: ["manual-only"],
      modelOverrides: { "manual-only": { contextWindowTokens: 96_000 } },
      reasoningOptionId: "effort",
    });

    expect(model?.metadata).toEqual({ contextWindowTokens: 96_000 });
  });

  it("keeps structured custom model presentation and capabilities", () => {
    const [model] = mergeGatewayModelCatalog({
      baseModels: [],
      catalog: { source: "none", models: [] },
      customModels: [
        {
          slug: "manual-only",
          name: "Manual model",
          capabilities: {
            optionDescriptors: [{ id: "fastMode", label: "Fast mode", type: "boolean" }],
          },
        },
      ],
      modelOverrides: {},
      reasoningOptionId: "effort",
    });

    expect(model).toMatchObject({
      slug: "manual-only",
      name: "Manual model",
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast mode", type: "boolean" }],
      },
    });
  });

  it("relays only usable context and includes overrides for models outside the catalog", () => {
    expect(
      usableModelContextWindows({
        models: [
          {
            slug: "catalog-model",
            name: "Catalog model",
            isCustom: true,
            capabilities: null,
            metadata: {
              contextWindowTokens: 180_000,
              maxContextWindowTokens: 1_000_000,
              source: "gateway",
            },
          },
          {
            slug: "max-only",
            name: "Max only",
            isCustom: true,
            capabilities: null,
            metadata: { maxContextWindowTokens: 500_000, source: "gateway" },
          },
        ],
        modelOverrides: {
          "manual-only": { contextWindowTokens: 220_000 },
          "manual-max-only": { maxContextWindowTokens: 900_000 },
        },
      }),
    ).toEqual({
      "catalog-model": 180_000,
      "manual-only": 220_000,
    });
  });
});

describe("gateway model catalog cache and URL validation", () => {
  it.effect("requests the largest Anthropic catalog page without dropping query parameters", () => {
    let requestUrl: URL | undefined;
    return Effect.gen(function* () {
      const catalog = yield* makeGatewayModelCatalog({
        instanceId: ProviderInstanceId.make("anthropic_gateway_request_test"),
        settings: decodeGatewaySettings({
          enabled: true,
          baseUrl: "https://gateway.example/v1",
          catalogUrl: "https://catalog.example/models?region=apac&limit=25",
          catalogFormat: "anthropic",
          authMode: "bearer",
        }),
        environment: {},
      });

      expect((yield* catalog.refresh).source).toBe("network");
      expect(requestUrl?.searchParams.get("region")).toBe("apac");
      expect(requestUrl?.searchParams.get("limit")).toBe("1000");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        gatewayTestLayer((request) => {
          requestUrl = new URL(request.url);
          return Response.json({ data: [] });
        }),
      ),
    );
  });

  it.effect("binds cached catalogs to connection settings and resolved credentials", () => {
    const initial = decodeGatewaySettings({
      enabled: true,
      baseUrl: "https://gateway.example/v1",
      catalogUrl: "https://catalog.example/models",
      catalogFormat: "openai",
      authMode: "bearer",
      apiKeyEnvironmentVariable: "GATEWAY_TOKEN",
    });
    const changedSettings = [
      { ...initial, baseUrl: "https://other-gateway.example/v1" },
      { ...initial, catalogUrl: "https://other-catalog.example/models" },
      { ...initial, catalogFormat: "anthropic" as const },
      { ...initial, authMode: "x-api-key" as const },
      { ...initial, apiKeyEnvironmentVariable: "OTHER_GATEWAY_TOKEN" },
    ];

    return Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_gateway_cache_test");
      const catalog = yield* makeGatewayModelCatalog({
        instanceId,
        settings: initial,
        environment: { GATEWAY_TOKEN: "secret" },
      });
      expect((yield* catalog.refresh).source).toBe("network");
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const rawCache = yield* fileSystem.readFileString(
        `${serverConfig.providerStatusCacheDir}/${instanceId}.gateway-models.json`,
      );
      expect(rawCache).not.toContain('"secret"');

      const matchingCatalog = yield* makeGatewayModelCatalog({
        instanceId,
        settings: initial,
        environment: { GATEWAY_TOKEN: "secret" },
      });
      expect(yield* matchingCatalog.current).toMatchObject({
        source: "cache",
        models: [{ slug: "cached-model" }],
      });

      const rotatedCredentialCatalog = yield* makeGatewayModelCatalog({
        instanceId,
        settings: initial,
        environment: { GATEWAY_TOKEN: "different-secret" },
      });
      expect(yield* rotatedCredentialCatalog.current).toEqual({ models: [], source: "none" });

      for (const settings of changedSettings) {
        const changedCatalog = yield* makeGatewayModelCatalog({
          instanceId,
          settings,
          environment: {
            GATEWAY_TOKEN: "secret",
            OTHER_GATEWAY_TOKEN: "secret",
          },
        });
        expect(yield* changedCatalog.current).toEqual({ models: [], source: "none" });
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        gatewayTestLayer(() =>
          Response.json({ data: [{ id: "cached-model", context_length: 128_000 }] }),
        ),
      ),
    );
  });

  it.effect("does not expose a Codex catalog path for an empty catalog", () =>
    Effect.gen(function* () {
      const catalog = yield* makeGatewayModelCatalog({
        instanceId: ProviderInstanceId.make("codex_gateway_empty_catalog_test"),
        settings: decodeGatewaySettings({
          enabled: true,
          baseUrl: "https://gateway.example/v1",
          catalogFormat: "codex",
          authMode: "bearer",
        }),
        environment: {},
      });

      expect(yield* catalog.refresh).toMatchObject({
        source: "network",
        models: [],
      });
      expect((yield* catalog.current).codexCatalogPath).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(() => Response.json({ models: [] })))),
  );

  it.effect("rejects non-HTTP and credential-bearing gateway URLs before fetching", () => {
    let fetchCount = 0;
    const invalidSettings = [
      decodeGatewaySettings({
        enabled: true,
        baseUrl: "file:///tmp/gateway",
        catalogFormat: "openai",
        authMode: "bearer",
      }),
      decodeGatewaySettings({
        enabled: true,
        baseUrl: "https://admin:top-secret@gateway.example/v1",
        catalogFormat: "openai",
        authMode: "bearer",
      }),
      decodeGatewaySettings({
        enabled: true,
        baseUrl: "https://gateway.example/v1",
        catalogUrl: "https://admin:top-secret@catalog.example/models",
        catalogFormat: "openai",
        authMode: "bearer",
      }),
      decodeGatewaySettings({
        enabled: true,
        baseUrl: "https://gateway.example/v1",
        catalogUrl: "ftp://catalog.example/models",
        catalogFormat: "openai",
        authMode: "bearer",
      }),
    ];

    return Effect.gen(function* () {
      for (const [index, settings] of invalidSettings.entries()) {
        const catalog = yield* makeGatewayModelCatalog({
          instanceId: ProviderInstanceId.make(`invalid_gateway_${index}`),
          settings,
          environment: {},
        });
        const snapshot = yield* catalog.refresh;
        expect(snapshot.source).toBe("none");
        expect(snapshot.lastError).not.toContain("top-secret");
        expect(snapshot.lastError).not.toContain("gateway.example");
      }
      expect(fetchCount).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        gatewayTestLayer(() => {
          fetchCount += 1;
          return Response.json({ data: [] });
        }),
      ),
    );
  });
});
