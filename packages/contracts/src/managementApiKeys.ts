import * as Schema from "effect/Schema";

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

/** Public representation returned by list and by the mutation endpoints. */
export const ManagementApiKey = Schema.Struct({
  id: ManagementApiKeyId,
  name: TrimmedNonEmptyString,
  prefix: TrimmedNonEmptyString,
  scopes: ManagementApiKeyScopes,
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type ManagementApiKey = typeof ManagementApiKey.Type;

/** Request body for creating a key. Omitted expiration means no expiration. */
export const ManagementApiKeyCreateRequest = Schema.Struct({
  name: TrimmedNonEmptyString,
  scopes: ManagementApiKeyScopes,
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
