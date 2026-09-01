import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClaudeSettings } from "@t3tools/contracts";

import {
  API_GATEWAY_API_KEY_ENVIRONMENT_VARIABLE,
  configAndEnvironmentWithApiGatewayApiKey,
  configWithApiGateway,
  hasApiGatewayValidationErrors,
  migrateLegacyApiGatewayApiKey,
  readApiGatewayDraft,
  validateApiGatewayDraft,
} from "./CompatibleApiGatewaySection";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("CompatibleApiGatewaySection config", () => {
  it("stores opaque API keys in the sensitive environment", () => {
    const next = configAndEnvironmentWithApiGatewayApiKey(
      {
        apiGateway: {
          enabled: true,
          baseUrl: "https://cli-proxyapi.example",
          catalogFormat: "auto",
          authMode: "bearer",
        },
      },
      [],
      "opaque key:/with-dashes?&=",
    );

    expect(readApiGatewayDraft(next.config).apiKeyEnvironmentVariable).toBe(
      API_GATEWAY_API_KEY_ENVIRONMENT_VARIABLE,
    );
    expect(next.environment).toEqual([
      {
        name: API_GATEWAY_API_KEY_ENVIRONMENT_VARIABLE,
        value: "opaque key:/with-dashes?&=",
        sensitive: true,
        valueRedacted: false,
      },
    ]);
    expect(JSON.stringify(next.config)).not.toContain("opaque key");
    expect(() => decodeClaudeSettings(next.config)).not.toThrow();
  });

  it("moves keys saved by the old field out of provider config", () => {
    const next = migrateLegacyApiGatewayApiKey(
      {
        apiGateway: {
          enabled: true,
          baseUrl: "https://cli-proxyapi.example",
          apiKeyEnvironmentVariable: "opaque-key-with-dashes",
          catalogFormat: "auto",
          authMode: "bearer",
        },
      },
      [],
    );

    expect(next).toBeDefined();
    expect(readApiGatewayDraft(next?.config).apiKeyEnvironmentVariable).toBe(
      API_GATEWAY_API_KEY_ENVIRONMENT_VARIABLE,
    );
    expect(next?.environment[0]).toMatchObject({
      name: API_GATEWAY_API_KEY_ENVIRONMENT_VARIABLE,
      value: "opaque-key-with-dashes",
      sensitive: true,
    });
    expect(JSON.stringify(next?.config)).not.toContain("opaque-key-with-dashes");
  });

  it("defaults to a disabled gateway without inventing an endpoint", () => {
    expect(readApiGatewayDraft({ customModels: [] })).toEqual({
      enabled: false,
      baseUrl: "",
      catalogUrl: "",
      catalogFormat: "auto",
      apiKeyEnvironmentVariable: "",
      authMode: "bearer",
    });
  });

  it("updates the nested gateway while preserving provider config", () => {
    expect(
      configWithApiGateway(
        { binaryPath: "/opt/codex", customModels: ["custom"] },
        {
          enabled: true,
          baseUrl: " https://gateway.example.com/v1 ",
          catalogUrl: " ",
          catalogFormat: "codex",
          apiKeyEnvironmentVariable: " OPENAI_API_KEY ",
          authMode: "bearer",
        },
      ),
    ).toEqual({
      binaryPath: "/opt/codex",
      customModels: ["custom"],
      apiGateway: {
        enabled: true,
        baseUrl: "https://gateway.example.com/v1",
        catalogFormat: "codex",
        apiKeyEnvironmentVariable: "OPENAI_API_KEY",
        authMode: "bearer",
      },
    });
  });

  it("round-trips disabled gateway details for later reuse", () => {
    const config = configWithApiGateway(undefined, {
      enabled: false,
      baseUrl: "https://gateway.example.com",
      catalogUrl: "https://gateway.example.com/models",
      catalogFormat: "openai",
      apiKeyEnvironmentVariable: "",
      authMode: "x-api-key",
    });

    expect(readApiGatewayDraft(config)).toEqual({
      enabled: false,
      baseUrl: "https://gateway.example.com",
      catalogUrl: "https://gateway.example.com/models",
      catalogFormat: "openai",
      apiKeyEnvironmentVariable: "",
      authMode: "x-api-key",
    });
  });

  it("requires safe HTTP URLs when gateway discovery is enabled", () => {
    const draft = {
      ...readApiGatewayDraft(undefined),
      enabled: true,
    };

    expect(validateApiGatewayDraft(draft)).toEqual({
      baseUrl: "Gateway base URL is required.",
    });
    expect(
      validateApiGatewayDraft({
        ...draft,
        baseUrl: "ftp://gateway.example.com",
        catalogUrl: "https://user:secret@gateway.example.com/v1/models",
      }),
    ).toEqual({
      baseUrl: "Gateway base URL must use http or https.",
      catalogUrl: "Model catalog URL must not include a username or password.",
    });
    expect(
      hasApiGatewayValidationErrors(
        validateApiGatewayDraft({
          ...draft,
          baseUrl: "https://gateway.example.com",
          catalogUrl: "http://localhost:8317/v1/models",
        }),
      ),
    ).toBe(false);
  });
});
