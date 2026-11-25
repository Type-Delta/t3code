// @effect-diagnostics nodeBuiltinImport:off -- inetd-style sockets need node:http; Effect has no incremental digest.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import {
  GATEWAY_HELPER_HEADER,
  GATEWAY_HELPER_STAGE_TIMEOUT_MS,
  GATEWAY_HELPER_PORT,
  GatewayHelperError,
  GatewayHelperJoinRequest,
  GatewayHelperStatus,
  GatewayHelperUpdateRequest,
  GatewayHelperUpdateState,
} from "@t3tools/contracts";
import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  parseChecksums,
} from "@t3tools/shared/cliRelease";
import { T3CODE_REPOSITORY_URL } from "@t3tools/shared/forkRepository";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { GatewayUserName, type GatewayConfig } from "./GatewayConfig.ts";
import {
  enrollGatewayUser,
  GatewayCliError,
  lockGatewayPath,
  readGatewayConfig,
  unenrollGatewayUser,
} from "./gatewayCliAdmin.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  type ConnectionOwner,
  GatewayPlatformError,
  type GatewayPlatform,
  type GatewayPlatformServices,
  type GatewayUserRecord,
} from "./platform/GatewayPlatform.ts";

/** A helper answer other than 2xx; `message` is safe to send to the caller. */
class GatewayHelperRequestError extends Schema.TaggedError<
  GatewayHelperRequestError,
  { readonly brand: unique symbol }
>()("GatewayHelperRequestError", { status: Schema.Int, message: Schema.String }) {}

interface GatewayHelperOptions {
  readonly platform: GatewayPlatform;
  readonly configPath: string;
  /** Defaults to this binary's version. */
  readonly runtimeVersion?: string;
  /** Windows: decrypts join passwords, which desktop apps encrypt to the published public key. */
  readonly passwordKey?: NodeCrypto.KeyObject;
}

type GatewayHelperServices = GatewayPlatformServices | HttpClient.HttpClient;

interface HelperRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly clientPort: number | undefined;
  readonly body: Effect.Effect<string, GatewayHelperRequestError>;
}

const MAX_BODY_BYTES = 16 * 1024;
const ROUTES = new Set(["GET /v1/status", "POST /v1/join", "POST /v1/leave", "POST /v1/update"]);

const fail = (status: number, message: string) =>
  Effect.fail(new GatewayHelperRequestError({ status, message }));
const decodeUserName = Schema.decodeUnknownOption(GatewayUserName);
const decodeJoin = Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayHelperJoinRequest));
const decodeLeave = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({})));
const decodeUpdate = Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayHelperUpdateRequest));
const updateStateJson = Schema.fromJsonString(GatewayHelperUpdateState);
const decodeUpdateState = Schema.decodeUnknownOption(updateStateJson);
const encodeUpdateState = Schema.encodeSync(updateStateJson);
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(GatewayHelperStatus));
const encodeError = Schema.encodeSync(Schema.fromJsonString(GatewayHelperError));
const isRequestError = Schema.is(GatewayHelperRequestError);
const isCliError = Schema.is(GatewayCliError);
const isPlatformError = Schema.is(GatewayPlatformError);

const isNewer = (version: string, than: string) =>
  parseSemver(version) !== null &&
  parseSemver(than) !== null &&
  compareSemverVersions(version, than) > 0;

// `gateway install` deletes this file once the new runtime is active.
export const updateStatePath = (path: Path.Path, configPath: string) =>
  path.join(path.dirname(configPath), ".t3code-gateway-helper", "update.json");

export const readUpdateState = Effect.fn("GatewayHelper.readUpdateState")(function* (
  configPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs.readFileString(updateStatePath(path, configPath)).pipe(Effect.option);
  return Option.getOrUndefined(Option.flatMap(contents, decodeUpdateState));
});

export const writeUpdateState = Effect.fn("GatewayHelper.writeUpdateState")(function* (
  configPath: string,
  state: GatewayHelperUpdateState["state"],
  version: string,
  message: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const updatedAt = yield* Clock.currentTimeMillis;
  const statePath = updateStatePath(path, configPath);
  // Renamed into place, so a status read never sees a half-written claim and drops it.
  const staged = `${statePath}.${process.pid}.tmp`;
  yield* fs.writeFileString(
    staged,
    `${encodeUpdateState({ state, version, message, updatedAt })}\n`,
    {
      mode: 0o644,
    },
  );
  // Windows refuses a rename while another process, such as a scanner, has either file open.
  yield* fs
    .rename(staged, statePath)
    .pipe(Effect.retry({ times: 5, schedule: Schedule.spaced("100 millis") }));
});

const callerUnknown = new GatewayHelperRequestError({
  status: 403,
  message: "Could not identify the connecting account.",
});

/** The account behind the connecting socket, as a gateway user whose OS record names the same account. */
const identifyCaller = Effect.fn("GatewayHelper.identifyCaller")(
  function* (
    platform: GatewayPlatform,
    connectionOwner: ConnectionOwner,
    clientPort: number | undefined,
  ) {
    if (clientPort === undefined) return yield* callerUnknown;
    const accountId = yield* Effect.promise(() => connectionOwner(clientPort, GATEWAY_HELPER_PORT));
    if (accountId === undefined) return yield* callerUnknown;
    const name = decodeUserName((yield* platform.accountName(accountId)).toLowerCase());
    if (Option.isNone(name)) return yield* callerUnknown;
    const record = yield* platform.lookupUser(name.value);
    if (record.accountId !== accountId) return yield* callerUnknown;
    return record;
  },
  Effect.mapError(() => callerUnknown),
);

const helperStatus = Effect.fn("GatewayHelper.status")(function* (
  options: GatewayHelperOptions,
  caller: GatewayUserRecord,
) {
  const config = yield* readGatewayConfig(options.configPath);
  const update = yield* readUpdateState(options.configPath);
  const runtimeVersion = options.runtimeVersion ?? packageJson.version;
  const entry = Object.hasOwn(config.users, caller.name) ? config.users[caller.name] : undefined;
  const backendPort = entry?.uid === caller.accountId ? entry.port : undefined;
  // An update to this helper's own version is still restarting backends until the install settles it.
  // A running claim older than the stale limit belongs to an install that died.
  const fresh =
    update !== undefined && (yield* Clock.currentTimeMillis) - update.updatedAt < STALE_UPDATE_MS;
  const showUpdate =
    update !== undefined &&
    ((isNewer(update.version, runtimeVersion) && (update.state === "failed" || fresh)) ||
      (update.version === runtimeVersion && fresh));
  return {
    version: 1,
    runtimeVersion,
    selfService: config.selfService === true,
    joinNeedsPassword: options.platform.joinNeedsPassword,
    user: caller.name,
    enrolled: backendPort !== undefined,
    ...(backendPort === undefined ? {} : { backendPort }),
    ...(showUpdate ? { update } : {}),
  } satisfies GatewayHelperStatus;
});

const downloadFailed = () =>
  new GatewayHelperRequestError({ status: 502, message: "Could not download the update." });

const download = Effect.fn("GatewayHelper.download")(function* (url: string) {
  const http = yield* HttpClient.HttpClient;
  return yield* http
    .execute(HttpClientRequest.get(url))
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
});

/** Downloads, verifies and extracts release `version` into `staging`; returns its executable. */
const stageRelease = Effect.fn("GatewayHelper.stageRelease")(function* (
  platform: GatewayPlatform,
  config: GatewayConfig,
  version: string,
  staging: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platformKey = cliArchivePlatformKey(platform.name, yield* HostProcess.Architecture);
  if (platformKey === undefined) {
    return yield* fail(400, "No release archive exists for this platform.");
  }
  const baseUrl = config.updates?.baseUrl ?? `${T3CODE_REPOSITORY_URL}/releases/download`;
  const archiveName = cliArchiveFileName(version, platformKey);
  const archive = path.join(staging, archiveName);

  const checksums = yield* download(
    cliReleaseAssetUrl(version, CLI_RELEASE_CHECKSUMS_FILE, baseUrl),
  ).pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError(downloadFailed),
  );
  const hash = NodeCrypto.createHash("sha256");
  yield* download(cliReleaseAssetUrl(version, archiveName, baseUrl)).pipe(
    Effect.flatMap((response) =>
      response.stream.pipe(
        Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))),
        Stream.run(fs.sink(archive, { flag: "wx" })),
      ),
    ),
    Effect.mapError(downloadFailed),
  );
  if (parseChecksums(checksums).get(archiveName) !== hash.digest("hex")) {
    return yield* fail(502, "The update checksum did not match.");
  }

  const result = yield* runner
    .run({
      command: cliArchiveTarCommand(platform.name, yield* HostProcess.Environment),
      args:
        platform.name === "win32"
          ? ["-xf", archive, "-C", staging, "--strip-components=1"]
          : [
              "-xzf",
              archive,
              "-C",
              staging,
              "--strip-components=1",
              "--no-same-owner",
              "--no-same-permissions",
            ],
      timeout: "5 minutes",
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
    })
    .pipe(Effect.option);
  if (Option.isNone(result) || result.value.code !== 0) {
    return yield* fail(502, "Could not extract the update.");
  }
  yield* fs.remove(archive);
  const executable = path.join(staging, platform.layout.executableName);
  if (!(yield* fs.exists(executable))) {
    return yield* fail(502, "The update archive did not contain the gateway executable.");
  }
  return executable;
});

export const STALE_UPDATE_MS = 30 * 60 * 1000;

/** Marks this version's claim as installing, only while it still holds it. */
const advanceUpdateClaim = Effect.fn("GatewayHelper.advanceUpdateClaim")(function* (
  configPath: string,
  version: string,
) {
  const path = yield* Path.Path;
  yield* lockGatewayPath(updateStatePath(path, configPath));
  const claim = yield* readUpdateState(configPath);
  if (claim?.state !== "running" || claim.version !== version) return false;
  yield* writeUpdateState(configPath, "running", version, "Installing update");
  return true;
}, Effect.scoped);

/** Ends this version's update claim if it still holds it: as failed with a reason, or by clearing it. */
export const settleUpdateClaim = Effect.fn("GatewayHelper.settleUpdateClaim")(function* (
  configPath: string,
  version: string,
  failure: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = updateStatePath(path, configPath);
  yield* lockGatewayPath(statePath);
  const claim = yield* readUpdateState(configPath);
  if (claim?.state !== "running" || claim.version !== version) return;
  if (failure === undefined) yield* fs.remove(statePath, { force: true });
  else yield* writeUpdateState(configPath, "failed", version, failure);
}, Effect.scoped);

/** Where the Windows gateway publishes the key desktop apps encrypt join passwords to. */
export const helperKeyPath = (path: Pick<Path.Path, "dirname" | "join">, configPath: string) =>
  path.join(path.dirname(configPath), ".t3code-gateway-helper", "helper-key.pem");

export const publishHelperKey = Effect.fn("GatewayHelper.publishKey")(function* (
  platform: GatewayPlatform,
  configPath: string,
  publicKey: NodeCrypto.KeyObject,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = helperKeyPath(path, configPath);
  yield* platform.secureDirectory(path.dirname(file), "admin");
  yield* fs.writeFileString(file, publicKey.export({ type: "spki", format: "pem" }).toString());
});

/** Anyone can listen on the helper port while the gateway restarts, so passwords travel encrypted. */
const decryptPassword = (key: NodeCrypto.KeyObject | undefined, encrypted: string) =>
  key === undefined
    ? fail(400, "This gateway takes no password.")
    : Effect.try({
        try: () =>
          NodeCrypto.privateDecrypt(
            { key, oaepHash: "sha256" },
            Buffer.from(encrypted, "base64"),
          ).toString("utf8"),
        catch: () =>
          new GatewayHelperRequestError({
            status: 400,
            message: "Shared T3 Code could not read the password. Try again.",
          }),
      });

/** Claims the single update slot. False when this same update is already running; fails while another is. */
const claimUpdate = Effect.fn("GatewayHelper.claimUpdate")(function* (
  options: GatewayHelperOptions,
  version: string,
  runtimeVersion: string,
) {
  const path = yield* Path.Path;
  const statePath = updateStatePath(path, options.configPath);
  yield* options.platform.secureDirectory(path.dirname(statePath), "admin");
  yield* lockGatewayPath(statePath);
  const previous = yield* readUpdateState(options.configPath);
  const now = yield* Clock.currentTimeMillis;
  // A detached install that died never clears its state; stop it blocking updates forever.
  if (
    previous?.state === "running" &&
    // An update to this helper's own version may still be restarting backends.
    parseSemver(previous.version) !== null &&
    compareSemverVersions(previous.version, runtimeVersion) >= 0 &&
    now - previous.updatedAt < STALE_UPDATE_MS
  ) {
    if (previous.version === version) return false;
    return yield* fail(409, `An update to ${previous.version} is already in progress.`);
  }
  yield* writeUpdateState(options.configPath, "running", version, "Downloading update");
  return true;
}, Effect.scoped);

const updateRuntime = Effect.fn("GatewayHelper.update")(function* (
  options: GatewayHelperOptions,
  config: GatewayConfig,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { platform } = options;
  const runtimeVersion = options.runtimeVersion ?? packageJson.version;
  // The version becomes part of a file name, so build metadata and path characters are refused.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || parseSemver(version) === null) {
    return yield* fail(400, "Update version must be a semantic version.");
  }
  const order = compareSemverVersions(version, runtimeVersion);
  if (order === 0) return 200;
  if (order < 0) {
    return yield* fail(400, `The shared runtime ${runtimeVersion} is newer than ${version}.`);
  }
  if (!(yield* claimUpdate(options, version, runtimeVersion))) return 202;
  yield* Effect.gen(function* () {
    const staging = yield* fs.makeTempDirectory({
      directory: platform.layout.installRoot,
      prefix: ".helper-staging-",
    });
    // A started installer owns the staging directory; `gateway install` prunes it.
    yield* Effect.gen(function* () {
      yield* platform.secureDirectory(staging, "admin");
      const executable = yield* stageRelease(platform, config, version, staging).pipe(
        Effect.timeoutOrElse({
          duration: GATEWAY_HELPER_STAGE_TIMEOUT_MS,
          orElse: () => fail(504, "Downloading the update took too long."),
        }),
      );
      // An install that finished during the download cleared the claim and pruned staging.
      if (!(yield* advanceUpdateClaim(options.configPath, version))) {
        return yield* fail(409, `Another install replaced the update to ${version}.`);
      }
      yield* platform.services.runDetached("update", [executable, "gateway", "install"]).pipe(
        Effect.mapError(
          (error) =>
            new GatewayHelperRequestError({
              status: 500,
              message: `Could not start the update: ${error.message}`,
            }),
        ),
      );
    }).pipe(
      Effect.onError(() =>
        fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  }).pipe(
    Effect.onError((cause) => {
      const error = Cause.squash(cause);
      const message = isRequestError(error) ? error.message : "The update failed.";
      return settleUpdateClaim(options.configPath, version, message).pipe(Effect.ignore);
    }),
  );
  return 202;
});

/** The answer for any failure. Known gateway errors keep their message; others are logged. */
const failureResponse = Effect.fn("GatewayHelper.failureResponse")(function* (
  cause: Cause.Cause<unknown>,
  secret?: string,
) {
  const scrub = (text: string) =>
    secret === undefined || secret === "" ? text : text.replaceAll(secret, "[redacted]");
  const error = Cause.squash(cause);
  if (isRequestError(error)) return error;
  if (isCliError(error) || isPlatformError(error)) {
    return new GatewayHelperRequestError({ status: 400, message: scrub(error.message) });
  }
  yield* Effect.logError(`Gateway helper request failed: ${scrub(Cause.pretty(cause))}`);
  return new GatewayHelperRequestError({ status: 500, message: "Gateway helper request failed." });
});

const handleRequest = Effect.fn("GatewayHelper.handle")(function* (
  options: GatewayHelperOptions,
  connectionOwner: ConnectionOwner,
  request: HelperRequest,
) {
  const { platform } = options;
  if (request.method === "OPTIONS") return yield* fail(404, "Not found.");
  if (
    request.headers[GATEWAY_HELPER_HEADER] !== "1" ||
    request.headers.host !== `127.0.0.1:${GATEWAY_HELPER_PORT}`
  ) {
    return yield* fail(403, "Gateway helper access denied.");
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return yield* fail(405, "Method not allowed.");
  }
  if (!ROUTES.has(`${request.method} ${request.url}`)) return yield* fail(404, "Not found.");
  if (
    request.method === "POST" &&
    request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json"
  ) {
    return yield* fail(415, "Content-Type must be application/json.");
  }
  const caller = yield* identifyCaller(platform, connectionOwner, request.clientPort);
  const answer = (status: number) =>
    Effect.map(helperStatus(options, caller), (body) => ({ status, text: encodeStatus(body) }));
  if (request.method === "GET") return yield* answer(200);

  const config = yield* readGatewayConfig(options.configPath);
  if (config.selfService !== true) {
    return yield* fail(403, "Self-service is disabled for this gateway.");
  }
  const body = yield* request.body;
  switch (request.url) {
    case "/v1/join": {
      const { encryptedPassword } = yield* decodeJoin(body).pipe(
        Effect.mapError(
          () => new GatewayHelperRequestError({ status: 400, message: "Invalid join request." }),
        ),
      );
      const password =
        encryptedPassword === undefined
          ? undefined
          : yield* decryptPassword(options.passwordKey, encryptedPassword);
      if (password === undefined && platform.joinNeedsPassword) {
        // Without one, Windows registration would wait on the gateway's own console for it.
        if (Object.hasOwn(config.users, caller.name)) return yield* answer(200);
        return yield* fail(400, "Joining needs your Windows password.");
      }
      // An admin's retry repairs a partial enrollment; a member would only see an absent backend.
      yield* enrollGatewayUser(platform, caller.name, undefined, {
        rollbackNew: true,
        ...(password === undefined ? {} : { password }),
      }).pipe(Effect.catchCause((cause) => Effect.flip(failureResponse(cause, password))));
      return yield* answer(200);
    }
    case "/v1/leave": {
      yield* decodeLeave(body).pipe(
        Effect.mapError(
          () => new GatewayHelperRequestError({ status: 400, message: "Invalid leave request." }),
        ),
      );
      yield* unenrollGatewayUser(platform, caller.name, { member: caller.accountId });
      return yield* answer(200);
    }
    default: {
      const { version } = yield* decodeUpdate(body).pipe(
        Effect.mapError(
          () => new GatewayHelperRequestError({ status: 400, message: "Invalid update request." }),
        ),
      );
      return yield* answer(yield* updateRuntime(options, config, version));
    }
  }
});

// Node HTTP boundary: everything below only moves bytes between sockets and handleRequest.

const readBody = (request: NodeHttp.IncomingMessage) =>
  Effect.callback<string, GatewayHelperRequestError>((resume) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    // Past the limit, keep draining so the connection can still carry the 413.
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) resume(fail(413, "Request body is too large."));
      else chunks.push(chunk);
    });
    request.once("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))));
    request.once("close", () => resume(fail(400, "The request body was not completed.")));
  });

const makeHandler = Effect.fn("GatewayHelper.makeHandler")(function* (
  options: GatewayHelperOptions,
) {
  const connectionOwner = yield* options.platform.makeConnectionOwner;
  const runFork = Effect.runForkWith(yield* Effect.context<GatewayHelperServices>());
  return (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    runFork(
      handleRequest(options, connectionOwner, {
        method: request.method,
        url: request.url,
        headers: request.headers,
        clientPort: request.socket.remotePort,
        body: readBody(request),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.map(failureResponse(cause), ({ status, message }) => ({
            status,
            text: encodeError({ error: message }),
          })),
        ),
        Effect.flatMap(({ status, text }) =>
          Effect.sync(() => {
            response.writeHead(status, {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(text),
              // One request per connection: a kept-alive connection would keep reaching the helper
              // process that answered it, which still reports the runtime it ran before an update.
              connection: "close",
            });
            response.end(text);
          }),
        ),
      ),
    );
  };
});

/** Serves helper requests on 127.0.0.1:`port` for the scope's lifetime; returns the bound port. */
export const listenGatewayHelper = Effect.fn("GatewayHelper.listen")(function* (
  options: GatewayHelperOptions,
  port = GATEWAY_HELPER_PORT,
) {
  const server = NodeHttp.createServer(yield* makeHandler(options));
  return yield* Effect.acquireRelease(
    Effect.callback<number, GatewayPlatformError>((resume) => {
      const listenFailed = (reason: string) =>
        resume(
          Effect.fail(
            new GatewayPlatformError({
              message: `Could not listen on 127.0.0.1:${port}: ${reason}`,
            }),
          ),
        );
      server.once("error", (error) => listenFailed(error.message));
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address !== null) resume(Effect.succeed(address.port));
        else listenFailed("no address");
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );
});

/** Serves the one connection an inetd-style service passed as fd 0, until it closes. */
export const gatewayHelperFromStdin = Effect.fn("GatewayHelper.stdin")(function* (
  options: GatewayHelperOptions,
) {
  const server = NodeHttp.createServer(yield* makeHandler(options));
  const socket = new NodeNet.Socket({ fd: 0 });
  yield* Effect.callback<void>((resume) => {
    socket.once("close", () => resume(Effect.void));
    server.emit("connection", socket);
    return Effect.sync(() => socket.destroy());
  });
});
