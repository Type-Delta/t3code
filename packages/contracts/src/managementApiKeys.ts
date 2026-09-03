import * as Schema from "effect/Schema";

import type { RuntimeMode } from "./orchestration.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The opaque identifier embedded in a management API key token. */
export const ManagementApiKeyId = TrimmedNonEmptyString.pipe(Schema.brand("ManagementApiKeyId"));
export type ManagementApiKeyId = typeof ManagementApiKeyId.Type;

/** Capabilities that can be granted to a management API key. */
export const ManagementApiKeyScope = Schema.Literals([
  "models:read",
  "threads:list",
  "threads:read",
  "threads:create",
  "threads:message",
  "threads:wait",
]);
export type ManagementApiKeyScope = typeof ManagementApiKeyScope.Type;
export const ManagementApiKeyScopes = Schema.Array(ManagementApiKeyScope);
export type ManagementApiKeyScopes = typeof ManagementApiKeyScopes.Type;

/**
 * Runtime modes which may be selected for a management key.
 *
 * `full-access` is intentionally absent. Provider-session callers can still
 * use that mode, but a durable third-party credential must not be able to
 * grant itself the server's unrestricted mode.
 */
export const ManagementApiKeyRuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
]);
export type ManagementApiKeyRuntimeMode = typeof ManagementApiKeyRuntimeMode.Type;

// Keep the key policy ordering in one shared place so the server and clients
// make the same ceiling decision. Larger values are more permissive.
export const MANAGEMENT_API_KEY_RUNTIME_MODE_ORDER = {
  "approval-required": 0,
  "auto-accept-edits": 1,
} as const satisfies Record<ManagementApiKeyRuntimeMode, number>;

export const DEFAULT_MANAGEMENT_API_KEY_RUNTIME_MODE: ManagementApiKeyRuntimeMode =
  "approval-required";

export function managementApiKeyRuntimeModeAllowed(
  mode: RuntimeMode,
): mode is ManagementApiKeyRuntimeMode {
  return mode === "approval-required" || mode === "auto-accept-edits";
}

export function managementApiKeyRuntimeModeAtMost(
  value: ManagementApiKeyRuntimeMode,
  maximum: ManagementApiKeyRuntimeMode,
): boolean {
  return (
    MANAGEMENT_API_KEY_RUNTIME_MODE_ORDER[value] <= MANAGEMENT_API_KEY_RUNTIME_MODE_ORDER[maximum]
  );
}

/** Public representation returned by list and by the mutation endpoints. */
export const ManagementApiKey = Schema.Struct({
  id: ManagementApiKeyId,
  name: TrimmedNonEmptyString,
  prefix: TrimmedNonEmptyString,
  scopes: ManagementApiKeyScopes,
  defaultRuntimeMode: ManagementApiKeyRuntimeMode,
  maximumRuntimeMode: ManagementApiKeyRuntimeMode,
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type ManagementApiKey = typeof ManagementApiKey.Type;

/** Request body for creating a key. Omitted expiration means no expiration. */
export const ManagementApiKeyCreateRequest = Schema.Struct({
  name: TrimmedNonEmptyString,
  scopes: ManagementApiKeyScopes,
  defaultRuntimeMode: ManagementApiKeyRuntimeMode,
  maximumRuntimeMode: ManagementApiKeyRuntimeMode,
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc)),
});
export type ManagementApiKeyCreateRequest = typeof ManagementApiKeyCreateRequest.Type;
export const ManagementApiKeyCreateInput = ManagementApiKeyCreateRequest;
export type ManagementApiKeyCreateInput = ManagementApiKeyCreateRequest;

/** Create and rotate reveal the replacement token exactly once. */
export const ManagementApiKeyCreateResponse = Schema.Struct({
  key: ManagementApiKey,
  secret: TrimmedNonEmptyString,
  mcpEndpoint: TrimmedNonEmptyString,
});
export type ManagementApiKeyCreateResponse = typeof ManagementApiKeyCreateResponse.Type;
export const ManagementApiKeyCreateResult = ManagementApiKeyCreateResponse;
export type ManagementApiKeyCreateResult = ManagementApiKeyCreateResponse;

export const ManagementApiKeyRotateResponse = ManagementApiKeyCreateResponse;
export type ManagementApiKeyRotateResponse = ManagementApiKeyCreateResponse;
export const ManagementApiKeyRotateResult = ManagementApiKeyRotateResponse;
export type ManagementApiKeyRotateResult = ManagementApiKeyRotateResponse;

export const ManagementApiKeyListResponse = Schema.Array(ManagementApiKey);
export type ManagementApiKeyListResponse = typeof ManagementApiKeyListResponse.Type;

export const ManagementApiKeyRevokeResponse = Schema.Struct({
  revoked: Schema.Boolean,
});
export type ManagementApiKeyRevokeResponse = typeof ManagementApiKeyRevokeResponse.Type;

export const ManagementApiKeyIdParams = Schema.Struct({
  id: ManagementApiKeyId,
});
