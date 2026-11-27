import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";

// Each /oauth/token attempt may take 10 s, so a backend busy after ready needs several attempts.
// Rejected credentials and non-transient server errors still fail immediately.
const BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT = Duration.seconds(60);
const BOOTSTRAP_TRANSIENT_RETRY_INTERVAL = Duration.millis(500);
const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);

const isTransientBearerBootstrapError = (error: RemoteEnvironmentRequestError): boolean => {
  switch (error._tag) {
    case "RemoteEnvironmentAuthFetchError":
    case "RemoteEnvironmentAuthTimeoutError":
      return true;
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
    default:
      return false;
  }
};

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedError<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedError<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

const BEARER_TOKEN_REFRESH_SKEW_MS = 5_000;

interface CachedBearerToken {
  readonly instance: DesktopBackendPool.DesktopBackendInstance;
  readonly activePid: number | null;
  readonly httpBaseUrl: string;
  /** The launch secret, or the fixed launch token for backends without one. */
  readonly launchCredential: string;
  readonly runningDistro: string | null;
  readonly token: string;
  readonly expiresAtEpochMs: number;
}

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: (
      environmentId?: string,
    ) => Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

/** @public */
export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const httpClient = yield* HttpClient.HttpClient;
  const mac = yield* Mac.Mac;
  const tokenRef = yield* Ref.make(new Map<string, CachedBearerToken>());
  const mutexes = new Map<string, Semaphore.Semaphore>();

  const getMutex = (backendId: string) => {
    const existing = mutexes.get(backendId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    mutexes.set(backendId, created);
    return created;
  };

  const getBearerToken = Effect.fn("desktop.localEnvironmentAuth.getBearerToken")(function* (
    environmentId?: string,
  ) {
    const backendId = environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID;
    const mutex = getMutex(backendId);
    const readyInstance = Effect.gen(function* () {
      const instances = yield* pool.list;
      const instance = instances.find((candidate) => candidate.id === backendId);
      if (instance === undefined || !(yield* instance.waitForReady(Duration.infinity))) {
        return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
      }
      return instance;
    });

    const exchange = Effect.gen(function* () {
      const instance = yield* readyInstance;
      const configOption = yield* instance.currentConfig;
      if (Option.isNone(configOption)) {
        return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
      }
      const config = configOption.value;
      const { activePid } = yield* instance.snapshot;
      const pid = Option.getOrNull(activePid);
      const httpBaseUrl = config.httpBaseUrl.href;
      const runningDistro = config.runningDistro ?? null;
      const secret = config.bootstrap.desktopBootstrapSecret;
      const launchCredential = secret ?? config.bootstrap.desktopBootstrapToken;
      if (!launchCredential && instance.mintCredential === undefined) {
        return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
      }

      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(tokenRef)).get(backendId);
      if (
        cached !== undefined &&
        cached.instance === instance &&
        cached.activePid === pid &&
        cached.httpBaseUrl === httpBaseUrl &&
        cached.launchCredential === launchCredential &&
        cached.runningDistro === runningDistro &&
        cached.expiresAtEpochMs > now + BEARER_TOKEN_REFRESH_SKEW_MS
      ) {
        return cached.token;
      }

      // A gateway token can be consumed even when the exchange response is lost.
      const credential =
        instance.mintCredential !== undefined
          ? yield* instance.mintCredential.pipe(
              Effect.mapError(
                (cause) => new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause }),
              ),
            )
          : secret === undefined
            ? launchCredential
            : yield* currentDesktopBootstrapToken(secret, now).pipe(
                Effect.provideService(Mac.Mac, mac),
              );

      const issuedAtEpochMs = yield* Clock.currentTimeMillis;
      const session = yield* bootstrapRemoteBearerSession({
        httpBaseUrl,
        credential,
        clientMetadata: {
          label: "T3 Code Desktop",
          deviceType: "desktop",
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

      const expiresInMs = Number.isFinite(session.expires_in)
        ? Math.max(0, session.expires_in * 1_000)
        : 0;
      yield* Ref.update(tokenRef, (current) =>
        new Map(current).set(backendId, {
          instance,
          activePid: pid,
          httpBaseUrl,
          launchCredential,
          runningDistro,
          token: session.access_token,
          expiresAtEpochMs: issuedAtEpochMs + expiresInMs,
        }),
      );
      return session.access_token;
    });

    return yield* mutex.withPermits(1)(
      readyInstance.pipe(
        Effect.andThen(
          exchange.pipe(
            Effect.retry({
              while: (error) =>
                error._tag !== "DesktopLocalEnvironmentAuthBackendNotConfiguredError" &&
                error._tag !== "DesktopLocalEnvironmentAuthSessionBootstrapError" &&
                isTransientBearerBootstrapError(error),
              schedule: Schedule.spaced(BOOTSTRAP_TRANSIENT_RETRY_INTERVAL),
            }),
            Effect.timeout(BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT),
            Effect.mapError((cause) =>
              cause._tag === "DesktopLocalEnvironmentAuthBackendNotConfiguredError" ||
              cause._tag === "DesktopLocalEnvironmentAuthSessionBootstrapError"
                ? cause
                : new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause }),
            ),
          ),
        ),
      ),
    );
  });

  return DesktopLocalEnvironmentAuth.of({ getBearerToken });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
