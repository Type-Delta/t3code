import type {
  ManagementApiKeyCreateRequest,
  ManagementApiKeyCreateResponse,
  ManagementApiKeyId,
  ManagementApiKeyListResponse,
  ManagementApiKeyRevokeResponse,
  ManagementApiKeyRotateResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS = 6_000;
const managementApiUrl = (httpBaseUrl: string, suffix = ""): string =>
  `${httpBaseUrl.replace(/\/+$/, "")}/api/management/keys${suffix}`;

/** Load management keys from the selected environment. */
export const listEnvironmentManagementApiKeys = Effect.fn(
  "clientRuntime.state.listEnvironmentManagementApiKeys",
)(function* (input: { readonly prepared: PreparedConnection; readonly timeoutMs?: number }) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    group: "management",
    method: "GET",
    url: (httpBaseUrl) => managementApiUrl(httpBaseUrl),
    timeoutMs: input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    request: ({ client, headers }) => client.keys({ headers }),
  });
});

/** Create a management key in the selected environment. */
export const createEnvironmentManagementApiKey = Effect.fn(
  "clientRuntime.state.createEnvironmentManagementApiKey",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly payload: ManagementApiKeyCreateRequest;
  readonly timeoutMs?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    group: "management",
    method: "POST",
    url: (httpBaseUrl) => managementApiUrl(httpBaseUrl),
    timeoutMs: input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    request: ({ client, headers }) => client.createKey({ headers, payload: input.payload }),
  });
});

/** Rotate a management key in the selected environment. */
export const rotateEnvironmentManagementApiKey = Effect.fn(
  "clientRuntime.state.rotateEnvironmentManagementApiKey",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly id: ManagementApiKeyId;
  readonly timeoutMs?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    group: "management",
    method: "POST",
    url: (httpBaseUrl) =>
      managementApiUrl(httpBaseUrl, `/${encodeURIComponent(String(input.id))}/rotate`),
    timeoutMs: input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.rotateKey({
        headers,
        params: { id: input.id },
      }),
  });
});

/** Revoke a management key in the selected environment. */
export const revokeEnvironmentManagementApiKey = Effect.fn(
  "clientRuntime.state.revokeEnvironmentManagementApiKey",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly id: ManagementApiKeyId;
  readonly timeoutMs?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    group: "management",
    method: "POST",
    url: (httpBaseUrl) =>
      managementApiUrl(httpBaseUrl, `/${encodeURIComponent(String(input.id))}/revoke`),
    timeoutMs: input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.revokeKey({
        headers,
        params: { id: input.id },
      }),
  });
});

export type {
  ManagementApiKeyCreateResponse,
  ManagementApiKeyListResponse,
  ManagementApiKeyRevokeResponse,
  ManagementApiKeyRotateResponse,
};
