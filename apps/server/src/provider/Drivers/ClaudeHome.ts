import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath" | "apiGateway">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  const environment: NodeJS.ProcessEnv = {
    ...resolvedBaseEnv,
  };
  if (homePath.length > 0) {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    environment["CLAUDE_CONFIG_DIR"] = resolvedHomePath;
  }

  const gateway = config.apiGateway;
  if (gateway?.enabled && gateway.baseUrl.trim().length > 0) {
    environment["ANTHROPIC_BASE_URL"] = gateway.baseUrl.trim();
    environment["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1";
    const apiKey = gateway.apiKeyEnvironmentVariable
      ? resolvedBaseEnv[gateway.apiKeyEnvironmentVariable]?.trim()
      : undefined;
    delete environment["ANTHROPIC_AUTH_TOKEN"];
    delete environment["ANTHROPIC_API_KEY"];
    const credentialVariable =
      gateway.authMode === "x-api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
    if (apiKey) {
      environment[credentialVariable] = apiKey;
    }
  }
  return environment;
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);
