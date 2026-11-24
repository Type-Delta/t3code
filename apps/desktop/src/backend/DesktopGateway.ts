// @effect-diagnostics nodeBuiltinImport:off - Encrypts the Windows join password to the gateway's key.
import * as NodeCrypto from "node:crypto";

import {
  GATEWAY_HELPER_HEADER,
  GATEWAY_HELPER_PORT,
  GATEWAY_HELPER_STAGE_TIMEOUT_MS,
  GatewayHelperError,
  GatewayHelperStatus,
} from "@t3tools/contracts";
import { gatewayHostFiles } from "@t3tools/shared/gatewayHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopHomeOwner from "./DesktopHomeOwner.ts";

// Fork-only (FORK.md, gateway self-service): the desktop side of shared T3 Code. The privileged
// helper on loopback says whether this account is enrolled; an enrolled app uses the account's
// gateway-managed backend instead of starting its own.

const HELPER_URL = `http://127.0.0.1:${GATEWAY_HELPER_PORT}`;
// Without a gateway the connection is refused at once; on Windows the helper names the caller with
// netstat and tasklist, which took over 1.5 s while the app was starting.
const STATUS_TIMEOUT = Duration.seconds(10);
// Joining registers OS services (on Windows a scheduled task), which can take a while.
const CHANGE_TIMEOUT = Duration.seconds(60);
const UPDATE_REQUEST_TIMEOUT = Duration.sum(
  Duration.millis(GATEWAY_HELPER_STAGE_TIMEOUT_MS),
  Duration.minutes(1),
);
// Another app's update may still be downloading when this one asks for the same version.
const UPDATE_TIMEOUT = Duration.sum(
  Duration.millis(GATEWAY_HELPER_STAGE_TIMEOUT_MS),
  Duration.minutes(5),
);
const UPDATE_POLL_INTERVAL = Duration.seconds(1);
// A backend just enrolled or updated may be restarting; Windows retries its task once a minute.
const ATTACH_READY_TIMEOUT = Duration.minutes(3);
const PAIR_TIMEOUT = Duration.seconds(30);
const PAIR_LABEL = "T3 Code desktop";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-gateway");

class DesktopGatewayError extends Schema.TaggedError<DesktopGatewayError>()("DesktopGatewayError", {
  operation: Schema.Literals(["join", "leave", "update", "pair"]),
  /** Plain text for the user: the helper's own error, or a fixed description. */
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const decodeStatus = Schema.decodeUnknownOption(GatewayHelperStatus);
const decodeHelperError = Schema.decodeUnknownOption(GatewayHelperError);

/** Whether startup should move the shared runtime up to this app's version first. */
export const shouldUpdateSharedRuntime = (
  status: GatewayHelperStatus,
  appVersion: string,
): boolean =>
  status.enrolled &&
  status.selfService &&
  parseSemver(appVersion) !== null &&
  parseSemver(status.runtimeVersion) !== null &&
  compareSemverVersions(appVersion, status.runtimeVersion) > 0;

/** How a requested runtime update stands in a status answer. */
const sharedRuntimeUpdateProgress = (
  status: GatewayHelperStatus,
  version: string,
): "done" | "failed" | "running" =>
  compareSemverVersions(status.runtimeVersion, version) >= 0
    ? "done"
    : status.update?.state === "failed" && status.update.version === version
      ? "failed"
      : "running";

/**
 * Arguments for the shared runtime's CLI that mint a one-time token on the backend serving `baseDir`.
 * Its default scopes are its server's standard ones; naming this app's could list one it lacks.
 */
export const pairCommandArgs = (baseDir: string): ReadonlyArray<string> => [
  "pair",
  "--base-dir",
  baseDir,
  "--label",
  PAIR_LABEL,
];

export const parsePairToken = (output: string): Option.Option<string> =>
  Option.fromNullishOr(/^Token: (\S+)$/m.exec(output)?.[1]);

/** The administrator's gateway install, seen from a desktop app. */
export class DesktopGatewayHost extends Context.Service<
  DesktopGatewayHost,
  {
    /**
     * Whether an administrator installed a gateway here. Any local account can listen on the helper
     * port where none holds it, so the app asks the helper nothing otherwise.
     */
    readonly trusted: Effect.Effect<boolean>;
    /** The shared runtime's CLI. Its tokens suit its backends whatever this app's version. */
    readonly runtimeExecutable: string;
    /**
     * Windows: the join password encrypted to the key only the gateway process holds, since anyone can
     * listen on the helper port while the gateway restarts.
     */
    readonly encryptPassword: (password: string) => Effect.Effect<string, DesktopGatewayError>;
  }
>()("@t3tools/desktop/backend/DesktopGateway/DesktopGatewayHost") {}

export const hostLayer = Layer.effect(
  DesktopGatewayHost,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const files = gatewayHostFiles(environment.platform, yield* HostProcess.Environment);
    const notReady = (cause?: unknown) =>
      new DesktopGatewayError({
        operation: "join",
        reason: "Shared T3 Code is not ready to take a password. Try again in a minute.",
        ...(cause === undefined ? {} : { cause }),
      });
    return DesktopGatewayHost.of({
      trusted: Effect.gen(function* () {
        if (files === undefined) return false;
        const link = yield* fileSystem.lstat(files.currentLink);
        // Only administrators can create entries under Program Files.
        return environment.platform === "win32" || Option.getOrUndefined(link.uid) === 0;
      }).pipe(Effect.orElseSucceed(() => false)),
      runtimeExecutable: files?.runtimeExecutable ?? "",
      encryptPassword: Effect.fn("DesktopGatewayHost.encryptPassword")(function* (password) {
        if (files?.helperKeyFile === undefined) return yield* notReady();
        // RSA-OAEP with SHA-256 and a 2048-bit key fits 190 bytes.
        if (Buffer.byteLength(password) > 190) {
          return yield* new DesktopGatewayError({
            operation: "join",
            reason: "This password is too long for shared T3 Code to take.",
          });
        }
        const key = yield* fileSystem
          .readFileString(files.helperKeyFile)
          .pipe(Effect.mapError(notReady));
        return yield* Effect.try({
          try: () =>
            NodeCrypto.publicEncrypt({ key, oaepHash: "sha256" }, Buffer.from(password)).toString(
              "base64",
            ),
          catch: notReady,
        });
      }),
    });
  }),
);

export class DesktopGateway extends Context.Service<
  DesktopGateway,
  {
    /** None when there is no helper or it answers with anything but a valid status. */
    readonly status: Effect.Effect<Option.Option<GatewayHelperStatus>>;
    readonly join: (password?: string) => Effect.Effect<GatewayHelperStatus, DesktopGatewayError>;
    readonly leave: Effect.Effect<GatewayHelperStatus, DesktopGatewayError>;
    /** Requests the update and waits until the runtime reaches `version` or the helper gives up. */
    readonly updateRuntime: (
      version: string,
    ) => Effect.Effect<GatewayHelperStatus, DesktopGatewayError>;
    /** A one-time token for this account's T3 home, only when the server holding it listens on `port`. */
    readonly mintPairingToken: (port: number) => Effect.Effect<string, DesktopGatewayError>;
    /** Set once startup uses the shared backend for this launch. */
    readonly attached: Ref.Ref<boolean>;
  }
>()("@t3tools/desktop/backend/DesktopGateway") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const host = yield* DesktopGatewayHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const attached = yield* Ref.make(false);

  const send = (request: HttpClientRequest.HttpClientRequest, timeout: Duration.Duration) =>
    host.trusted.pipe(
      Effect.flatMap((trusted) =>
        trusted
          ? Effect.void
          : Effect.fail(new Cause.NoSuchElementError("No shared T3 Code is installed here.")),
      ),
      Effect.andThen(
        httpClient.execute(request.pipe(HttpClientRequest.setHeader(GATEWAY_HELPER_HEADER, "1"))),
      ),
      Effect.flatMap((response) =>
        response.json.pipe(Effect.map((body) => ({ status: response.status, body }))),
      ),
      Effect.timeout(timeout),
    );

  const status = send(HttpClientRequest.get(`${HELPER_URL}/v1/status`), STATUS_TIMEOUT).pipe(
    Effect.map(({ status, body }) => (status === 200 ? decodeStatus(body) : Option.none())),
    Effect.orElseSucceed(() => Option.none<GatewayHelperStatus>()),
  );

  const change = Effect.fn("DesktopGateway.change")(function* (
    operation: "join" | "leave" | "update",
    body: object,
  ) {
    const fail = (reason: string, cause?: unknown) =>
      new DesktopGatewayError({ operation, reason, ...(cause === undefined ? {} : { cause }) });
    const response = yield* send(
      HttpClientRequest.post(`${HELPER_URL}/v1/${operation}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
      // The helper downloads and stages the whole update before it answers.
      operation === "update" ? UPDATE_REQUEST_TIMEOUT : CHANGE_TIMEOUT,
    ).pipe(Effect.mapError((cause) => fail("Shared T3 Code did not answer.", cause)));
    if (response.status < 200 || response.status >= 300) {
      return yield* fail(
        Option.match(decodeHelperError(response.body), {
          onNone: () => `Shared T3 Code refused the request (HTTP ${response.status}).`,
          onSome: ({ error }) => error,
        }),
      );
    }
    return yield* Effect.fromOption(decodeStatus(response.body)).pipe(
      Effect.mapError(() => fail("Shared T3 Code sent an answer this app cannot read.")),
    );
  });

  const updateRuntime = Effect.fn("DesktopGateway.updateRuntime")(function* (version: string) {
    const fail = (reason: string) => new DesktopGatewayError({ operation: "update", reason });
    yield* change("update", { version });
    const settled = yield* status.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(UPDATE_POLL_INTERVAL),
        until: (current) =>
          Option.isSome(current) &&
          sharedRuntimeUpdateProgress(current.value, version) !== "running",
      }),
      Effect.timeoutOption(UPDATE_TIMEOUT),
      Effect.map(Option.flatten),
    );
    if (Option.isNone(settled)) return yield* fail("The shared T3 Code update timed out.");
    if (sharedRuntimeUpdateProgress(settled.value, version) === "failed") {
      return yield* fail(settled.value.update?.message ?? "The shared T3 Code update failed.");
    }
    return settled.value;
  });

  const mintPairingToken = Effect.fn("DesktopGateway.mintPairingToken")(function* (port: number) {
    const fail = (reason: string, cause?: unknown) =>
      new DesktopGatewayError({
        operation: "pair",
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    // Any local account can answer on the helper's port while the gateway restarts, so the token
    // goes only to the server that holds this T3 home.
    const owner = yield* DesktopHomeOwner.readLockedHomeOwner().pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (Option.isNone(owner) || owner.value.port !== port) {
      return yield* fail("The server holding this T3 home is not on the shared port.");
    }
    // This app's own CLI could need a database migration that an older shared server blocks.
    const output = yield* spawner
      .string(
        ChildProcess.make(host.runtimeExecutable, pairCommandArgs(environment.baseDir), {
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.timeout(PAIR_TIMEOUT),
        Effect.mapError((cause) => fail("Could not run t3 pair for the shared server.", cause)),
      );
    return yield* Effect.fromOption(parsePairToken(output)).pipe(
      Effect.mapError(() => fail("t3 pair did not print a token for the shared server.")),
    );
  });

  return DesktopGateway.of({
    status,
    join: Effect.fn("DesktopGateway.join")(function* (password?: string) {
      if (password === undefined) return yield* change("join", {});
      return yield* change("join", { encryptedPassword: yield* host.encryptPassword(password) });
    }),
    leave: change("leave", {}),
    updateRuntime,
    mintPairingToken,
    attached,
  });
});

export const layer = Layer.effect(DesktopGateway, make);

/**
 * Before the local backend starts: when this account is enrolled, update the shared runtime to the
 * app's version if allowed, then use the account's shared backend. "local" means start the app's
 * own backend; "quit" means that is unsafe because the shared backend still holds the T3 home.
 */
export const attachAtStartup = Effect.fn("desktop.gateway.attachAtStartup")(function* () {
  const gateway = yield* DesktopGateway;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const found = yield* gateway.status;
  if (Option.isNone(found) || !found.value.enrolled) return "local" as const;
  let status = found.value;
  yield* logInfo("this account uses shared T3 Code", {
    runtimeVersion: status.runtimeVersion,
    backendPort: status.backendPort ?? null,
  });
  yield* (yield* DesktopWindow.DesktopWindow).showConnectingSplash("Connecting to shared T3 Code…");

  if (shouldUpdateSharedRuntime(status, environment.appVersion)) {
    status = yield* gateway.updateRuntime(environment.appVersion).pipe(
      Effect.catch((error) =>
        logWarning("shared runtime update failed; staying on the current one", {
          reason: error.reason,
        }).pipe(
          Effect.andThen(
            dialog.showErrorBox(
              "Shared T3 Code was not updated",
              `${error.reason}\n\nT3 Code will keep using version ${status.runtimeVersion} for now.`,
            ),
          ),
          Effect.andThen(gateway.status),
          Effect.map(Option.getOrElse(() => status)),
        ),
      ),
    );
  }

  const failure = yield* Effect.gen(function* () {
    if (status.backendPort === undefined) return "Shared T3 Code has no server for this account.";
    const port = status.backendPort;
    const httpBaseUrl = new URL(`http://127.0.0.1:${port}/`);
    // Minting proves the shared server serves this T3 home before the app commits to it.
    const credential = yield* gateway
      .mintPairingToken(port)
      .pipe(
        Effect.retry({ schedule: Schedule.spaced(Duration.seconds(2)) }),
        Effect.timeoutOption(ATTACH_READY_TIMEOUT),
      );
    if (Option.isNone(credential))
      return "The shared T3 Code server for this account did not answer.";
    // The first session uses the token that proved the server; later ones mint their own.
    const unused = yield* Ref.make<Option.Option<string>>(credential);
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    yield* pool.attachPrimary({
      httpBaseUrl,
      mintCredential: Ref.getAndSet(unused, Option.none()).pipe(
        Effect.flatMap((token) =>
          Option.isSome(token) ? Effect.succeed(token.value) : gateway.mintPairingToken(port),
        ),
      ),
    });
    yield* Ref.set(gateway.attached, true);
    yield* (yield* pool.primary).start;
    return null;
  });
  if (failure === null) return "attached" as const;

  // A home the shared backend still holds would make the app's own backend fail or fight it.
  if (!(yield* DesktopHomeOwner.awaitHomeOwnershipRelease())) {
    yield* dialog.showErrorBox(
      "Couldn't open shared T3 Code",
      `${failure}\n\nIts server is still using your T3 Code data, so this app cannot start its own. Try again in a minute.`,
    );
    return "quit" as const;
  }
  yield* dialog.showErrorBox(
    "Couldn't open shared T3 Code",
    `${failure}\n\nT3 Code will use its own server for now.`,
  );
  return "local" as const;
});
