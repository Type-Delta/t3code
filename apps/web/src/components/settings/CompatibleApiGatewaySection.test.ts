import { describe, expect, it } from "vite-plus/test";

import {
  configWithApiGateway,
  hasApiGatewayValidationErrors,
  readApiGatewayDraft,
  validateApiGatewayDraft,
} from "./CompatibleApiGatewaySection";

describe("CompatibleApiGatewaySection config", () => {
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
