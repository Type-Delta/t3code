import { describe, expect, it } from "vite-plus/test";

import {
  buildManagementApiKeyCodexExample,
  buildManagementApiKeyJsonExample,
  canRotateManagementApiKey,
  clampManagementApiKeyDefaultRuntimeMode,
  clearManagementApiKeyReveal,
  MANAGEMENT_API_KEY_RUNTIME_MODES,
  managementApiKeyPresetForScopes,
  orderedManagementApiKeyScopes,
  revealManagementApiKey,
  resolveManagementApiKeyExpiration,
  scopesForManagementApiKeyPreset,
} from "./ManagementApiKeysSettings.logic";

describe("management API key access presets", () => {
  it("keeps scopes in permission order and maps the built-in presets", () => {
    expect(orderedManagementApiKeyScopes(["threads:wait", "models:read", "threads:list"])).toEqual([
      "models:read",
      "threads:list",
      "threads:wait",
    ]);
    expect(scopesForManagementApiKeyPreset("read-only")).toEqual([
      "models:read",
      "threads:list",
      "threads:read",
    ]);
    expect(scopesForManagementApiKeyPreset("thread-orchestration")).toHaveLength(6);
    expect(managementApiKeyPresetForScopes(["models:read", "threads:read", "threads:list"])).toBe(
      "read-only",
    );
    expect(managementApiKeyPresetForScopes(["threads:read"])).toBe("custom");
  });
});

describe("management API key safety settings", () => {
  it("offers only supervised and auto-accept-edits modes", () => {
    expect(MANAGEMENT_API_KEY_RUNTIME_MODES.map((mode) => mode.value)).toEqual([
      "approval-required",
      "auto-accept-edits",
    ]);
  });

  it("clamps the default mode when the ceiling is lowered", () => {
    expect(clampManagementApiKeyDefaultRuntimeMode("auto-accept-edits", "approval-required")).toBe(
      "approval-required",
    );
    expect(clampManagementApiKeyDefaultRuntimeMode("approval-required", "auto-accept-edits")).toBe(
      "approval-required",
    );
  });

  it("resolves explicit expiration choices from a stable clock", () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    expect(resolveManagementApiKeyExpiration("30-days", now)).toBe("2026-02-14T12:00:00.000Z");
    expect(resolveManagementApiKeyExpiration("90-days", now)).toBe("2026-04-15T12:00:00.000Z");
    expect(resolveManagementApiKeyExpiration("1-year", now)).toBe("2027-01-15T12:00:00.000Z");
    expect(resolveManagementApiKeyExpiration("never", now)).toBeNull();
  });

  it("blocks rotation after expiry while allowing never-expiring keys", () => {
    expect(
      canRotateManagementApiKey("2026-01-14T12:00:00.000Z", Date.parse("2026-01-15T12:00:00.000Z")),
    ).toBe(false);
    expect(
      canRotateManagementApiKey("2026-01-16T12:00:00.000Z", Date.parse("2026-01-15T12:00:00.000Z")),
    ).toBe(true);
    expect(canRotateManagementApiKey(null, Date.parse("2026-01-15T12:00:00.000Z"))).toBe(true);
    expect(canRotateManagementApiKey("not-a-date", Date.parse("2026-01-15T12:00:00.000Z"))).toBe(
      false,
    );
  });

  it("keeps the one-time secret in reveal state until explicit clearing", () => {
    const result = revealManagementApiKey(
      { secret: "t3mgmt_key_secret", mcpEndpoint: "https://example.test/mcp" },
      "created",
    );
    expect(result.secret).toBe("t3mgmt_key_secret");
    expect(result.operation).toBe("created");
    expect(clearManagementApiKeyReveal()).toBeNull();
  });
});

describe("management API key client examples", () => {
  const endpoint = "https://example.test/mcp";

  it("produces a JSON HTTP MCP example with an environment variable", () => {
    const example = JSON.parse(buildManagementApiKeyJsonExample(endpoint)) as {
      mcpServers: { t3: { type: string; url: string; headers: { Authorization: string } } };
    };
    expect(example.mcpServers.t3.type).toBe("http");
    expect(example.mcpServers.t3.url).toBe(endpoint);
    expect(example.mcpServers.t3.headers.Authorization).toBe("Bearer ${T3_MANAGEMENT_API_KEY}");
  });

  it("uses Codex's bearer token environment variable setting", () => {
    expect(buildManagementApiKeyCodexExample(endpoint)).toContain(
      'bearer_token_env_var = "T3_MANAGEMENT_API_KEY"',
    );
    expect(buildManagementApiKeyCodexExample(endpoint)).toContain(`url = "${endpoint}"`);
  });
});
