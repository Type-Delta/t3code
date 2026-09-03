import type {
  ManagementApiKeyCreateRequest,
  ManagementApiKeyCreateResponse,
  ManagementApiKeyId,
  ManagementApiKeyListResponse,
  ManagementApiKeyRevokeResponse,
  ManagementApiKeyRotateResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS = 6_000;

/** Load management keys from the selected environment. */
export const listEnvironmentManagementApiKeys = Effect.fn(
  "clientRuntime.state.listEnvironmentManagementApiKeys",
)(function* (input: { readonly prepared: PreparedConnection; readonly timeoutMs?: number }) {
  const requestUrl = makeEnvironmentHttpApiUrlBuilder(input.prepared.httpBaseUrl).management.keys();
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.management.keys({ headers }),
    ),
  );
});

/** Create a management key in the selected environment. */
export const createEnvironmentManagementApiKey = Effect.fn(
  "clientRuntime.state.createEnvironmentManagementApiKey",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly payload: ManagementApiKeyCreateRequest;
  readonly timeoutMs?: number;
}) {
  const requestUrl = makeEnvironmentHttpApiUrlBuilder(
    input.prepared.httpBaseUrl,
  ).management.createKey();
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.management.createKey({ headers, payload: input.payload }),
    ),
  );
});

/** Rotate a management key in the selected environment. */
export const rotateEnvironmentManagementApiKey = Effect.fn(
  "clientRuntime.state.rotateEnvironmentManagementApiKey",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly id: ManagementApiKeyId;
  readonly timeoutMs?: number;
}) {
  const requestUrl = makeEnvironmentHttpApiUrlBuilder(
    input.prepared.httpBaseUrl,
  ).management.rotateKey({ params: { id: input.id } });
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.management.rotateKey({
        headers,
        params: { id: input.id },
      }),
    ),
  );
});

/** Revoke a management key in the selected environment. */
export const revokeEnvironmentManagementApiKey = Effect.fn(
  "clientRuntime.state.revokeEnvironmentManagementApiKey",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly id: ManagementApiKeyId;
  readonly timeoutMs?: number;
}) {
  const requestUrl = makeEnvironmentHttpApiUrlBuilder(
    input.prepared.httpBaseUrl,
  ).management.revokeKey({ params: { id: input.id } });
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_MANAGEMENT_API_KEYS_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.management.revokeKey({
        headers,
        params: { id: input.id },
      }),
    ),
  );
});

export type {
  ManagementApiKeyCreateResponse,
  ManagementApiKeyListResponse,
  ManagementApiKeyRevokeResponse,
  ManagementApiKeyRotateResponse,
};
