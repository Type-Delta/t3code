"use client";

import { useEffect, useState } from "react";
import type { ApiGatewayAuthMode, ApiGatewayCatalogFormat } from "@t3tools/contracts";

import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

export interface ApiGatewayDraft {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly catalogUrl: string;
  readonly catalogFormat: ApiGatewayCatalogFormat;
  readonly apiKeyEnvironmentVariable: string;
  readonly authMode: ApiGatewayAuthMode;
}

export interface ApiGatewayValidationErrors {
  readonly baseUrl?: string;
  readonly catalogUrl?: string;
}

const DEFAULT_GATEWAY: ApiGatewayDraft = {
  enabled: false,
  baseUrl: "",
  catalogUrl: "",
  catalogFormat: "auto",
  apiKeyEnvironmentVariable: "",
  authMode: "bearer",
};

const CATALOG_FORMAT_LABELS: Record<ApiGatewayCatalogFormat, string> = {
  auto: "Auto-detect",
  codex: "Codex",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const AUTH_MODE_LABELS: Record<ApiGatewayAuthMode, string> = {
  bearer: "Bearer token",
  "x-api-key": "x-api-key header",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function readApiGatewayDraft(config: unknown): ApiGatewayDraft {
  const gateway = asRecord(asRecord(config)?.apiGateway);
  if (!gateway) return DEFAULT_GATEWAY;

  const catalogFormat = gateway.catalogFormat;
  const authMode = gateway.authMode;
  return {
    enabled: gateway.enabled === true,
    baseUrl: typeof gateway.baseUrl === "string" ? gateway.baseUrl : "",
    catalogUrl: typeof gateway.catalogUrl === "string" ? gateway.catalogUrl : "",
    catalogFormat:
      catalogFormat === "codex" || catalogFormat === "anthropic" || catalogFormat === "openai"
        ? catalogFormat
        : "auto",
    apiKeyEnvironmentVariable:
      typeof gateway.apiKeyEnvironmentVariable === "string"
        ? gateway.apiKeyEnvironmentVariable
        : "",
    authMode: authMode === "x-api-key" ? "x-api-key" : "bearer",
  };
}

export function configWithApiGateway(
  config: unknown,
  gateway: ApiGatewayDraft,
): Record<string, unknown> {
  const current = asRecord(config);
  const base = current ? { ...current } : {};
  base.apiGateway = {
    enabled: gateway.enabled,
    baseUrl: gateway.baseUrl.trim(),
    catalogFormat: gateway.catalogFormat,
    authMode: gateway.authMode,
    ...(gateway.catalogUrl.trim() ? { catalogUrl: gateway.catalogUrl.trim() } : {}),
    ...(gateway.apiKeyEnvironmentVariable.trim()
      ? { apiKeyEnvironmentVariable: gateway.apiKeyEnvironmentVariable.trim() }
      : {}),
  };
  return base;
}

function validateHttpUrl(value: string, label: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return `${label} must be a valid URL.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${label} must use http or https.`;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return `${label} must not include a username or password.`;
  }
  return undefined;
}

export function validateApiGatewayDraft(gateway: ApiGatewayDraft): ApiGatewayValidationErrors {
  if (!gateway.enabled) return {};

  const baseUrl = gateway.baseUrl.trim();
  const catalogUrl = gateway.catalogUrl.trim();
  const baseUrlError =
    baseUrl.length === 0
      ? "Gateway base URL is required."
      : validateHttpUrl(baseUrl, "Gateway base URL");
  const catalogUrlError =
    catalogUrl.length > 0 ? validateHttpUrl(catalogUrl, "Model catalog URL") : undefined;
  return {
    ...(baseUrlError ? { baseUrl: baseUrlError } : {}),
    ...(catalogUrlError ? { catalogUrl: catalogUrlError } : {}),
  };
}

export function hasApiGatewayValidationErrors(errors: ApiGatewayValidationErrors): boolean {
  return errors.baseUrl !== undefined || errors.catalogUrl !== undefined;
}

interface CompatibleApiGatewaySectionProps {
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog";
  readonly onChange: (nextConfig: Record<string, unknown>) => void;
}

function GatewayTextField(props: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
  readonly value: string;
  readonly error?: string | undefined;
  readonly variant: CompatibleApiGatewaySectionProps["variant"];
  readonly onChange: (value: string) => void;
}) {
  const descriptionId = `${props.id}-description`;
  const errorId = `${props.id}-error`;
  return (
    <label htmlFor={props.id} className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{props.label}</span>
      {props.variant === "card" ? (
        <DraftInput
          id={props.id}
          value={props.value}
          onCommit={props.onChange}
          placeholder={props.placeholder}
          spellCheck={false}
          aria-invalid={props.error !== undefined}
          aria-describedby={props.error ? `${descriptionId} ${errorId}` : descriptionId}
        />
      ) : (
        <Input
          id={props.id}
          className="bg-background"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          spellCheck={false}
          aria-invalid={props.error !== undefined}
          aria-describedby={props.error ? `${descriptionId} ${errorId}` : descriptionId}
        />
      )}
      <span id={descriptionId} className="text-[11px] text-muted-foreground">
        {props.description}
      </span>
      {props.error ? (
        <span id={errorId} role="alert" className="text-[11px] text-destructive">
          {props.error}
        </span>
      ) : null}
    </label>
  );
}

export function CompatibleApiGatewaySection({
  value,
  idPrefix,
  variant,
  onChange,
}: CompatibleApiGatewaySectionProps) {
  const [gateway, setGateway] = useState(() => readApiGatewayDraft(value));
  useEffect(() => {
    setGateway(readApiGatewayDraft(value));
  }, [idPrefix, value]);

  const validationErrors = validateApiGatewayDraft(gateway);
  const publish = (patch: Partial<ApiGatewayDraft>) => {
    const next = { ...gateway, ...patch };
    setGateway(next);
    if (variant === "dialog" || !hasApiGatewayValidationErrors(validateApiGatewayDraft(next))) {
      onChange(configWithApiGateway(value, next));
    }
  };

  return (
    <section className="grid gap-3 rounded-lg border border-border/70 bg-muted/15 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">Compatible API gateway</div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Let T3 discover models and relay their metadata to this provider.
          </p>
        </div>
        <Switch
          checked={gateway.enabled}
          onCheckedChange={(checked) => publish({ enabled: Boolean(checked) })}
          aria-label="Use compatible API gateway"
        />
      </div>

      {gateway.enabled ? (
        <div className="grid gap-3 border-t border-border/60 pt-3">
          <GatewayTextField
            id={`${idPrefix}-gateway-base-url`}
            label="Gateway base URL"
            description="The OpenAI or Anthropic-compatible inference endpoint."
            placeholder="https://gateway.example.com"
            value={gateway.baseUrl}
            error={validationErrors.baseUrl}
            variant={variant}
            onChange={(baseUrl) => publish({ baseUrl })}
          />

          <GatewayTextField
            id={`${idPrefix}-gateway-catalog-url`}
            label="Model catalog URL"
            description="Optional. Leave empty to derive /v1/models from the base URL."
            placeholder="https://gateway.example.com/v1/models"
            value={gateway.catalogUrl}
            error={validationErrors.catalogUrl}
            variant={variant}
            onChange={(catalogUrl) => publish({ catalogUrl })}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Catalog format</span>
              <Select
                value={gateway.catalogFormat}
                onValueChange={(catalogFormat) =>
                  publish({ catalogFormat: catalogFormat as ApiGatewayCatalogFormat })
                }
              >
                <SelectTrigger id={`${idPrefix}-gateway-catalog-format`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(CATALOG_FORMAT_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Authentication</span>
              <Select
                value={gateway.authMode}
                onValueChange={(authMode) => publish({ authMode: authMode as ApiGatewayAuthMode })}
              >
                <SelectTrigger id={`${idPrefix}-gateway-auth-mode`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(AUTH_MODE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </div>

          <GatewayTextField
            id={`${idPrefix}-gateway-api-key-environment-variable`}
            label="API key environment variable"
            description="T3 reads this variable from the provider instance. Leave empty for no auth header."
            placeholder="OPENAI_API_KEY"
            value={gateway.apiKeyEnvironmentVariable}
            variant={variant}
            onChange={(apiKeyEnvironmentVariable) => publish({ apiKeyEnvironmentVariable })}
          />
        </div>
      ) : null}
    </section>
  );
}
