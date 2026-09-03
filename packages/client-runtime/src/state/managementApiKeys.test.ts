import { EnvironmentId, ManagementApiKeyId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  createEnvironmentManagementApiKey,
  listEnvironmentManagementApiKeys,
  revokeEnvironmentManagementApiKey,
  rotateEnvironmentManagementApiKey,
} from "./managementApiKeys.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "environment-token" },
  target: TARGET,
};

const KEY = {
  id: ManagementApiKeyId.make("key-1"),
  name: "Automation key",
  prefix: "t3mgmt_key-1",
  scopes: ["threads:list" as const],
  defaultRuntimeMode: "approval-required" as const,
  maximumRuntimeMode: "approval-required" as const,
  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  expiresAt: null,
  lastUsedAt: null,
};

const CREATE_RESPONSE = {
  key: KEY,
  secret: "t3mgmt_key-1_secret",
  mcpEndpoint: "https://environment.example.test/mcp",
};

describe("environment management API keys", () => {
  it.effect("routes every operation to the prepared environment with bearer auth", () => {
    const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
    const fetchFn = ((request, init) => {
      calls.push([request, init ?? {}]);
      const url = String(request);
      if (url.endsWith("/api/management/keys")) {
        return Promise.resolve(Response.json(init?.method === "POST" ? CREATE_RESPONSE : [KEY]));
      }
      if (url.endsWith("/rotate")) {
        return Promise.resolve(Response.json(CREATE_RESPONSE));
      }
      return Promise.resolve(Response.json({ revoked: true }));
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const list = yield* listEnvironmentManagementApiKeys({ prepared: PREPARED });
      const created = yield* createEnvironmentManagementApiKey({
        prepared: PREPARED,
        payload: {
          name: "Automation key",
          scopes: ["threads:list"],
          defaultRuntimeMode: "approval-required",
          maximumRuntimeMode: "approval-required",
        },
      });
      const rotated = yield* rotateEnvironmentManagementApiKey({
        prepared: PREPARED,
        id: KEY.id,
      });
      const revoked = yield* revokeEnvironmentManagementApiKey({
        prepared: PREPARED,
        id: KEY.id,
      });

      expect(list).toEqual([KEY]);
      expect(created).toEqual(CREATE_RESPONSE);
      expect(rotated).toEqual(CREATE_RESPONSE);
      expect(revoked).toEqual({ revoked: true });
      expect(calls).toHaveLength(4);

      const expected = [
        ["GET", "https://environment.example.test/api/management/keys"],
        ["POST", "https://environment.example.test/api/management/keys"],
        ["POST", "https://environment.example.test/api/management/keys/key-1/rotate"],
        ["POST", "https://environment.example.test/api/management/keys/key-1/revoke"],
      ];
      calls.forEach(([request, init], index) => {
        expect([init.method, String(request)]).toEqual(expected[index]);
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer environment-token");
        expect(init.credentials).toBeUndefined();
      });
    }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
  });

  it.effect("uses the exact management endpoint URL for DPoP proofs", () => {
    const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
    const fetchFn = ((request, init) => {
      calls.push([request, init ?? {}]);
      return Promise.resolve(Response.json([]));
    }) satisfies typeof fetch;
    const prepared: PreparedConnection = {
      ...PREPARED,
      httpAuthorization: { _tag: "Dpop", accessToken: "environment-access-token" },
    };
    const signer = ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("thumbprint"),
      createProof: (input) => Effect.succeed(`proof:${input.method}:${input.url}`),
    });

    return listEnvironmentManagementApiKeys({ prepared }).pipe(
      Effect.provide(
        Layer.mergeAll(
          remoteHttpClientLayer(fetchFn),
          Layer.succeed(ManagedRelayDpopSigner, signer),
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual([]);
          const [request, init] = calls[0]!;
          expect(String(request)).toBe("https://environment.example.test/api/management/keys");
          expect(new Headers(init.headers).get("authorization")).toBe(
            "DPoP environment-access-token",
          );
          expect(new Headers(init.headers).get("dpop")).toBe(
            "proof:GET:https://environment.example.test/api/management/keys",
          );
        }),
      ),
    );
  });

  it.effect("uses the encoded parameter URL for DPoP mutation proofs", () => {
    const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
    const fetchFn = ((request, init) => {
      calls.push([request, init ?? {}]);
      return Promise.resolve(Response.json(CREATE_RESPONSE));
    }) satisfies typeof fetch;
    const prepared: PreparedConnection = {
      ...PREPARED,
      httpAuthorization: { _tag: "Dpop", accessToken: "environment-access-token" },
    };
    const signer = ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("thumbprint"),
      createProof: (input) => Effect.succeed(`proof:${input.method}:${input.url}`),
    });
    const id = ManagementApiKeyId.make("key/with space");

    return rotateEnvironmentManagementApiKey({ prepared, id }).pipe(
      Effect.provide(
        Layer.mergeAll(
          remoteHttpClientLayer(fetchFn),
          Layer.succeed(ManagedRelayDpopSigner, signer),
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual(CREATE_RESPONSE);
          const [request, init] = calls[0]!;
          const expectedUrl =
            "https://environment.example.test/api/management/keys/key%2Fwith%20space/rotate";
          expect(String(request)).toBe(expectedUrl);
          expect(new Headers(init.headers).get("dpop")).toBe(`proof:POST:${expectedUrl}`);
        }),
      ),
    );
  });

  it.effect("includes cookies for a primary environment request", () => {
    const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
    const fetchFn = ((request, init) => {
      calls.push([request, init ?? {}]);
      return Promise.resolve(Response.json([]));
    }) satisfies typeof fetch;
    const prepared: PreparedConnection = { ...PREPARED, httpAuthorization: null };

    return listEnvironmentManagementApiKeys({ prepared }).pipe(
      Effect.provide(remoteHttpClientLayer(fetchFn)),
      Effect.tap(() =>
        Effect.sync(() => {
          const [, init] = calls[0]!;
          expect(init.credentials).toBe("include");
          expect(new Headers(init.headers).get("authorization")).toBeNull();
        }),
      ),
    );
  });
});
