import { EnvironmentId, ManagementApiKeyId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
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
  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  expiresAt: null,
  lastUsedAt: null,
};

const CREATE_RESPONSE = {
  key: KEY,
  secret: "t3mgmt_key-1_secret",
  mcpEndpoint: "https://environment.example.test/mcp",
};

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: TARGET.environmentId,
  label: "Relay environment",
});
const RELAY_PREPARED: PreparedConnection = {
  ...PREPARED,
  httpBaseUrl: "https://stale.example.test",
  httpAuthorization: {
    _tag: "Dpop",
    accessToken: "stale-token",
    expiresAtEpochMs: 0,
  },
  target: RELAY_TARGET,
};
const CURRENT_ORIGIN = "https://current.example.test";
const RENEWED_ORIGIN = "https://renewed.example.test";

function makeRelayHarness(reply: (requestNumber: number) => Response | Promise<Response>) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const authorizations: Array<
    Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0]
  > = [];
  const proofs: Array<ManagedRelayDpopProofInput> = [];
  const remoteAuthorization = RemoteEnvironmentAuthorization.of({
    authorizeBearer: () => Effect.die("Unexpected bearer authorization."),
    authorizeDpop: () => Effect.die("HTTP requests must not prepare a WebSocket connection."),
    authorizeDpopHttp: (input) =>
      Effect.sync(() => {
        authorizations.push(input);
        const renewed = input.rejectedAccessToken !== undefined;
        return {
          environmentId: TARGET.environmentId,
          label: RELAY_TARGET.label,
          httpBaseUrl: renewed ? RENEWED_ORIGIN : CURRENT_ORIGIN,
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: renewed ? "renewed-token" : "current-token",
            expiresAtEpochMs: 1_800_000_000_000,
          },
        };
      }),
  });
  const signer = ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof: (input) =>
      Effect.sync(() => {
        proofs.push(input);
        return `proof-${proofs.length}`;
      }),
  });
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length);
  };
  return {
    calls,
    authorizations,
    proofs,
    layer: Layer.mergeAll(
      remoteHttpClientLayer(fetchFn),
      Layer.succeed(ManagedRelayDpopSigner, signer),
      Layer.succeed(RemoteEnvironmentAuthorization, remoteAuthorization),
    ),
  };
}

function credentialRejectedResponse() {
  return Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-rejected",
    },
    { status: 401 },
  );
}

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

  it.effect("uses the latest relay credential and endpoint for each request", () =>
    Effect.gen(function* () {
      const harness = makeRelayHarness(() => Response.json([]));

      const result = yield* listEnvironmentManagementApiKeys({
        prepared: RELAY_PREPARED,
      }).pipe(Effect.provide(harness.layer));

      expect(result).toEqual([]);
      expect(harness.authorizations).toEqual([{ expectedEnvironmentId: TARGET.environmentId }]);
      expect(harness.calls[0]!.url).toBe(`${CURRENT_ORIGIN}/api/management/keys`);
      expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
        "DPoP current-token",
      );
      expect(harness.proofs).toEqual([
        {
          method: "GET",
          url: `${CURRENT_ORIGIN}/api/management/keys`,
          accessToken: "current-token",
        },
      ]);
    }),
  );

  it.effect("uses the encoded parameter URL for DPoP mutation proofs", () => {
    const harness = makeRelayHarness(() => Response.json(CREATE_RESPONSE));
    const id = ManagementApiKeyId.make("key/with space");

    return rotateEnvironmentManagementApiKey({ prepared: RELAY_PREPARED, id }).pipe(
      Effect.provide(harness.layer),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual(CREATE_RESPONSE);
          const expectedUrl = `${CURRENT_ORIGIN}/api/management/keys/key%2Fwith%20space/rotate`;
          expect(harness.calls[0]!.url).toBe(expectedUrl);
          expect(harness.proofs[0]).toEqual({
            method: "POST",
            url: expectedUrl,
            accessToken: "current-token",
          });
        }),
      ),
    );
  });

  it.effect("renews once after an invalid relay credential and uses the rotated endpoint", () =>
    Effect.gen(function* () {
      const harness = makeRelayHarness((requestNumber) =>
        requestNumber === 1 ? credentialRejectedResponse() : Response.json([]),
      );

      const result = yield* listEnvironmentManagementApiKeys({
        prepared: RELAY_PREPARED,
      }).pipe(Effect.provide(harness.layer));

      expect(result).toEqual([]);
      expect(harness.authorizations).toEqual([
        { expectedEnvironmentId: TARGET.environmentId },
        { expectedEnvironmentId: TARGET.environmentId, rejectedAccessToken: "current-token" },
      ]);
      expect(harness.calls.map((call) => call.url)).toEqual([
        `${CURRENT_ORIGIN}/api/management/keys`,
        `${RENEWED_ORIGIN}/api/management/keys`,
      ]);
      expect(
        harness.calls.map((call) => new Headers(call.init.headers).get("authorization")),
      ).toEqual(["DPoP current-token", "DPoP renewed-token"]);
      expect(harness.proofs[1]).toEqual({
        method: "GET",
        url: `${RENEWED_ORIGIN}/api/management/keys`,
        accessToken: "renewed-token",
      });
    }),
  );

  it.effect("does not renew or retry when the relay credential lacks scope", () =>
    Effect.gen(function* () {
      const harness = makeRelayHarness(() =>
        Response.json(
          {
            _tag: "EnvironmentScopeRequiredError",
            code: "insufficient_scope",
            requiredScope: "access:write",
            traceId: "trace-scope",
          },
          { status: 403 },
        ),
      );

      yield* listEnvironmentManagementApiKeys({
        prepared: RELAY_PREPARED,
      }).pipe(Effect.provide(harness.layer), Effect.flip);

      expect(harness.calls).toHaveLength(1);
      expect(harness.authorizations).toEqual([{ expectedEnvironmentId: TARGET.environmentId }]);
    }),
  );

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
