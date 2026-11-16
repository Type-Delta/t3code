import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import type { ApiGatewaySettings } from "@t3tools/contracts";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

const quoteCliArg = (arg: string): string => JSON.stringify(arg);

export const appendCodexLaunchArgs = (
  launchArgs: string | undefined,
  additionalArgs: ReadonlyArray<string>,
): string => [...codexLaunchArgv(launchArgs), ...additionalArgs].map(quoteCliArg).join(" ");

const codexConfigValue = (value: string): string => JSON.stringify(value);
const codexConfigArray = (values: ReadonlyArray<string>): string =>
  `[${values.map(codexConfigValue).join(", ")}]`;

const normalizeCodexResponsesBaseUrl = (url: URL): string => {
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return url.toString();
};

const codexGatewayCatalogUrl = (url: URL): string => {
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
  return url.toString();
};

const CODEX_GATEWAY_AUTH_SCRIPT = 'process.stdout.write(process.env[process.argv[1]] ?? "")';

export function codexGatewayLaunchArgv(input: {
  readonly apiGateway: ApiGatewaySettings | undefined;
  readonly codexCatalogPath?: string | undefined;
}): ReadonlyArray<string> {
  const args: string[] = [];
  const gateway = input.apiGateway;
  if (gateway?.enabled) {
    try {
      const baseUrl = new URL(gateway.baseUrl);
      if (
        (baseUrl.protocol === "http:" || baseUrl.protocol === "https:") &&
        baseUrl.username.length === 0 &&
        baseUrl.password.length === 0
      ) {
        args.push(
          "-c",
          'model_provider="t3_api_gateway"',
          "-c",
          'model_providers.t3_api_gateway.name="T3 API Gateway"',
          "-c",
          `model_providers.t3_api_gateway.base_url=${codexConfigValue(normalizeCodexResponsesBaseUrl(baseUrl))}`,
          "-c",
          'model_providers.t3_api_gateway.wire_api="responses"',
        );
        if (gateway.codexImageGeneration) {
          // Codex exposes image_gen for custom providers with a static actor header.
          args.push(
            "-c",
            'model_providers.t3_api_gateway.http_headers={"x-openai-actor-authorization"="t3_api_gateway"}',
          );
        }
        if (gateway.useCodexCatalog) {
          const catalogUrl = gateway.catalogUrl?.trim()
            ? new URL(gateway.catalogUrl.trim())
            : new URL(baseUrl);
          if (
            (catalogUrl.protocol === "http:" || catalogUrl.protocol === "https:") &&
            catalogUrl.username.length === 0 &&
            catalogUrl.password.length === 0
          ) {
            args.push(
              "-c",
              `model_providers.t3_api_gateway.model_catalog_url=${codexConfigValue(
                gateway.catalogUrl?.trim()
                  ? catalogUrl.toString()
                  : codexGatewayCatalogUrl(catalogUrl),
              )}`,
            );
          }
          if (gateway.apiKeyEnvironmentVariable && gateway.authMode === "bearer") {
            args.push(
              "-c",
              `model_providers.t3_api_gateway.auth={command=${codexConfigValue(process.execPath)}, args=${codexConfigArray(["-e", CODEX_GATEWAY_AUTH_SCRIPT, gateway.apiKeyEnvironmentVariable])}}`,
            );
          } else if (gateway.apiKeyEnvironmentVariable && gateway.authMode === "x-api-key") {
            args.push(
              "-c",
              `model_providers.t3_api_gateway.env_http_headers={"x-api-key"=${codexConfigValue(gateway.apiKeyEnvironmentVariable)}}`,
            );
          }
        } else if (gateway.apiKeyEnvironmentVariable) {
          args.push(
            "-c",
            gateway.authMode === "x-api-key"
              ? `model_providers.t3_api_gateway.env_http_headers={"x-api-key"=${codexConfigValue(gateway.apiKeyEnvironmentVariable)}}`
              : `model_providers.t3_api_gateway.env_key=${codexConfigValue(gateway.apiKeyEnvironmentVariable)}`,
          );
        }
      }
    } catch {
      // Invalid gateway URLs remain visible in settings but are never sent to Codex.
    }
  }
  if (input.codexCatalogPath && !gateway?.useCodexCatalog) {
    args.push("-c", `model_catalog_json=${codexConfigValue(input.codexCatalogPath)}`);
  }
  return args;
}

// T3 unsubscribes only when it unloads a thread; Codex's own unload delay would stack on that.
export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  "-c",
  "thread_unload_delay_secs=0",
  ...codexLaunchArgv(launchArgs),
];

interface LaunchArgFilter {
  readonly switches: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
  readonly inlinePrefixes: ReadonlyArray<string>;
}

const SHARED_VALUE_FLAGS = ["--config", "-c", "--enable", "--disable"];
const SHARED_INLINE_PREFIXES = ["--config=", "-c=", "--enable=", "--disable="];

const MCP_LIST_FILTER: LaunchArgFilter = {
  switches: new Set(),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--profile=", "-p="],
};

const EXEC_FILTER: LaunchArgFilter = {
  switches: new Set(["--strict-config", "--oss"]),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--local-provider", "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--local-provider=", "--profile=", "-p="],
};

const filterLaunchArgs = (launchArgs: string | undefined, allowed: LaunchArgFilter) => {
  const args = codexLaunchArgv(launchArgs);
  const kept: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (allowed.switches.has(arg)) {
      kept.push(arg);
    } else if (allowed.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        index++;
      }
    } else if (allowed.inlinePrefixes.some((prefix) => arg.startsWith(prefix))) {
      kept.push(arg);
    }
  }

  return kept;
};

const HOOK_FEATURES = new Set(["hooks", "codex_hooks"]);

// Feature toggles beat config overrides, so a launch arg's hook enable would undo ours.
export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = filterLaunchArgs(launchArgs, EXEC_FILTER);
  return args.filter((arg, index) => {
    if (arg.startsWith("--enable=")) return !HOOK_FEATURES.has(arg.slice("--enable=".length));
    if (arg === "--enable") return !HOOK_FEATURES.has(args[index + 1] ?? "");
    return !(args[index - 1] === "--enable" && HOOK_FEATURES.has(arg));
  });
};

export const codexMcpListLaunchArgs = (launchArgs?: string) =>
  filterLaunchArgs(launchArgs, MCP_LIST_FILTER);
