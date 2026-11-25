import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ProcessRunner from "../../processRunner.ts";
import {
  GatewayPlatformError,
  type GatewayAccountId,
  type GatewayActivation,
  type GatewayPlatform,
  type GatewayUserRecord,
  readRuntimeVersion,
} from "./GatewayPlatform.ts";
import { loopbackPeerUid, parseProcNetTcp, readTcpSockets } from "./linuxProc.ts";

export const GATEWAY_UNIT = "t3code-gateway.service";
export const GATEWAY_USER_UNIT_TEMPLATE = "t3code@.service";
export const HELPER_SOCKET_UNIT = "t3code-gateway-helper.socket";
export const HELPER_SERVICE_UNIT_TEMPLATE = "t3code-gateway-helper@.service";
const gatewayAccount = "t3code";
const unitMarker = "# Managed by t3 gateway install";
const startLimit = ["StartLimitIntervalSec=60", "StartLimitBurst=5"];
const systemPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const toolEnv = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" };
const logHint = `journalctl -u ${GATEWAY_UNIT}`;

export const linuxGatewayPaths = {
  installRoot: "/opt/t3code",
  launcher: "/usr/local/bin/t3",
  configPath: "/etc/t3code/gateway.json",
  // Holds one `<user>` folder per enrolled user, owned by that user, mode 0755.
  pairingDir: "/var/lib/t3code/pairing",
  unitDir: "/etc/systemd/system",
  runtimeUnitDir: "/run/systemd/system",
};
type LinuxGatewayPaths = typeof linuxGatewayPaths;

export function renderGatewayUnits(executable: string) {
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
      `ExecStart=${executable} gateway run-backend`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n"),
    [HELPER_SOCKET_UNIT]: [
      unitMarker,
      "[Unit]",
      "Description=T3 Code gateway self-service helper socket",
      "",
      "[Socket]",
      "ListenStream=127.0.0.1:3774",
      // Accept=yes starts the matching `t3code-gateway-helper@.service` per connection.
      "Accept=yes",
      "",
      "[Install]",
      "WantedBy=sockets.target",
      "",
    ].join("\n"),
    [HELPER_SERVICE_UNIT_TEMPLATE]: [
      unitMarker,
      "[Unit]",
      "Description=T3 Code gateway self-service helper",
      "",
      "[Service]",
      "Type=exec",
      "User=root",
      "StandardInput=socket",
      // The reply goes out on stdin's socket; log lines on stdout would corrupt it.
      "StandardOutput=journal",
      "StandardError=journal",
      `Environment=PATH=${systemPath}`,
      `ExecStart=${executable} gateway helper`,
      "NoNewPrivileges=no",
      "ProtectSystem=false",
      "ProtectHome=false",
      "PrivateTmp=yes",
      "",
    ].join("\n"),
  };
}

// UID_MIN in most distributions' login.defs; lower uids are system accounts.
const firstPersonUid = 1000;
const fail = (message: string) => new GatewayPlatformError({ message });
const asPlatformError = (error: { readonly message: string }) => fail(error.message);

const entry = Effect.fn("GatewayPlatform.linux.entry")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.lstat(file).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
});

const exec = Effect.fn("GatewayPlatform.linux.exec")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  return yield* runner
    .run({ command, args, timeout: "120 seconds", env: toolEnv })
    .pipe(Effect.mapError(asPlatformError));
});

const runTool = Effect.fn("GatewayPlatform.linux.runTool")(function* (
  command: string,
  args: ReadonlyArray<string>,
  acceptedCodes: ReadonlyArray<number> = [0],
) {
  const result = yield* exec(command, args);
  if (result.code === null || !acceptedCodes.includes(result.code)) {
    return yield* fail(
      `${command} ${args.join(" ")} failed (exit ${result.code}). ${result.stderr.trim()}`.trim(),
    );
  }
  return result;
});

const readPasswd = Effect.fn("GatewayPlatform.linux.readPasswd")(function* (user: string) {
  const result = yield* exec("getent", ["passwd", user]);
  const [name, , uidText, gidText, , home, shell] = result.stdout.trim().split(":");
  const uid = Number(uidText);
  const gid = Number(gidText);
  if (
    result.code !== 0 ||
    name !== user ||
    !/^\d+$/.test(uidText ?? "") ||
    !Number.isSafeInteger(uid) ||
    !/^\d+$/.test(gidText ?? "") ||
    !Number.isSafeInteger(gid)
  ) {
    return undefined;
  }
  return { name, uid, gid, home, shell };
});

const lookupUser = Effect.fn("GatewayPlatform.linux.lookupUser")(function* (name: string) {
  if (name === gatewayAccount) {
    return yield* fail(`The Linux account ${name} is reserved for the gateway.`);
  }
  const passwd = yield* readPasswd(name);
  if (passwd === undefined) return yield* fail(`Linux user ${name} was not found.`);
  if (passwd.uid === 0) return yield* fail(`Linux user ${name} is root and cannot be enrolled.`);
  if (passwd.uid < firstPersonUid) {
    return yield* fail(`Linux user ${name} is a system account and cannot be enrolled.`);
  }
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = passwd.home;
  const homeInfo =
    home && path.isAbsolute(home)
      ? yield* fs.stat(home).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.undefined,
          ),
        )
      : undefined;
  if (home === undefined || homeInfo?.type !== "Directory") {
    return yield* fail(`The home directory for ${name} does not exist or is not a directory.`);
  }
  return { name, accountId: passwd.uid, home } satisfies GatewayUserRecord;
}, Effect.mapError(asPlatformError));

const accountName = Effect.fn("GatewayPlatform.linux.accountName")(function* (
  accountId: GatewayAccountId,
) {
  if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId < 0) {
    return yield* fail(`Linux account id ${String(accountId)} is invalid.`);
  }
  const result = yield* exec("getent", ["passwd", String(accountId)]);
  const [name, , uidText] = result.stdout.trim().split(":");
  if (result.code !== 0 || name === undefined || Number(uidText) !== accountId) {
    return yield* fail(`Linux account ${accountId} was not found.`);
  }
  return name;
}, Effect.mapError(asPlatformError));

// A sticky shared ancestor cannot let another user replace the trusted entry below it.
const writableByOthers = (info: FileSystem.File.Info, ancestor: boolean | undefined) =>
  (info.mode & 0o022) !== 0 && !(ancestor && (info.mode & 0o1000) !== 0);

const checkAdminOwned = Effect.fn("GatewayPlatform.linux.checkAdminOwned")(function* (
  file: string,
  kind: "File" | "Directory",
  options?: { readonly ancestor?: boolean },
) {
  const info = yield* entry(file);
  if (info === undefined) return false;
  if (
    info.type !== kind ||
    Option.getOrUndefined(info.uid) !== 0 ||
    writableByOthers(info, options?.ancestor)
  ) {
    return yield* fail(
      kind === "Directory"
        ? `Expected a root-owned directory at ${file} writable only by root.`
        : `Expected a root-owned regular file at ${file} writable only by root.`,
    );
  }
  return true;
}, Effect.mapError(asPlatformError));

const checkRuntimeSource = Effect.fn("GatewayPlatform.linux.checkRuntimeSource")(function* (
  source: string,
  kind: "File" | "Directory",
  options?: { readonly ancestor?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.lstat(source);
  const uid = Option.getOrUndefined(info.uid);
  const sudoUid = (yield* HostProcess.Environment).SUDO_UID;
  const adminUid = sudoUid && /^\d+$/.test(sudoUid) ? Number(sudoUid) : undefined;
  if (info.type !== kind) return yield* fail(`Expected a ${kind.toLowerCase()} at ${source}.`);
  if (
    uid === undefined ||
    (uid !== 0 && uid !== adminUid) ||
    writableByOthers(info, options?.ancestor)
  ) {
    return yield* fail(
      `Runtime source requires trusted ownership and no group or world write access: ${source}.`,
    );
  }
}, Effect.mapError(asPlatformError));

// Explicit mode and owner so the result does not depend on root's umask.
const secureDirectory = Effect.fn("GatewayPlatform.linux.secureDirectory")(function* (
  directory: string,
  owner: "admin" | GatewayUserRecord,
) {
  let ids = { uid: 0, gid: 0 };
  if (owner !== "admin") {
    const passwd = yield* readPasswd(owner.name);
    if (passwd === undefined || passwd.uid !== owner.accountId) {
      return yield* fail(`Linux user ${owner.name} no longer has uid ${owner.accountId}.`);
    }
    ids = passwd;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o755 });
  if ((yield* fs.lstat(directory)).type !== "Directory") {
    return yield* fail(`Expected a directory at ${directory}.`);
  }
  yield* fs.chown(directory, ids.uid, ids.gid);
  yield* fs.chmod(directory, 0o755);
}, Effect.mapError(asPlatformError));

const secureRuntimeFile = Effect.fn("GatewayPlatform.linux.secureRuntimeFile")(function* (
  file: string,
  executable: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(file, executable ? 0o755 : 0o644);
}, Effect.mapError(asPlatformError));

// Coreutils walks by directory descriptor so a user cannot redirect root with a symlink swap.
const removeTree = Effect.fn("GatewayPlatform.linux.removeTree")(function* (directory: string) {
  const result = yield* exec("rm", [
    "--recursive",
    "--force",
    "--one-file-system",
    "--",
    directory,
  ]);
  if (result.code !== 0) return yield* fail(`Could not remove pairing directory ${directory}.`);
});

const replaceLink = Effect.fn("GatewayPlatform.linux.replaceLink")(
  function* (target: string, link: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staging = yield* fs.makeTempDirectoryScoped({
      directory: path.dirname(link),
      prefix: ".t3code-",
    });
    const stagedLink = path.join(staging, "link");
    yield* fs.symlink(target, stagedLink);
    yield* fs.rename(stagedLink, link);
  },
  Effect.scoped,
  Effect.mapError(asPlatformError),
);

const listeners = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tcp = yield* fs.readFileString("/proc/net/tcp");
  const tcp6 = yield* fs.readFileString("/proc/net/tcp6").pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(""),
    ),
  );
  return [tcp, tcp6].flatMap(parseProcNetTcp).map(({ port, uid }) => ({ port, owner: uid }));
}).pipe(Effect.mapError(asPlatformError));

const ensureGatewayAccount = Effect.gen(function* () {
  let result = yield* runTool("getent", ["passwd", gatewayAccount], [0, 2]);
  if (result.code === 2) {
    yield* runTool("useradd", [
      "--system",
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      gatewayAccount,
    ]);
    result = yield* runTool("getent", ["passwd", gatewayAccount]);
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
const helperInstancePattern = HELPER_SERVICE_UNIT_TEMPLATE.replace("@.", "@*.");
const isGatewayUnit = (name: string) =>
  name === GATEWAY_UNIT ||
  name === HELPER_SOCKET_UNIT ||
  (name.startsWith("t3code@") &&
    name.endsWith(".service") &&
    name !== GATEWAY_USER_UNIT_TEMPLATE) ||
  (name.startsWith("t3code-gateway-helper@") &&
    name.endsWith(".service") &&
    name !== HELPER_SERVICE_UNIT_TEMPLATE);
const userUnit = (user: string) => `t3code@${user}.service`;

const listUnits = Effect.fn("GatewayPlatform.linux.listUnits")(function* (
  listing: "active" | "loaded",
) {
  const { stdout } = yield* runTool("systemctl", [
    "list-units",
    "--plain",
    listing === "active" ? "--state=active" : "--all",
    "--no-legend",
    "--no-pager",
    GATEWAY_UNIT,
    instancePattern,
    HELPER_SOCKET_UNIT,
    helperInstancePattern,
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0]!)
    .filter(isGatewayUnit);
});

const readFragmentPath = Effect.fn("GatewayPlatform.linux.readFragmentPath")(function* (
  unit: string,
) {
  const { stdout } = yield* runTool("systemctl", [
    "show",
    "--property=FragmentPath",
    "--value",
    unit,
  ]);
  return stdout.trim();
});

const checkTemplateFragment = Effect.fn("GatewayPlatform.linux.checkTemplateFragment")(function* (
  unit: string,
  expected: string | undefined,
) {
  // Systemd cannot load a template by name. Its cat command resolves the exact template on disk.
  const result = yield* runTool("systemctl", ["cat", "--no-pager", unit], [0, 1]);
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

const hasManagedFragment = Effect.fn("GatewayPlatform.linux.hasManagedFragment")(function* (
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

const resetFailedUnits = Effect.fn("GatewayPlatform.linux.resetFailedUnits")(function* (
  ...units: ReadonlyArray<string>
) {
  // A unit that systemd has not loaded has no counters to reset.
  yield* runTool("systemctl", ["reset-failed", ...units]).pipe(Effect.ignore);
});

const waitForGateway = Effect.fn("GatewayPlatform.linux.waitForGateway")(
  function* (account: GatewayAccountId, port: number) {
    while (
      !(yield* listeners).some((listener) => listener.owner === account && listener.port === port)
    ) {
      yield* Effect.sleep("500 millis");
    }
  },
  (effect, _account, port) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => fail(`The gateway did not listen on port ${port} within 20 seconds.`),
      }),
    ),
);

/** Linux systemd adapter; `paths` are overridable so tests can point it at a temporary tree. */
export const makeLinuxGatewayPlatform = (paths: LinuxGatewayPaths): GatewayPlatform => {
  const gatewayUnitPath = `${paths.unitDir}/${GATEWAY_UNIT}`;
  const templatePath = `${paths.unitDir}/${GATEWAY_USER_UNIT_TEMPLATE}`;

  const checkUnitDirectories = Effect.gen(function* () {
    const path = yield* Path.Path;
    for (const directory of [path.dirname(paths.unitDir), paths.unitDir]) {
      yield* checkAdminOwned(directory, "Directory");
    }
  });

  const readManagedUnits = Effect.fn("GatewayPlatform.linux.readManagedUnits")(function* (
    command: "install" | "uninstall",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const units = new Map<string, string>();
    let unmanagedGateway = false;
    for (const unit of [
      GATEWAY_UNIT,
      GATEWAY_USER_UNIT_TEMPLATE,
      HELPER_SOCKET_UNIT,
      HELPER_SERVICE_UNIT_TEMPLATE,
    ]) {
      const file = path.join(paths.unitDir, unit);
      const info = yield* entry(file);
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

  const writeUnit = Effect.fn("GatewayPlatform.linux.writeUnit")(function* (
    unit: string,
    contents: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staging = yield* fs.makeTempDirectoryScoped({
      directory: paths.unitDir,
      prefix: ".t3code-",
    });
    const file = path.join(staging, unit);
    yield* fs.writeFileString(file, contents);
    yield* fs.chmod(file, 0o644);
    yield* fs.rename(file, path.join(paths.unitDir, unit));
  }, Effect.scoped);

  const enabledUnits = Effect.fn("GatewayPlatform.linux.enabledUnits")(function* (unitDir: string) {
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
      entry(path.join(wants, name)).pipe(Effect.map((info) => info?.type === "SymbolicLink")),
    );
  });

  const preflight = Effect.gen(function* () {
    yield* checkUnitDirectories;
    const { units: previousUnits } = yield* readManagedUnits("install");
    const previousGatewayFragment = previousUnits.has(GATEWAY_UNIT) ? gatewayUnitPath : undefined;
    const gatewayFragment = yield* readFragmentPath(GATEWAY_UNIT);
    if (gatewayFragment && gatewayFragment !== previousGatewayFragment) {
      return yield* fail(
        `Refusing to install: systemd loaded unmanaged unit ${GATEWAY_UNIT} from ${gatewayFragment}.`,
      );
    }
    const installed = (yield* entry(`${paths.installRoot}/current`)) !== undefined;
    if (!gatewayFragment && (installed || previousGatewayFragment !== undefined)) {
      return yield* fail(
        `Refusing to install: systemd did not load the installer-marked unit at ${gatewayUnitPath}.`,
      );
    }
    yield* checkTemplateFragment(
      GATEWAY_USER_UNIT_TEMPLATE,
      previousUnits.has(GATEWAY_USER_UNIT_TEMPLATE) ? templatePath : undefined,
    );
    yield* checkTemplateFragment(
      HELPER_SERVICE_UNIT_TEMPLATE,
      previousUnits.has(HELPER_SERVICE_UNIT_TEMPLATE)
        ? `${paths.unitDir}/${HELPER_SERVICE_UNIT_TEMPLATE}`
        : undefined,
    );
    const helperSocketFragment = yield* readFragmentPath(HELPER_SOCKET_UNIT);
    const previousHelperSocket = previousUnits.has(HELPER_SOCKET_UNIT)
      ? `${paths.unitDir}/${HELPER_SOCKET_UNIT}`
      : undefined;
    if (helperSocketFragment && helperSocketFragment !== previousHelperSocket) {
      return yield* fail(
        `Refusing to install: systemd loaded unmanaged unit ${HELPER_SOCKET_UNIT} from ${helperSocketFragment}.`,
      );
    }
  });

  const activate = Effect.fn("GatewayPlatform.linux.activate")(function* (
    activation: GatewayActivation,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const units = renderGatewayUnits(activation.executable);
    const { units: previousUnits } = yield* readManagedUnits("install");
    const previousGatewayFragment = previousUnits.has(GATEWAY_UNIT) ? gatewayUnitPath : undefined;
    const { port } = activation.config.listen;
    const restorePreviousRuntime = activation.restorePreviousRuntime;
    let rollbackStatus = "";
    const active = yield* Effect.gen(function* () {
      for (const [unit, contents] of Object.entries(units)) yield* writeUnit(unit, contents);
      yield* runTool("systemctl", ["daemon-reload"]);
      const active = yield* listUnits("active");
      if (!(yield* hasManagedFragment(GATEWAY_UNIT, gatewayUnitPath))) {
        return yield* fail(`systemd did not load the installed unit at ${gatewayUnitPath}.`);
      }
      if (
        !(yield* hasManagedFragment(HELPER_SOCKET_UNIT, `${paths.unitDir}/${HELPER_SOCKET_UNIT}`))
      ) {
        return yield* fail(`systemd did not load the installed helper socket unit.`);
      }
      yield* resetFailedUnits(GATEWAY_UNIT);
      yield* runTool("systemctl", ["enable", "--now", GATEWAY_UNIT]);
      yield* resetFailedUnits(HELPER_SOCKET_UNIT);
      yield* runTool("systemctl", ["enable", "--now", HELPER_SOCKET_UNIT]);
      if (active.includes(GATEWAY_UNIT)) yield* runTool("systemctl", ["restart", GATEWAY_UNIT]);
      yield* waitForGateway(activation.gatewayAccount, port);
      return active;
    }).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || restorePreviousRuntime === undefined) return Effect.void;
        return Effect.gen(function* () {
          const rollback = yield* Effect.gen(function* () {
            yield* restorePreviousRuntime;
            for (const unit of Object.keys(units)) {
              const contents = previousUnits.get(unit);
              if (contents === undefined) {
                yield* fs.remove(`${paths.unitDir}/${unit}`, { force: true });
              } else {
                yield* writeUnit(unit, contents);
              }
            }
            yield* runTool("systemctl", ["daemon-reload"]);
            if (!(yield* hasManagedFragment(GATEWAY_UNIT, previousGatewayFragment))) {
              return yield* fail(`systemd did not load the previous unit at ${gatewayUnitPath}.`);
            }
            yield* resetFailedUnits(GATEWAY_UNIT);
            yield* runTool("systemctl", ["restart", GATEWAY_UNIT]);
            yield* waitForGateway(activation.gatewayAccount, port);
          }).pipe(Effect.result);
          rollbackStatus = Result.isSuccess(rollback)
            ? "Restored the previous runtime and unit files. The gateway is listening."
            : `Rollback failed: ${rollback.failure.message}`;
          if (Exit.hasInterrupts(exit)) {
            yield* Console.warn(`${rollbackStatus} See ${logHint}.`);
          }
        });
      }),
      Effect.mapError((error) =>
        fail([error.message, rollbackStatus, `See ${logHint}.`].filter(Boolean).join(" ")),
      ),
    );

    const backends = yield* Effect.filter(
      active.filter(
        (unit) => unit.startsWith("t3code@") && unit.endsWith(".service") && unit !== GATEWAY_UNIT,
      ),
      (unit) => hasManagedFragment(unit, templatePath),
    );
    if (backends.length === 0) return;
    yield* resetFailedUnits(...backends);
    const restarted = yield* runTool("systemctl", ["try-restart", ...backends]).pipe(Effect.result);
    for (const unit of backends) {
      const state = yield* runTool("systemctl", ["is-active", unit], [0, 3, 4]).pipe(
        Effect.map(({ stdout }) => stdout.trim()),
        Effect.orElseSucceed(() => "unavailable"),
      );
      yield* Console.log(`${unit}: ${state || "unavailable"}`);
    }
    if (Result.isFailure(restarted)) return yield* restarted.failure;
  }, Effect.mapError(asPlatformError));

  const uninstall = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* checkUnitDirectories;
    const { units: managedFiles, unmanagedGateway } = yield* readManagedUnits("uninstall");
    const loadedUnits = yield* listUnits("loaded");
    const enabled = yield* enabledUnits(paths.unitDir);
    const runtimeEnabled = yield* enabledUnits(paths.runtimeUnitDir);
    const candidates = new Set([...loadedUnits, ...enabled, ...runtimeEnabled]);
    if (unmanagedGateway) candidates.delete(GATEWAY_UNIT);
    const gatewayFragment = managedFiles.has(GATEWAY_UNIT) ? gatewayUnitPath : undefined;
    const managed = new Set(
      yield* Effect.filter(candidates, (unit) =>
        hasManagedFragment(
          unit,
          unit === GATEWAY_UNIT
            ? gatewayFragment
            : unit === HELPER_SOCKET_UNIT
              ? `${paths.unitDir}/${HELPER_SOCKET_UNIT}`
              : unit.startsWith("t3code-gateway-helper@")
                ? `${paths.unitDir}/${HELPER_SERVICE_UNIT_TEMPLATE}`
                : templatePath,
        ),
      ),
    );
    const loaded = loadedUnits.filter((unit) => managed.has(unit));
    const persistent = enabled.filter((unit) => managed.has(unit));
    const runtime = runtimeEnabled.filter((unit) => managed.has(unit));
    if (loaded.length > 0) yield* runTool("systemctl", ["stop", ...loaded]);
    if (persistent.length > 0) yield* runTool("systemctl", ["disable", ...persistent]);
    if (runtime.length > 0) yield* runTool("systemctl", ["disable", "--runtime", ...runtime]);
    for (const unit of managedFiles.keys()) {
      yield* fs.remove(`${paths.unitDir}/${unit}`, { force: true });
    }
    yield* runTool("systemctl", ["daemon-reload"]);
  }).pipe(Effect.mapError(asPlatformError));

  const changeUserUnit = Effect.fn("GatewayPlatform.linux.changeUserUnit")(function* (
    action: "enable" | "disable",
    user: string,
  ) {
    const unit = userUnit(user);
    const result = yield* exec("systemctl", [action, "--now", unit]);
    if (result.code !== 0) {
      return yield* fail(`systemctl could not ${action} --now ${unit} (exit ${result.code}).`);
    }
  });

  const runDetached = Effect.fn("GatewayPlatform.linux.runDetached")(function* (
    label: string,
    argv: ReadonlyArray<string>,
  ) {
    if (!/^[a-z]+$/.test(label) || argv.length === 0) {
      return yield* fail("Detached jobs require a lowercase label and a non-empty command.");
    }
    const unit = `t3code-gateway-${label}`;
    const state = yield* exec("systemctl", ["show", "--property=ActiveState", "--value", unit]);
    if (state.code === 0) {
      const activeState = state.stdout.trim();
      if (["active", "activating", "deactivating", "reloading"].includes(activeState)) {
        return yield* fail(`Detached job ${unit} is already active.`);
      }
      yield* runTool("systemctl", ["reset-failed", unit]).pipe(Effect.ignore);
    } else if (state.code !== 1) {
      return yield* fail(`Could not inspect detached job ${unit}.`);
    }
    yield* runTool("systemd-run", [`--unit=${unit}`, "--collect", "--quiet", "--", ...argv]);
  }, Effect.mapError(asPlatformError));

  return {
    name: "linux",
    layout: {
      installRoot: paths.installRoot,
      launcher: paths.launcher,
      configPath: paths.configPath,
      pairingDir: paths.pairingDir,
      executableName: "t3",
      runtimeEntries: [
        ["client", "Directory"],
        ["node_modules", "Directory"],
        ["resource-monitor", "Directory"],
        ["lib", "Directory"],
        ["client/index.html", "File"],
        ["lib/libatomic.so.1", "File"],
      ],
    },
    currentAccount: Effect.gen(function* () {
      const uid = yield* HostProcess.UserId;
      if (uid === undefined) return yield* fail("Could not determine the current Linux uid.");
      return uid;
    }),
    isAdmin: Effect.map(HostProcess.UserId, (uid) => uid === 0),
    lookupUser,
    accountName,
    runtimeVersion: readRuntimeVersion("t3"),
    checkAdminOwned,
    checkRuntimeSource,
    secureDirectory,
    secureRuntimeFile,
    removeTree,
    replaceLink,
    listeners,
    makeConnectionOwner: Effect.succeed(async (backendPort: number, clientPort: number) =>
      loopbackPeerUid(await readTcpSockets(), backendPort, clientPort),
    ),
    markerAttribution: "file-owner",
    helperHost: "service",
    joinNeedsPassword: false,
    services: {
      ensureGatewayAccount,
      preflight: preflight.pipe(Effect.mapError(asPlatformError)),
      activate,
      enableUser: (user) => changeUserUnit("enable", user.name),
      disableUser: (user) => changeUserUnit("disable", user),
      userState: (user) =>
        exec("systemctl", ["is-active", userUnit(user)]).pipe(
          Effect.map((result) => result.stdout.trim() || "unavailable"),
        ),
      runDetached,
      uninstall,
      logHint,
    },
  };
};

export const linuxGatewayPlatform = makeLinuxGatewayPlatform(linuxGatewayPaths);
