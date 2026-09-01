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

const normalizeCodexResponsesBaseUrl = (url: URL): string => {
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return url.toString();
};

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
        if (gateway.apiKeyEnvironmentVariable) {
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
  if (input.codexCatalogPath) {
    args.push("-c", `model_catalog_json=${codexConfigValue(input.codexCatalogPath)}`);
  }
  return args;
}

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
