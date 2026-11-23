import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { acquireServiceSelectionLock } from "../cloud/serviceSelectionLock.ts";
import {
  emptyGatewayConfig,
  GATEWAY_BACKEND_PORT_RANGE,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_PAIRING_DIR_ENV,
  GatewayConfig,
  type GatewayAccountId,
} from "./GatewayConfig.ts";
import { acquireWindowsGatewayLock } from "./gatewayLock.ts";
import type { GatewayPlatform } from "./platform/GatewayPlatform.ts";

export class GatewayCliError extends Schema.TaggedError<
  GatewayCliError,
  { readonly brand: unique symbol }
>()("GatewayCliError", { message: Schema.String }) {}

const configJson = Schema.fromJsonString(GatewayConfig, { space: 2 });
const decodeConfig = Schema.decodeEffect(configJson);
const encodeConfig = Schema.encodeEffect(configJson);

export const gatewayPaths = Effect.fn("gatewayCli.paths")(function* (platform: GatewayPlatform) {
  const env = yield* HostProcess.Environment;
  return {
    configPath: env[GATEWAY_CONFIG_PATH_ENV] || platform.layout.configPath,
    pairingDir: env[GATEWAY_PAIRING_DIR_ENV] || platform.layout.pairingDir,
  };
});

export const gatewayEntry = Effect.fn("gatewayCli.entry")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.lstat(file).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
});

export const ensureReadableGatewayConfig = Effect.fn("gatewayCli.ensureReadableConfig")(function* (
  platform: GatewayPlatform,
  file: string,
) {
  if (!(yield* platform.checkAdminOwned(file, "File"))) return false;
  yield* platform.secureRuntimeFile(file, false);
  return true;
});

const checkAdminAncestors = Effect.fn("gatewayCli.checkAdminAncestors")(function* (
  platform: GatewayPlatform,
  directory: string,
) {
  const path = yield* Path.Path;
  const ancestors = [directory];
  while (path.dirname(directory) !== directory) {
    directory = path.dirname(directory);
    ancestors.push(directory);
  }
  for (const ancestor of ancestors.reverse()) {
    if (!(yield* platform.checkAdminOwned(ancestor, "Directory"))) break;
  }
});

const privilegedGatewayPaths = Effect.fn("gatewayCli.privilegedPaths")(function* (
  platform: GatewayPlatform,
) {
  const path = yield* Path.Path;
  const { configPath, pairingDir } = yield* gatewayPaths(platform);
  const checkedConfigPath = path.resolve(configPath);
  const checkedPairingDir = path.resolve(pairingDir);
  if (configPath !== platform.layout.configPath) {
    yield* checkAdminAncestors(platform, path.dirname(checkedConfigPath));
    const info = yield* gatewayEntry(checkedConfigPath);
    if (info !== undefined && info.type !== "File") {
      return yield* new GatewayCliError({
        message: `Expected a regular file at ${checkedConfigPath}.`,
      });
    }
  }
  if (pairingDir !== platform.layout.pairingDir) {
    yield* checkAdminAncestors(platform, checkedPairingDir);
  }
  return { configPath: checkedConfigPath, pairingDir: checkedPairingDir };
});

export const readGatewayConfig = Effect.fn("gatewayCli.readConfig")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(configPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
  return contents === undefined ? emptyGatewayConfig : yield* decodeConfig(contents);
});

export const requireAdmin = Effect.fn("gatewayCli.requireAdmin")(function* (
  platform: GatewayPlatform,
) {
  if (!(yield* platform.isAdmin)) {
    return yield* new GatewayCliError({
      message: "Run this gateway command as root or an elevated administrator.",
    });
  }
});

export const addGatewayUser = Effect.fn("gatewayCli.addUser")(function* (
  config: GatewayConfig,
  user: string,
  uid: GatewayAccountId,
  requestedPort?: number,
  occupiedPorts: ReadonlyArray<number> = [],
) {
  const existing = Object.hasOwn(config.users, user) ? config.users[user] : undefined;
  if (existing !== undefined) {
    if (existing.uid !== uid) {
      return yield* new GatewayCliError({
        message: `${user}'s account id has changed. Remove the gateway entry before adding it again.`,
      });
    }
    if (requestedPort !== undefined && requestedPort !== existing.port) {
      return yield* new GatewayCliError({
        message: `${user} is already enrolled on port ${existing.port}. Remove the gateway entry before adding it again with a different port.`,
      });
    }
    return config;
  }
  if (Object.values(config.users).some((entry) => entry.uid === uid)) {
    return yield* new GatewayCliError({
      message: `Account ${uid} is already enrolled in the gateway.`,
    });
  }

  const { first, last } = GATEWAY_BACKEND_PORT_RANGE;
  const used = new Set([
    config.listen.port,
    ...Object.values(config.users).map((entry) => entry.port),
    ...occupiedPorts,
  ]);
  let port = requestedPort ?? first;
  if (requestedPort === undefined) {
    while (port <= last && used.has(port)) port++;
    if (port > last) {
      return yield* new GatewayCliError({ message: "No gateway backend ports are available." });
    }
  } else if (!Number.isInteger(port) || port < first || port > last || used.has(port)) {
    return yield* new GatewayCliError({
      message: `Gateway backend port ${port} must be unused and between ${first} and ${last}.`,
    });
  }

  return { ...config, users: { ...config.users, [user]: { uid, port } } };
});

export const removeGatewayUser = (config: GatewayConfig, user: string): GatewayConfig => {
  if (!Object.hasOwn(config.users, user)) return config;
  const users = { ...config.users };
  delete users[user];
  return { ...config, users };
};

export const lockGatewayPath = Effect.fn("gatewayCli.lockGatewayPath")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o755 });
  const acquire =
    (yield* HostProcess.Platform) === "win32"
      ? acquireWindowsGatewayLock
      : acquireServiceSelectionLock;
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquire(file),
      catch: () =>
        new GatewayCliError({ message: `Could not acquire the gateway lock for ${file}.` }),
    }),
    (release) => Effect.sync(release),
  );
});

export const writeGatewayConfig = Effect.fn("gatewayCli.writeConfig")(function* (
  platform: GatewayPlatform,
  configPath: string,
  config: GatewayConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* encodeConfig(config);
  const staging = yield* fs.makeTempDirectoryScoped({
    directory: path.dirname(configPath),
    prefix: ".t3code-",
  });
  const file = path.join(staging, path.basename(configPath));
  yield* fs.writeFileString(file, contents + "\n");
  // The gateway and enrolled users must be able to read the replacement as soon as it lands.
  yield* platform.secureRuntimeFile(file, false);
  yield* fs.rename(file, configPath);
}, Effect.scoped);

export const enrollGatewayUser = Effect.fn("gatewayCli.enrollUser")(function* (
  platform: GatewayPlatform,
  user: string,
  requestedPort?: number,
  options?: { readonly password?: string },
) {
  yield* requireAdmin(platform);
  const path = yield* Path.Path;
  const { configPath, pairingDir } = yield* privilegedGatewayPaths(platform);
  yield* platform.checkAdminOwned(configPath, "File");
  const record = yield* platform.lookupUser(user);
  yield* lockGatewayPath(configPath);
  yield* ensureReadableGatewayConfig(platform, configPath);
  const config = yield* readGatewayConfig(configPath);
  let occupiedPorts: ReadonlyArray<number> = [];
  if (!Object.hasOwn(config.users, user)) {
    occupiedPorts = (yield* platform.listeners).map(({ port }) => port);
  }
  const updated = yield* addGatewayUser(
    config,
    user,
    record.accountId,
    requestedPort,
    occupiedPorts,
  );
  const port = updated.users[user]!.port;
  const defaultConfigDir = path.dirname(platform.layout.configPath);
  if (path.dirname(configPath) === defaultConfigDir) {
    yield* platform.secureDirectory(defaultConfigDir, "admin");
  }
  if (pairingDir === platform.layout.pairingDir) {
    yield* platform.secureDirectory(path.dirname(pairingDir), "admin");
    yield* platform.secureDirectory(pairingDir, "admin");
  } else if (!(yield* platform.checkAdminOwned(pairingDir, "Directory"))) {
    yield* platform.secureDirectory(pairingDir, "admin");
  }
  yield* platform.secureDirectory(path.join(pairingDir, user), record);
  // Keep the port reserved if the backend cannot start. Retrying repairs the partial enrollment.
  if (updated !== config) yield* writeGatewayConfig(platform, configPath, updated);
  yield* platform.services.enableUser(
    record,
    path.join(platform.layout.installRoot, "current", platform.layout.executableName),
    options,
  );
  return port;
}, Effect.scoped);

export const unenrollGatewayUser = Effect.fn("gatewayCli.unenrollUser")(function* (
  platform: GatewayPlatform,
  user: string,
) {
  yield* requireAdmin(platform);
  const path = yield* Path.Path;
  const { configPath, pairingDir } = yield* privilegedGatewayPaths(platform);
  yield* platform.checkAdminOwned(configPath, "File");
  yield* lockGatewayPath(configPath);
  const config = yield* readGatewayConfig(configPath);
  const updated = removeGatewayUser(config, user);
  if (updated !== config) yield* writeGatewayConfig(platform, configPath, updated);
  // Cleanup starts only once the gateway stops routing to the user, and runs on every retry.
  yield* Effect.void.pipe(
    Effect.onExit(() => platform.removeTree(path.join(pairingDir, user))),
    Effect.onExit(() =>
      platform.services
        .disableUser(user)
        .pipe(Effect.catch((error) => Console.warn(`Warning: ${error.message}`))),
    ),
  );
}, Effect.scoped);

export const listGatewayUsers = Effect.fn("gatewayCli.listUsers")(function* (
  platform: GatewayPlatform,
) {
  const { configPath } = yield* gatewayPaths(platform);
  const config = yield* readGatewayConfig(configPath);
  return yield* Effect.forEach(
    Object.entries(config.users).sort(([a], [b]) => a.localeCompare(b)),
    ([user, entry]) =>
      Effect.map(platform.services.userState(user), (state) => ({ user, ...entry, state })),
  );
});
