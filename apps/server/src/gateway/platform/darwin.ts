import * as NodeNet from "node:net";

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
} from "./GatewayPlatform.ts";

export const GATEWAY_LABEL = "com.t3tools.t3code.gateway";
const backendLabelPrefix = "com.t3tools.t3code.backend.";
export const backendLabel = (user: string) => `${backendLabelPrefix}${user}`;
export const SOCKETS_LABEL = "com.t3tools.t3code.sockets";
export const HELPER_LABEL = "com.t3tools.t3code.helper";
const gatewayAccount = "_t3code";
const plistMarker = "<!-- Managed by t3 gateway install -->";
const servicePath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const toolEnv = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" };
// `launchctl print` exits with this when the domain has no such service.
const launchctlNotFound = 113;
const roleAccountIds = { first: 200, last: 400 };
// macOS gives people uids from 501; lower ones are system and role accounts.
const firstPersonUid = 500;
const userNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const darwinGatewayPaths = {
  installRoot: "/usr/local/t3code",
  launcher: "/usr/local/bin/t3",
  configPath: "/Library/Application Support/T3Code/gateway.json",
  pairingDir: "/Library/Application Support/T3Code/pairing",
  launchDaemonsDir: "/Library/LaunchDaemons",
  logDir: "/Library/Logs/T3Code",
  jobsDir: "/Library/Application Support/T3Code/jobs",
  ownerSocket: "/var/run/com.t3tools.t3code.sockets.sock",
};
type DarwinGatewayPaths = Omit<typeof darwinGatewayPaths, "jobsDir"> & {
  readonly jobsDir?: string;
};

const fail = (message: string) => new GatewayPlatformError({ message });
const asPlatformError = (error: { readonly message: string }) => fail(error.message);

const xmlEscape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export interface LaunchDaemonSpec {
  readonly label: string;
  readonly userName: string;
  readonly arguments: ReadonlyArray<string>;
  readonly home: string;
  readonly workingDirectory?: string | undefined;
  readonly log: string;
}

const plistKey = (name: string, indent = "\t") => `${indent}<key>${name}</key>`;
const plistString = (value: string, indent = "\t") =>
  `${indent}<string>${xmlEscape(value)}</string>`;
const plistArguments = (values: ReadonlyArray<string>) => [
  plistKey("ProgramArguments"),
  "\t<array>",
  ...values.map((value) => plistString(value, "\t\t")),
  "\t</array>",
];

/** A plist dict carrying the installer marker on its second line. */
const renderPlist = (body: ReadonlyArray<string>) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    plistMarker,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...body,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

export const renderLaunchDaemon = (spec: LaunchDaemonSpec) =>
  renderPlist([
    plistKey("Label"),
    plistString(spec.label),
    plistKey("UserName"),
    plistString(spec.userName),
    ...(spec.workingDirectory === undefined
      ? []
      : [plistKey("WorkingDirectory"), plistString(spec.workingDirectory)]),
    plistKey("EnvironmentVariables"),
    "\t<dict>",
    plistKey("HOME", "\t\t"),
    plistString(spec.home, "\t\t"),
    plistKey("PATH", "\t\t"),
    plistString(servicePath, "\t\t"),
    "\t</dict>",
    ...plistArguments(spec.arguments),
    plistKey("RunAtLoad"),
    "\t<true/>",
    plistKey("KeepAlive"),
    "\t<true/>",
    plistKey("ThrottleInterval"),
    "\t<integer>5</integer>",
    plistKey("StandardOutPath"),
    plistString(spec.log),
    plistKey("StandardErrorPath"),
    plistString(spec.log),
  ]);

const snapshotMarkers = { ps: "T3CODE-PS", end: "T3CODE-END" };
const ownerSnapshotScript = `/usr/sbin/netstat -anv -p tcp && echo ${snapshotMarkers.ps} && /bin/ps -axo pid=,uid= && echo ${snapshotMarkers.end}`;

/**
 * The owner-check helper: launchd accepts each connection to `socket` and runs one snapshot of
 * netstat and the process table on it. Only `uid` (and root) may connect.
 */
export const renderSocketsDaemon = (socket: string, uid: number) =>
  renderPlist([
    plistKey("Label"),
    plistString(SOCKETS_LABEL),
    plistKey("UserName"),
    plistString(gatewayAccount),
    ...plistArguments(["/bin/sh", "-c", ownerSnapshotScript]),
    plistKey("inetdCompatibility"),
    "\t<dict>",
    plistKey("Wait", "\t\t"),
    "\t\t<false/>",
    "\t</dict>",
    plistKey("Sockets"),
    "\t<dict>",
    plistKey("Listeners", "\t\t"),
    "\t\t<dict>",
    plistKey("SockPathName", "\t\t\t"),
    plistString(socket, "\t\t\t"),
    plistKey("SockPathOwner", "\t\t\t"),
    `\t\t\t<integer>${uid}</integer>`,
    plistKey("SockPathMode", "\t\t\t"),
    `\t\t\t<integer>${0o600}</integer>`,
    "\t\t</dict>",
    "\t</dict>",
  ]);

export const renderHelperDaemon = (executable: string, log: string) =>
  renderPlist([
    plistKey("Label"),
    plistString(HELPER_LABEL),
    plistKey("UserName"),
    plistString("root"),
    ...plistArguments([executable, "gateway", "helper"]),
    plistKey("inetdCompatibility"),
    "\t<dict>",
    plistKey("Wait", "\t\t"),
    "\t\t<false/>",
    "\t</dict>",
    plistKey("Sockets"),
    "\t<dict>",
    plistKey("Listeners", "\t\t"),
    "\t\t<dict>",
    plistKey("SockNodeName", "\t\t\t"),
    plistString("127.0.0.1", "\t\t\t"),
    plistKey("SockServiceName", "\t\t\t"),
    plistString("3774", "\t\t\t"),
    "\t\t</dict>",
    "\t</dict>",
    plistKey("RunAtLoad"),
    "\t<true/>",
    plistKey("KeepAlive"),
    "\t<false/>",
    plistKey("StandardOutPath"),
    plistString(log),
    plistKey("StandardErrorPath"),
    plistString(log),
  ]);

export const renderDetachedDaemon = (label: string, argv: ReadonlyArray<string>, log: string) =>
  renderPlist([
    plistKey("Label"),
    plistString(label),
    plistKey("UserName"),
    plistString("root"),
    ...plistArguments(argv),
    plistKey("RunAtLoad"),
    "\t<true/>",
    plistKey("KeepAlive"),
    "\t<false/>",
    plistKey("StandardOutPath"),
    plistString(log),
    plistKey("StandardErrorPath"),
    plistString(log),
  ]);

const isManagedPlist = (contents: string) => contents.split("\n", 2)[1] === plistMarker;

interface Endpoint {
  readonly address: string;
  /** Undefined for a wildcard port (`*.*`). */
  readonly port: number | undefined;
}

export interface NetstatRow {
  readonly local: Endpoint;
  readonly foreign: Endpoint;
  readonly state: string;
  readonly pid: number | undefined;
}

const parseEndpoint = (token: string): Endpoint | undefined => {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const portText = token.slice(dot + 1);
  if (portText === "*") return { address: token.slice(0, dot), port: undefined };
  return /^\d+$/.test(portText)
    ? { address: token.slice(0, dot), port: Number(portText) }
    : undefined;
};

/**
 * TCP rows of `netstat -anv -p tcp`. The `process:pid` column sits mid-row, right-aligned, and
 * process names can contain spaces, so the pid is the last `:<digits>` token; later columns are hex.
 */
export const parseNetstat = (output: string): Array<NetstatRow> =>
  output.split("\n").flatMap((line) => {
    const tokens = line.trim().split(/\s+/);
    if (!/^tcp(4|6|46)$/.test(tokens[0] ?? "")) return [];
    const local = parseEndpoint(tokens[3] ?? "");
    const foreign = parseEndpoint(tokens[4] ?? "");
    const state = tokens[5];
    if (local === undefined || foreign === undefined || state === undefined) return [];
    const pidText = tokens
      .slice(6)
      .findLast((token) => /:\d+$/.test(token))
      ?.split(":")
      .at(-1);
    const pid = pidText === undefined ? undefined : Number(pidText);
    return [{ local, foreign, state, pid: pid !== undefined && pid > 0 ? pid : undefined }];
  });

/** uid by pid from `ps -o pid=,uid=` lines. */
export const parseProcessOwners = (output: string) => {
  const owners = new Map<number, number>();
  for (const line of output.split("\n")) {
    const [pid, uid] = line.trim().split(/\s+/);
    if (pid && uid && /^\d+$/.test(pid) && /^\d+$/.test(uid)) owners.set(Number(pid), Number(uid));
  }
  return owners;
};

/** The sockets helper's output; undefined unless both commands finished. */
export const parseOwnerSnapshot = (output: string) => {
  const ps = output.search(new RegExp(`^${snapshotMarkers.ps}$`, "m"));
  if (ps < 0 || !output.endsWith(`\n${snapshotMarkers.end}\n`)) return undefined;
  return { rows: parseNetstat(output.slice(0, ps)), owners: parseProcessOwners(output.slice(ps)) };
};

const connectedStates = new Set(["ESTABLISHED", "SYN_RCVD"]);
const loopbackListenAddresses = new Set(["127.0.0.1", "*"]);

/**
 * The uid behind the backend end of our loopback connection. netstat names the listener's process
 * even for a connection not yet accepted; when that row is missing, every loopback listener on the
 * port must belong to one uid. Anything else fails closed.
 */
export const attributeConnection = (
  rows: ReadonlyArray<NetstatRow>,
  owners: ReadonlyMap<number, number>,
  backendPort: number,
  clientPort: number,
) => {
  const peers = rows.filter(
    (row) =>
      connectedStates.has(row.state) &&
      row.local.address === "127.0.0.1" &&
      row.local.port === backendPort &&
      row.foreign.address === "127.0.0.1" &&
      row.foreign.port === clientPort,
  );
  if (peers.length > 1) return undefined;
  const candidates =
    peers[0]?.pid !== undefined
      ? peers
      : rows.filter(
          (row) =>
            row.state === "LISTEN" &&
            row.local.port === backendPort &&
            loopbackListenAddresses.has(row.local.address),
        );
  const uids = new Set(
    candidates.map((row) => (row.pid === undefined ? undefined : owners.get(row.pid))),
  );
  const [uid] = uids;
  return uids.size === 1 ? uid : undefined;
};

/** `dscl . -read` attributes. A value list follows the key, or continuation lines when values have spaces. */
export const parseDsclRecord = (output: string) => {
  const attributes = new Map<string, Array<string>>();
  let current: Array<string> | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith(" ") && current !== undefined) {
      current.push(line.slice(1));
      continue;
    }
    const match = /^([A-Za-z0-9_:.-]+?):(?: (.*))?$/.exec(line);
    if (match === null) {
      current = undefined;
      continue;
    }
    current = match[2] === undefined ? [] : match[2].split(" ");
    attributes.set(match[1]!, current);
  }
  return attributes;
};

/** `name id` lines of `dscl . -list <path> <attribute>`. */
export const parseDsclList = (output: string) =>
  output.split("\n").flatMap((line) => {
    const [name, id] = line.trim().split(/\s+/);
    return name && id && /^-?\d+$/.test(id) ? [{ name, id: Number(id) }] : [];
  });

/** The top-level `state` of `launchctl print system/<label>`; nested blocks are indented further. */
export const parseLaunchctlState = (output: string) => /^\tstate = (.+)$/m.exec(output)?.[1];
const parseLaunchctlPath = (output: string) => /^\tpath = (.+)$/m.exec(output)?.[1];

const entry = Effect.fn("GatewayPlatform.darwin.entry")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.lstat(file).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
});

const exec = Effect.fn("GatewayPlatform.darwin.exec")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  return yield* runner
    .run({ command, args, timeout: "120 seconds", env: toolEnv })
    .pipe(Effect.mapError(asPlatformError));
});

const runTool = Effect.fn("GatewayPlatform.darwin.runTool")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const result = yield* exec(command, args);
  if (result.code !== 0) {
    return yield* fail(
      `${command} ${args.join(" ")} failed (exit ${result.code}). ${result.stderr.trim()}`.trim(),
    );
  }
  return result;
});

const dscl = "/usr/bin/dscl";
const launchctl = "/bin/launchctl";

const readAccount = Effect.fn("GatewayPlatform.darwin.readAccount")(function* (name: string) {
  const result = yield* exec(dscl, [
    ".",
    "-read",
    `/Users/${name}`,
    "UniqueID",
    "PrimaryGroupID",
    "NFSHomeDirectory",
    "UserShell",
  ]);
  if (result.code !== 0) {
    if (result.stderr.includes("eDSRecordNotFound")) return undefined;
    return yield* fail(`dscl could not read /Users/${name} (exit ${result.code}).`);
  }
  const record = parseDsclRecord(result.stdout);
  const id = (key: string) => {
    const [value, ...rest] = record.get(key) ?? [];
    return value !== undefined && rest.length === 0 && /^-?\d+$/.test(value)
      ? Number(value)
      : undefined;
  };
  return {
    uid: id("UniqueID"),
    gid: id("PrimaryGroupID"),
    home: record.get("NFSHomeDirectory")?.[0],
    shell: record.get("UserShell")?.[0],
  };
});

const lookupUser = Effect.fn("GatewayPlatform.darwin.lookupUser")(function* (name: string) {
  if (name === gatewayAccount) {
    return yield* fail(`The macOS account ${name} is reserved for the gateway.`);
  }
  if (!userNamePattern.test(name)) {
    return yield* fail(`${name} is not a macOS user that can be enrolled.`);
  }
  const account = yield* readAccount(name);
  if (account?.uid === undefined) return yield* fail(`macOS user ${name} was not found.`);
  if (account.uid === 0) return yield* fail(`macOS user ${name} is root and cannot be enrolled.`);
  if (account.uid < firstPersonUid) {
    return yield* fail(`macOS user ${name} is a system account (uid ${account.uid}).`);
  }
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = account.home;
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
  return { name, accountId: account.uid, home } satisfies GatewayUserRecord;
}, Effect.mapError(asPlatformError));

const accountName = Effect.fn("GatewayPlatform.darwin.accountName")(function* (
  accountId: GatewayAccountId,
) {
  if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId < 0) {
    return yield* fail(`macOS account id ${String(accountId)} is invalid.`);
  }
  const result = yield* exec(dscl, [".", "-search", "/Users", "UniqueID", String(accountId)]);
  if (result.code !== 0) {
    return yield* fail(`macOS account ${accountId} was not found.`);
  }
  const match = result.stdout.match(/^(?:\/Users\/)?([^\s]+)\s+UniqueID\s*=\s*(-?\d+)\s*$/m);
  if (match?.[2] !== String(accountId)) {
    return yield* fail(`macOS account ${accountId} was not found.`);
  }
  return match[1]!;
}, Effect.mapError(asPlatformError));

// SIP keeps these root-owned links to /private immutable, so they resolve like directories.
const systemLinks = ["/etc", "/tmp", "/var"];
const resolveSystemLinks = Effect.fn("GatewayPlatform.darwin.resolveSystemLinks")(function* (
  file: string,
) {
  const link = systemLinks.find((name) => file === name || file.startsWith(`${name}/`));
  if (link === undefined) return file;
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.realPath(link)) + file.slice(link.length);
});

// A sticky shared ancestor cannot let another user replace the trusted entry below it.
const writableByOthers = (info: FileSystem.File.Info, ancestor: boolean | undefined) =>
  (info.mode & 0o022) !== 0 && !(ancestor && (info.mode & 0o1000) !== 0);

const checkAdminOwned = Effect.fn("GatewayPlatform.darwin.checkAdminOwned")(function* (
  file: string,
  kind: "File" | "Directory",
  options?: { readonly ancestor?: boolean },
) {
  const info = yield* entry(yield* resolveSystemLinks(file));
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

const checkRuntimeSource = Effect.fn("GatewayPlatform.darwin.checkRuntimeSource")(function* (
  source: string,
  kind: "File" | "Directory",
  options?: { readonly ancestor?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.lstat(yield* resolveSystemLinks(source));
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

const accountIds = Effect.fn("GatewayPlatform.darwin.accountIds")(function* (
  owner: "admin" | GatewayUserRecord,
) {
  if (owner === "admin") return { uid: 0, gid: 0 };
  const account = yield* readAccount(owner.name);
  if (account?.uid !== owner.accountId || account.gid === undefined) {
    return yield* fail(`macOS user ${owner.name} no longer has uid ${owner.accountId}.`);
  }
  return { uid: account.uid, gid: account.gid };
});

// Explicit mode and owner so the result does not depend on root's umask.
const secureDirectory = Effect.fn("GatewayPlatform.darwin.secureDirectory")(function* (
  directory: string,
  owner: "admin" | GatewayUserRecord,
) {
  const ids = yield* accountIds(owner);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o755 });
  if ((yield* fs.lstat(directory)).type !== "Directory") {
    return yield* fail(`Expected a directory at ${directory}.`);
  }
  yield* fs.chown(directory, ids.uid, ids.gid);
  yield* fs.chmod(directory, 0o755);
}, Effect.mapError(asPlatformError));

const secureRuntimeFile = Effect.fn("GatewayPlatform.darwin.secureRuntimeFile")(function* (
  file: string,
  executable: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(file, executable ? 0o755 : 0o644);
}, Effect.mapError(asPlatformError));

// BSD rm walks with fts without following links; -x keeps it on one file system.
const removeTree = Effect.fn("GatewayPlatform.darwin.removeTree")(function* (directory: string) {
  const result = yield* exec("/bin/rm", ["-R", "-f", "-x", "--", directory]);
  if (result.code !== 0) return yield* fail(`Could not remove pairing directory ${directory}.`);
});

const replaceLink = Effect.fn("GatewayPlatform.darwin.replaceLink")(
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

const readNetstat = runTool("/usr/sbin/netstat", ["-anv", "-p", "tcp"]).pipe(
  Effect.map(({ stdout }) => parseNetstat(stdout)),
);

/** uid by pid; pids that have exited are missing. */
const processOwners = Effect.fn("GatewayPlatform.darwin.processOwners")(function* (
  pids: ReadonlyArray<number>,
) {
  if (pids.length === 0) return new Map<number, number>();
  // ps exits non-zero only when none of the pids exist.
  const { stdout } = yield* exec("/bin/ps", ["-o", "pid=,uid=", "-p", pids.join(",")]);
  return parseProcessOwners(stdout);
});

/**
 * Root commands run netstat themselves. The gateway cannot: macOS shows netstat rows only to a
 * root process or one whose responsible binary is Apple- or Developer ID-signed, which an ad hoc
 * signed t3 is not. It asks the sockets helper instead, see `readOwnerSnapshot`.
 */
const listeners = Effect.gen(function* () {
  const rows = (yield* readNetstat).filter(
    (row) => row.state === "LISTEN" && row.local.port !== undefined,
  );
  const owners = yield* processOwners([
    ...new Set(rows.flatMap((row) => (row.pid === undefined ? [] : [row.pid]))),
  ]);
  return rows.flatMap((row) => {
    const owner = row.pid === undefined ? undefined : owners.get(row.pid);
    return row.local.port === undefined || owner === undefined
      ? []
      : [{ port: row.local.port, owner }];
  });
});

const snapshotMaxBytes = 16 * 1024 * 1024;

/** Reads the sockets helper's whole reply; undefined on any error, 2 s of silence or an oversized reply. */
export const readOwnerSnapshot = (socketPath: string) =>
  new Promise<string | undefined>((resolve) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    const socket = NodeNet.connect({ path: socketPath, timeout: 2000 });
    const finish = (text?: string) => {
      socket.destroy();
      resolve(text);
    };
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > snapshotMaxBytes) finish();
      else chunks.push(chunk);
    });
    socket.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    socket.on("timeout", () => finish());
    socket.on("error", () => finish());
    socket.on("close", () => finish());
  });

const ensureGatewayAccount = Effect.gen(function* () {
  if ((yield* readAccount(gatewayAccount)) === undefined) {
    const used = Effect.fn("GatewayPlatform.darwin.usedIds")(function* (
      directory: string,
      attribute: string,
    ) {
      const { stdout } = yield* runTool(dscl, [".", "-list", directory, attribute]);
      return parseDsclList(stdout);
    });
    const users = yield* used("/Users", "UniqueID");
    const groups = yield* used("/Groups", "PrimaryGroupID");
    const taken = new Set([...users, ...groups].map(({ id }) => id));
    let id = roleAccountIds.first;
    while (taken.has(id)) id++;
    if (id > roleAccountIds.last) {
      return yield* fail(
        `No free id between ${roleAccountIds.first} and ${roleAccountIds.last} for ${gatewayAccount}.`,
      );
    }
    const existingGroup = groups.find(({ name }) => name === gatewayAccount);
    const set = (record: string, attribute: string, value: string) =>
      runTool(dscl, [".", "-create", record, attribute, value]);
    if (existingGroup === undefined) {
      const group = `/Groups/${gatewayAccount}`;
      yield* runTool(dscl, [".", "-create", group]);
      yield* set(group, "RealName", "T3 Code gateway");
      yield* set(group, "Password", "*");
      yield* set(group, "PrimaryGroupID", String(id));
    }
    const user = `/Users/${gatewayAccount}`;
    yield* runTool(dscl, [".", "-create", user]);
    yield* set(user, "RealName", "T3 Code gateway");
    yield* set(user, "UserShell", "/usr/bin/false");
    yield* set(user, "NFSHomeDirectory", "/var/empty");
    yield* set(user, "Password", "*");
    yield* set(user, "IsHidden", "1");
    yield* set(user, "PrimaryGroupID", String(existingGroup?.id ?? id));
    yield* set(user, "UniqueID", String(id));
  }
  const account = yield* readAccount(gatewayAccount);
  if (
    account?.uid === undefined ||
    account.uid === 0 ||
    account.gid === undefined ||
    (account.shell !== "/usr/bin/false" && account.shell !== "/sbin/nologin")
  ) {
    return yield* fail(
      `The macOS account ${gatewayAccount} must be a non-root account with a /usr/bin/false shell. Fix or delete it with \`dscl . -delete /Users/${gatewayAccount}\`.`,
    );
  }
  return account.uid;
});

const printService = Effect.fn("GatewayPlatform.darwin.printService")(function* (label: string) {
  const result = yield* exec(launchctl, ["print", `system/${label}`]);
  if (result.code === launchctlNotFound) return undefined;
  if (result.code !== 0) {
    return yield* fail(`launchctl could not read system/${label} (exit ${result.code}).`);
  }
  return result.stdout;
});

const pollUntil = Effect.fn("GatewayPlatform.darwin.pollUntil")(
  function* (
    condition: Effect.Effect<boolean, GatewayPlatformError, ProcessRunner.ProcessRunner>,
    _timeoutMessage: string,
    _duration: "10 seconds" | "20 seconds",
  ) {
    while (!(yield* condition)) yield* Effect.sleep("500 millis");
  },
  (effect, _condition, timeoutMessage, duration) =>
    effect.pipe(Effect.timeoutOrElse({ duration, orElse: () => fail(timeoutMessage) })),
);

/** Loads `file` unless launchd has it unchanged; returns the earlier `launchctl print` then. */
const loadService = Effect.fn("GatewayPlatform.darwin.loadService")(function* (
  label: string,
  file: string,
  changed: boolean,
) {
  const target = `system/${label}`;
  const printed = yield* printService(label);
  if (printed !== undefined && !changed) return printed;
  if (printed !== undefined) {
    yield* runTool(launchctl, ["bootout", target]);
    yield* pollUntil(
      Effect.map(printService(label), (output) => output === undefined),
      `launchd did not unload ${label} within 10 seconds.`,
      "10 seconds",
    );
  }
  // An administrator's `launchctl disable` would make bootstrap fail.
  yield* runTool(launchctl, ["enable", target]);
  yield* runTool(launchctl, ["bootstrap", "system", file]);
  return undefined;
});

/** Makes launchd run `label` from `file`; a changed definition is reloaded, which kickstart skips. */
const startService = Effect.fn("GatewayPlatform.darwin.startService")(function* (
  label: string,
  file: string,
  options: { readonly changed: boolean; readonly restart: boolean },
) {
  const printed = yield* loadService(label, file, options.changed);
  if (printed === undefined) return;
  if (options.restart) yield* runTool(launchctl, ["kickstart", "-k", `system/${label}`]);
  else if (parseLaunchctlState(printed) !== "running") {
    yield* runTool(launchctl, ["kickstart", `system/${label}`]);
  }
});

const stopService = Effect.fn("GatewayPlatform.darwin.stopService")(function* (label: string) {
  if ((yield* printService(label)) === undefined) return;
  yield* runTool(launchctl, ["bootout", `system/${label}`]);
});

const serviceState = Effect.fn("GatewayPlatform.darwin.serviceState")(function* (label: string) {
  const output = yield* printService(label);
  if (output === undefined) return "unavailable";
  const state = parseLaunchctlState(output);
  return state === "running"
    ? "running"
    : state === "not running"
      ? "stopped"
      : (state ?? "unknown");
});

const waitForGateway = (account: GatewayAccountId, port: number) =>
  pollUntil(
    Effect.map(listeners, (rows) =>
      rows.some((listener) => listener.owner === account && listener.port === port),
    ),
    `The gateway did not listen on port ${port} within 20 seconds.`,
    "20 seconds",
  );

/** macOS launchd adapter; `paths` are overridable so tests can point it at a temporary tree. */
export const makeDarwinGatewayPlatform = (paths: DarwinGatewayPaths): GatewayPlatform => {
  const logHint = `${paths.logDir}/gateway.log`;
  const plistPath = (label: string) => `${paths.launchDaemonsDir}/${label}.plist`;
  const gatewayPlist = plistPath(GATEWAY_LABEL);
  const helperPlist = plistPath(HELPER_LABEL);
  const jobsDir =
    paths.jobsDir ?? `${paths.configPath.slice(0, paths.configPath.lastIndexOf("/"))}/jobs`;

  const gatewaySpec = (executable: string): LaunchDaemonSpec => ({
    label: GATEWAY_LABEL,
    userName: gatewayAccount,
    arguments: [executable, "gateway", "run"],
    home: "/var/empty",
    log: `${paths.logDir}/gateway.log`,
  });
  const backendSpec = (user: GatewayUserRecord, executable: string): LaunchDaemonSpec => ({
    label: backendLabel(user.name),
    userName: user.name,
    arguments: [executable, "gateway", "run-backend"],
    home: user.home,
    workingDirectory: user.home,
    log: `${paths.logDir}/backend.${user.name}.log`,
  });

  const checkUserName = (user: string) =>
    userNamePattern.test(user)
      ? Effect.void
      : Effect.fail(fail(`${user} is not a macOS user name.`));

  const checkDaemonDirectories = Effect.gen(function* () {
    const path = yield* Path.Path;
    for (const directory of [path.dirname(paths.launchDaemonsDir), paths.launchDaemonsDir]) {
      yield* checkAdminOwned(directory, "Directory");
    }
  });

  /** The managed plist at `file`, undefined when absent; fails on anything else. */
  const readManagedPlist = Effect.fn("GatewayPlatform.darwin.readManagedPlist")(function* (
    file: string,
  ) {
    const info = yield* entry(file);
    if (info === undefined) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const contents = info.type === "File" ? yield* fs.readFileString(file) : undefined;
    if (contents === undefined || !isManagedPlist(contents)) {
      return yield* fail(`Refusing to modify unmanaged ${file}. Move it out of the way first.`);
    }
    return contents;
  });

  const managedPlistNames = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(paths.launchDaemonsDir))
      .filter(
        (name) =>
          name === `${GATEWAY_LABEL}.plist` ||
          name === `${HELPER_LABEL}.plist` ||
          name === `${SOCKETS_LABEL}.plist` ||
          (name.startsWith(backendLabelPrefix) && name.endsWith(".plist")),
      )
      .sort();
  });

  const writePlist = Effect.fn("GatewayPlatform.darwin.writePlist")(function* (
    file: string,
    contents: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staging = yield* fs.makeTempDirectoryScoped({
      directory: paths.launchDaemonsDir,
      prefix: ".t3code-",
    });
    const staged = path.join(staging, path.basename(file));
    yield* fs.writeFileString(staged, contents);
    // launchd refuses plists that are not root-owned or that others can write.
    yield* fs.chown(staged, 0, 0);
    yield* fs.chmod(staged, 0o644);
    yield* fs.rename(staged, file);
  }, Effect.scoped);

  /** Writes `contents` unless it is already there; returns whether launchd must reload it. */
  const definePlist = Effect.fn("GatewayPlatform.darwin.definePlist")(function* (
    label: string,
    contents: string,
  ) {
    const file = plistPath(label);
    const previous = yield* readManagedPlist(file);
    if (previous !== contents) yield* writePlist(file, contents);
    return { file, previous, changed: previous !== contents };
  });

  const defineJob = Effect.fn("GatewayPlatform.darwin.defineJob")(function* (
    spec: LaunchDaemonSpec,
    owner: number,
  ) {
    const fs = yield* FileSystem.FileSystem;
    // The log directory is root's; each job's log is its own so the job can always open it.
    yield* secureDirectory(paths.logDir, "admin");
    yield* checkAdminOwned(paths.logDir, "Directory");
    const log = yield* entry(spec.log);
    if (log !== undefined && log.type !== "File") {
      return yield* fail(`Expected a regular file or nothing at ${spec.log}.`);
    }
    yield* fs.writeFileString(spec.log, "", { flag: "a" });
    yield* fs.chown(spec.log, owner, 0);
    yield* fs.chmod(spec.log, 0o600);
    return yield* definePlist(spec.label, renderLaunchDaemon(spec));
  });

  const restorePlist = Effect.fn("GatewayPlatform.darwin.restorePlist")(function* (
    file: string,
    previous: string | undefined,
  ) {
    const fs = yield* FileSystem.FileSystem;
    if (previous === undefined) yield* fs.remove(file, { force: true });
    else yield* writePlist(file, previous);
  });

  const preflight = Effect.gen(function* () {
    yield* checkDaemonDirectories;
    for (const name of yield* managedPlistNames) {
      yield* readManagedPlist(`${paths.launchDaemonsDir}/${name}`);
    }
    const loaded = yield* printService(GATEWAY_LABEL);
    const loadedFrom = loaded === undefined ? undefined : parseLaunchctlPath(loaded);
    if (loaded !== undefined && loadedFrom !== gatewayPlist) {
      return yield* fail(
        `Refusing to install: launchd runs ${GATEWAY_LABEL} from ${loadedFrom ?? "an unknown definition"}, not ${gatewayPlist}.`,
      );
    }
    const helperLoaded = yield* printService(HELPER_LABEL);
    const helperFrom = helperLoaded === undefined ? undefined : parseLaunchctlPath(helperLoaded);
    if (helperLoaded !== undefined && helperFrom !== helperPlist) {
      return yield* fail(
        `Refusing to install: launchd runs ${HELPER_LABEL} from ${helperFrom ?? "an unknown definition"}, not ${helperPlist}.`,
      );
    }
  });

  const activate = Effect.fn("GatewayPlatform.darwin.activate")(function* (
    activation: GatewayActivation,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const { port } = activation.config.listen;
    const gatewayUid = activation.gatewayAccount;
    if (typeof gatewayUid !== "number") {
      return yield* fail(`Expected a numeric uid for ${gatewayAccount}.`);
    }
    yield* checkDaemonDirectories;
    const changed: Array<{ readonly file: string; readonly previous: string | undefined }> = [];
    const backends: Array<{ readonly label: string; readonly file: string; changed: boolean }> = [];
    let gateway: { readonly previous: string | undefined; readonly changed: boolean } | undefined;
    const restorePreviousRuntime = activation.restorePreviousRuntime;
    let rollbackStatus = "";
    yield* Effect.gen(function* () {
      // The gateway's owner checks need the helper. It does not depend on the runtime, so
      // rollback leaves it as is.
      const sockets = yield* definePlist(
        SOCKETS_LABEL,
        renderSocketsDaemon(paths.ownerSocket, gatewayUid),
      );
      yield* loadService(SOCKETS_LABEL, sockets.file, sockets.changed);
      const helper = yield* definePlist(
        HELPER_LABEL,
        renderHelperDaemon(activation.executable, `${paths.logDir}/helper.log`),
      );
      yield* secureDirectory(paths.logDir, "admin");
      yield* fs.writeFileString(`${paths.logDir}/helper.log`, "", { flag: "a" });
      yield* fs.chown(`${paths.logDir}/helper.log`, 0, 0);
      yield* fs.chmod(`${paths.logDir}/helper.log`, 0o600);
      yield* loadService(HELPER_LABEL, helper.file, helper.changed);
      if (helper.changed) changed.push({ file: helperPlist, previous: helper.previous });
      gateway = yield* defineJob(gatewaySpec(activation.executable), gatewayUid);
      if (gateway.changed) changed.push({ file: gatewayPlist, previous: gateway.previous });
      for (const user of activation.users) {
        if (typeof user.accountId !== "number") continue;
        const spec = backendSpec(user, activation.executable);
        const backend = yield* defineJob(spec, user.accountId);
        if (backend.changed) changed.push(backend);
        backends.push({ label: spec.label, file: backend.file, changed: backend.changed });
      }
      yield* startService(GATEWAY_LABEL, gatewayPlist, { changed: gateway.changed, restart: true });
      yield* waitForGateway(gatewayUid, port);
    }).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || restorePreviousRuntime === undefined) return Effect.void;
        return Effect.gen(function* () {
          const rollback = yield* Effect.gen(function* () {
            yield* restorePreviousRuntime;
            for (const { file, previous } of changed) yield* restorePlist(file, previous);
            if (gateway !== undefined && gateway.previous === undefined) {
              yield* stopService(GATEWAY_LABEL);
              return yield* fail(`There was no previous ${gatewayPlist} to restore.`);
            }
            // A changed definition may already be loaded, so launchd must reload the restored one.
            yield* startService(GATEWAY_LABEL, gatewayPlist, {
              changed: gateway?.changed ?? false,
              restart: true,
            });
            yield* waitForGateway(gatewayUid, port);
          }).pipe(Effect.result);
          rollbackStatus = Result.isSuccess(rollback)
            ? "Restored the previous runtime and launchd definitions. The gateway is listening."
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

    const failures: Array<string> = [];
    for (const backend of backends) {
      const started = yield* startService(backend.label, backend.file, {
        changed: backend.changed,
        restart: true,
      }).pipe(Effect.result);
      if (Result.isFailure(started)) failures.push(started.failure.message);
      const state = yield* serviceState(backend.label).pipe(
        Effect.orElseSucceed(() => "unavailable"),
      );
      yield* Console.log(`${backend.label}: ${state}`);
    }
    if (failures.length > 0) return yield* fail(failures.join(" "));
  }, Effect.mapError(asPlatformError));

  const enableUser = Effect.fn("GatewayPlatform.darwin.enableUser")(function* (
    user: GatewayUserRecord,
    executable: string,
  ) {
    yield* checkUserName(user.name);
    if (typeof user.accountId !== "number") {
      return yield* fail(`Expected a numeric uid for macOS user ${user.name}.`);
    }
    yield* checkDaemonDirectories;
    const spec = backendSpec(user, executable);
    const { file, changed } = yield* defineJob(spec, user.accountId);
    yield* startService(spec.label, file, { changed, restart: false });
  }, Effect.mapError(asPlatformError));

  const disableUser = Effect.fn("GatewayPlatform.darwin.disableUser")(function* (user: string) {
    yield* checkUserName(user);
    const label = backendLabel(user);
    const file = plistPath(label);
    yield* readManagedPlist(file);
    yield* stopService(label);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(file, { force: true });
  }, Effect.mapError(asPlatformError));

  const uninstall = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* checkDaemonDirectories;
    // The gateway goes first so nothing routes to a backend while it stops.
    const names = (yield* managedPlistNames).sort((a, b) =>
      a === `${GATEWAY_LABEL}.plist` ? -1 : b === `${GATEWAY_LABEL}.plist` ? 1 : 0,
    );
    for (const name of names) {
      const file = `${paths.launchDaemonsDir}/${name}`;
      const managed = yield* readManagedPlist(file).pipe(Effect.result);
      if (Result.isFailure(managed)) {
        yield* Console.warn(`Skipping ${file}: it has no installer marker.`);
        continue;
      }
      yield* stopService(name.slice(0, -".plist".length));
      yield* fs.remove(file, { force: true });
      if (name === `${SOCKETS_LABEL}.plist`) yield* fs.remove(paths.ownerSocket, { force: true });
    }
    const jobs = yield* fs.readDirectory(jobsDir).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
    );
    for (const name of jobs.filter((file) => /^com\.t3tools\.t3code\.[a-z]+\.plist$/.test(file))) {
      const file = `${jobsDir}/${name}`;
      const contents = yield* fs.readFileString(file).pipe(Effect.result);
      if (Result.isFailure(contents) || !isManagedPlist(contents.success)) {
        yield* Console.warn(`Skipping ${file}: it has no installer marker.`);
        continue;
      }
      yield* stopService(name.slice(0, -".plist".length));
      yield* fs.remove(file, { force: true });
    }
  }).pipe(Effect.mapError(asPlatformError));

  const runDetached = Effect.fn("GatewayPlatform.darwin.runDetached")(
    function* (label: string, argv: ReadonlyArray<string>) {
      if (!/^[a-z]+$/.test(label) || argv.length === 0) {
        return yield* fail("Detached jobs require a lowercase label and a non-empty command.");
      }
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const labelName = `com.t3tools.t3code.${label}`;
      const file = path.join(jobsDir, `${labelName}.plist`);
      const previous = yield* entry(file);
      if (previous !== undefined) {
        if (previous.type !== "File") return yield* fail(`Expected a regular file at ${file}.`);
        const contents = yield* fs.readFileString(file);
        if (!isManagedPlist(contents)) return yield* fail(`Refusing to modify unmanaged ${file}.`);
      }
      const loaded = yield* printService(labelName);
      if (loaded !== undefined && parseLaunchctlState(loaded) === "running") {
        return yield* fail(`Detached job ${labelName} is already running.`);
      }
      if (loaded !== undefined) yield* runTool(launchctl, ["bootout", `system/${labelName}`]);
      yield* secureDirectory(jobsDir, "admin");
      yield* checkAdminOwned(jobsDir, "Directory");
      yield* secureDirectory(paths.logDir, "admin");
      const log = path.join(paths.logDir, `${label}.log`);
      yield* fs.writeFileString(log, "", { flag: "a" });
      yield* fs.chown(log, 0, 0);
      yield* fs.chmod(log, 0o600);
      const staging = yield* fs.makeTempDirectoryScoped({ directory: jobsDir, prefix: ".t3code-" });
      const staged = path.join(staging, path.basename(file));
      yield* fs.writeFileString(staged, renderDetachedDaemon(labelName, argv, log));
      yield* fs.chown(staged, 0, 0);
      yield* fs.chmod(staged, 0o644);
      yield* fs.rename(staged, file);
      yield* runTool(launchctl, ["bootstrap", "system", file]);
    },
    Effect.scoped,
    Effect.mapError(asPlatformError),
  );

  return {
    name: "darwin",
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
        ["client/index.html", "File"],
      ],
    },
    currentAccount: Effect.gen(function* () {
      const uid = yield* HostProcess.UserId;
      if (uid === undefined) return yield* fail("Could not determine the current macOS uid.");
      return uid;
    }),
    isAdmin: Effect.map(HostProcess.UserId, (uid) => uid === 0),
    lookupUser,
    accountName,
    checkAdminOwned,
    checkRuntimeSource,
    secureDirectory,
    secureRuntimeFile,
    removeTree,
    replaceLink,
    listeners,
    makeConnectionOwner: Effect.succeed((backendPort, clientPort) =>
      readOwnerSnapshot(paths.ownerSocket)
        .then((output) => {
          const snapshot = output === undefined ? undefined : parseOwnerSnapshot(output);
          return (
            snapshot && attributeConnection(snapshot.rows, snapshot.owners, backendPort, clientPort)
          );
        })
        .catch(() => undefined),
    ),
    markerAttribution: "file-owner",
    helperHost: "service",
    joinNeedsPassword: false,
    services: {
      ensureGatewayAccount,
      preflight: preflight.pipe(Effect.mapError(asPlatformError)),
      activate,
      enableUser,
      disableUser,
      userState: (user) =>
        userNamePattern.test(user)
          ? serviceState(backendLabel(user))
          : Effect.succeed("unavailable"),
      runDetached,
      uninstall,
      logHint,
    },
  };
};

export const darwinGatewayPlatform = makeDarwinGatewayPlatform(darwinGatewayPaths);
