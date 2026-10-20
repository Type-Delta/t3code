import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";
import * as TestClock from "effect/testing/TestClock";

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
                new Response("server error", { status: 500 }),
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

  it.effect(
    "exchanges the current window's token when the backend was launched with a secret",
    () =>
      Effect.gen(function* () {
        const presented = yield* Ref.make<string | null>(null);
        const base = makeConfig(3773, "desktop-bootstrap-token");
        const configRef = yield* Ref.make(
          Option.some({
            ...base,
            bootstrap: { ...base.bootstrap, desktopBootstrapSecret: "desktop-secret" },
          } as DesktopBackendManager.DesktopBackendStartConfig),
        );
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            return Ref.set(presented, new URLSearchParams(body).get("subject_token")).pipe(
              Effect.as(makeSessionResponse(request, "desktop-bearer-token")),
            );
          }),
        );
        const poolLayer = DesktopBackendPool.layerTest([
          makeInstance(
            DesktopBackendPool.BackendInstanceId(PRIMARY_LOCAL_ENVIRONMENT_ID),
            configRef,
          ),
        ]);

        yield* TestClock.setTime(DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1);
        yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          return yield* auth.getBearerToken();
        }).pipe(
          Effect.provide(
            DesktopLocalEnvironmentAuth.layer.pipe(
              Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
            ),
          ),
        );

        assert.strictEqual(
          yield* Ref.get(presented),
          currentDesktopBootstrapToken("desktop-secret", DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1),
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  const makeExchange = (failures: number, failure: () => Response) =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const configRef = yield* Ref.make(Option.some(makeConfig(3773, "desktop-bootstrap-token")));
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.updateAndGet(requestCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count <= failures
                ? HttpClientResponse.fromWeb(request, failure())
                : makeSessionResponse(request, "desktop-bearer-token"),
            ),
          ),
        ),
      );
      const poolLayer = DesktopBackendPool.layerTest([
        makeInstance(DesktopBackendPool.BackendInstanceId(PRIMARY_LOCAL_ENVIRONMENT_ID), configRef),
      ]);
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
          ),
        ),
      );
      return { auth, requestCount };
    });

  it.effect("retries a backend that is still starting", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(
        2,
        () => new Response("", { status: 503 }),
      );

      const fiber = yield* auth.getBearerToken().pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));

      assert.strictEqual(yield* Fiber.join(fiber), "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry a rejected bootstrap credential", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(1, () =>
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-1",
          },
          { status: 401 },
        ),
      );

      const fiber = yield* auth.getBearerToken().pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));
      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error._tag, "DesktopLocalEnvironmentAuthSessionBootstrapError");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
