import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  appendCodexLaunchArgs,
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexGatewayLaunchArgv,
  codexLaunchArgv,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("Codex API gateway launch configuration", () => {
  it.each([
    ["https://proxy.example", "https://proxy.example/v1"],
    ["https://proxy.example/", "https://proxy.example/v1"],
    ["https://proxy.example/openai", "https://proxy.example/openai/v1"],
    ["https://proxy.example/openai/v1/", "https://proxy.example/openai/v1"],
  ])("normalizes the Responses API base URL: %s", (configured, expected) => {
    const args = codexGatewayLaunchArgv({
      apiGateway: {
        enabled: true,
        baseUrl: configured,
        catalogFormat: "auto",
        authMode: "bearer",
      },
    });

    NodeAssert.equal(
      args.includes(`model_providers.t3_api_gateway.base_url=${JSON.stringify(expected)}`),
      true,
    );
  });

  it("round-trips managed config values containing spaces", () => {
    const combined = appendCodexLaunchArgs("--strict-config", [
      "-c",
      'model_catalog_json="/tmp/t3 catalogs/models.json"',
    ]);

    NodeAssert.deepStrictEqual(codexLaunchArgv(combined), [
      "--strict-config",
      "-c",
      'model_catalog_json="/tmp/t3 catalogs/models.json"',
    ]);
  });

  it("configures the provider and native catalog without exposing an API key", () => {
    const args = codexGatewayLaunchArgv({
      apiGateway: {
        enabled: true,
        baseUrl: "https://proxy.example/v1",
        catalogFormat: "codex",
        apiKeyEnvironmentVariable: "CPA_API_KEY",
        authMode: "bearer",
      },
      codexCatalogPath: "/tmp/t3-models.json",
    });

    NodeAssert.deepStrictEqual(args, [
      "-c",
      'model_provider="t3_api_gateway"',
      "-c",
      'model_providers.t3_api_gateway.name="T3 API Gateway"',
      "-c",
      'model_providers.t3_api_gateway.base_url="https://proxy.example/v1"',
      "-c",
      'model_providers.t3_api_gateway.wire_api="responses"',
      "-c",
      'model_providers.t3_api_gateway.env_key="CPA_API_KEY"',
      "-c",
      'model_catalog_json="/tmp/t3-models.json"',
    ]);
    NodeAssert.equal(args.join(" ").includes("secret-value"), false);
  });

  it("rejects gateway URLs containing inline credentials", () => {
    NodeAssert.deepStrictEqual(
      codexGatewayLaunchArgv({
        apiGateway: {
          enabled: true,
          baseUrl: "https://username:password@proxy.example/v1",
          catalogFormat: "auto",
          authMode: "bearer",
        },
      }),
      [],
    );
  });

  it("references x-api-key credentials through an environment-backed header", () => {
    const args = codexGatewayLaunchArgv({
      apiGateway: {
        enabled: true,
        baseUrl: "https://proxy.example/v1",
        catalogFormat: "openai",
        apiKeyEnvironmentVariable: "PROXY_API_KEY",
        authMode: "x-api-key",
      },
    });

    NodeAssert.equal(
      args.includes(
        'model_providers.t3_api_gateway.env_http_headers={"x-api-key"="PROXY_API_KEY"}',
      ),
      true,
    );
  });
});
