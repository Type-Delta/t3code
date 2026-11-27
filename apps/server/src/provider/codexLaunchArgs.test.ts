import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  appendCodexLaunchArgs,
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
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
  it.each([
    {
      name: "preserves escaped TOML quotes in config values",
      launchArgs: String.raw`--config model=\"gpt-6.1-sol\" --strict-config`,
      expected: ["--config", 'model="gpt-6.1-sol"', "--strict-config"],
    },
    {
      name: "lets launch args override the unload delay",
      launchArgs: "-c thread_unload_delay_secs=1800",
      expected: ["-c", "thread_unload_delay_secs=1800"],
    },
    {
      name: "preserves an escaped trailing space in the environment override",
      launchArgs: "--strict-config",
      environment: { T3CODE_CODEX_LAUNCH_ARGS: "--cloud-skills-snapshot skills.json\\ " },
      expected: ["--cloud-skills-snapshot", "skills.json "],
    },
    {
      name: "uses configured arguments when the environment override is blank",
      launchArgs: "--strict-config",
      environment: { T3CODE_CODEX_LAUNCH_ARGS: " \t " },
      expected: ["--strict-config"],
    },
  ])("asks Codex to unload unsubscribed threads immediately and $name", (row) => {
    const launchArgs = resolveCodexLaunchArgs(row.launchArgs, row.environment ?? {});
    NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs), [
      "app-server",
      "-c",
      "thread_unload_delay_secs=0",
      ...row.expected,
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

  it("keeps user hooks, apps, and plugins off during text generation", () => {
    const launchArgs =
      "--enable hooks --enable=hooks --enable codex_hooks --enable=codex_hooks --enable apps --enable=apps --enable connectors --enable=connectors --enable plugins --enable=plugins --enable foo --disable hooks";
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs), [
      "--enable",
      "foo",
      "--disable",
      "hooks",
    ]);
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs), [
      "--enable",
      "hooks",
      "--enable=hooks",
      "--enable",
      "codex_hooks",
      "--enable=codex_hooks",
      "--enable",
      "foo",
      "--disable",
      "hooks",
    ]);
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
        useCodexCatalog: false,
        codexImageGeneration: false,
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
        useCodexCatalog: false,
        codexImageGeneration: false,
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
          useCodexCatalog: false,
          codexImageGeneration: false,
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
        useCodexCatalog: false,
        codexImageGeneration: false,
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

  it("lets Codex fetch a gateway catalog with command-backed bearer auth", () => {
    const launch = (selfExecutable: boolean) =>
      codexGatewayLaunchArgv({
        apiGateway: {
          enabled: true,
          baseUrl: "https://proxy.example/v1",
          catalogFormat: "codex",
          apiKeyEnvironmentVariable: "PROXY_API_KEY",
          authMode: "bearer",
          useCodexCatalog: true,
          codexImageGeneration: false,
        },
        codexCatalogPath: "/tmp/should-not-be-used.json",
        selfExecutable,
      });
    const args = launch(false);

    NodeAssert.ok(
      args.includes(
        'model_providers.t3_api_gateway.model_catalog_url="https://proxy.example/v1/models"',
      ),
    );
    NodeAssert.ok(args.join(" ").includes("model_providers.t3_api_gateway.auth={command="));
    NodeAssert.ok(args.join(" ").includes('args=["-e", '));
    NodeAssert.ok(args.join(" ").includes('"PROXY_API_KEY"]}'));
    NodeAssert.ok(!args.join(" ").includes("model_catalog_json"));
    NodeAssert.ok(!args.join(" ").includes("secret-value"));
    // A single-executable t3 rejects -e, so it prints the key through its own fast path.
    NodeAssert.ok(launch(true).join(" ").includes('args=["__env-value", "PROXY_API_KEY"]}'));
  });

  it.each([false, true])(
    "opts into image generation independently of native catalog discovery (%s)",
    (useCodexCatalog) => {
      const apiGateway = {
        enabled: true,
        baseUrl: "https://gateway.example/v1",
        catalogFormat: "codex" as const,
        apiKeyEnvironmentVariable: "GATEWAY_API_KEY",
        authMode: "bearer" as const,
        useCodexCatalog,
        codexImageGeneration: true,
      };
      const actorHeader =
        'model_providers.t3_api_gateway.http_headers={"x-openai-actor-authorization"="t3_api_gateway"}';
      const args = codexGatewayLaunchArgv({ apiGateway });
      NodeAssert.ok(args.includes(actorHeader));
      NodeAssert.deepStrictEqual(codexExecLaunchArgs(appendCodexLaunchArgs(undefined, args)), args);
      for (const patch of [{ codexImageGeneration: false }, { enabled: false }]) {
        NodeAssert.ok(
          !codexGatewayLaunchArgv({ apiGateway: { ...apiGateway, ...patch } }).includes(
            actorHeader,
          ),
        );
      }
    },
  );
});

describe.each(["", "="])("codex exec and mcp list launch args with -p%swork", (separator) => {
  const launchArgs = `--strict-config --oss --local-provider ollama --profile local -p${separator}work -c${separator}model_provider=ollama --listen off --enable foo`;

  it("keeps the local model provider flags for codex exec", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs), [
      "--strict-config",
      "--oss",
      "--local-provider",
      "ollama",
      "--profile",
      "local",
      "-p=work",
      "-c=model_provider=ollama",
      "--enable",
      "foo",
    ]);
  });

  it("keeps the selected profile and drops exec-only flags for codex mcp list", () => {
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs), [
      "--profile",
      "local",
      "-p=work",
      "-c=model_provider=ollama",
      "--enable",
      "foo",
    ]);
  });
});
