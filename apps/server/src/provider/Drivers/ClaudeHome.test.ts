import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toEqual(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });

  describe("Claude gateway environment", () => {
    it.effect("enables gateway discovery and aliases the configured bearer credential", () =>
      Effect.gen(function* () {
        const settings = decodeClaudeSettings({
          apiGateway: {
            enabled: true,
            baseUrl: "https://gateway.example/v1",
            apiKeyEnvironmentVariable: "GATEWAY_API_KEY",
            authMode: "bearer",
          },
        });
        const baseEnvironment = {
          GATEWAY_API_KEY: "test-key",
          ANTHROPIC_AUTH_TOKEN: "old-bearer-key",
          ANTHROPIC_API_KEY: "stale-api-key",
        };
        const environment = yield* makeClaudeEnvironment(settings, baseEnvironment);

        expect(environment["ANTHROPIC_BASE_URL"]).toBe("https://gateway.example/v1");
        expect(environment["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]).toBe("1");
        expect(environment["ANTHROPIC_AUTH_TOKEN"]).toBe("test-key");
        expect(environment["ANTHROPIC_API_KEY"]).toBeUndefined();
        expect(baseEnvironment).toEqual({
          GATEWAY_API_KEY: "test-key",
          ANTHROPIC_AUTH_TOKEN: "old-bearer-key",
          ANTHROPIC_API_KEY: "stale-api-key",
        });
      }),
    );

    it.effect("aliases the configured x-api-key credential and clears an inherited bearer", () =>
      Effect.gen(function* () {
        const settings = decodeClaudeSettings({
          apiGateway: {
            enabled: true,
            baseUrl: "https://gateway.example/v1",
            apiKeyEnvironmentVariable: "GATEWAY_API_KEY",
            authMode: "x-api-key",
          },
        });
        const baseEnvironment = {
          GATEWAY_API_KEY: "test-key",
          ANTHROPIC_AUTH_TOKEN: "stale-bearer-key",
          ANTHROPIC_API_KEY: "old-api-key",
        };
        const environment = yield* makeClaudeEnvironment(settings, baseEnvironment);

        expect(environment["ANTHROPIC_API_KEY"]).toBe("test-key");
        expect(environment["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
        expect(baseEnvironment).toEqual({
          GATEWAY_API_KEY: "test-key",
          ANTHROPIC_AUTH_TOKEN: "stale-bearer-key",
          ANTHROPIC_API_KEY: "old-api-key",
        });
      }),
    );

    it.effect("clears inherited credentials when the configured source is missing", () =>
      Effect.gen(function* () {
        const settings = decodeClaudeSettings({
          apiGateway: {
            enabled: true,
            baseUrl: "https://gateway.example/v1",
            apiKeyEnvironmentVariable: "MISSING_GATEWAY_API_KEY",
            authMode: "bearer",
          },
        });
        const baseEnvironment = {
          ANTHROPIC_AUTH_TOKEN: "stale-bearer-key",
          ANTHROPIC_API_KEY: "stale-api-key",
        };
        const environment = yield* makeClaudeEnvironment(settings, baseEnvironment);

        expect(environment["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
        expect(environment["ANTHROPIC_API_KEY"]).toBeUndefined();
        expect(baseEnvironment).toEqual({
          ANTHROPIC_AUTH_TOKEN: "stale-bearer-key",
          ANTHROPIC_API_KEY: "stale-api-key",
        });
      }),
    );

    it.effect("clears inherited credentials when the configured source is blank", () =>
      Effect.gen(function* () {
        const settings = decodeClaudeSettings({
          apiGateway: {
            enabled: true,
            baseUrl: "https://gateway.example/v1",
            apiKeyEnvironmentVariable: "GATEWAY_API_KEY",
            authMode: "x-api-key",
          },
        });
        const baseEnvironment = {
          GATEWAY_API_KEY: "   ",
          ANTHROPIC_AUTH_TOKEN: "stale-bearer-key",
          ANTHROPIC_API_KEY: "stale-api-key",
        };
        const environment = yield* makeClaudeEnvironment(settings, baseEnvironment);

        expect(environment["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
        expect(environment["ANTHROPIC_API_KEY"]).toBeUndefined();
        expect(baseEnvironment).toEqual({
          GATEWAY_API_KEY: "   ",
          ANTHROPIC_AUTH_TOKEN: "stale-bearer-key",
          ANTHROPIC_API_KEY: "stale-api-key",
        });
      }),
    );

    it.effect("does not alter gateway variables when the gateway is disabled", () =>
      Effect.gen(function* () {
        const settings = decodeClaudeSettings({
          apiGateway: {
            enabled: false,
            baseUrl: "https://gateway.example/v1",
            authMode: "x-api-key",
          },
        });
        const environment = yield* makeClaudeEnvironment(settings, {});

        expect(environment["ANTHROPIC_BASE_URL"]).toBeUndefined();
        expect(environment["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]).toBeUndefined();
      }),
    );
  });
});
