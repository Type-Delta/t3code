import { EnvironmentHttpCommonError } from "@t3tools/contracts";
import type {
  ManagementApiKeyRuntimeMode,
  ManagementApiKey,
  ManagementApiKeyCreateRequest,
  ManagementApiKeyId,
  ManagementApiKeyScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/unstable/http";

import { runPrimaryHttp } from "../../lib/runtime";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export type ManagementApiKeySafeRuntimeMode = Exclude<ManagementApiKeyRuntimeMode, "auto">;

export interface ManagementApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: ReadonlyArray<ManagementApiKeyScope>;
  readonly defaultRuntimeMode: ManagementApiKeyRuntimeMode;
  readonly maximumRuntimeMode: ManagementApiKeyRuntimeMode;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface ManagementApiKeyCreateInput {
  readonly name: string;
  readonly scopes: ReadonlyArray<ManagementApiKeyScope>;
  readonly defaultRuntimeMode: ManagementApiKeySafeRuntimeMode;
  readonly maximumRuntimeMode: ManagementApiKeySafeRuntimeMode;
  readonly expiresAt: string | null;
}

export interface ManagementApiKeyCreateResult {
  readonly key: ManagementApiKeyRecord;
  readonly secret: string;
  readonly mcpEndpoint: string;
}

export interface ManagementApiKeyRotateResult extends ManagementApiKeyCreateResult {}

export class ManagementApiKeyRequestError extends Error {
  readonly operation: ManagementApiKeyRequestOperation;
  readonly status: number;

  constructor(input: {
    readonly operation: ManagementApiKeyRequestOperation;
    readonly status: number;
    readonly message?: string;
  }) {
    super(input.message ?? `Management API key request failed (HTTP ${input.status}).`);
    this.name = "ManagementApiKeyRequestError";
    this.operation = input.operation;
    this.status = input.status;
  }
}

type ManagementApiKeyRequestOperation = "list" | "create" | "revoke" | "rotate";

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
  if (HttpClientError.isHttpClientError(error) && error.response !== undefined) {
    return error.response.status;
  }
  return 500;
}

function managementApiKeyRequestError(
  operation: ManagementApiKeyRequestOperation,
  cause: unknown,
): ManagementApiKeyRequestError {
  return new ManagementApiKeyRequestError({ operation, status: readHttpApiStatus(cause) });
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
    defaultRuntimeMode: value.defaultRuntimeMode,
    maximumRuntimeMode: value.maximumRuntimeMode,
    createdAt: toIso(value.createdAt),
    expiresAt: toNullableIso(value.expiresAt),
    lastUsedAt: toNullableIso(value.lastUsedAt),
  };
}

function toCreatePayload(input: ManagementApiKeyCreateInput): ManagementApiKeyCreateRequest {
  return {
    name: input.name,
    scopes: input.scopes,
    defaultRuntimeMode: input.defaultRuntimeMode,
    maximumRuntimeMode: input.maximumRuntimeMode,
    ...(input.expiresAt === null
      ? { expiresAt: null }
      : { expiresAt: DateTime.makeUnsafe(input.expiresAt) }),
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

export function listManagementApiKeys(): Promise<ReadonlyArray<ManagementApiKeyRecord>> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.management.keys({ headers: {} })),
      Effect.map((keys) => keys.map(mapManagementApiKey)),
      Effect.mapError((cause) => managementApiKeyRequestError("list", cause)),
    ),
  );
}

export function createManagementApiKey(
  input: ManagementApiKeyCreateInput,
): Promise<ManagementApiKeyCreateResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.management.createKey({ headers: {}, payload: toCreatePayload(input) }),
      ),
      Effect.map(mapMutationResult),
      Effect.mapError((cause) => managementApiKeyRequestError("create", cause)),
    ),
  );
}

export function revokeManagementApiKey(id: string): Promise<void> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.management.revokeKey({
          headers: {},
          params: { id: id as ManagementApiKeyId },
        }),
      ),
      Effect.asVoid,
      Effect.mapError((cause) => managementApiKeyRequestError("revoke", cause)),
    ),
  );
}

export function rotateManagementApiKey(id: string): Promise<ManagementApiKeyRotateResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.management.rotateKey({
          headers: {},
          params: { id: id as ManagementApiKeyId },
        }),
      ),
      Effect.map(mapMutationResult),
      Effect.mapError((cause) => managementApiKeyRequestError("rotate", cause)),
    ),
  );
}
