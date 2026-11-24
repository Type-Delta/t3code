import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";

import packageJson from "../../package.json" with { type: "json" };
import {
  readUpdateState,
  settleUpdateClaim,
  STALE_UPDATE_MS,
  updateStatePath,
} from "./gatewayHelper.ts";
import {
  emptyGatewayConfig,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_PAIRING_DIR_ENV,
} from "./GatewayConfig.ts";
import {
  ensureReadableGatewayConfig,
  gatewayEntry,
  GatewayCliError,
  lockGatewayPath,
  readGatewayConfig,
  requireAdmin,
  writeGatewayConfig,
} from "./gatewayCliAdmin.ts";
import type {
  GatewayPlatform,
  GatewayPlatformError,
  GatewayPlatformServices,
} from "./platform/GatewayPlatform.ts";

const installMarker = ".t3code-gateway-install";
const archivePlatform = { linux: "linux", darwin: "mac", win32: "win" } as const;

const packageHint = (platform: GatewayPlatform) =>
  [
    "Use an extracted CLI archive from this fork.",
    "Build the web client and server with `vp run --filter=@t3tools/web build` and `node apps/server/scripts/cli.ts build`.",
    "Run `node apps/server/scripts/cli.ts build-exe` and `vp run build:resource-monitor`.",
    `Then run \`node scripts/build-cli-archive.ts --platform ${archivePlatform[platform.name]} --arch <x64|arm64> --version <version> --resource-monitor-dir <staged-monitor-dir>\`.`,
  ].join(" ");

const fail = (message: string) => new GatewayCliError({ message });

const requireDefaultPaths = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  for (const variable of [GATEWAY_CONFIG_PATH_ENV, GATEWAY_PAIRING_DIR_ENV]) {
    if (env[variable]) {
      return yield* fail(
        `Unset ${variable} before installing or uninstalling the gateway. The gateway services use the default paths.`,
      );
    }
  }
});

const hasInstallMarker = Effect.fn("gatewayInstall.hasInstallMarker")(function* (
  platform: GatewayPlatform,
) {
  const path = yield* Path.Path;
  return yield* platform
    .checkAdminOwned(path.join(platform.layout.installRoot, installMarker), "File")
    .pipe(Effect.orElseSucceed(() => false));
});

const checkInstallDirectories = Effect.fn("gatewayInstall.checkInstallDirectories")(function* (
  platform: GatewayPlatform,
) {
  const path = yield* Path.Path;
  const { installRoot, launcher } = platform.layout;
  for (const directory of new Set([
    path.dirname(installRoot),
    path.dirname(path.dirname(launcher)),
    path.dirname(launcher),
    installRoot,
  ])) {
    yield* platform.checkAdminOwned(directory, "Directory");
  }
});

const managedLink = Effect.fn("gatewayInstall.managedLink")(function* (
  file: string,
  installRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* gatewayEntry(file);
  if (info === undefined) return { exists: false, target: undefined };
  if (info.type !== "SymbolicLink") return { exists: true, target: undefined };
  const target = path.resolve(path.dirname(file), yield* fs.readLink(file));
  const relative = path.relative(installRoot, target);
  return {
    exists: true,
    target:
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
        ? target
        : undefined,
  };
});

const copyRuntimeEntry = Effect.fn("gatewayInstall.copyRuntimeEntry")(function* (
  platform: GatewayPlatform,
  source: string,
  destination: string,
): Effect.fn.Return<
  void,
  GatewayCliError | GatewayPlatformError | PlatformError.PlatformError,
  GatewayPlatformServices
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(source);
  if (info.type !== "File" && info.type !== "Directory") {
    return yield* fail(`Unexpected runtime entry at ${source}. ${packageHint(platform)}`);
  }
  yield* platform.checkRuntimeSource(source, info.type);
  if (info.type === "File") {
    yield* fs.copyFile(source, destination);
    yield* platform.secureRuntimeFile(destination, (info.mode & 0o111) !== 0);
    return;
  }
  // The staged root is secured once; folders below take its permissions (inherited on Windows).
  yield* fs.makeDirectory(destination);
  yield* platform.secureRuntimeFile(destination, true);
  for (const name of yield* fs.readDirectory(source)) {
    yield* copyRuntimeEntry(platform, path.join(source, name), path.join(destination, name));
  }
});

const runtimeSource = Effect.fn("gatewayInstall.runtimeSource")(function* (
  platform: GatewayPlatform,
) {
  const path = yield* Path.Path;
  if (!(yield* HostProcess.IsExecutable)) {
    return yield* fail(
      `Gateway install requires the standalone t3 executable. ${packageHint(platform)}`,
    );
  }
  const executable = yield* HostProcess.ExecutablePath;
  const directory = path.dirname(executable);
  for (let folder = directory; ; folder = path.dirname(folder)) {
    yield* platform.checkRuntimeSource(folder, "Directory", { ancestor: folder !== directory });
    if (folder === path.dirname(folder)) break;
  }
  for (const [name, type] of platform.layout.runtimeEntries) {
    if ((yield* gatewayEntry(path.join(directory, name)))?.type !== type) {
      return yield* fail(
        `The standalone runtime is missing ${name} beside ${executable}. ${packageHint(platform)}`,
      );
    }
  }
  return { executable, directory };
});

export const treesMatch = Effect.fn("gatewayInstall.treesMatch")(function* (
  left: string,
  right: string,
): Effect.fn.Return<boolean, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(right);
  const leftInfo = yield* fs.lstat(left);
  if (leftInfo.type !== info.type || (leftInfo.mode & 0o111) !== (info.mode & 0o111)) return false;
  if (info.type === "File") {
    const [leftBytes, rightBytes] = yield* Effect.all([fs.readFile(left), fs.readFile(right)]);
    return (
      leftBytes.length === rightBytes.length &&
      leftBytes.every((byte, index) => byte === rightBytes[index])
    );
  }
  if (info.type !== "Directory") return false;
  const [leftNames, rightNames] = yield* Effect.all([
    fs.readDirectory(left),
    fs.readDirectory(right),
  ]);
  if (
    leftNames.length !== rightNames.length ||
    leftNames.some((name) => !rightNames.includes(name))
  )
    return false;
  for (const name of rightNames)
    if (!(yield* treesMatch(path.join(left, name), path.join(right, name)))) return false;
  return true;
});

const publishRuntime = Effect.fn("gatewayInstall.publishRuntime")(function* (
  platform: GatewayPlatform,
  source: Effect.Success<ReturnType<typeof runtimeSource>>,
  active: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { installRoot, executableName, runtimeEntries } = platform.layout;
  const staging = yield* fs.makeTempDirectoryScoped({
    directory: installRoot,
    prefix: ".install-",
  });
  const runtime = path.join(staging, "runtime");
  yield* platform.secureDirectory(runtime, "admin");
  yield* copyRuntimeEntry(platform, source.executable, path.join(runtime, executableName));
  // Nested entries are only checked; copying their top-level parent brings them along.
  for (const [name] of runtimeEntries.filter(([name]) => !name.includes("/"))) {
    yield* copyRuntimeEntry(platform, path.join(source.directory, name), path.join(runtime, name));
  }

  const version = packageJson.version;
  const versionDir = path.join(installRoot, version);
  const exists = yield* platform.checkAdminOwned(versionDir, "Directory");
  for (const candidate of new Set([active, exists ? versionDir : undefined])) {
    if (
      candidate !== undefined &&
      path.dirname(candidate) === installRoot &&
      (candidate === versionDir || path.basename(candidate).startsWith(`${version}-`)) &&
      (yield* platform.checkAdminOwned(candidate, "Directory")) &&
      (yield* treesMatch(candidate, runtime))
    ) {
      return candidate;
    }
  }
  // Development builds can change without a package version bump.
  const destination = exists
    ? path.join(installRoot, `${version}-${path.basename(staging).slice(".install-".length)}`)
    : versionDir;
  yield* fs.rename(runtime, destination);
  return destination;
}, Effect.scoped);

const pruneRuntimes = Effect.fn("gatewayInstall.pruneRuntimes")(function* (
  platform: GatewayPlatform,
  current: string,
  previous: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { installRoot, launcher } = platform.layout;
  if (!(yield* hasInstallMarker(platform))) return;
  for (const name of yield* fs.readDirectory(installRoot)) {
    if (name === installMarker || name === "current" || name === "previous") continue;
    const directory = path.join(installRoot, name);
    if (directory === current || directory === previous || directory === path.dirname(launcher)) {
      continue;
    }
    if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.+-]+)?$/i.test(name)) {
      yield* Console.warn(`Skipping unexpected install entry ${directory}.`);
      continue;
    }
    const removable = yield* platform
      .checkAdminOwned(directory, "Directory")
      .pipe(
        Effect.catch((error) =>
          Console.warn(`Skipping ${directory}. ${error.message}`).pipe(Effect.as(false)),
        ),
      );
    // The install already succeeded; a runtime still in use (locked on Windows) waits for the next one.
    if (removable) {
      yield* fs
        .remove(directory, { recursive: true })
        .pipe(
          Effect.catch((error) => Console.warn(`Could not remove ${directory}. ${error.message}`)),
        );
    }
  }
});

export const installGateway = Effect.fn("gatewayInstall.install")(function* (
  platform: GatewayPlatform,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { layout } = platform;
  const configDir = path.dirname(layout.configPath);
  // A self-service update runs from the helper's staging folder and owns the claim for its version.
  const stagedFrom = path.dirname(yield* HostProcess.ExecutablePath);
  const selfServiceUpdate =
    path.dirname(stagedFrom) === layout.installRoot &&
    path.basename(stagedFrom).startsWith(".helper-staging-");
  if (selfServiceUpdate) {
    // Members' apps wait on the claim, so a failed install must not leave it running.
    yield* Effect.addFinalizer((exit) => {
      if (Exit.isSuccess(exit)) return Effect.void;
      const error = Cause.squash(exit.cause);
      const reason = error instanceof Error ? error.message : "The update could not be installed.";
      return settleUpdateClaim(layout.configPath, packageJson.version, reason).pipe(Effect.ignore);
    });
  }
  yield* requireAdmin(platform);
  yield* requireDefaultPaths;
  const source = yield* runtimeSource(platform);
  yield* checkInstallDirectories(platform);
  yield* lockGatewayPath(layout.installRoot);
  // Every finished install clears the claim, so one made since this update was requested may hold a
  // newer runtime that this one must not replace.
  if (selfServiceUpdate) {
    const claim = yield* readUpdateState(layout.configPath);
    if (claim?.state !== "running" || claim.version !== packageJson.version) {
      return yield* fail(`Another install replaced the update to ${packageJson.version}.`);
    }
  }
  const marked = yield* hasInstallMarker(platform);
  if (
    !marked &&
    (yield* platform.checkAdminOwned(layout.installRoot, "Directory")) &&
    (yield* fs.readDirectory(layout.installRoot)).length > 0
  ) {
    return yield* fail(
      `Refusing to use unmanaged install root ${layout.installRoot}. Move it out of the way first.`,
    );
  }
  const current = path.join(layout.installRoot, "current");
  const previous = path.join(layout.installRoot, "previous");
  const executable = path.join(current, layout.executableName);
  const activeLink = yield* managedLink(current, layout.installRoot);
  const activeRuntime = activeLink.target;
  const previousLink = yield* managedLink(previous, layout.installRoot);
  const launcher = yield* managedLink(layout.launcher, layout.installRoot);
  for (const [file, link] of [
    [current, activeLink],
    [previous, previousLink],
    [layout.launcher, launcher],
  ] as const) {
    if (
      link.exists &&
      (link.target === undefined ||
        (file !== layout.launcher && path.dirname(link.target) !== layout.installRoot))
    ) {
      return yield* fail(
        `Another entry already occupies ${file}. Move it before installing the gateway.`,
      );
    }
  }
  yield* platform.services.preflight;
  yield* platform.checkAdminOwned(path.dirname(configDir), "Directory");
  yield* platform.checkAdminOwned(path.dirname(path.dirname(layout.pairingDir)), "Directory");
  yield* platform.secureDirectory(layout.installRoot, "admin");
  if (!marked) {
    const marker = path.join(layout.installRoot, installMarker);
    yield* fs.writeFileString(marker, "");
    yield* platform.secureRuntimeFile(marker, false);
  }
  for (const directory of [configDir, path.dirname(layout.pairingDir), layout.pairingDir]) {
    yield* platform.checkAdminOwned(directory, "Directory");
    yield* platform.secureDirectory(directory, "admin");
  }
  for (const directory of [
    path.dirname(path.dirname(layout.launcher)),
    path.dirname(layout.launcher),
  ]) {
    if (!(yield* platform.checkAdminOwned(directory, "Directory"))) {
      yield* platform.secureDirectory(directory, "admin");
    }
  }
  yield* lockGatewayPath(layout.configPath);
  if (!(yield* ensureReadableGatewayConfig(platform, layout.configPath))) {
    yield* writeGatewayConfig(platform, layout.configPath, emptyGatewayConfig);
  }
  const config = yield* readGatewayConfig(layout.configPath);
  const configured = config.selfService === undefined ? { ...config, selfService: true } : config;
  if (configured !== config) yield* writeGatewayConfig(platform, layout.configPath, configured);
  const destination = yield* publishRuntime(platform, source, activeRuntime);
  const gatewayAccount = yield* platform.services.ensureGatewayAccount;
  if (activeRuntime !== destination) yield* platform.replaceLink(destination, current);
  if (launcher.target !== executable) yield* platform.replaceLink(executable, layout.launcher);
  const users = yield* Effect.forEach(Object.entries(config.users), ([name, { uid }]) =>
    platform.lookupUser(name).pipe(
      Effect.map((user) => (user.accountId === uid ? [user] : [])),
      Effect.orElseSucceed(() => []),
    ),
  );
  const activation = yield* platform.services
    .activate({
      executable,
      config: configured,
      gatewayAccount,
      users: users.flat(),
      restorePreviousRuntime:
        activeRuntime === undefined
          ? undefined
          : activeRuntime === destination
            ? Effect.void
            : platform.replaceLink(activeRuntime, current),
    })
    .pipe(Effect.result);

  // The gateway kept the new runtime unless activation rolled it back.
  const previousRuntime = activeRuntime === destination ? previousLink.target : activeRuntime;
  if (
    previousRuntime !== undefined &&
    previousRuntime !== previousLink.target &&
    (yield* managedLink(current, layout.installRoot)).target === destination
  ) {
    yield* platform.replaceLink(previousRuntime, previous);
  }
  if (Result.isFailure(activation)) return yield* activation.failure;
  yield* pruneRuntimes(platform, destination, previousRuntime);
  // An administrator's install supersedes every pending update. A self-service one keeps the
  // fresh staging of an update another member requested meanwhile.
  const now = yield* Clock.currentTimeMillis;
  for (const name of yield* fs.readDirectory(layout.installRoot)) {
    const staging = path.join(layout.installRoot, name);
    if (!name.startsWith(".helper-staging-")) continue;
    if (selfServiceUpdate && staging !== stagedFrom) {
      const modified = yield* fs.stat(staging).pipe(
        Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
        Effect.orElseSucceed(() => undefined),
      );
      if (modified !== undefined && now - modified < STALE_UPDATE_MS) continue;
    }
    yield* fs.remove(staging, { recursive: true }).pipe(Effect.ignore);
  }
  yield* (
    selfServiceUpdate
      ? settleUpdateClaim(layout.configPath, packageJson.version, undefined)
      : fs.remove(updateStatePath(path, layout.configPath), { force: true })
  ).pipe(Effect.ignore);
  yield* Console.log(`Installed ${destination} and started the gateway. CLI: ${layout.launcher}.`);
}, Effect.scoped);

export const uninstallGateway = Effect.fn("gatewayInstall.uninstall")(function* (
  platform: GatewayPlatform,
) {
  yield* requireAdmin(platform);
  yield* requireDefaultPaths;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { layout } = platform;
  const configDir = path.dirname(layout.configPath);
  yield* checkInstallDirectories(platform);
  yield* lockGatewayPath(layout.installRoot);
  yield* platform.checkAdminOwned(path.dirname(configDir), "Directory");
  if (yield* platform.checkAdminOwned(configDir, "Directory")) {
    yield* lockGatewayPath(layout.configPath);
  }
  yield* platform.services.uninstall;
  const marked = yield* hasInstallMarker(platform);
  if (marked) {
    const launcher = yield* managedLink(layout.launcher, layout.installRoot);
    if (launcher.target !== undefined) yield* fs.remove(layout.launcher);
    // The marker goes last, so a removal that fails partway can be finished or reinstalled over.
    for (const name of yield* fs.readDirectory(layout.installRoot)) {
      if (name !== installMarker) {
        yield* fs.remove(path.join(layout.installRoot, name), { recursive: true });
      }
    }
    yield* fs.remove(layout.installRoot, { recursive: true });
  } else if (yield* platform.checkAdminOwned(layout.installRoot, "Directory")) {
    yield* Console.log(`Kept unmanaged install root ${layout.installRoot}.`);
  }
  yield* Console.log(
    `Removed the gateway services${marked ? " and runtime" : ""}. Kept ${[...new Set([configDir, path.dirname(layout.pairingDir)])].join(", ")}, the gateway account, and each user's T3 Code data.`,
  );
}, Effect.scoped);
