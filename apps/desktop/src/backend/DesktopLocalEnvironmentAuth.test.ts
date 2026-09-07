import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const SECONDARY_LOCAL_ENVIRONMENT_ID = DesktopBackendPool.BackendInstanceId("wsl:ubuntu");

const makeConfig = (port: number, credential: string) =>
  ({
    executablePath: "/electron",
    entryPath: "/server/bin.mjs",
    cwd: "/server",
    args: [],
    env: {},
    extendEnv: false,
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home: "/tmp/t3",
      host: "127.0.0.1",
      desktopBootstrapToken: credential,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    },
    httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
    bootstrapDelivery: "fd3",
    captureOutput: true,
    preflightFailure: Option.none(),
  }) as unknown as DesktopBackendManager.DesktopBackendStartConfig;

const makeInstance = (
  id: DesktopBackendPool.BackendInstanceId,
  configRef: Ref.Ref<Option.Option<DesktopBackendManager.DesktopBackendStartConfig>>,
) =>
  ({
    id,
    label: Effect.succeed(id),
    currentConfig: Ref.get(configRef),
    start: Effect.void,
    stop: () => Effect.void,
    snapshot: Effect.succeed({}),
    waitForReady: () => Effect.succeed(true),
  }) as unknown as DesktopBackendPool.DesktopBackendInstance;

const makeSessionResponse = (request: HttpClientRequest.HttpClientRequest, token: string) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      JSON.stringify({
        access_token: token,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "orchestration:read",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const configRef = yield* Ref.make(Option.some(makeConfig(3773, "desktop-bootstrap-token")));
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(makeSessionResponse(request, "desktop-bearer-token")),
          ),
        ),
      );
      const poolLayer = DesktopBackendPool.layerTest([
        makeInstance(DesktopBackendPool.BackendInstanceId(PRIMARY_LOCAL_ENVIRONMENT_ID), configRef),
      ]);
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken(), auth.getBearerToken()], {
          concurrency: "unbounded",
        });
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  it.effect("shares one exchange between concurrent window and tray consumers", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const validTokens = yield* Ref.make<ReadonlySet<string>>(new Set());
      const primaryConfigRef = yield* Ref.make(
        Option.some(makeConfig(3773, "desktop-bootstrap-token")),
      );
      const secondaryConfigRef = yield* Ref.make(
        Option.some(makeConfig(3774, "secondary-bootstrap-token")),
      );
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const exchange = yield* Ref.modify(
              requestCount,
              (count) => [count + 1, count + 1] as const,
            );
            const token = `desktop-bearer-token-${exchange}`;
            // Both consumers should retain an accepted credential while sharing
            // one exchange for a backend, as the real auth server does.
            yield* Ref.update(validTokens, (tokens) => new Set(tokens).add(token));
            return makeSessionResponse(request, token);
          }),
        ),
      );
      const poolLayer = DesktopBackendPool.layerTest([
        makeInstance(
          DesktopBackendPool.BackendInstanceId(PRIMARY_LOCAL_ENVIRONMENT_ID),
          primaryConfigRef,
        ),
        makeInstance(SECONDARY_LOCAL_ENVIRONMENT_ID, secondaryConfigRef),
      ]);
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
      );

      const [windowToken, trayToken, secondaryToken] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const [window, tray] = yield* Effect.all([auth.getBearerToken(), auth.getBearerToken()], {
          concurrency: "unbounded",
        });
        const secondary = yield* auth.getBearerToken(SECONDARY_LOCAL_ENVIRONMENT_ID);
        return [window, tray, secondary] as const;
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(windowToken, "desktop-bearer-token-1");
      assert.strictEqual(trayToken, windowToken);
      assert.strictEqual(secondaryToken, "desktop-bearer-token-2");
      assert.strictEqual(yield* Ref.get(requestCount), 2);
      assert.isTrue((yield* Ref.get(validTokens)).has(windowToken));
      assert.isTrue((yield* Ref.get(validTokens)).has(secondaryToken));
    }),
  );

  it.effect(
    "re-exchanges after a backend config change without sharing tokens across backends",
    () =>
      Effect.gen(function* () {
        const requestCount = yield* Ref.make(0);
        const configRef = yield* Ref.make(Option.some(makeConfig(3773, "desktop-bootstrap-token")));
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const exchange = yield* Ref.modify(
                requestCount,
                (count) => [count + 1, count + 1] as const,
              );
              return makeSessionResponse(request, `desktop-bearer-token-${exchange}`);
            }),
          ),
        );
        const poolLayer = DesktopBackendPool.layerTest([
          makeInstance(
            DesktopBackendPool.BackendInstanceId(PRIMARY_LOCAL_ENVIRONMENT_ID),
            configRef,
          ),
        ]);
        const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
          Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
        );

        const [first, cached, afterConfigChange] = yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          const firstToken = yield* auth.getBearerToken();
          const cachedToken = yield* auth.getBearerToken(PRIMARY_LOCAL_ENVIRONMENT_ID);
          yield* Ref.set(configRef, Option.some(makeConfig(3773, "rotated-bootstrap-token")));
          const rotatedToken = yield* auth.getBearerToken();
          return [firstToken, cachedToken, rotatedToken] as const;
        }).pipe(Effect.provide(testLayer));

        assert.strictEqual(first, "desktop-bearer-token-1");
        assert.strictEqual(cached, first);
        assert.strictEqual(afterConfigChange, "desktop-bearer-token-2");
        assert.strictEqual(yield* Ref.get(requestCount), 2);
      }),
  );

  it.effect("does not cache a failed exchange, so a later retry can recover", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const configRef = yield* Ref.make(Option.some(makeConfig(3773, "desktop-bootstrap-token")));
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const exchange = yield* Ref.modify(
              requestCount,
              (count) => [count + 1, count + 1] as const,
            );
            if (exchange === 1) {
              return HttpClientResponse.fromWeb(
                request,
                new Response("unavailable", { status: 503 }),
              );
            }
            return makeSessionResponse(request, "recovered-desktop-bearer-token");
          }),
        ),
      );
      const poolLayer = DesktopBackendPool.layerTest([
        makeInstance(DesktopBackendPool.BackendInstanceId(PRIMARY_LOCAL_ENVIRONMENT_ID), configRef),
      ]);
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
      );

      const [failed, recovered] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const first = yield* auth.getBearerToken().pipe(Effect.orElseSucceed(() => "failed"));
        const second = yield* auth.getBearerToken();
        return [first, second] as const;
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(failed, "failed");
      assert.strictEqual(recovered, "recovered-desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 2);
    }),
  );
});
