import { ApiGatewaySettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { codexLaunchArgv } from "../Layers/codexLaunchArgs.ts";
import { syncCodexGatewayLaunchArgs, withCodexGatewayInventoryAuthority } from "./CodexDriver.ts";

const decodeGatewaySettings = Schema.decodeSync(ApiGatewaySettings);

describe("Codex gateway launch arguments", () => {
  const providerDraft = {
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-31T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } as const;

  it("marks network and cached gateway inventories as authoritative", () => {
    expect(
      withCodexGatewayInventoryAuthority(providerDraft, {
        source: "network",
        models: [],
      }).modelsAuthoritative,
    ).toBe(true);
    expect(
      withCodexGatewayInventoryAuthority(providerDraft, {
        source: "cache",
        models: [],
      }).modelsAuthoritative,
    ).toBe(true);
    expect(
      withCodexGatewayInventoryAuthority(
        { ...providerDraft, modelsAuthoritative: true },
        { source: "none", models: [] },
      ).modelsAuthoritative,
    ).toBeUndefined();
  });

  it("updates the shared launch environment as catalog formats change", () => {
    const apiGateway = decodeGatewaySettings({
      enabled: true,
      baseUrl: "https://gateway.example/v1",
      catalogFormat: "auto",
      authMode: "bearer",
    });
    const environment: NodeJS.ProcessEnv = {};

    syncCodexGatewayLaunchArgs({
      environment,
      baseLaunchArgs: '--config model_reasoning_effort="high"',
      apiGateway,
      catalog: {
        source: "network",
        models: [{ slug: "rich-model", name: "Rich model" }],
        codexCatalogPath: "/tmp/current-codex-models.json",
      },
    });

    expect(codexLaunchArgv(environment["T3CODE_CODEX_LAUNCH_ARGS"])).toContain(
      'model_catalog_json="/tmp/current-codex-models.json"',
    );

    syncCodexGatewayLaunchArgs({
      environment,
      baseLaunchArgs: '--config model_reasoning_effort="high"',
      apiGateway,
      catalog: {
        source: "network",
        models: [{ slug: "openai-list-model", name: "OpenAI list model" }],
      },
    });

    expect(environment["T3CODE_CODEX_LAUNCH_ARGS"]).toContain("model_reasoning_effort");
    expect(environment["T3CODE_CODEX_LAUNCH_ARGS"]).toContain("t3_api_gateway");
    expect(environment["T3CODE_CODEX_LAUNCH_ARGS"]).not.toContain("model_catalog_json");
  });

  it("does not retain a catalog path when a later catalog is empty", () => {
    const apiGateway = decodeGatewaySettings({
      enabled: true,
      baseUrl: "https://gateway.example/v1",
      catalogFormat: "codex",
      authMode: "bearer",
    });
    const environment: NodeJS.ProcessEnv = {};

    syncCodexGatewayLaunchArgs({
      environment,
      baseLaunchArgs: "",
      apiGateway,
      catalog: {
        source: "network",
        models: [],
        codexCatalogPath: "/tmp/stale-codex-models.json",
      },
    });

    expect(environment["T3CODE_CODEX_LAUNCH_ARGS"]).not.toContain("model_catalog_json");
  });
});
