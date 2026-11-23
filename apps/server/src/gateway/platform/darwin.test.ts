import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ExitCode } from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import { emptyGatewayConfig } from "../GatewayConfig.ts";
import { currentGatewayPlatform, type GatewayActivation } from "./GatewayPlatform.ts";
import {
  backendLabel,
  darwinGatewayPaths,
  darwinGatewayPlatform,
  GATEWAY_LABEL,
  makeDarwinGatewayPlatform,
  parseDsclList,
  parseDsclRecord,
  parseLaunchctlState,
  parseNetstat,
  parseOwnerSnapshot,
  renderLaunchDaemon,
  renderHelperDaemon,
  HELPER_LABEL,
  renderSocketsDaemon,
  SOCKETS_LABEL,
} from "./darwin.ts";
import { makeTestGatewayRoot, posixOwnership } from "./testing.ts";

// Captured on macOS 27.2.1 (arm64) with LC_ALL=C.
const realNetstat = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs
tcp4       0      0  192.168.1.125.65044    172.217.194.188.5228   ESTABLISHED        23672         4874  131072  131072 Google Chrome He:28615  00102 00000008 000000000003f5fc 00000080 04000900      2      0 000000
tcp4       0      0  127.0.0.1.60075        *.*                    LISTEN                 0            0  131072  131072   T3 Code (Beta):26934  00100 00000106 0000000000039db9 00000001 00000800      1      0 000000
tcp6       0      0  fe80::c10a:b748:.1025  fe80::5f7:6a72:8.1026  ESTABLISHED           90            9  132108  132108 identityservices:3000   00102 00000204 0000000000013d53 00000001 04000900      2      0 000000
tcp46      0      0  *.3283                 *.*                    LISTEN                 0            0  131072  131072         ARDAgent:6650   00000 00000202 000000000000b708 00000040 00000800      2      0 000000
tcp4       0      0  127.0.0.1.56109        127.0.0.1.56110        ESTABLISHED            0            0  408300  146988           Python:49602  01003 00000000 000000000006d221 00000080 01000800      2      0 000000
tcp4       0      0  127.0.0.1.56110        127.0.0.1.56109        ESTABLISHED            0            0  408300  146988           Python:49600  00002 00000000 000000000006d220 00000080 04000900      2      0 000000
tcp4       0      0  127.0.0.1.56086        127.0.0.1.49234        TIME_WAIT            514          267  408128  146988   T3 Code (Beta):6067   02131 00000108 000000000006d059 00000081 04000900      0      0 000000
`;

const realDscl = {
  nud: "NFSHomeDirectory: /Users/nud\nPrimaryGroupID: 20\nUniqueID: 502\nUserShell: /bin/zsh\n",
  root: "NFSHomeDirectory: /var/root /private/var/root\nUniqueID: 0\nUserShell: /bin/sh\n",
  setup: "NFSHomeDirectory: /var/setup\nRealName:\n Setup User\nUniqueID: 248\n",
  missingKey: "UniqueID: 502\n",
};

// `launchctl print system/com.apple.fseventsd`, trimmed.
const realLaunchctlPrint = `system/com.apple.fseventsd = {
	active count = 3
	path = /System/Library/LaunchDaemons/com.apple.fseventsd.plist
	type = LaunchDaemon
	state = running

	resource coalition = {
		ID = 3102
		type = resource
		state = active
	}
	pid = 410
}
`;

const output = (stdout = "", code = 0, stderr = "") => ({
  stdout,
  stderr,
  code: ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const netstatLine = (local: string, foreign: string, state: string, process: string) =>
  `tcp4       0      0  ${local.padEnd(22)} ${foreign.padEnd(22)} ${state.padEnd(11)}          0            0  131072  131072 ${process.padStart(22)}  00100 00000106 0000000000039db9 00000001 00000800      1      0 000000`;

const listenLine = netstatLine("127.0.0.1.3801", "*.*", "LISTEN", "t3:800");

/** What the sockets helper prints: netstat, then the process table. */
const snapshot = (lines: ReadonlyArray<string>) =>
  [
    ...realNetstat.split("\n").slice(0, 2),
    ...lines,
    "T3CODE-PS",
    "    1     0",
    "  700   250",
    "  800   501",
    "  900   502",
    "T3CODE-END",
    "",
  ].join("\n");

/** Serves `reply` to every connection on a Unix socket at `socketPath` until the test ends. */
const serveSnapshot = (socketPath: string, reply: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.end(reply));
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(socketPath, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

const gatewayPid = 700;
const gatewayUid = 250;

const fixture = Effect.fn("darwinGatewayTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* makeTestGatewayRoot("t3-gateway-darwin-");
  const at = (...parts: ReadonlyArray<string>) => path.join(root, ...parts);
  const paths = {
    installRoot: at("usr/local/t3code"),
    launcher: at("usr/local/bin/t3"),
    configPath: at("Library/Application Support/T3Code/gateway.json"),
    pairingDir: at("Library/Application Support/T3Code/pairing"),
    launchDaemonsDir: at("Library/LaunchDaemons"),
    logDir: at("Library/Logs/T3Code"),
    jobsDir: at("Library/Application Support/T3Code/jobs"),
    ownerSocket: at("o.sock"),
  };
  yield* fs.makeDirectory(paths.launchDaemonsDir, { recursive: true, mode: 0o755 });
  yield* fs.makeDirectory(at("Library/Logs"), { recursive: true, mode: 0o755 });
  const platform = makeDarwinGatewayPlatform(paths);

  const calls: Array<string> = [];
  const users = new Map<string, Map<string, string>>();
  const groups = new Map<string, Map<string, string>>();
  const launchd = {
    loaded: new Map<string, string>(),
    failBootstrap: 0,
    failBootstrapOf: undefined as string | undefined,
    failing: new Set<string>(),
    stopped: new Set<string>(),
    gatewayListens: true,
    netstat: undefined as string | undefined,
    pids: new Map<number, number>([[gatewayPid, gatewayUid]]),
    failTools: false,
  };
  const record = (attributes: Map<string, string>) =>
    [...attributes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}: ${value}\n`)
      .join("");
  const setUser = (name: string, attributes: Record<string, string>) =>
    users.set(name, new Map(Object.entries(attributes)));

  const run: ProcessRunner.ProcessRunner["Service"]["run"] = ({ command, args, env }) =>
    Effect.sync(() => {
      assert.deepEqual(env, { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" });
      calls.push([command, ...args].join(" "));
      if (launchd.failTools) return output("", 1, "tool failed");
      switch (command) {
        case "/usr/bin/dscl": {
          const [, action, recordPath, attribute, value] = args;
          const [, kind, name] = recordPath!.split("/");
          const table = kind === "Users" ? users : groups;
          if (action === "-read") {
            const entry = table.get(name!);
            return entry === undefined
              ? output("", 56, "<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)\n")
              : output(record(entry));
          }
          if (action === "-list") {
            return output(
              [...table].map(([entry, attrs]) => `${entry} ${attrs.get(attribute!)}\n`).join(""),
            );
          }
          if (action === "-search") {
            const matches = [...table].flatMap(([entry, attrs]) =>
              // Real `dscl . -search` output: the value is an array on its own lines.
              attrs.get(attribute!) === value
                ? [`${entry}\t\t${attribute} = (\n    ${value}\n)\n`]
                : [],
            );
            return output(matches.join(""));
          }
          const entry = table.get(name!) ?? new Map<string, string>();
          table.set(name!, entry);
          if (attribute !== undefined) entry.set(attribute, value!);
          return output();
        }
        case "/bin/launchctl": {
          const label = (args[1] ?? "").replace("system/", "");
          switch (args[0]) {
            case "print": {
              const file = launchd.loaded.get(label);
              return file === undefined
                ? output(
                    "",
                    113,
                    `Bad request.\nCould not find service "${label}" in domain for system\n`,
                  )
                : output(
                    `system/${label} = {\n\tpath = ${file}\n\tstate = ${launchd.stopped.has(label) ? "not running" : "running"}\n}\n`,
                  );
            }
            case "bootstrap": {
              const bootstrapping = path.basename(args[2] ?? "", ".plist");
              if (
                launchd.failBootstrap > 0 &&
                (launchd.failBootstrapOf ?? bootstrapping) === bootstrapping
              ) {
                launchd.failBootstrap--;
                return output("", 5, "Bootstrap failed: 5: Input/output error\n");
              }
              const file = args[2]!;
              launchd.loaded.set(path.basename(file, ".plist"), file);
              return output();
            }
            case "bootout":
              launchd.loaded.delete(label);
              return output();
            case "kickstart": {
              const target = args.at(-1)!.replace("system/", "");
              return launchd.failing.has(target)
                ? output("", 1, "Could not kickstart service\n")
                : output();
            }
          }
          return output();
        }
        case "/usr/sbin/netstat": {
          if (launchd.netstat !== undefined) return output(launchd.netstat);
          const listening = launchd.loaded.has(GATEWAY_LABEL) && launchd.gatewayListens;
          return output(
            listening
              ? netstatLine(
                  `*.${emptyGatewayConfig.listen.port}`,
                  "*.*",
                  "LISTEN",
                  `t3:${gatewayPid}`,
                ) + "\n"
              : "",
          );
        }
        case "/bin/ps":
          return output(
            args[3]!
              .split(",")
              .flatMap((pid) => {
                const uid = launchd.pids.get(Number(pid));
                return uid === undefined ? [] : [`${pid.padStart(5)} ${String(uid).padStart(5)}\n`];
              })
              .join(""),
          );
      }
      return output();
    });

  const owners = new Map<string, number>();
  const ownership = new Map<string, [number, number]>();
  const stagedFs: FileSystem.FileSystem = {
    ...fs,
    lstat: (file) =>
      fs.lstat(file).pipe(
        Effect.map((info) => ({
          ...info,
          uid: Option.some(owners.get(file) ?? 0),
        })),
      ),
    realPath: (file) => (file === "/etc" ? Effect.succeed(at("private/etc")) : fs.realPath(file)),
    chown: (file, uid, gid) => Effect.sync(() => void ownership.set(file, [uid, gid])),
  };
  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, stagedFs),
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
      Effect.provideService(HostProcess.UserId, 0),
      Effect.provideService(HostProcess.Environment, { SUDO_UID: "501" }),
    );
  const alice = { name: "alice", accountId: 501, home: at("Users/alice") };
  const activation = (
    restorePreviousRuntime?: GatewayActivation["restorePreviousRuntime"],
    executable = "/usr/local/t3code/current/t3",
  ): GatewayActivation => ({
    executable,
    config: emptyGatewayConfig,
    gatewayAccount: gatewayUid,
    users: [alice],
    restorePreviousRuntime,
  });
  const plist = (label: string) => path.join(paths.launchDaemonsDir, `${label}.plist`);
  return {
    alice,
    at,
    calls,
    groups,
    launchd,
    owners,
    ownership,
    paths,
    platform,
    plist,
    provide,
    run,
    setUser,
    users,
    activate: (restore?: GatewayActivation["restorePreviousRuntime"], executable?: string) =>
      provide(platform.services.activate(activation(restore, executable))),
  };
});

const capture = (field: "log" | "warn", reports: Array<string>) =>
  Effect.updateService(Console.Console, (console) => ({
    ...console,
    [field]: (...args: ReadonlyArray<unknown>) => {
      reports.push(args.join(" "));
    },
  }));

describe("parsers", () => {
  it("reads the pid of every TCP row, including names with spaces and wildcard ports", () => {
    assert.deepEqual(
      parseNetstat(realNetstat).map((row) => [
        `${row.local.address}.${row.local.port ?? "*"}`,
        `${row.foreign.address}.${row.foreign.port ?? "*"}`,
        row.state,
        row.pid,
      ]),
      [
        ["192.168.1.125.65044", "172.217.194.188.5228", "ESTABLISHED", 28615],
        ["127.0.0.1.60075", "*.*", "LISTEN", 26934],
        ["fe80::c10a:b748:.1025", "fe80::5f7:6a72:8.1026", "ESTABLISHED", 3000],
        ["*.3283", "*.*", "LISTEN", 6650],
        ["127.0.0.1.56109", "127.0.0.1.56110", "ESTABLISHED", 49602],
        ["127.0.0.1.56110", "127.0.0.1.56109", "ESTABLISHED", 49600],
        ["127.0.0.1.56086", "127.0.0.1.49234", "TIME_WAIT", 6067],
      ],
    );
    assert.deepEqual(parseNetstat("tcp4 bad row\nudp4 0 0 *.5353 *.*\n"), []);
    assert.isUndefined(
      parseNetstat(netstatLine("127.0.0.1.3801", "*.*", "LISTEN", "kernel:0"))[0]?.pid,
    );
  });

  it("reads the sockets helper's netstat rows and process table only when both finished", () => {
    const parsed = parseOwnerSnapshot(snapshot([listenLine]));
    assert.deepEqual(
      parsed?.rows.map((row) => row.pid),
      [800],
    );
    assert.deepEqual(
      [...(parsed?.owners ?? [])],
      [
        [1, 0],
        [700, 250],
        [800, 501],
        [900, 502],
      ],
    );
    assert.isUndefined(parseOwnerSnapshot(snapshot([listenLine]).replace("T3CODE-END\n", "")));
    assert.isUndefined(parseOwnerSnapshot(realNetstat));
  });

  it.each([
    [
      realDscl.nud,
      { UniqueID: ["502"], NFSHomeDirectory: ["/Users/nud"], UserShell: ["/bin/zsh"] },
    ],
    [realDscl.root, { NFSHomeDirectory: ["/var/root", "/private/var/root"] }],
    [realDscl.setup, { RealName: ["Setup User"], UniqueID: ["248"] }],
    ["dsAttrTypeNative:IsHidden: 1\n", { "dsAttrTypeNative:IsHidden": ["1"] }],
  ] as const)("reads dscl attributes %#", (text, expected) => {
    const record = parseDsclRecord(text);
    for (const [key, values] of Object.entries(expected)) assert.deepEqual(record.get(key), values);
  });

  it("reads dscl id listings and the top-level launchctl state", () => {
    assert.deepEqual(parseDsclList("_oahd                    441\nnobody -2\ntypedelta 501\n"), [
      { name: "_oahd", id: 441 },
      { name: "nobody", id: -2 },
      { name: "typedelta", id: 501 },
    ]);
    assert.equal(parseLaunchctlState(realLaunchctlPrint), "running");
    assert.equal(
      parseLaunchctlState(
        "system/x = {\n\tstate = spawn scheduled\n\tjob = {\n\t\tstate = active\n",
      ),
      "spawn scheduled",
    );
  });
});

describe("launchd definitions", () => {
  it("renders an escaped LaunchDaemon with the installer marker", () => {
    assert.equal(
      renderLaunchDaemon({
        label: backendLabel("alice"),
        userName: "alice",
        arguments: ["/usr/local/t3code/current/t3", "gateway", "run-backend"],
        home: "/Users/a&b <c>",
        workingDirectory: "/Users/a&b <c>",
        log: '/Library/Logs/T3Code/backend."alice".log',
      }),
      `<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by t3 gateway install -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.t3tools.t3code.backend.alice</string>
	<key>UserName</key>
	<string>alice</string>
	<key>WorkingDirectory</key>
	<string>/Users/a&amp;b &lt;c&gt;</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>/Users/a&amp;b &lt;c&gt;</string>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/local/t3code/current/t3</string>
		<string>gateway</string>
		<string>run-backend</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>StandardOutPath</key>
	<string>/Library/Logs/T3Code/backend.&quot;alice&quot;.log</string>
	<key>StandardErrorPath</key>
	<string>/Library/Logs/T3Code/backend.&quot;alice&quot;.log</string>
</dict>
</plist>
`,
    );
  });

  it.effect("selects the macOS adapter with the system layout", () =>
    currentGatewayPlatform().pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.map((platform) => {
        assert.equal(platform.name, "darwin");
        assert.deepEqual(platform.layout, {
          installRoot: darwinGatewayPaths.installRoot,
          launcher: darwinGatewayPaths.launcher,
          configPath: darwinGatewayPaths.configPath,
          pairingDir: darwinGatewayPaths.pairingDir,
          executableName: "t3",
          runtimeEntries: [
            ["client", "Directory"],
            ["node_modules", "Directory"],
            ["resource-monitor", "Directory"],
            ["client/index.html", "File"],
          ],
        });
      }),
    ),
  );
});

// These run the adapter against real files and sockets with POSIX owners, modes and Unix
// sockets, none of which Windows has. Linux and macOS hosts run them.
describe.skipIf(!posixOwnership)("on a POSIX host", () => {
  it.layer(NodeServices.layer)("launchd services", (it) => {
    it.effect("first install writes root-owned definitions and starts gateway then backends", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, activate, alice, calls, launchd, ownership, paths, platform, plist, provide } =
          yield* fixture();
        yield* provide(platform.services.preflight);
        const reports: Array<string> = [];
        yield* activate().pipe(capture("log", reports));
        const gatewayFile = plist(GATEWAY_LABEL);
        const backendFile = plist(backendLabel("alice"));
        const socketsFile = plist(SOCKETS_LABEL);
        const helperFile = plist(HELPER_LABEL);
        assert.equal(
          yield* fs.readFileString(socketsFile),
          renderSocketsDaemon(paths.ownerSocket, gatewayUid),
        );
        assert.equal(
          yield* fs.readFileString(helperFile),
          renderHelperDaemon("/usr/local/t3code/current/t3", `${paths.logDir}/helper.log`),
        );
        assert.equal(
          yield* fs.readFileString(gatewayFile),
          renderLaunchDaemon({
            label: GATEWAY_LABEL,
            userName: "_t3code",
            arguments: ["/usr/local/t3code/current/t3", "gateway", "run"],
            home: "/var/empty",
            log: `${paths.logDir}/gateway.log`,
          }),
        );
        assert.include(yield* fs.readFileString(backendFile), `<string>${alice.home}</string>`);
        for (const file of [socketsFile, helperFile, gatewayFile, backendFile]) {
          assert.equal((yield* fs.stat(file)).mode & 0o777, 0o644);
        }
        assert.deepEqual(ownership.get(`${paths.logDir}/gateway.log`), [gatewayUid, 0]);
        assert.deepEqual(ownership.get(`${paths.logDir}/backend.alice.log`), [501, 0]);
        assert.equal((yield* fs.stat(`${paths.logDir}/backend.alice.log`)).mode & 0o777, 0o600);
        assert.deepEqual(ownership.get(paths.logDir), [0, 0]);
        assert.deepEqual(
          calls.filter((call) => !call.includes(" print ")),
          [
            `/bin/launchctl enable system/${SOCKETS_LABEL}`,
            `/bin/launchctl bootstrap system ${socketsFile}`,
            `/bin/launchctl enable system/${HELPER_LABEL}`,
            `/bin/launchctl bootstrap system ${helperFile}`,
            `/bin/launchctl enable system/${GATEWAY_LABEL}`,
            `/bin/launchctl bootstrap system ${gatewayFile}`,
            "/usr/sbin/netstat -anv -p tcp",
            `/bin/ps -o pid=,uid= -p ${gatewayPid}`,
            `/bin/launchctl enable system/${backendLabel("alice")}`,
            `/bin/launchctl bootstrap system ${backendFile}`,
          ],
        );
        assert.deepEqual(reports, [`${backendLabel("alice")}: running`]);
        assert.deepEqual(
          [...launchd.loaded.keys()],
          [SOCKETS_LABEL, HELPER_LABEL, GATEWAY_LABEL, backendLabel("alice")],
        );
        assert.sameMembers(yield* fs.readDirectory(paths.launchDaemonsDir), [
          `${backendLabel("alice")}.plist`,
          `${GATEWAY_LABEL}.plist`,
          `${SOCKETS_LABEL}.plist`,
          `${HELPER_LABEL}.plist`,
        ]);
        assert.isTrue(yield* fs.exists(at("Library/Logs/T3Code")));
      }),
    );

    it.effect("reactivating unchanged definitions only restarts the jobs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { activate, calls, plist } = yield* fixture();
        yield* activate();
        const before = yield* fs.stat(plist(GATEWAY_LABEL));
        calls.length = 0;
        yield* activate(Effect.void).pipe(capture("log", []));
        assert.deepEqual(
          calls.filter((call) => !/ print |\/ps |netstat/.test(call)),
          [
            `/bin/launchctl kickstart -k system/${GATEWAY_LABEL}`,
            `/bin/launchctl kickstart -k system/${backendLabel("alice")}`,
          ],
        );
        assert.deepEqual((yield* fs.stat(plist(GATEWAY_LABEL))).mtime, before.mtime);
      }),
    );

    it.effect("reloads a changed definition instead of kickstarting the stale one", () =>
      Effect.gen(function* () {
        const { activate, calls, plist } = yield* fixture();
        yield* activate();
        calls.length = 0;
        yield* activate(Effect.void, "/usr/local/t3code/other/t3").pipe(capture("log", []));
        const gatewayCalls = calls.filter(
          (call) => call.includes(GATEWAY_LABEL) && !call.includes(" print "),
        );
        assert.deepEqual(gatewayCalls, [
          `/bin/launchctl bootout system/${GATEWAY_LABEL}`,
          `/bin/launchctl enable system/${GATEWAY_LABEL}`,
          `/bin/launchctl bootstrap system ${plist(GATEWAY_LABEL)}`,
        ]);
      }),
    );

    it.effect("fails a first activation without a rollback and points at the log", () =>
      Effect.gen(function* () {
        const { activate, calls, launchd, platform, provide } = yield* fixture();
        yield* provide(platform.services.preflight);
        launchd.failBootstrapOf = GATEWAY_LABEL;
        launchd.failBootstrap = 1;
        const error = yield* Effect.flip(activate());
        assert.match(error.message, /bootstrap system .* failed \(exit 5\)\. Bootstrap failed/);
        assert.match(error.message, /See .*\/Library\/Logs\/T3Code\/gateway\.log\.$/);
        assert.notMatch(error.message, /Rollback|Restored/);
        assert.isFalse(
          calls.some((call) => call.includes(backendLabel("alice")) && call.includes("bootstrap")),
        );
      }),
    );

    it.effect.each([true, false])(
      "rolls back the runtime and definitions when the update fails (rollback works: %s)",
      (rollbackWorks) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { activate, calls, launchd, plist } = yield* fixture();
          yield* activate();
          const previous = yield* fs.readFileString(plist(GATEWAY_LABEL));
          const previousBackend = yield* fs.readFileString(plist(backendLabel("alice")));
          launchd.failBootstrap = rollbackWorks ? 1 : 2;
          launchd.failBootstrapOf = GATEWAY_LABEL;
          calls.length = 0;
          const error = yield* Effect.flip(
            activate(
              Effect.sync(() => void calls.push("restore runtime")),
              "/usr/local/t3code/other/t3",
            ),
          );
          assert.match(
            error.message,
            rollbackWorks
              ? /failed \(exit 5\).*Restored the previous runtime and launchd definitions\. The gateway is listening\./
              : /Rollback failed: .*bootstrap/,
          );
          assert.include(error.message, "See ");
          assert.equal(yield* fs.readFileString(plist(GATEWAY_LABEL)), previous);
          assert.equal(yield* fs.readFileString(plist(backendLabel("alice"))), previousBackend);
          assert.include(calls, "restore runtime");
          assert.isFalse(
            calls.some((call) => call.includes(`kickstart -k system/${backendLabel("alice")}`)),
          );
          assert.equal(launchd.loaded.has(GATEWAY_LABEL), rollbackWorks);
        }),
    );

    it.effect("rolls back before touching the gateway when the sockets helper fails to load", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { activate, calls, launchd, plist } = yield* fixture();
        yield* activate();
        const previous = yield* fs.readFileString(plist(GATEWAY_LABEL));
        yield* fs.writeFileString(
          plist(SOCKETS_LABEL),
          renderSocketsDaemon("/var/run/old.sock", gatewayUid),
        );
        launchd.failBootstrap = 1;
        calls.length = 0;
        const error = yield* Effect.flip(
          activate(
            Effect.sync(() => void calls.push("restore runtime")),
            "/usr/local/t3code/other/t3",
          ),
        );
        assert.match(error.message, /bootstrap system .*sockets\.plist failed.*Restored/);
        assert.include(calls, "restore runtime");
        assert.equal(yield* fs.readFileString(plist(GATEWAY_LABEL)), previous);
      }),
    );

    it.effect("reports a failing backend after the gateway is up without rolling back", () =>
      Effect.gen(function* () {
        const { activate, calls, launchd } = yield* fixture();
        yield* activate();
        launchd.failing.add(backendLabel("alice"));
        const reports: Array<string> = [];
        const error = yield* Effect.flip(
          activate(Effect.sync(() => void calls.push("restore runtime"))).pipe(
            capture("log", reports),
          ),
        );
        assert.match(
          error.message,
          /kickstart -k system\/com\.t3tools\.t3code\.backend\.alice failed/,
        );
        assert.deepEqual(reports, [`${backendLabel("alice")}: running`]);
        assert.notInclude(calls, "restore runtime");
      }),
    );

    it.effect("refuses unmanaged definitions or a gateway loaded from elsewhere", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, calls, launchd, platform, plist, provide } = yield* fixture();
        const preflight = provide(platform.services.preflight);
        const manual = '<?xml version="1.0"?>\n<plist version="1.0"><dict/></plist>\n';
        yield* fs.writeFileString(plist(backendLabel("bob")), manual);
        assert.match(
          (yield* Effect.flip(preflight)).message,
          /Refusing to modify unmanaged .*backend\.bob\.plist/,
        );
        yield* fs.remove(plist(backendLabel("bob")));
        yield* fs.writeFileString(plist(SOCKETS_LABEL), manual);
        assert.match(
          (yield* Effect.flip(preflight)).message,
          /Refusing to modify unmanaged .*sockets\.plist/,
        );
        yield* fs.remove(plist(SOCKETS_LABEL));
        yield* fs.makeDirectory(plist(GATEWAY_LABEL));
        assert.match((yield* Effect.flip(preflight)).message, /Refusing to modify unmanaged/);
        yield* fs.remove(plist(GATEWAY_LABEL), { recursive: true });
        launchd.loaded.set(GATEWAY_LABEL, at("elsewhere.plist"));
        assert.match(
          (yield* Effect.flip(preflight)).message,
          /launchd runs com\.t3tools\.t3code\.gateway from .*elsewhere\.plist/,
        );
        assert.isFalse(calls.some((call) => /bootstrap|bootout|kickstart/.test(call)));
      }),
    );

    it.effect("enables, reports and disables one user's backend", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { alice, calls, launchd, platform, plist, provide } = yield* fixture();
        const { enableUser, disableUser, userState } = platform.services;
        const label = backendLabel("alice");
        assert.equal(yield* provide(userState("alice")), "unavailable");
        yield* provide(enableUser(alice, "/usr/local/t3code/current/t3"));
        yield* provide(enableUser(alice, "/usr/local/t3code/current/t3"));
        assert.equal(yield* provide(userState("alice")), "running");
        launchd.stopped.add(label);
        assert.equal(yield* provide(userState("alice")), "stopped");
        yield* provide(enableUser(alice, "/usr/local/t3code/current/t3"));
        yield* provide(disableUser("alice"));
        yield* provide(disableUser("alice"));
        assert.isFalse(yield* fs.exists(plist(label)));
        assert.equal(yield* provide(userState("alice")), "unavailable");
        assert.deepEqual(
          calls.filter((call) => !call.includes(" print ")),
          [
            `/bin/launchctl enable system/${label}`,
            `/bin/launchctl bootstrap system ${plist(label)}`,
            `/bin/launchctl kickstart system/${label}`,
            `/bin/launchctl bootout system/${label}`,
          ],
        );

        const manual = "<plist/>\n";
        yield* fs.writeFileString(plist(label), manual);
        assert.match(
          (yield* Effect.flip(provide(disableUser("alice")))).message,
          /Refusing to modify unmanaged/,
        );
        assert.equal(yield* fs.readFileString(plist(label)), manual);
        assert.match(
          (yield* Effect.flip(provide(disableUser("../evil")))).message,
          /not a macOS user name/,
        );
      }),
    );

    it.effect("writes and bootstraps a detached launchd job", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { calls, paths, platform, provide } = yield* fixture();
        yield* provide(
          platform.services.runDetached("update", [
            "/usr/local/t3code/staged/t3",
            "gateway",
            "install",
          ]),
        );
        const file = `${paths.jobsDir}/com.t3tools.t3code.update.plist`;
        assert.include(yield* fs.readFileString(file), "<key>KeepAlive</key>");
        assert.include(yield* fs.readFileString(file), "<false/>");
        assert.include(calls, `/bin/launchctl bootstrap system ${file}`);
      }),
    );

    it.effect("refuses a linked log file or a log folder others own", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { alice, at, owners, ownership, paths, platform, provide } = yield* fixture();
        const enable = provide(platform.services.enableUser(alice, "/usr/local/t3code/current/t3"));
        const target = at("etc-sudoers");
        yield* fs.writeFileString(target, "root only");
        yield* fs.chmod(target, 0o440);
        yield* fs.makeDirectory(paths.logDir, { mode: 0o755 });
        const log = `${paths.logDir}/backend.alice.log`;
        yield* fs.symlink(target, log);
        assert.include((yield* Effect.flip(enable)).message, log);
        assert.equal(yield* fs.readFileString(target), "root only");
        assert.equal((yield* fs.stat(target)).mode & 0o777, 0o440);
        assert.isFalse(ownership.has(log) || ownership.has(target));

        yield* fs.remove(log);
        owners.set(paths.logDir, 501);
        assert.include((yield* Effect.flip(enable)).message, paths.logDir);
        assert.isFalse(yield* fs.exists(log));
      }),
    );

    it.effect("uninstall stops the gateway first and keeps definitions it does not manage", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { activate, calls, launchd, paths, platform, plist, provide } = yield* fixture();
        yield* activate();
        const manual = "<plist/>\n";
        yield* fs.writeFileString(plist(backendLabel("manual")), manual);
        yield* fs.writeFileString(plist("com.t3tools.t3code.boot"), manual);
        launchd.loaded.set(backendLabel("manual"), plist(backendLabel("manual")));
        // launchd may leave the socket file behind.
        yield* fs.writeFileString(paths.ownerSocket, "");
        calls.length = 0;
        const warnings: Array<string> = [];
        yield* provide(platform.services.uninstall).pipe(capture("warn", warnings));
        assert.deepEqual(
          calls.filter((call) => !call.includes(" print ")),
          [
            `/bin/launchctl bootout system/${GATEWAY_LABEL}`,
            `/bin/launchctl bootout system/${backendLabel("alice")}`,
            `/bin/launchctl bootout system/${HELPER_LABEL}`,
            `/bin/launchctl bootout system/${SOCKETS_LABEL}`,
          ],
        );
        assert.isFalse(yield* fs.exists(paths.ownerSocket));
        assert.isTrue(warnings.some((warning) => warning.includes("backend.manual.plist")));
        assert.sameMembers(yield* fs.readDirectory(paths.launchDaemonsDir), [
          `${backendLabel("manual")}.plist`,
          "com.t3tools.t3code.boot.plist",
        ]);
        calls.length = 0;
        yield* provide(platform.services.uninstall).pipe(capture("warn", []));
        assert.isFalse(calls.some((call) => call.includes("bootout")));
      }),
    );

    it.effect("creates the hidden role account with a free id once", () =>
      Effect.gen(function* () {
        const { calls, groups, platform, provide, setUser, users } = yield* fixture();
        setUser("_spotlight", { UniqueID: "200" });
        setUser("typedelta", { UniqueID: "501" });
        groups.set("_guest", new Map([["PrimaryGroupID", "201"]]));
        const ensure = provide(platform.services.ensureGatewayAccount);
        assert.equal(yield* ensure, 202);
        assert.equal(yield* ensure, 202);
        assert.deepEqual(Object.fromEntries(users.get("_t3code")!), {
          RealName: "T3 Code gateway",
          UserShell: "/usr/bin/false",
          NFSHomeDirectory: "/var/empty",
          Password: "*",
          IsHidden: "1",
          PrimaryGroupID: "202",
          UniqueID: "202",
        });
        assert.equal(groups.get("_t3code")?.get("PrimaryGroupID"), "202");
        const read =
          "/usr/bin/dscl . -read /Users/_t3code UniqueID PrimaryGroupID NFSHomeDirectory UserShell";
        assert.deepEqual(calls.slice(0, 4), [
          read,
          "/usr/bin/dscl . -list /Users UniqueID",
          "/usr/bin/dscl . -list /Groups PrimaryGroupID",
          "/usr/bin/dscl . -create /Groups/_t3code",
        ]);
        assert.deepEqual(calls.slice(-2), [read, read]);

        for (const bad of [
          { UniqueID: "202", PrimaryGroupID: "202", UserShell: "/bin/zsh" },
          { UniqueID: "0", PrimaryGroupID: "0", UserShell: "/usr/bin/false" },
        ]) {
          setUser("_t3code", bad);
          assert.include(
            (yield* Effect.flip(ensure)).message,
            "must be a non-root account with a /usr/bin/false shell",
          );
        }
      }),
    );
  });

  it.layer(NodeServices.layer)("accounts and ownership", (it) => {
    it.effect(
      "looks up people and refuses the role, system, root, unknown or homeless accounts",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { at, calls, platform, provide, setUser } = yield* fixture();
          yield* fs.makeDirectory(at("Users/alice"), { recursive: true });
          setUser("alice", {
            UniqueID: "501",
            PrimaryGroupID: "20",
            NFSHomeDirectory: at("Users/alice"),
          });
          setUser("bob", {
            UniqueID: "502",
            PrimaryGroupID: "20",
            NFSHomeDirectory: at("missing"),
          });
          setUser("root", {
            UniqueID: "0",
            PrimaryGroupID: "0",
            NFSHomeDirectory: "/var/root /private/var/root",
          });
          setUser("daemon", { UniqueID: "1", PrimaryGroupID: "1", NFSHomeDirectory: "/var/root" });
          setUser("nobody", {
            UniqueID: "-2",
            PrimaryGroupID: "-2",
            NFSHomeDirectory: "/var/empty",
          });
          assert.deepEqual(yield* provide(platform.lookupUser("alice")), {
            name: "alice",
            accountId: 501,
            home: at("Users/alice"),
          });
          assert.equal(yield* provide(platform.accountName(501)), "alice");
          for (const [user, expected] of [
            ["_t3code", /reserved for the gateway/],
            ["../Groups/admin", /not a macOS user that can be enrolled/],
            ["bob", /home directory for bob does not exist/],
            ["root", /root and cannot be enrolled/],
            ["daemon", /system account \(uid 1\)/],
            ["nobody", /system account \(uid -2\)/],
            ["carol", /macOS user carol was not found/],
          ] as const) {
            assert.match(
              (yield* Effect.flip(provide(platform.lookupUser(user)))).message,
              expected,
            );
          }
          assert.isFalse(calls.some((call) => call.includes("_t3code") || call.includes("Groups")));
        }),
    );

    it.effect("secures directories for root or the user's own uid and primary group", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { alice, at, ownership, platform, provide, setUser } = yield* fixture();
        setUser("alice", { UniqueID: "501", PrimaryGroupID: "20", NFSHomeDirectory: alice.home });
        const shared = at("pairing");
        const own = at("pairing/alice");
        yield* provide(platform.secureDirectory(shared, "admin"));
        yield* fs.chmod(shared, 0o700);
        yield* provide(platform.secureDirectory(shared, "admin"));
        yield* provide(platform.secureDirectory(own, alice));
        assert.deepEqual(ownership.get(shared), [0, 0]);
        assert.deepEqual(ownership.get(own), [501, 20]);
        for (const directory of [shared, own]) {
          assert.equal((yield* fs.stat(directory)).mode & 0o777, 0o755);
        }
        const moved = provide(platform.secureDirectory(own, { ...alice, accountId: 505 }));
        assert.include((yield* Effect.flip(moved)).message, "no longer has uid 505");
      }),
    );

    it.effect("trusts only root-owned entries that others cannot write, through /etc", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, owners, platform, provide } = yield* fixture();
        const directory = at("private/etc/t3code");
        const file = at("private/etc/t3code/gateway.json");
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(file, "{}");
        for (const [checked, entry, kind, uid, mode, ancestor, trusted] of [
          ["/etc/t3code/gateway.json", file, "File", 0, 0o644, false, true],
          ["/etc/t3code/gateway.json", file, "File", 501, 0o644, false, false],
          ["/etc/t3code/gateway.json", file, "File", 0, 0o664, false, false],
          ["/etc/t3code/gateway.json", file, "File", 0, 0o646, false, false],
          ["/etc/t3code/gateway.json", file, "Directory", 0, 0o644, false, false],
          ["/etc/t3code", directory, "Directory", 0, 0o755, false, true],
          [directory, directory, "Directory", 0, 0o775, false, false],
          [directory, directory, "Directory", 0, 0o1777, false, false],
          [directory, directory, "Directory", 0, 0o1777, true, true],
          ["/etc", at("private/etc"), "Directory", 0, 0o755, false, true],
        ] as const) {
          owners.set(entry, uid);
          yield* fs.chmod(entry, mode);
          const result = yield* Effect.result(
            provide(platform.checkAdminOwned(checked, kind, { ancestor })),
          );
          assert.equal(
            Result.isSuccess(result) ? result.success : "rejected",
            trusted || "rejected",
            `${checked} ${kind} ${uid} ${mode.toString(8)}`,
          );
        }
        assert.isFalse(yield* provide(platform.checkAdminOwned("/etc/t3code/absent", "File")));
      }),
    );

    it.effect("trusts archive entries owned by root or the sudo admin", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, owners, platform, provide } = yield* fixture();
        const file = at("archive/t3");
        const directory = at("archive");
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(file, "binary");
        for (const [entry, kind, uid, mode, ancestor, trusted] of [
          [file, "File", 501, 0o755, false, true],
          [file, "File", 502, 0o755, false, false],
          [file, "File", 501, 0o775, false, false],
          [directory, "Directory", 0, 0o1777, false, false],
          [directory, "Directory", 0, 0o1777, true, true],
        ] as const) {
          owners.set(entry, uid);
          yield* fs.chmod(entry, mode);
          const result = yield* Effect.result(
            provide(platform.checkRuntimeSource(entry, kind, { ancestor })),
          );
          assert.propertyVal(result, "_tag", trusted ? "Success" : "Failure");
        }
      }),
    );

    it.effect("removes a pairing folder with BSD rm on one file system", () =>
      Effect.gen(function* () {
        const { calls, launchd, platform, provide } = yield* fixture();
        const folder = "/Library/Application Support/T3Code/pairing/alice";
        yield* provide(platform.removeTree(folder));
        assert.deepEqual(calls, [`/bin/rm -R -f -x -- ${folder}`]);
        launchd.failTools = true;
        assert.include(
          (yield* Effect.flip(provide(platform.removeTree(folder)))).message,
          "Could not remove pairing directory",
        );
      }),
    );

    it.effect("lists listeners with their owners and skips exited processes", () =>
      Effect.gen(function* () {
        const { launchd, platform, provide } = yield* fixture();
        launchd.netstat = realNetstat;
        launchd.pids = new Map([
          [26934, 501],
          [6650, 0],
        ]);
        assert.deepEqual(yield* provide(platform.listeners), [
          { port: 60075, owner: 501 },
          { port: 3283, owner: 0 },
        ]);
      }),
    );

    it.effect.each([
      [
        "the accepting end",
        [
          netstatLine("127.0.0.1.3801", "127.0.0.1.50000", "ESTABLISHED", "t3:800"),
          netstatLine("127.0.0.1.50000", "127.0.0.1.3801", "ESTABLISHED", "t3:700"),
          netstatLine("127.0.0.1.3801", "*.*", "LISTEN", "t3:900"),
        ],
        501,
      ],
      [
        "the listener when the accepting end is missing",
        [netstatLine("127.0.0.1.3801", "*.*", "LISTEN", "t3:800")],
        501,
      ],
      [
        "nobody when two accounts listen",
        [
          netstatLine("127.0.0.1.3801", "*.*", "LISTEN", "t3:800"),
          netstatLine("*.3801", "*.*", "LISTEN", "t3:900"),
        ],
        undefined,
      ],
      [
        "nobody when the listener has exited",
        [netstatLine("127.0.0.1.3801", "*.*", "LISTEN", "t3:801")],
        undefined,
      ],
      ["nobody when no one listens", [], undefined],
    ] as const)("attributes a backend connection to %s", ([, lines, expected]) =>
      Effect.gen(function* () {
        const { paths, platform, provide } = yield* fixture();
        yield* serveSnapshot(paths.ownerSocket, snapshot(lines));
        const owner = yield* provide(platform.makeConnectionOwner);
        assert.equal(yield* Effect.promise(() => owner(3801, 50000)), expected);
      }),
    );

    it.effect.each([
      ["the helper is not there", undefined],
      ["the helper stops early", snapshot([listenLine]).split("T3CODE-PS")[0]!],
      ["the process table is cut short", snapshot([listenLine]).replace("T3CODE-END\n", "")],
      ["the helper sends garbage", "netstat: sysctl: Operation not permitted\n"],
    ] as const)("fails closed when %s", ([, reply]) =>
      Effect.gen(function* () {
        const { calls, paths, platform, provide } = yield* fixture();
        if (reply !== undefined) yield* serveSnapshot(paths.ownerSocket, reply);
        const owner = yield* provide(platform.makeConnectionOwner);
        assert.isUndefined(yield* Effect.promise(() => owner(3801, 50000)));
        assert.deepEqual(calls, []);
      }),
    );
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "darwin")("on macOS", () => {
  it.layer(NodeServices.layer)("links", (it) => {
    it.effect("leaves replaced links readable by everyone whatever the caller's umask", () =>
      Effect.gen(function* () {
        const root = yield* makeTestGatewayRoot("t3-darwin-link-");
        const link = `${root}/current`;
        const previous = process.umask(0o077);
        yield* darwinGatewayPlatform
          .replaceLink(`${root}/runtime`, link)
          .pipe(
            Effect.provide(ProcessRunner.layer),
            Effect.ensuring(Effect.sync(() => process.umask(previous))),
          );
        assert.equal(NodeFS.lstatSync(link).mode & 0o777, 0o755);
      }),
    );
  });
});
