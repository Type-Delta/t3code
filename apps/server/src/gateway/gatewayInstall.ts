import * as HostProcess from "@t3tools/shared/HostProcess";
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
  emptyGatewayConfig,
  GATEWAY_CONFIG_DIR,
  GATEWAY_CONFIG_PATH,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_INSTALL_ROOT,
  GATEWAY_PAIRING_DIR,
  GATEWAY_PAIRING_DIR_ENV,
  GATEWAY_UNIT,
  GATEWAY_USER_ENV_DIR,
  GATEWAY_USER_UNIT_TEMPLATE,
} from "./GatewayConfig.ts";
import {
  checkRootDirectory,
  ensureDirectory,
  ensureReadableGatewayConfig,
  gatewayEntry,
  gatewayAccount,
  GatewayCliError,
  lockGatewayPath,
  readGatewayConfig,
  readGatewayListeners,
  requireRoot,
  runGatewaySystemTool,
  writeGatewayConfig,
} from "./gatewayCliAdmin.ts";

const systemLayout = {
  installRoot: GATEWAY_INSTALL_ROOT,
  launcher: "/usr/local/bin/t3",
  unitDir: "/etc/systemd/system",
  runtimeUnitDir: "/run/systemd/system",
  configDir: GATEWAY_CONFIG_DIR,
  configPath: GATEWAY_CONFIG_PATH,
  userEnvDir: GATEWAY_USER_ENV_DIR,
  pairingDir: GATEWAY_PAIRING_DIR,
};

type InstallLayout = { readonly [K in keyof typeof systemLayout]: string };

const installMarker = ".t3code-gateway-install";
const unitMarker = "# Managed by t3 gateway install";
const startLimit = ["StartLimitIntervalSec=60", "StartLimitBurst=5"];
const systemPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const runtimeDirectories = ["client", "node_modules", "resource-monitor", "lib"] as const;
const packageHint = [
  "Use an extracted Linux CLI archive from this fork.",
  "Build the web client and server with `vp run --filter=@t3tools/web build` and `node apps/server/scripts/cli.ts build`.",
  "Run `node apps/server/scripts/cli.ts build-exe` and `vp run build:resource-monitor`.",
  "Then run `node scripts/build-cli-archive.ts --platform linux --arch <x64|arm64> --version <version> --resource-monitor-dir <staged-monitor-dir>`.",
].join(" ");

export function renderGatewayUnits(layout: InstallLayout = systemLayout) {
  const executable = `${layout.installRoot}/current/t3`;
  return {
    [GATEWAY_UNIT]: [
      unitMarker,
      "[Unit]",
      "Description=T3 Code multi-user gateway",
      ...startLimit,
      "",
      "[Service]",
      "Type=exec",
      `User=${gatewayAccount}`,
      `ExecStart=${executable} gateway run`,
      "Restart=on-failure",
      "RestartSec=5",
      "NoNewPrivileges=yes",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateTmp=yes",
      "CapabilityBoundingSet=",
      "PrivateDevices=yes",
      "LockPersonality=yes",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectKernelLogs=yes",
      "ProtectControlGroups=yes",
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK",
      "RestrictNamespaces=yes",
      "SystemCallFilter=@system-service",
      "SystemCallErrorNumber=EPERM",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n"),
    [GATEWAY_USER_UNIT_TEMPLATE]: [
      unitMarker,
      "[Unit]",
      "Description=T3 Code backend for %i",
      ...startLimit,
      "",
      "[Service]",
      "Type=exec",
      "User=%i",
      "WorkingDirectory=~",
      `Environment=PATH=${systemPath}`,
      `EnvironmentFile=${layout.userEnvDir}/%i.env`,
      `ExecStart=${executable} gateway run-backend`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n"),
  };
}

const fail = (message: string) => new GatewayCliError({ message });

const requireDefaultPaths = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  for (const variable of [GATEWAY_CONFIG_PATH_ENV, GATEWAY_PAIRING_DIR_ENV]) {
    if (env[variable]) {
      return yield* fail(
        `Unset ${variable} before installing or uninstalling the gateway. The systemd service uses the default paths.`,
      );
    }
  }
});

const readManagedUnits = Effect.fn("gatewayInstall.readManagedUnits")(function* (
  unitDir: string,
  command: "install" | "uninstall",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const units = new Map<string, string>();
  let unmanagedGateway = false;
  for (const unit of [GATEWAY_UNIT, GATEWAY_USER_UNIT_TEMPLATE]) {
    const file = path.join(unitDir, unit);
    const info = yield* gatewayEntry(file);
    if (info === undefined) continue;
    const skipUnmanagedGateway = unit === GATEWAY_UNIT && command === "uninstall";
    if (skipUnmanagedGateway && info.type === "SymbolicLink") {
      yield* Console.warn(`Skipping ${unit}: ${file} is a symlink.`);
      unmanagedGateway = true;
      continue;
    }
    if (info.type !== "File") return yield* fail(`Expected a regular file at ${file}.`);
    const contents = yield* fs.readFileString(file);
    if (!contents.startsWith(unitMarker + "\n")) {
      if (skipUnmanagedGateway) {
        yield* Console.warn(`Skipping ${unit}: ${file} has no installer marker.`);
        unmanagedGateway = true;
        continue;
      }
      return yield* fail(
        `Refusing to modify unmanaged unit ${file}. Move it out of the way first.`,
      );
    }
    units.set(unit, contents);
  }
  return { units, unmanagedGateway };
});

const writeUnit = Effect.fn("gatewayInstall.writeUnit")(function* (
  unitDir: string,
  unit: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staging = yield* fs.makeTempDirectoryScoped({
    directory: unitDir,
    prefix: ".t3code-",
  });
  const file = path.join(staging, unit);
  yield* fs.writeFileString(file, contents);
  yield* fs.chmod(file, 0o644);
  yield* fs.rename(file, path.join(unitDir, unit));
}, Effect.scoped);

const hasInstallMarker = Effect.fn("gatewayInstall.hasInstallMarker")(function* (root: string) {
  const path = yield* Path.Path;
  const info = yield* gatewayEntry(path.join(root, installMarker));
  return (
    info?.type === "File" && Option.getOrUndefined(info.uid) === 0 && (info.mode & 0o022) === 0
  );
});

const preflight = Effect.fn("gatewayInstall.preflight")(function* (layout: InstallLayout) {
  const path = yield* Path.Path;
  for (const directory of new Set([
    path.dirname(layout.installRoot),
    path.dirname(path.dirname(layout.launcher)),
    path.dirname(layout.launcher),
    path.dirname(layout.unitDir),
    layout.unitDir,
    layout.installRoot,
  ])) {
    yield* checkRootDirectory(directory);
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
      !relative.startsWith("../") &&
      !path.isAbsolute(relative)
        ? target
        : undefined,
  };
});

const runSystemTool = Effect.fn("gatewayInstall.runSystemTool")(function* (
  command: string,
  args: ReadonlyArray<string>,
  acceptedCodes: ReadonlyArray<number> = [0],
) {
  const result = yield* runGatewaySystemTool({
    command,
    args,
    timeout: "120 seconds",
  });
  if (result.code === null || !acceptedCodes.includes(result.code)) {
    const detail = result.stderr.trim();
    return yield* fail(
      `${command} ${args.join(" ")} failed (exit ${result.code}). ${detail}`.trim(),
    );
  }
  return result;
});

const ensureAccount = Effect.fn("gatewayInstall.ensureAccount")(function* () {
  let result = yield* runSystemTool("getent", ["passwd", gatewayAccount], [0, 2]);
  if (result.code === 2) {
    yield* runSystemTool("useradd", [
      "--system",
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      gatewayAccount,
    ]);
    result = yield* runSystemTool("getent", ["passwd", gatewayAccount]);
  }
  const [name, , uid, , , , shell] = result.stdout.trim().split(":");
  if (
    name !== gatewayAccount ||
    !uid ||
    !/^[0-9]+$/.test(uid) ||
    !Number.isSafeInteger(Number(uid)) ||
    Number(uid) === 0 ||
    !shell?.endsWith("/nologin")
  ) {
    return yield* fail(
      `The Linux account ${gatewayAccount} must be a non-root account with a nologin shell.`,
    );
  }
  return Number(uid);
});

const instancePattern = GATEWAY_USER_UNIT_TEMPLATE.replace("@.", "@*.");
const isGatewayUnit = (name: string) =>
  name === GATEWAY_UNIT ||
  (name.startsWith("t3code@") && name.endsWith(".service") && name !== GATEWAY_USER_UNIT_TEMPLATE);

const listUnits = Effect.fn("gatewayInstall.listUnits")(function* (listing: "active" | "loaded") {
  const { stdout } = yield* runSystemTool("systemctl", [
    "list-units",
    "--plain",
    listing === "active" ? "--state=active" : "--all",
    "--no-legend",
    "--no-pager",
    GATEWAY_UNIT,
    instancePattern,
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0]!)
    .filter(isGatewayUnit);
});

const readFragmentPath = Effect.fn("gatewayInstall.readFragmentPath")(function* (unit: string) {
  const { stdout } = yield* runSystemTool("systemctl", [
    "show",
    "--property=FragmentPath",
    "--value",
    unit,
  ]);
  return stdout.trim();
});

const checkTemplateFragment = Effect.fn("gatewayInstall.checkTemplateFragment")(function* (
  expected: string | undefined,
) {
  // Systemd cannot load a template by name. Its cat command resolves the exact template on disk.
  const unit = GATEWAY_USER_UNIT_TEMPLATE;
  const result = yield* runSystemTool("systemctl", ["cat", "--no-pager", unit], [0, 1]);
  if (
    result.code === 1 &&
    result.stdout === "" &&
    result.stderr.trim() === `No files found for ${unit}.`
  ) {
    return;
  }
  const header = result.stdout.trimStart().split("\n", 1)[0];
  if (result.code === 0 && expected !== undefined && header === `# ${expected}`) return;
  const fragment = header?.startsWith("# /") ? header.slice(2) : undefined;
  return yield* fail(
    fragment === undefined
      ? `Refusing to install: could not verify the effective unit for ${unit}.`
      : `Refusing to install: systemd resolves unmanaged unit ${unit} to ${fragment}.`,
  );
});

const hasManagedFragment = Effect.fn("gatewayInstall.hasManagedFragment")(function* (
  unit: string,
  expected: string | undefined,
) {
  if (expected === undefined) {
    yield* Console.warn(`Skipping ${unit}: no installer-marked unit file.`);
    return false;
  }
  const fragment = yield* readFragmentPath(unit).pipe(Effect.orElseSucceed(() => ""));
  if (fragment === expected) return true;
  yield* Console.warn(
    `Skipping ${unit}: effective unit is ${fragment || "unknown"} (expected ${expected}).`,
  );
  return false;
});

const enabledUnits = Effect.fn("gatewayInstall.enabledUnits")(function* (unitDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // list-unit-files can omit enabled template instances present only in the target's .wants.
  const wants = path.join(unitDir, "multi-user.target.wants");
  const names = yield* fs.readDirectory(wants).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
  return yield* Effect.filter(names.filter(isGatewayUnit).sort(), (name) =>
    gatewayEntry(path.join(wants, name)).pipe(Effect.map((info) => info?.type === "SymbolicLink")),
  );
});

function checkSourceOwnership(
  source: string,
  info: FileSystem.File.Info,
  adminUid: number | undefined,
  ancestor = false,
) {
  const uid = Option.getOrUndefined(info.uid);
  // A sticky shared ancestor cannot let another user replace the trusted entry below it.
  if (
    uid === undefined ||
    (uid !== 0 && uid !== adminUid) ||
    ((info.mode & 0o022) !== 0 && !(ancestor && (info.mode & 0o1000) !== 0))
  ) {
    return fail(
      `Runtime source requires trusted ownership and no group or world write access: ${source}.`,
    );
  }
}

const copyRuntimeEntry = Effect.fn("gatewayInstall.copyRuntimeEntry")(function* (
  source: string,
  destination: string,
  adminUid: number | undefined,
): Effect.fn.Return<
  void,
  GatewayCliError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(source);
  if (info.type !== "File" && info.type !== "Directory") {
    return yield* fail(`Unexpected runtime entry at ${source}. ${packageHint}`);
  }
  const unsafe = checkSourceOwnership(source, info, adminUid);
  if (unsafe) return yield* unsafe;
  if (info.type === "File") {
    yield* fs.copyFile(source, destination);
    yield* fs.chmod(destination, info.mode & 0o111 ? 0o755 : 0o644);
    return;
  }
  yield* fs.makeDirectory(destination);
  yield* fs.chmod(destination, 0o755);
  for (const name of yield* fs.readDirectory(source)) {
    yield* copyRuntimeEntry(path.join(source, name), path.join(destination, name), adminUid);
  }
});

const runtimeSource = Effect.fn("gatewayInstall.runtimeSource")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* HostProcess.IsExecutable)) {
    return yield* fail(`Gateway install requires the standalone t3 executable. ${packageHint}`);
  }
  const executable = yield* HostProcess.ExecutablePath;
  const directory = path.dirname(executable);
  const sudoUid = (yield* HostProcess.Environment).SUDO_UID;
  const adminUid = sudoUid && /^\d+$/.test(sudoUid) ? Number(sudoUid) : undefined;
  for (let folder = directory; ; folder = path.dirname(folder)) {
    const info = yield* fs.lstat(folder);
    if (info.type !== "Directory") return yield* fail(`Expected a directory at ${folder}.`);
    const unsafe = checkSourceOwnership(folder, info, adminUid, folder !== directory);
    if (unsafe) return yield* unsafe;
    if (folder === path.dirname(folder)) break;
  }
  for (const [name, type] of [
    ...runtimeDirectories.map((name) => [name, "Directory"] as const),
    ["client/index.html", "File"],
    ["lib/libatomic.so.1", "File"],
  ] as const) {
    if ((yield* gatewayEntry(path.join(directory, name)))?.type !== type) {
      return yield* fail(
        `The standalone runtime is missing ${name} beside ${executable}. ${packageHint}`,
      );
    }
  }
  return { executable, directory, adminUid };
});

const matchingExecutableBits = Effect.fn("gatewayInstall.matchingExecutableBits")(function* (
  left: string,
  right: string,
): Effect.fn.Return<boolean, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(right);
  if (info.type === "File") return ((yield* fs.lstat(left)).mode & 0o111) === (info.mode & 0o111);
  for (const name of yield* fs.readDirectory(right)) {
    if (!(yield* matchingExecutableBits(path.join(left, name), path.join(right, name)))) {
      return false;
    }
  }
  return true;
});

const publishRuntime = Effect.fn("gatewayInstall.publishRuntime")(function* (
  source: Effect.Success<ReturnType<typeof runtimeSource>>,
  installRoot: string,
  active: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staging = yield* fs.makeTempDirectoryScoped({
    directory: installRoot,
    prefix: ".install-",
  });
  const runtime = path.join(staging, "runtime");
  yield* fs.makeDirectory(runtime);
  yield* fs.chmod(runtime, 0o755);
  yield* copyRuntimeEntry(source.executable, path.join(runtime, "t3"), source.adminUid);
  for (const name of runtimeDirectories) {
    yield* copyRuntimeEntry(
      path.join(source.directory, name),
      path.join(runtime, name),
      source.adminUid,
    );
  }

  const version = packageJson.version;
  const versionDir = path.join(installRoot, version);
  const exists = yield* checkRootDirectory(versionDir);
  for (const candidate of new Set([active, exists ? versionDir : undefined])) {
    if (
      candidate !== undefined &&
      path.dirname(candidate) === installRoot &&
      (candidate === versionDir || path.basename(candidate).startsWith(`${version}-`)) &&
      (yield* checkRootDirectory(candidate))
    ) {
      const compared = yield* runSystemTool(
        "diff",
        ["--recursive", "--brief", "--no-dereference", "--", candidate, runtime],
        [0, 1],
      );
      if (compared.code === 0 && (yield* matchingExecutableBits(candidate, runtime))) {
        return candidate;
      }
    }
  }
  // Development builds can change without a package version bump.
  const destination = exists
    ? path.join(installRoot, `${version}-${path.basename(staging).slice(".install-".length)}`)
    : versionDir;
  yield* fs.rename(runtime, destination);
  return destination;
}, Effect.scoped);

const replaceLink = Effect.fn("gatewayInstall.replaceLink")(function* (
  target: string,
  link: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staging = yield* fs.makeTempDirectoryScoped({
    directory: path.dirname(link),
    prefix: ".t3code-",
  });
  const stagedLink = path.join(staging, "link");
  yield* fs.symlink(target, stagedLink);
  yield* fs.rename(stagedLink, link);
}, Effect.scoped);

const waitForGateway = Effect.fn("gatewayInstall.waitForGateway")(
  function* (uid: number, port: number) {
    while (
      !(yield* readGatewayListeners()).some(
        (listener) => listener.uid === uid && listener.port === port,
      )
    ) {
      yield* Effect.sleep("500 millis");
    }
  },
  (effect, _uid, port) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => fail(`The gateway did not listen on port ${port} within 20 seconds.`),
      }),
    ),
);

const resetFailedUnits = Effect.fn("gatewayInstall.resetFailedUnits")(function* (
  ...units: ReadonlyArray<string>
) {
  // A unit that systemd has not loaded has no counters to reset.
  yield* runSystemTool("systemctl", ["reset-failed", ...units]).pipe(Effect.ignore);
});

const pruneRuntimes = Effect.fn("gatewayInstall.pruneRuntimes")(function* (
  installRoot: string,
  current: string,
  previous: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* hasInstallMarker(installRoot))) return;
  for (const name of yield* fs.readDirectory(installRoot)) {
    if (name === installMarker || name === "current" || name === "previous") continue;
    const directory = path.join(installRoot, name);
    if (directory === current || directory === previous) continue;
    if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.+-]+)?$/i.test(name)) {
      yield* Console.warn(`Skipping unexpected install entry ${directory}.`);
      continue;
    }
    const removable = yield* checkRootDirectory(directory).pipe(
      Effect.catchTags({
        GatewayCliError: (error) =>
          Console.warn(`Skipping ${directory}. ${error.message}`).pipe(Effect.as(false)),
      }),
    );
    if (removable) yield* fs.remove(directory, { recursive: true });
  }
});

const installAt = Effect.fn("gatewayInstall.install")(function* (layout: InstallLayout) {
  yield* requireRoot;
  yield* requireDefaultPaths;
  const source = yield* runtimeSource();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* preflight(layout);
  const gatewayUnitPath = path.join(layout.unitDir, GATEWAY_UNIT);
  yield* lockGatewayPath(gatewayUnitPath);
  const marked = yield* hasInstallMarker(layout.installRoot);
  if (
    !marked &&
    (yield* checkRootDirectory(layout.installRoot)) &&
    (yield* fs.readDirectory(layout.installRoot)).length > 0
  ) {
    return yield* fail(
      `Refusing to use unmanaged install root ${layout.installRoot}. Move it out of the way first.`,
    );
  }
  const current = path.join(layout.installRoot, "current");
  const previous = path.join(layout.installRoot, "previous");
  const executable = path.join(current, "t3");
  const activeLink = yield* managedLink(current, layout.installRoot);
  const activeRuntime = activeLink.target;
  const previousLink = yield* managedLink(previous, layout.installRoot);
  const launcher = yield* managedLink(layout.launcher, layout.installRoot);
  const units = renderGatewayUnits(layout);
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
  const { units: previousUnits } = yield* readManagedUnits(layout.unitDir, "install");
  const previousGatewayFragment = previousUnits.has(GATEWAY_UNIT) ? gatewayUnitPath : undefined;
  const gatewayFragment = yield* readFragmentPath(GATEWAY_UNIT);
  if (gatewayFragment && gatewayFragment !== previousGatewayFragment) {
    return yield* fail(
      `Refusing to install: systemd loaded unmanaged unit ${GATEWAY_UNIT} from ${gatewayFragment}.`,
    );
  }
  if (!gatewayFragment && (activeRuntime !== undefined || previousGatewayFragment !== undefined)) {
    return yield* fail(
      `Refusing to install: systemd did not load the installer-marked unit at ${gatewayUnitPath}.`,
    );
  }
  const template = path.join(layout.unitDir, GATEWAY_USER_UNIT_TEMPLATE);
  yield* checkTemplateFragment(
    previousUnits.has(GATEWAY_USER_UNIT_TEMPLATE) ? template : undefined,
  );
  yield* checkRootDirectory(path.dirname(layout.configDir));
  yield* checkRootDirectory(path.dirname(path.dirname(layout.pairingDir)));
  yield* ensureDirectory(layout.installRoot, 0, 0);
  if (!marked) {
    yield* fs.writeFileString(path.join(layout.installRoot, installMarker), "", { mode: 0o644 });
  }
  for (const directory of [
    layout.configDir,
    layout.userEnvDir,
    path.dirname(layout.pairingDir),
    layout.pairingDir,
  ]) {
    yield* checkRootDirectory(directory);
    yield* ensureDirectory(directory, 0, 0);
  }
  for (const directory of [
    path.dirname(path.dirname(layout.launcher)),
    path.dirname(layout.launcher),
  ]) {
    if (!(yield* checkRootDirectory(directory))) yield* ensureDirectory(directory, 0, 0);
  }
  yield* lockGatewayPath(layout.configPath);
  if (!(yield* ensureReadableGatewayConfig(layout.configPath))) {
    yield* writeGatewayConfig(layout.configPath, emptyGatewayConfig);
  }
  const gatewayConfig = yield* readGatewayConfig(layout.configPath);
  const destination = yield* publishRuntime(source, layout.installRoot, activeRuntime);
  const uid = yield* ensureAccount();
  let rollbackStatus = "";
  const active = yield* Effect.gen(function* () {
    for (const [unit, contents] of Object.entries(units)) {
      yield* writeUnit(layout.unitDir, unit, contents);
    }
    if (activeRuntime !== destination) yield* replaceLink(path.basename(destination), current);
    if (!launcher.exists) {
      yield* fs.symlink(executable, layout.launcher);
    } else if (launcher.target !== executable) {
      yield* replaceLink(executable, layout.launcher);
    }

    yield* runSystemTool("systemctl", ["daemon-reload"]);
    const active = yield* listUnits("active");
    if (!(yield* hasManagedFragment(GATEWAY_UNIT, gatewayUnitPath))) {
      return yield* fail(`systemd did not load the installed unit at ${gatewayUnitPath}.`);
    }
    yield* resetFailedUnits(GATEWAY_UNIT);
    yield* runSystemTool("systemctl", ["enable", "--now", GATEWAY_UNIT]);
    if (active.includes(GATEWAY_UNIT)) {
      yield* runSystemTool("systemctl", ["restart", GATEWAY_UNIT]);
    }
    yield* waitForGateway(uid, gatewayConfig.listen.port);
    return active;
  }).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit) || activeRuntime === undefined) return Effect.void;
      return Effect.gen(function* () {
        const rollback = yield* Effect.gen(function* () {
          if (activeRuntime !== destination) {
            yield* replaceLink(path.basename(activeRuntime), current);
          }
          for (const unit of Object.keys(units)) {
            const contents = previousUnits.get(unit);
            if (contents === undefined) {
              yield* fs.remove(path.join(layout.unitDir, unit), { force: true });
            } else {
              yield* writeUnit(layout.unitDir, unit, contents);
            }
          }
          yield* runSystemTool("systemctl", ["daemon-reload"]);
          if (!(yield* hasManagedFragment(GATEWAY_UNIT, previousGatewayFragment))) {
            return yield* fail(`systemd did not load the previous unit at ${gatewayUnitPath}.`);
          }
          yield* resetFailedUnits(GATEWAY_UNIT);
          yield* runSystemTool("systemctl", ["restart", GATEWAY_UNIT]);
          yield* waitForGateway(uid, gatewayConfig.listen.port);
        }).pipe(Effect.result);
        rollbackStatus = Result.isSuccess(rollback)
          ? "Restored the previous runtime and unit files. The gateway is listening."
          : `Rollback failed: ${rollback.failure.message}`;
        if (Exit.hasInterrupts(exit)) {
          yield* Console.warn(`${rollbackStatus} See journalctl -u ${GATEWAY_UNIT}.`);
        }
      });
    }),
    Effect.mapError((error) =>
      fail(
        [error.message, rollbackStatus, `See journalctl -u ${GATEWAY_UNIT}.`]
          .filter(Boolean)
          .join(" "),
      ),
    ),
  );

  const previousRuntime = activeRuntime === destination ? previousLink.target : activeRuntime;
  if (previousRuntime !== undefined && previousRuntime !== previousLink.target) {
    yield* replaceLink(path.basename(previousRuntime), previous);
  }
  const backends = yield* Effect.filter(
    active.filter((unit) => unit !== GATEWAY_UNIT),
    (unit) => hasManagedFragment(unit, template),
  );
  if (backends.length > 0) {
    yield* resetFailedUnits(...backends);
    const restarted = yield* runSystemTool("systemctl", ["try-restart", ...backends]).pipe(
      Effect.result,
    );
    for (const unit of backends) {
      const state = yield* runSystemTool("systemctl", ["is-active", unit], [0, 3, 4]).pipe(
        Effect.map(({ stdout }) => stdout.trim()),
        Effect.orElseSucceed(() => "unavailable"),
      );
      yield* Console.log(`${unit}: ${state || "unavailable"}`);
    }
    if (Result.isFailure(restarted)) return yield* restarted.failure;
  }
  yield* pruneRuntimes(layout.installRoot, destination, previousRuntime);
  yield* Console.log(
    `Installed ${destination} and started ${GATEWAY_UNIT}. CLI: ${layout.launcher}.`,
  );
}, Effect.scoped);

const uninstallAt = Effect.fn("gatewayInstall.uninstall")(function* (layout: InstallLayout) {
  yield* requireRoot;
  yield* requireDefaultPaths;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* preflight(layout);
  const gatewayUnitPath = path.join(layout.unitDir, GATEWAY_UNIT);
  yield* lockGatewayPath(gatewayUnitPath);
  const { units: managedFiles, unmanagedGateway } = yield* readManagedUnits(
    layout.unitDir,
    "uninstall",
  );
  yield* checkRootDirectory(path.dirname(layout.configDir));
  if (yield* checkRootDirectory(layout.configDir)) yield* lockGatewayPath(layout.configPath);
  const loadedUnits = yield* listUnits("loaded");
  const enabled = yield* enabledUnits(layout.unitDir);
  const runtimeEnabled = yield* enabledUnits(layout.runtimeUnitDir);
  const candidates = new Set([...loadedUnits, ...enabled, ...runtimeEnabled]);
  if (unmanagedGateway) candidates.delete(GATEWAY_UNIT);
  const gatewayFragment = managedFiles.has(GATEWAY_UNIT) ? gatewayUnitPath : undefined;
  const template = path.join(layout.unitDir, GATEWAY_USER_UNIT_TEMPLATE);
  const managed = new Set(
    yield* Effect.filter(candidates, (unit) =>
      hasManagedFragment(unit, unit === GATEWAY_UNIT ? gatewayFragment : template),
    ),
  );
  const loaded = loadedUnits.filter((unit) => managed.has(unit));
  const persistent = enabled.filter((unit) => managed.has(unit));
  const runtime = runtimeEnabled.filter((unit) => managed.has(unit));
  if (loaded.length > 0) yield* runSystemTool("systemctl", ["stop", ...loaded]);
  if (persistent.length > 0) yield* runSystemTool("systemctl", ["disable", ...persistent]);
  if (runtime.length > 0) {
    yield* runSystemTool("systemctl", ["disable", "--runtime", ...runtime]);
  }

  for (const unit of managedFiles.keys()) {
    yield* fs.remove(path.join(layout.unitDir, unit), { force: true });
  }
  const marked = yield* hasInstallMarker(layout.installRoot);
  if (marked) {
    const launcher = yield* managedLink(layout.launcher, layout.installRoot);
    if (launcher.target !== undefined) yield* fs.remove(layout.launcher);
    yield* fs.remove(layout.installRoot, { recursive: true });
  } else if (yield* checkRootDirectory(layout.installRoot)) {
    yield* Console.log(`Kept unmanaged install root ${layout.installRoot}.`);
  }
  yield* runSystemTool("systemctl", ["daemon-reload"]);
  yield* Console.log(
    `Removed installer-managed unit files${marked ? " and runtime" : ""}. Kept ${layout.configDir}, ${path.dirname(layout.pairingDir)}, the ${gatewayAccount} account, and each user's T3 Code data.`,
  );
}, Effect.scoped);

export const installGateway = (layout: InstallLayout = systemLayout) => installAt(layout);
export const uninstallGateway = (layout: InstallLayout = systemLayout) => uninstallAt(layout);
