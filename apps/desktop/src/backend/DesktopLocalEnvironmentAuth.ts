import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";

// A loopback /oauth/token exchange can fail transiently while the backend
// settles (a 502-504, a refused or reset connection, a timeout). Retry those
// for as long as the renderer's own bootstrap does; a rejected credential or a
// server error is final.
const BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT = Duration.seconds(15);
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
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* pool.list;
        const instance = instances.find((candidate) => candidate.id === backendId);
        if (instance === undefined) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }

        const configOption = yield* instance.currentConfig;
        if (Option.isNone(configOption)) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const config = configOption.value;
        const now = yield* Clock.currentTimeMillis;
        // A backend launched with the desktop secret accepts the current
        // window's token, not the one frozen into its launch config; this
        // exchange can run long after launch (e.g. after a suspend).
        const secret = config.bootstrap.desktopBootstrapSecret;
        const launchCredential = secret ?? config.bootstrap.desktopBootstrapToken;
        if (!launchCredential) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const credential =
          secret === undefined ? launchCredential : currentDesktopBootstrapToken(secret, now);

        const httpBaseUrl = config.httpBaseUrl.href;
        const cached = (yield* Ref.get(tokenRef)).get(instance.id);
        if (
          cached !== undefined &&
          cached.httpBaseUrl === httpBaseUrl &&
          cached.launchCredential === launchCredential &&
          cached.runningDistro === (config.runningDistro ?? null) &&
          cached.expiresAtEpochMs > now + BEARER_TOKEN_REFRESH_SKEW_MS
        ) {
          return cached.token;
        }

        // Timestamp before the exchange so network latency shortens the
        // usable cache lifetime instead of extending the server's expiry.
        const issuedAtEpochMs = now;
        const session = yield* bootstrapRemoteBearerSession({
          httpBaseUrl,
          credential,
          clientMetadata: {
            label: "T3 Code Desktop",
            deviceType: "desktop",
          },
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.retry({
            while: isTransientBearerBootstrapError,
            schedule: Schedule.spaced(BOOTSTRAP_TRANSIENT_RETRY_INTERVAL),
          }),
          Effect.timeout(BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new DesktopLocalEnvironmentAuthSessionBootstrapError({
                cause,
              }),
          ),
        );
        const expiresInMs = Number.isFinite(session.expires_in)
          ? Math.max(0, session.expires_in * 1_000)
          : 0;
        yield* Ref.update(tokenRef, (current) => {
          const next = new Map(current);
          next.set(instance.id, {
            httpBaseUrl,
            launchCredential,
            runningDistro: config.runningDistro ?? null,
            token: session.access_token,
            expiresAtEpochMs: issuedAtEpochMs + expiresInMs,
          });
          return next;
        });
        return session.access_token;
      }),
    );
  });

  return DesktopLocalEnvironmentAuth.of({ getBearerToken });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
