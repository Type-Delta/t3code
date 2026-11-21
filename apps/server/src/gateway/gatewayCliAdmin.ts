import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { acquireServiceSelectionLock } from "../cloud/serviceSelectionLock.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  emptyGatewayConfig,
  GATEWAY_BACKEND_PORT_RANGE,
  GATEWAY_CONFIG_DIR,
  GATEWAY_CONFIG_PATH,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_PAIRING_DIR,
  GATEWAY_PAIRING_DIR_ENV,
  GATEWAY_USER_ENV_DIR,
  GatewayConfig,
} from "./GatewayConfig.ts";
import { parseProcNetTcp } from "./GatewayListeners.ts";

export const gatewayAccount = "t3code";

export class GatewayCliError extends Schema.TaggedError<
  GatewayCliError,
  { readonly brand: unique symbol }
>()("GatewayCliError", { message: Schema.String }) {}

const configJson = Schema.fromJsonString(GatewayConfig, { space: 2 });
const decodeConfig = Schema.decodeEffect(configJson);
const encodeConfig = Schema.encodeEffect(configJson);

export const gatewayPaths = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  return {
    configPath: env[GATEWAY_CONFIG_PATH_ENV] || GATEWAY_CONFIG_PATH,
    pairingDir: env[GATEWAY_PAIRING_DIR_ENV] || GATEWAY_PAIRING_DIR,
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

export const checkRootDirectory = Effect.fn("gatewayCli.checkRootDirectory")(function* (
  directory: string,
) {
  const info = yield* gatewayEntry(directory);
  if (info === undefined) return false;
  if (info.type !== "Directory" || Option.getOrUndefined(info.uid) !== 0 || info.mode & 0o022) {
    return yield* new GatewayCliError({
      message: `Expected a root-owned directory at ${directory} writable only by root.`,
    });
  }
  return true;
});

const checkRootConfigFile = Effect.fn("gatewayCli.checkRootConfigFile")(function* (file: string) {
  const info = yield* gatewayEntry(file);
  if (info === undefined) return undefined;
  if (info.type !== "File" || Option.getOrUndefined(info.uid) !== 0 || info.mode & 0o022) {
    return yield* new GatewayCliError({
      message: `Expected a root-owned regular file at ${file} writable only by root.`,
    });
  }
  return info;
});

export const ensureReadableGatewayConfig = Effect.fn("gatewayCli.ensureReadableConfig")(function* (
  file: string,
) {
  const info = yield* checkRootConfigFile(file);
  if (info === undefined) return false;
  if ((info.mode & 0o004) === 0) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.chmod(file, 0o644);
  }
  return true;
});

const checkRootAncestors = Effect.fn("gatewayCli.checkRootAncestors")(function* (
  directory: string,
) {
  const path = yield* Path.Path;
  const ancestors = [directory];
  while (path.dirname(directory) !== directory) {
    directory = path.dirname(directory);
    ancestors.push(directory);
  }
  for (const ancestor of ancestors.reverse()) {
    if (!(yield* checkRootDirectory(ancestor))) break;
  }
});

const privilegedGatewayPaths = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { configPath, pairingDir } = yield* gatewayPaths;
  const checkedConfigPath = path.resolve(configPath);
  const checkedPairingDir = path.resolve(pairingDir);
  if (configPath !== GATEWAY_CONFIG_PATH) {
    yield* checkRootAncestors(path.dirname(checkedConfigPath));
    const info = yield* gatewayEntry(checkedConfigPath);
    if (info !== undefined && info.type !== "File") {
      return yield* new GatewayCliError({
        message: `Expected a regular file at ${checkedConfigPath}.`,
      });
    }
  }
  if (pairingDir !== GATEWAY_PAIRING_DIR) {
    yield* checkRootAncestors(checkedPairingDir);
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

export const requireLinux = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") {
    return yield* new GatewayCliError({ message: "The T3 Code gateway requires Linux." });
  }
});

export const requireRoot = requireLinux.pipe(
  Effect.andThen(
    Effect.gen(function* () {
      if ((yield* HostProcess.UserId) !== 0) {
        return yield* new GatewayCliError({ message: "Run this gateway command as root." });
      }
    }),
  ),
);

export const addGatewayUser = Effect.fn("gatewayCli.addUser")(function* (
  config: GatewayConfig,
  user: string,
  uid: number,
  requestedPort?: number,
  occupiedPorts: ReadonlyArray<number> = [],
) {
  const existing = Object.hasOwn(config.users, user) ? config.users[user] : undefined;
  if (existing !== undefined) {
    if (existing.uid !== uid) {
      return yield* new GatewayCliError({
        message: `${user}'s Linux uid has changed. Remove the gateway entry before adding it again.`,
      });
    }
    if (requestedPort !== undefined && requestedPort !== existing.port) {
      return yield* new GatewayCliError({
        message: `${user} is already enrolled on port ${existing.port}. Remove the gateway entry before adding it again with a different port.`,
      });
    }
    return config;
  }
  if (uid === 0 || Object.values(config.users).some((entry) => entry.uid === uid)) {
    return yield* new GatewayCliError({
      message: `Linux uid ${uid} is root or already enrolled in the gateway.`,
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

export const gatewayUserEnv = (port: number) => `T3CODE_PORT=${port}\nT3CODE_HOST=127.0.0.1\n`;

export const runGatewaySystemTool = Effect.fn("gatewayCli.runSystemTool")(function* (
  input: Pick<ProcessRunner.ProcessRunInput, "command" | "args" | "timeout">,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  return yield* runner.run({
    ...input,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
  });
});

const lookupLinuxUser = Effect.fn("gatewayCli.lookupLinuxUser")(function* (user: string) {
  const result = yield* runGatewaySystemTool({ command: "getent", args: ["passwd", user] });
  const [name, , uidText, gidText, , home] = result.stdout.trim().split(":");
  const uid = Number(uidText);
  const gid = Number(gidText);
  if (
    result.code !== 0 ||
    name !== user ||
    uidText === undefined ||
    !/^\d+$/.test(uidText) ||
    !Number.isSafeInteger(uid) ||
    gidText === undefined ||
    !/^\d+$/.test(gidText) ||
    !Number.isSafeInteger(gid)
  ) {
    return yield* new GatewayCliError({ message: `Linux user ${user} was not found.` });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeInfo =
    home && path.isAbsolute(home)
      ? yield* fs.stat(home).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.undefined,
          ),
        )
      : undefined;
  if (homeInfo?.type !== "Directory") {
    return yield* new GatewayCliError({
      message: `The home directory for ${user} does not exist or is not a directory.`,
    });
  }
  return { uid, gid };
});

// Explicit mode and owner so the result does not depend on root's umask.
export const ensureDirectory = Effect.fn("gatewayCli.ensureDirectory")(function* (
  directory: string,
  uid: number,
  gid: number,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o755 });
  if ((yield* fs.lstat(directory)).type !== "Directory") {
    return yield* new GatewayCliError({ message: `Expected a directory at ${directory}.` });
  }
  yield* fs.chown(directory, uid, gid);
  yield* fs.chmod(directory, 0o755);
});

const removePairingDirectory = Effect.fn("gatewayCli.removePairingDirectory")(function* (
  directory: string,
) {
  // Coreutils walks by directory descriptor so a user cannot redirect root with a symlink swap.
  const result = yield* runGatewaySystemTool({
    command: "rm",
    args: ["--recursive", "--force", "--one-file-system", "--", directory],
  });
  if (result.code !== 0) {
    return yield* new GatewayCliError({
      message: `Could not remove pairing directory ${directory}.`,
    });
  }
});

const userUnit = (user: string) => `t3code@${user}.service`;

const changeUserUnit = Effect.fn("gatewayCli.changeUserUnit")(function* (
  action: "enable" | "disable",
  user: string,
) {
  const unit = userUnit(user);
  const result = yield* runGatewaySystemTool({
    command: "systemctl",
    args: [action, "--now", unit],
  });
  if (result.code !== 0) {
    return yield* new GatewayCliError({
      message: `systemctl could not ${action} --now ${unit} (exit ${result.code}).`,
    });
  }
});

const userUnitState = Effect.fn("gatewayCli.userUnitState")(function* (user: string) {
  const result = yield* runGatewaySystemTool({
    command: "systemctl",
    args: ["is-active", userUnit(user)],
  });
  return result.stdout.trim() || "unavailable";
});

export const lockGatewayPath = Effect.fn("gatewayCli.lockGatewayPath")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o755 });
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireServiceSelectionLock(file),
      catch: () =>
        new GatewayCliError({ message: `Could not acquire the gateway lock for ${file}.` }),
    }),
    (release) => Effect.sync(release),
  );
});

export const writeGatewayConfig = Effect.fn("gatewayCli.writeConfig")(function* (
  configPath: string,
  config: GatewayConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* encodeConfig(config);
  // The gateway and enrolled users must be able to read the replacement as soon as it lands.
  yield* writeFileStringAtomically({ filePath: configPath, contents: contents + "\n" }).pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      writeFileString: (filePath, content, options) =>
        fs
          .writeFileString(filePath, content, options)
          .pipe(Effect.andThen(fs.chmod(filePath, 0o644))),
    }),
  );
});

export const readGatewayListeners = Effect.fn("gatewayCli.readListeners")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tcp = yield* fs.readFileString("/proc/net/tcp");
  const tcp6 = yield* fs.readFileString("/proc/net/tcp6").pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(""),
    ),
  );
  return [tcp, tcp6].flatMap(parseProcNetTcp);
});

export const enrollGatewayUser = Effect.fn("gatewayCli.enrollUser")(function* (
  user: string,
  requestedPort?: number,
) {
  yield* requireRoot;
  const path = yield* Path.Path;
  const { configPath, pairingDir } = yield* privilegedGatewayPaths;
  yield* checkRootConfigFile(configPath);
  if (user === gatewayAccount) {
    return yield* new GatewayCliError({
      message: `The Linux account ${user} is reserved for the gateway.`,
    });
  }
  const { uid, gid } = yield* lookupLinuxUser(user);
  yield* lockGatewayPath(configPath);
  yield* ensureReadableGatewayConfig(configPath);
  const config = yield* readGatewayConfig(configPath);
  let occupiedPorts: ReadonlyArray<number> = [];
  if (!Object.hasOwn(config.users, user)) {
    occupiedPorts = (yield* readGatewayListeners()).map(({ port }) => port);
  }
  const updated = yield* addGatewayUser(config, user, uid, requestedPort, occupiedPorts);
  const port = updated.users[user]!.port;
  const envPath = path.join(GATEWAY_USER_ENV_DIR, `${user}.env`);
  if (path.dirname(configPath) === GATEWAY_CONFIG_DIR) {
    yield* ensureDirectory(GATEWAY_CONFIG_DIR, 0, 0);
  }
  yield* ensureDirectory(path.dirname(envPath), 0, 0);
  if (pairingDir === GATEWAY_PAIRING_DIR) {
    yield* ensureDirectory(path.dirname(pairingDir), 0, 0);
    yield* ensureDirectory(pairingDir, 0, 0);
  } else {
    if (!(yield* checkRootDirectory(pairingDir))) yield* ensureDirectory(pairingDir, 0, 0);
  }
  yield* ensureDirectory(path.join(pairingDir, user), uid, gid);
  // Keep the port reserved if systemd cannot start the unit. Retrying repairs the partial enrollment.
  if (updated !== config) yield* writeGatewayConfig(configPath, updated);
  yield* writeFileStringAtomically({
    filePath: envPath,
    contents: gatewayUserEnv(port),
  });
  yield* changeUserUnit("enable", user);
  return port;
}, Effect.scoped);

export const unenrollGatewayUser = Effect.fn("gatewayCli.unenrollUser")(function* (user: string) {
  yield* requireRoot;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { configPath, pairingDir } = yield* privilegedGatewayPaths;
  yield* checkRootConfigFile(configPath);
  yield* lockGatewayPath(configPath);
  const config = yield* readGatewayConfig(configPath);
  const updated = removeGatewayUser(config, user);
  if (updated !== config) yield* writeGatewayConfig(configPath, updated);
  // Cleanup starts only once the gateway stops routing to the user, and runs on every retry.
  yield* Effect.void.pipe(
    Effect.onExit(() => fs.remove(path.join(GATEWAY_USER_ENV_DIR, `${user}.env`), { force: true })),
    Effect.onExit(() => removePairingDirectory(path.join(pairingDir, user))),
    Effect.onExit(() =>
      changeUserUnit("disable", user).pipe(
        Effect.catch((error) => Console.warn(`Warning: ${error.message}`)),
      ),
    ),
  );
}, Effect.scoped);

export const listGatewayUsers = Effect.fn("gatewayCli.listUsers")(function* () {
  yield* requireLinux;
  const { configPath } = yield* gatewayPaths;
  const config = yield* readGatewayConfig(configPath);
  return yield* Effect.forEach(
    Object.entries(config.users).sort(([a], [b]) => a.localeCompare(b)),
    ([user, entry]) => Effect.map(userUnitState(user), (state) => ({ user, ...entry, state })),
  );
});
