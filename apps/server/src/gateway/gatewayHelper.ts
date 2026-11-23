// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off -- Node HTTP and archive plumbing are isolated adapters.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  GATEWAY_HELPER_HEADER,
  GATEWAY_HELPER_PORT,
  GatewayHelperJoinRequest,
  GatewayHelperStatus,
  GatewayHelperUpdateRequest,
  GatewayHelperUpdateState,
} from "@t3tools/contracts";
import {
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  parseChecksums,
} from "@t3tools/shared/cliRelease";
import { T3CODE_REPOSITORY_URL } from "@t3tools/shared/forkRepository";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

import packageJson from "../../package.json" with { type: "json" };
import { GatewayUserName, type GatewayConfig as GatewayConfigType } from "./GatewayConfig.ts";
import { enrollGatewayUser, readGatewayConfig, unenrollGatewayUser } from "./gatewayCliAdmin.ts";
import { lockGatewayPath } from "./gatewayCliAdmin.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { GatewayPlatform, GatewayUserRecord } from "./platform/GatewayPlatform.ts";

const MAX_BODY = 16 * 1024;
const decodeUser = Schema.decodeUnknownOption(GatewayUserName);
const stateSchema = Schema.decodeUnknownOption(GatewayHelperUpdateState);

const errorMessage = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Gateway helper request failed.";
};

export interface GatewayHelperOptions {
  readonly platform: GatewayPlatform;
  readonly configPath: string;
  readonly runtimeVersion?: string;
  readonly run?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
  readonly context?: unknown;
  readonly architecture?: NodeJS.Architecture;
  readonly fetch?: typeof globalThis.fetch;
}

type HelperRun = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  response.end(text);
};

const error = (response: NodeHttp.ServerResponse, status: number, message: string) =>
  json(response, status, { error: message });

const readRequestBody = (request: NodeHttp.IncomingMessage): Promise<Buffer | undefined> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        request.off("data", onData);
        resolve(undefined);
      } else chunks.push(chunk);
    };
    request.on("data", onData);
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("close", () => resolve(undefined));
  });

const parseJson = <A>(schema: Schema.Schema<A>, body: Buffer): A | undefined => {
  try {
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(schema as never)(JSON.parse(body.toString("utf8"))),
    );
  } catch {
    return undefined;
  }
};

const updateStatePath = (configPath: string) =>
  NodePath.join(NodePath.dirname(configPath), ".t3code-gateway-helper", "update.json");

const readState = async (configPath: string) => {
  try {
    return Option.getOrUndefined(
      stateSchema(JSON.parse(await NodeFSP.readFile(updateStatePath(configPath), "utf8"))),
    );
  } catch {
    return undefined;
  }
};

const writeState = async (configPath: string, state: GatewayHelperUpdateState) => {
  const file = updateStatePath(configPath);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o755 });
  await NodeFSP.writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o644 });
};

const identity = async (
  request: NodeHttp.IncomingMessage,
  options: GatewayHelperOptions,
  run: HelperRun,
) => {
  const clientPort = request.socket.remotePort;
  if (clientPort === undefined) return undefined;
  const owner = await run(options.platform.makeConnectionOwner).then((make) =>
    make(clientPort, GATEWAY_HELPER_PORT),
  );
  if (owner === undefined) return undefined;
  const name = await run(options.platform.accountName(owner));
  const user = Option.getOrUndefined(decodeUser(name.toLowerCase()));
  if (user === undefined) return undefined;
  const record = await run(options.platform.lookupUser(user));
  return record.accountId === owner ? record : undefined;
};

const currentStatus = async (
  record: GatewayUserRecord,
  config: GatewayConfigType,
  options: GatewayHelperOptions,
) => {
  const update = await readState(options.configPath);
  const runtimeVersion = options.runtimeVersion ?? packageJson.version;
  const visibleUpdate =
    update !== undefined &&
    parseSemver(runtimeVersion) !== null &&
    parseSemver(update.version) !== null &&
    compareVersion(runtimeVersion, update.version) < 0
      ? update
      : undefined;
  return {
    version: 1 as const,
    runtimeVersion,
    selfService: config.selfService === true,
    joinNeedsPassword: options.platform.joinNeedsPassword,
    user: record.name,
    enrolled:
      Object.hasOwn(config.users, record.name) &&
      config.users[record.name]!.uid === record.accountId,
    ...(Object.hasOwn(config.users, record.name)
      ? { backendPort: config.users[record.name]!.port }
      : {}),
    ...(visibleUpdate === undefined ? {} : { update: visibleUpdate }),
  } satisfies GatewayHelperStatus;
};

const compareVersion = (left: string, right: string) => compareSemverVersions(left, right);

const extract = Effect.fn("GatewayHelper.extract")(function* (
  archive: string,
  destination: string,
  platform: GatewayPlatform,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: cliArchiveTarCommand(platform.name, process.env),
    args:
      platform.name === "win32"
        ? ["-xf", archive, "-C", destination, "--strip-components=1"]
        : [
            "-xzf",
            archive,
            "-C",
            destination,
            "--strip-components=1",
            "--no-same-owner",
            "--no-same-permissions",
          ],
    maxOutputBytes: 64 * 1024,
  });
  if (result.code !== 0) {
    return yield* Effect.die(new Error("archive extraction failed"));
  }
});

const update = async (
  config: GatewayConfigType,
  version: string,
  options: GatewayHelperOptions,
  run: HelperRun,
) => {
  const runtimeVersion = options.runtimeVersion ?? packageJson.version;
  if (parseSemver(version) === null) {
    return { status: 400 as const, message: "Update version must be a semantic version." };
  }
  if (parseSemver(runtimeVersion) === null) {
    return { status: 500 as const, message: "The running runtime has an invalid version." };
  }
  if (compareVersion(version, runtimeVersion) <= 0) return { status: 200 as const, config };
  const previous = await readState(options.configPath);
  if (
    previous?.state === "running" &&
    parseSemver(previous.version) !== null &&
    compareVersion(runtimeVersion, previous.version) < 0
  ) {
    return { status: 409 as const, message: "An update is already in progress." };
  }
  const platformKey = cliArchivePlatformKey(
    platformNodeName(options.platform),
    options.architecture ?? "x64",
  );
  if (platformKey === undefined)
    return { status: 400 as const, message: "No release archive exists for this platform." };
  const baseUrl = config.updates?.baseUrl ?? `${T3CODE_REPOSITORY_URL}/releases/download`;
  const archiveName = cliArchiveFileName(version, platformKey);
  const fetcher = options.fetch ?? globalThis.fetch;
  const staging = await NodeFSP.mkdtemp(
    NodePath.join(options.platform.layout.installRoot, ".helper-staging-"),
  );
  try {
    await run(options.platform.secureDirectory(staging, "admin"));
    let archiveResponse: Response;
    let sumsResponse: Response;
    try {
      archiveResponse = await fetcher(cliReleaseAssetUrl(version, archiveName, baseUrl));
      sumsResponse = await fetcher(cliReleaseAssetUrl(version, "SHA256SUMS", baseUrl));
    } catch {
      return { status: 502 as const, message: "Could not download the update." };
    }
    if (!archiveResponse.ok || !sumsResponse.ok) {
      return { status: 502 as const, message: "Could not download the update." };
    }
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const expected = parseChecksums(await sumsResponse.text()).get(archiveName);
    const actual = NodeCrypto.createHash("sha256").update(archive).digest("hex");
    if (expected === undefined || expected !== actual) {
      return { status: 502 as const, message: "The update checksum did not match." };
    }
    const archivePath = NodePath.join(staging, archiveName);
    await NodeFSP.writeFile(archivePath, archive, { mode: 0o644 });
    await run(extract(archivePath, staging, options.platform));
    const executable = NodePath.join(staging, options.platform.layout.executableName);
    if (
      !(await NodeFSP.stat(executable).then(
        () => true,
        () => false,
      ))
    ) {
      return {
        status: 502 as const,
        message: "The update archive did not contain the gateway executable.",
      };
    }
    await writeState(options.configPath, {
      state: "running",
      version,
      message: "Installing update",
      updatedAt: await run(Clock.currentTimeMillis),
    });
    try {
      await run(
        options.platform.services.runDetached("update", [executable, "gateway", "install"]),
      );
    } catch (cause) {
      const message = errorMessage(cause);
      await writeState(options.configPath, {
        state: "failed",
        version,
        message,
        updatedAt: await run(Clock.currentTimeMillis),
      });
      return { status: 500 as const, message };
    }
    return { status: 202 as const, config };
  } finally {
    // The detached installer owns a successful staging directory. Every failed path removes it.
    // A running state is the only path where the installer may still need the files.
    const state = await readState(options.configPath);
    if (state?.state !== "running" || state.version !== version) {
      await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};

const platformNodeName = (platform: GatewayPlatform): NodeJS.Platform => platform.name;

export const makeGatewayHelperHandler = (options: GatewayHelperOptions) => {
  const run: HelperRun =
    options.run ?? ((effect) => Effect.runPromiseWith(options.context as never)(effect));
  return async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    let requestPassword: string | undefined;
    try {
      if (
        request.headers[GATEWAY_HELPER_HEADER] !== "1" ||
        request.headers.host !== `127.0.0.1:${GATEWAY_HELPER_PORT}`
      ) {
        error(response, 403, "Gateway helper access denied.");
        return;
      }
      if (request.method === "OPTIONS") {
        error(response, 404, "Not found.");
        return;
      }
      if (request.method !== "GET" && request.method !== "POST") {
        error(response, 405, "Method not allowed.");
        return;
      }
      if (
        request.method === "POST" &&
        request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
      ) {
        error(response, 415, "Content-Type must be application/json.");
        return;
      }
      const record = await identity(request, options, run).catch(() => undefined);
      if (record === undefined) {
        error(response, 403, "Could not identify the connecting account.");
        return;
      }
      const config = await run(readGatewayConfig(options.configPath));
      if (request.method === "GET" && request.url === "/v1/status") {
        json(response, 200, await currentStatus(record, config, options));
        return;
      }
      if (
        config.selfService !== true &&
        ["/v1/join", "/v1/leave", "/v1/update"].includes(request.url ?? "")
      ) {
        error(response, 403, "Self-service is disabled for this gateway.");
        return;
      }
      if (request.method !== "POST") {
        error(response, 404, "Not found.");
        return;
      }
      const body = await readRequestBody(request);
      if (body === undefined) {
        error(response, 413, "Request body is too large.");
        return;
      }
      if (request.url === "/v1/join") {
        const input = parseJson(GatewayHelperJoinRequest, body);
        if (input === undefined) return error(response, 400, "Invalid join request.");
        const password = (input as typeof GatewayHelperJoinRequest.Type).password;
        requestPassword = password;
        await run(
          enrollGatewayUser(
            options.platform,
            record.name,
            undefined,
            password === undefined ? undefined : { password },
          ),
        );
        const updated = await run(readGatewayConfig(options.configPath));
        json(response, 200, await currentStatus(record, updated, options));
        return;
      }
      if (request.url === "/v1/leave") {
        if (parseJson(Schema.Struct({}), body) === undefined)
          return error(response, 400, "Invalid leave request.");
        await run(unenrollGatewayUser(options.platform, record.name));
        const updated = await run(readGatewayConfig(options.configPath));
        json(response, 200, await currentStatus(record, updated, options));
        return;
      }
      if (request.url === "/v1/update") {
        const input = parseJson(GatewayHelperUpdateRequest, body);
        if (input === undefined) return error(response, 400, "Invalid update request.");
        const result = await run(
          Effect.scoped(
            lockGatewayPath(options.configPath).pipe(
              Effect.flatMap(() =>
                Effect.promise(() =>
                  update(
                    config,
                    (input as typeof GatewayHelperUpdateRequest.Type).version,
                    options,
                    run,
                  ),
                ),
              ),
            ),
          ),
        );
        if (result.message !== undefined) return error(response, result.status, result.message);
        const updated = await run(readGatewayConfig(options.configPath));
        json(response, result.status, await currentStatus(record, updated, options));
        return;
      }
      error(response, 404, "Not found.");
    } catch (cause) {
      const status =
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        (cause as { readonly _tag?: unknown })._tag === "GatewayCliError"
          ? 400
          : 500;
      const message = errorMessage(cause);
      error(
        response,
        status,
        requestPassword === undefined ? message : message.replaceAll(requestPassword, "[redacted]"),
      );
    }
  };
};

export const serveGatewayHelper = Effect.fn("GatewayHelper.serve")(function* (
  options: GatewayHelperOptions,
  socket?: NodeNet.Socket,
) {
  const handler = makeGatewayHelperHandler(options);
  if (socket !== undefined) {
    const server = NodeHttp.createServer(handler);
    yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.once("close", resolve);
            server.emit("connection", socket);
          }),
      ),
      () => Effect.sync(() => server.close()),
    );
    return;
  }
  const server = NodeHttp.createServer(handler);
  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(GATEWAY_HELPER_PORT, "127.0.0.1", () => resolve());
        }),
    ),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
});

export const gatewayHelperFromStdin = Effect.fn("GatewayHelper.stdin")(function* (
  options: GatewayHelperOptions,
) {
  const socket = new NodeNet.Socket({ fd: 0 });
  const server = NodeHttp.createServer(makeGatewayHelperHandler(options));
  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          socket.once("close", resolve);
          server.emit("connection", socket);
        }),
    ),
    () =>
      Effect.sync(() => {
        server.close();
        socket.destroy();
      }),
  );
});
