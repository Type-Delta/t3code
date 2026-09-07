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
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS = 6_000;

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
    method: "GET",
    url: (httpBaseUrl) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).management.keys(),
    timeoutMs: input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    request: ({ client, headers }) => client.management.keys({ headers }),
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
    method: "POST",
    url: (httpBaseUrl) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).management.createKey(),
    timeoutMs: input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.management.createKey({ headers, payload: input.payload }),
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
    method: "POST",
    url: (httpBaseUrl) =>
      makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).management.rotateKey({
        params: { id: input.id },
      }),
    timeoutMs: input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.management.rotateKey({
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
    method: "POST",
    url: (httpBaseUrl) =>
      makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).management.revokeKey({
        params: { id: input.id },
      }),
    timeoutMs: input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.management.revokeKey({
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
