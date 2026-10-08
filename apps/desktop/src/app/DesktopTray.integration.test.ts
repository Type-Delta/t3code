import { describe, expect, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const electronState = vi.hoisted(() => ({
  resolveTooltip: undefined as ((label: string) => void) | undefined,
  trayCount: 0,
}));

vi.mock("electron", () => {
  class Tray {
    public constructor(_icon: unknown) {
      electronState.trayCount += 1;
    }

    public setToolTip(label: string): void {
      electronState.resolveTooltip?.(label);
    }

    public setContextMenu(_menu: unknown): void {}

    public destroy(): void {}
  }

  return {
    Tray,
    Menu: {
      buildFromTemplate: (template: unknown) => template,
    },
    nativeImage: {
      createEmpty: () => ({ setTemplateImage: () => undefined }),
      createFromPath: (_path: string) => ({ setTemplateImage: () => undefined }),
    },
  };
});

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
  configRef: Ref.Ref<Option.Option<DesktopBackendManager.DesktopBackendStartConfig>>,
  readyRef: Ref.Ref<boolean>,
) =>
  ({
    id: DesktopBackendPool.BackendInstanceId(PRIMARY_LOCAL_ENVIRONMENT_ID),
    label: Effect.succeed("Windows"),
    currentConfig: Ref.get(configRef),
    start: Effect.void,
    stop: () => Effect.void,
    snapshot: Ref.get(readyRef).pipe(Effect.map((ready) => ({ ready }))),
    waitForReady: () => Effect.succeed(true),
  }) as unknown as DesktopBackendPool.DesktopBackendInstance;

const sessionResponse = (request: HttpClientRequest.HttpClientRequest, token: string) =>
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

describe("DesktopTray authentication integration", () => {
  effectIt.effect("keeps the window and tray on one accepted backend session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestCount = yield* Ref.make(0);
        const seenBearerTokens = yield* Ref.make<ReadonlyArray<string>>([]);
        const trayBearerTokens = yield* Ref.make<ReadonlyArray<string>>([]);
        const exchangeStarted = yield* Deferred.make<void>();
        const releaseExchange = yield* Deferred.make<void>();
        const configRef = yield* Ref.make(Option.some(makeConfig(3773, "desktop-bootstrap-token")));
        const readyRef = yield* Ref.make(false);
        const countFails = yield* Ref.make(false);
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const pathname = new URL(request.url).pathname;
            if (pathname === "/oauth/token") {
              return Effect.gen(function* () {
                if (!(yield* Ref.get(readyRef))) {
                  return yield* new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: "backend not ready",
                    }),
                  });
                }
                const exchange = yield* Ref.modify(
                  requestCount,
                  (count) => [count + 1, count + 1] as const,
                );
                const token = `desktop-bearer-token-${exchange}`;
                yield* Ref.update(seenBearerTokens, (tokens) => [...tokens, token]);
                if (exchange === 1) {
                  yield* Deferred.succeed(exchangeStarted, undefined);
                  yield* Deferred.await(releaseExchange);
                }
                return sessionResponse(request, token);
              });
            }
            if (pathname === "/api/orchestration/running-thread-count") {
              return Effect.gen(function* () {
                if (yield* Ref.get(countFails)) {
                  return yield* new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: "count transport failed",
                    }),
                  });
                }
                const authorization = request.headers.authorization;
                if (authorization !== undefined) {
                  yield* Ref.update(trayBearerTokens, (tokens) => [...tokens, authorization]);
                }
                return HttpClientResponse.fromWeb(
                  request,
                  new Response("4", {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  }),
                );
              });
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
            );
          }),
        );
        const poolLayer = DesktopBackendPool.layerTest([makeInstance(configRef, readyRef)]);
        const authLayer = DesktopLocalEnvironmentAuth.layer.pipe(
          Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
        );
        const assetsLayer = Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            ico: Option.some("tray.ico"),
            icns: Option.none(),
            png: Option.none(),
          }),
          resolveResourcePath: () => Effect.succeedNone,
        } as unknown as DesktopAssets.DesktopAssets["Service"]);
        const windowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
          activate: Effect.void,
        } as unknown as DesktopWindow.DesktopWindow["Service"]);
        const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
          quit: Effect.void,
        } as unknown as ElectronApp.ElectronApp["Service"]);
        const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "linux",
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
        const stateLayer = Layer.succeed(DesktopState.DesktopState, {
          backendReady: yield* Ref.make(false),
          quitting: yield* Ref.make(false),
        });
        const baseLayer = Layer.mergeAll(
          assetsLayer,
          poolLayer,
          windowLayer,
          electronAppLayer,
          environmentLayer,
          stateLayer,
          httpClientLayer,
        );
        const appLayer = DesktopTray.layer.pipe(
          Layer.provideMerge(authLayer),
          Layer.provideMerge(baseLayer),
        );
        const { tray, auth } = yield* Effect.gen(function* () {
          return {
            tray: yield* Effect.service(DesktopTray.DesktopTray),
            auth: yield* Effect.service(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth),
          };
        }).pipe(Effect.provide(appLayer));
        electronState.trayCount = 0;
        const startupTooltip = new Promise<string>((resolve) => {
          electronState.resolveTooltip = resolve;
        });
        yield* tray.configure;
        expect(yield* Effect.promise(() => startupTooltip)).toBe("T3 Code: 0 threads running");
        expect(yield* Ref.get(requestCount)).toBe(0);
        yield* Ref.set(readyRef, true);
        const tooltip = new Promise<string>((resolve) => {
          electronState.resolveTooltip = resolve;
        });
        const windowTokenFiber = yield* auth.getBearerToken().pipe(Effect.forkScoped);
        yield* Deferred.await(exchangeStarted);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.succeed(releaseExchange, undefined);
        const [windowToken, label] = yield* Effect.all(
          [Fiber.join(windowTokenFiber), Effect.promise(() => tooltip)],
          { concurrency: "unbounded" },
        );

        expect(yield* Ref.get(requestCount)).toBe(1);
        expect(yield* Ref.get(seenBearerTokens)).toEqual(["desktop-bearer-token-1"]);
        expect(yield* Ref.get(trayBearerTokens)).toEqual(["Bearer desktop-bearer-token-1"]);
        expect(windowToken).toBe("desktop-bearer-token-1");
        expect(label).toBe("T3 Code: 4 threads running");
        expect(electronState.trayCount).toBe(1);
        const staleTooltip = new Promise<string>((resolve) => {
          electronState.resolveTooltip = resolve;
        });
        yield* Ref.set(countFails, true);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Effect.promise(() => staleTooltip)).toBe(
          "T3 Code: 4 threads running (last known)",
        );
        const recoveredTooltip = new Promise<string>((resolve) => {
          electronState.resolveTooltip = resolve;
        });
        yield* Ref.set(countFails, false);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Effect.promise(() => recoveredTooltip)).toBe("T3 Code: 4 threads running");
        expect(yield* Ref.get(requestCount)).toBe(1);
        electronState.resolveTooltip = undefined;
      }),
    ),
  );
});
