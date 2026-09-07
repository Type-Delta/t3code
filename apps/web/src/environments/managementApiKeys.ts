import {
  EnvironmentHttpCommonError,
  type ManagementApiKey,
  type ManagementApiKeyCreateRequest,
  type ManagementApiKeyId,
  type ManagementApiKeyScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError } from "effect/unstable/http";

import {
  createEnvironmentManagementApiKey as createAdapterManagementApiKey,
  listEnvironmentManagementApiKeys as listAdapterManagementApiKeys,
  revokeEnvironmentManagementApiKey as revokeAdapterManagementApiKey,
  rotateEnvironmentManagementApiKey as rotateAdapterManagementApiKey,
} from "@t3tools/client-runtime/state/management-api-keys";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { runtime } from "../lib/runtime";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export interface ManagementApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: ReadonlyArray<ManagementApiKeyScope>;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface ManagementApiKeyCreateInput {
  readonly name: string;
  readonly scopes: ReadonlyArray<ManagementApiKeyScope>;
  readonly expiresAt: string | null;
}

export interface ManagementApiKeyCreateResult {
  readonly key: ManagementApiKeyRecord;
  readonly secret: string;
  readonly mcpEndpoint: string;
}

export interface ManagementApiKeyRotateResult extends ManagementApiKeyCreateResult {}

type ManagementApiKeyRequestOperation = "list" | "create" | "revoke" | "rotate";

export class ManagementApiKeyRequestError extends Error {
  readonly operation: ManagementApiKeyRequestOperation;
  readonly status: number;

  constructor(input: {
    readonly operation: ManagementApiKeyRequestOperation;
    readonly status: number;
  }) {
    super(`Management API key request failed (HTTP ${input.status}).`);
    this.name = "ManagementApiKeyRequestError";
    this.operation = input.operation;
    this.status = input.status;
  }
}

function readHttpApiStatus(error: unknown): number {
  if (isEnvironmentHttpCommonError(error)) {
    switch (error._tag) {
      case "EnvironmentAuthInvalidError":
        return 401;
      case "EnvironmentScopeRequiredError":
      case "EnvironmentOperationForbiddenError":
        return 403;
      case "EnvironmentRequestInvalidError":
        return 400;
      case "EnvironmentResourceNotFoundError":
        return 404;
      case "EnvironmentInternalError":
        return 500;
    }
  }
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : HttpClientError.isHttpClientError(error) && error.response !== undefined
      ? error.response.status
      : 500;
}

function toIso(value: DateTime.Utc | string): string {
  return typeof value === "string" ? value : DateTime.formatIso(value);
}

function toNullableIso(value: DateTime.Utc | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapManagementApiKey(value: ManagementApiKey): ManagementApiKeyRecord {
  return {
    id: value.id,
    name: value.name,
    prefix: value.prefix,
    scopes: value.scopes,
    createdAt: toIso(value.createdAt),
    expiresAt: toNullableIso(value.expiresAt),
    lastUsedAt: toNullableIso(value.lastUsedAt),
  };
}

function mapMutationResult(value: {
  readonly key: ManagementApiKey;
  readonly secret: string;
  readonly mcpEndpoint: string;
}): ManagementApiKeyCreateResult {
  return {
    key: mapManagementApiKey(value.key),
    secret: value.secret,
    mcpEndpoint: value.mcpEndpoint,
  };
}

function mapCreatePayload(input: ManagementApiKeyCreateInput): ManagementApiKeyCreateRequest {
  return {
    name: input.name,
    scopes: input.scopes,
    ...(input.expiresAt === null
      ? { expiresAt: null }
      : { expiresAt: DateTime.makeUnsafe(input.expiresAt) }),
  };
}

function runManagementApiKeyRequest<A>(
  operation: ManagementApiKeyRequestOperation,
  effect: Effect.Effect<A, object, HttpClient.HttpClient>,
): Promise<A> {
  return runtime.runPromise(effect).catch((cause) => {
    throw new ManagementApiKeyRequestError({ operation, status: readHttpApiStatus(cause) });
  });
}

export function listEnvironmentManagementApiKeys(input: {
  readonly prepared: PreparedConnection;
  readonly timeoutMs?: number;
}): Promise<ReadonlyArray<ManagementApiKeyRecord>> {
  return runManagementApiKeyRequest(
    "list",
    listAdapterManagementApiKeys(input).pipe(Effect.map((keys) => keys.map(mapManagementApiKey))),
  );
}

export function createEnvironmentManagementApiKey(input: {
  readonly prepared: PreparedConnection;
  readonly payload: ManagementApiKeyCreateInput;
  readonly timeoutMs?: number;
}): Promise<ManagementApiKeyCreateResult> {
  return runManagementApiKeyRequest(
    "create",
    createAdapterManagementApiKey({
      ...input,
      payload: mapCreatePayload(input.payload),
    }).pipe(Effect.map(mapMutationResult)),
  );
}

export function revokeEnvironmentManagementApiKey(input: {
  readonly prepared: PreparedConnection;
  readonly id: string;
  readonly timeoutMs?: number;
}): Promise<void> {
  return runManagementApiKeyRequest(
    "revoke",
    revokeAdapterManagementApiKey({
      ...input,
      id: input.id as ManagementApiKeyId,
    }).pipe(Effect.asVoid),
  );
}

export function rotateEnvironmentManagementApiKey(input: {
  readonly prepared: PreparedConnection;
  readonly id: string;
  readonly timeoutMs?: number;
}): Promise<ManagementApiKeyRotateResult> {
  return runManagementApiKeyRequest(
    "rotate",
    rotateAdapterManagementApiKey({
      ...input,
      id: input.id as ManagementApiKeyId,
    }).pipe(Effect.map(mapMutationResult)),
  );
}
