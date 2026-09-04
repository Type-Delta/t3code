import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildManagementApiKeyCodexExample,
  buildManagementApiKeyJsonExample,
  buildManagementApiKeyEnvironmentOptions,
  canRotateManagementApiKey,
  clearManagementApiKeyReveal,
  managementApiKeyPresetForScopes,
  orderedManagementApiKeyScopes,
  revealManagementApiKey,
  resolveManagementApiKeyExpiration,
  resolveSelectedManagementApiKeyEnvironmentId,
  scopesForManagementApiKeyPreset,
} from "./ManagementApiKeysSettings.logic";

const environment = (environmentId: string, label: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
});

describe("management API key environment selection", () => {
  it("sorts the primary machine first, then labels with an id tie-breaker", () => {
    const options = buildManagementApiKeyEnvironmentOptions(
      [environment("z", "Zulu"), environment("b", "Alpha"), environment("a", "Alpha")],
      EnvironmentId.make("z"),
    );
    expect(options.map(({ environmentId }) => environmentId)).toEqual(["z", "a", "b"]);
  });

  it("preserves a known selection and falls back to primary then first", () => {
    const options = [environment("primary", "Primary"), environment("remote", "Remote")];
    expect(
      resolveSelectedManagementApiKeyEnvironmentId(
        options,
        EnvironmentId.make("remote"),
        EnvironmentId.make("primary"),
      ),
    ).toBe("remote");
    expect(
      resolveSelectedManagementApiKeyEnvironmentId(
        options,
        EnvironmentId.make("missing"),
        EnvironmentId.make("primary"),
      ),
    ).toBe("primary");
    expect(resolveSelectedManagementApiKeyEnvironmentId([], null, null)).toBeNull();
  });
});

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

describe("management API key lifecycle helpers", () => {
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
