import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../../processRunner.ts";
import { emptyGatewayConfig } from "../GatewayConfig.ts";
import { currentGatewayPlatform, type GatewayActivation } from "./GatewayPlatform.ts";
import {
  GATEWAY_UNIT,
  GATEWAY_USER_UNIT_TEMPLATE,
  HELPER_SERVICE_UNIT_TEMPLATE,
  linuxGatewayPaths,
  makeLinuxGatewayPlatform,
  renderGatewayUnits,
} from "./linux.ts";
import { posixOwnership } from "./testing.ts";

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

const fixture = Effect.fn("linuxGatewayTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-linux-" });
  const at = (...parts: ReadonlyArray<string>) => path.join(root, ...parts);
  const paths = {
    installRoot: at("opt", "t3code"),
    launcher: at("usr", "local", "bin", "t3"),
    configPath: at("etc", "t3code", "gateway.json"),
    pairingDir: at("var", "lib", "t3code", "pairing"),
    unitDir: at("etc", "systemd", "system"),
    runtimeUnitDir: at("run", "systemd", "system"),
  };
  yield* fs.makeDirectory(paths.unitDir, { recursive: true, mode: 0o755 });
  const platform = makeLinuxGatewayPlatform(paths);

  const calls: Array<string> = [];
  const manager = {
    active: "",
    loaded: "",
    fragments: new Map<string, string>(),
    passwd: new Map<string, string>(),
    failEnable: false,
    failAll: false,
    listenerUid: 123,
    failBackendRestart: false,
    rollbackListenerUid: undefined as number | undefined,
    detachedState: "" as string,
  };
  const listenerRead = yield* Deferred.make<void>();
  const rollbackListenerRead = yield* Deferred.make<void>();
  const owners = new Map<string, number>();
  const ownership = new Map<string, [number, number]>();
  let gatewayRestarts = 0;
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = ({ command, args, env }) =>
    Effect.gen(function* () {
      assert.equal(env?.PATH, "/usr/sbin:/usr/bin:/sbin:/bin");
      calls.push([command, ...args].join(" "));
      if (manager.failAll) return output("", 1, "Unit not found");
      if (command === "getent") {
        const entry = manager.passwd.get(args[1]!);
        return entry === undefined ? output("", 2) : output(entry + "\n");
      }
      if (command === "useradd") {
        manager.passwd.set("t3code", "t3code:x:123:123::/nonexistent:/usr/sbin/nologin");
        return output();
      }
      if (command !== "systemctl") return output();
      const unit = args.at(-1)!;
      const unitFile = (name: string) =>
        path.join(
          paths.unitDir,
          name.startsWith("t3code@") && name !== GATEWAY_USER_UNIT_TEMPLATE
            ? GATEWAY_USER_UNIT_TEMPLATE
            : name.startsWith("t3code-gateway-helper@") && name !== HELPER_SERVICE_UNIT_TEMPLATE
              ? HELPER_SERVICE_UNIT_TEMPLATE
              : name,
        );
      switch (args[0]) {
        case "list-units":
          return output(args.includes("--state=active") ? manager.active : manager.loaded);
        case "enable":
          return output("", manager.failEnable ? 1 : 0);
        case "restart":
          if (unit === GATEWAY_UNIT && ++gatewayRestarts === 2) {
            manager.listenerUid = manager.rollbackListenerUid ?? manager.listenerUid;
          }
          return output();
        case "try-restart":
          return output("", manager.failBackendRestart ? 1 : 0);
        case "is-active":
          return manager.failBackendRestart ? output("failed\n", 3) : output("active\n");
        case "stop":
          manager.loaded = "";
          return output();
        case "disable": {
          const runtime = args[1] === "--runtime";
          const wants = path.join(
            runtime ? paths.runtimeUnitDir : paths.unitDir,
            "multi-user.target.wants",
          );
          for (const name of args.slice(runtime ? 2 : 1)) yield* fs.remove(path.join(wants, name));
          return output();
        }
        case "show":
        case "cat": {
          if (args[0] === "show" && args.includes("ActiveState")) {
            return manager.detachedState === ""
              ? output("", 1, "Unit not found")
              : output(`${manager.detachedState}\n`);
          }
          const file = unitFile(unit);
          const fragment = manager.fragments.get(unit) ?? ((yield* fs.exists(file)) ? file : "");
          if (args[0] === "show") return output(fragment + "\n");
          return fragment
            ? output(`# ${fragment}\n[Unit]\n`)
            : output("", 1, `No files found for ${unit}.\n`);
        }
      }
      return output();
    }).pipe(Effect.orDie);
  const stagedFs: FileSystem.FileSystem = {
    ...fs,
    lstat: (file) =>
      fs.lstat(file).pipe(
        Effect.map((info) => ({
          ...info,
          uid: Option.some(owners.get(file) ?? 0),
          // The temporary root's shared ancestors are not under test.
          mode: root.startsWith(file + "/") ? info.mode & ~0o022 : info.mode,
        })),
      ),
    readFileString: (file, encoding) => {
      if (file === "/proc/net/tcp") {
        const signal =
          gatewayRestarts === 0
            ? Effect.void
            : Deferred.succeed(
                gatewayRestarts === 1 ? listenerRead : rollbackListenerRead,
                undefined,
              );
        return signal.pipe(
          Effect.as(
            `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid\n0: 00000000:${emptyGatewayConfig.listen.port.toString(16)} 00000000:0000 0A 0:0 0:0 0 ${manager.listenerUid}\n`,
          ),
        );
      }
      if (file === "/proc/net/tcp6") return Effect.succeed("");
      return fs.readFileString(file, encoding);
    },
    chown: (file, uid, gid) => Effect.sync(() => void ownership.set(file, [uid, gid])),
  };
  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, stagedFs),
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
      Effect.provideService(HostProcess.UserId, 0),
      Effect.provideService(HostProcess.Environment, { SUDO_UID: "1001" }),
    );
  const activation = (
    restorePreviousRuntime?: GatewayActivation["restorePreviousRuntime"],
  ): GatewayActivation => ({
    executable: at("opt/t3code/current/t3"),
    config: emptyGatewayConfig,
    gatewayAccount: 123,
    users: [],
    restorePreviousRuntime,
  });
  return {
    at,
    calls,
    manager,
    owners,
    ownership,
    paths,
    platform,
    provide,
    listenerRead,
    rollbackListenerRead,
    gatewayRestarts: () => gatewayRestarts,
    activate: (restore?: GatewayActivation["restorePreviousRuntime"]) =>
      provide(platform.services.activate(activation(restore))),
    preflight: provide(platform.services.preflight),
    uninstall: provide(platform.services.uninstall),
  };
});

const capture = (field: "log" | "warn", reports: Array<string>) =>
  Effect.updateService(Console.Console, (console) => ({
    ...console,
    [field]: (...args: ReadonlyArray<unknown>) => {
      reports.push(args.join(" "));
    },
  }));

const unitLookups = [
  "systemctl show --property=FragmentPath --value t3code-gateway.service",
  "systemctl cat --no-pager t3code@.service",
  "systemctl cat --no-pager t3code-gateway-helper@.service",
  "systemctl show --property=FragmentPath --value t3code-gateway-helper.socket",
];

it("renders the gateway and per-user systemd units", () => {
  const units = renderGatewayUnits("/opt/t3code/current/t3");
  assert.equal(
    units[GATEWAY_UNIT],
    `# Managed by t3 gateway install
[Unit]
Description=T3 Code multi-user gateway
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
User=t3code
ExecStart=/opt/t3code/current/t3 gateway run
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=
PrivateDevices=yes
LockPersonality=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
`,
  );
  assert.equal(
    units[GATEWAY_USER_UNIT_TEMPLATE],
    `# Managed by t3 gateway install
[Unit]
Description=T3 Code backend for %i
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
User=%i
WorkingDirectory=~
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/opt/t3code/current/t3 gateway run-backend
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`,
  );
  assert.include(units["t3code-gateway-helper.socket"], "ListenStream=127.0.0.1:3774");
  assert.include(units["t3code-gateway-helper.socket"], "Accept=yes");
  assert.include(units["t3code-gateway-helper@.service"], "StandardInput=socket");
  assert.include(
    units["t3code-gateway-helper@.service"],
    "ExecStart=/opt/t3code/current/t3 gateway helper",
  );
});

describe("platform selection", () => {
  it.effect("selects the Linux adapter with the system paths", () =>
    currentGatewayPlatform().pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.map((platform) => {
        assert.equal(platform.name, "linux");
        assert.equal(platform.layout.configPath, linuxGatewayPaths.configPath);
      }),
    ),
  );

  it.effect("fails cleanly on unsupported platforms", () =>
    Effect.flip(currentGatewayPlatform()).pipe(
      Effect.provideService(HostProcess.Platform, "aix"),
      Effect.map((error) => assert.include(error.message, "not supported on aix")),
    ),
  );
});

// These run the adapter against real files and sockets with POSIX owners, modes and Unix
// sockets, none of which Windows has. Linux and macOS hosts run them.
describe.skipIf(!posixOwnership)("on a POSIX host", () => {
  it.layer(NodeServices.layer)("systemd services", (it) => {
    it.effect("activates the gateway and restarts running managed backends on update", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, activate, calls, manager, preflight } = yield* fixture();
        yield* preflight;
        yield* activate();
        for (const [name, contents] of Object.entries(
          renderGatewayUnits(at("opt/t3code/current/t3")),
        )) {
          const file = at("etc/systemd/system", name);
          assert.equal(yield* fs.readFileString(file), contents);
          assert.equal((yield* fs.stat(file)).mode & 0o777, 0o644);
        }
        assert.deepEqual(calls, [
          ...unitLookups,
          "systemctl daemon-reload",
          "systemctl list-units --plain --state=active --no-legend --no-pager t3code-gateway.service t3code@*.service t3code-gateway-helper.socket t3code-gateway-helper@*.service",
          "systemctl show --property=FragmentPath --value t3code-gateway.service",
          "systemctl show --property=FragmentPath --value t3code-gateway-helper.socket",
          "systemctl reset-failed t3code-gateway.service",
          "systemctl enable --now t3code-gateway.service",
          "systemctl reset-failed t3code-gateway-helper.socket",
          "systemctl enable --now t3code-gateway-helper.socket",
        ]);

        manager.active = [
          "t3code-gateway.service loaded active running Gateway",
          "t3code@alice.service loaded active running Backend",
          "t3code@custom.service loaded active running Custom",
          "",
        ].join("\n");
        manager.fragments.set(
          "t3code@custom.service",
          at("etc/systemd/system/t3code@custom.service"),
        );
        const warnings: Array<string> = [];
        yield* preflight;
        yield* activate(Effect.void).pipe(capture("warn", warnings));
        assert.isTrue(warnings.some((report) => report.includes("Skipping t3code@custom.service")));
        assert.deepEqual(calls.slice(-6), [
          "systemctl restart t3code-gateway.service",
          "systemctl show --property=FragmentPath --value t3code@alice.service",
          "systemctl show --property=FragmentPath --value t3code@custom.service",
          "systemctl reset-failed t3code@alice.service",
          "systemctl try-restart t3code@alice.service",
          "systemctl is-active t3code@alice.service",
        ]);
      }),
    );

    it.effect("fails a first activation without a rollback and points at the journal", () =>
      Effect.gen(function* () {
        const { activate, calls, manager } = yield* fixture();
        manager.failEnable = true;
        const error = yield* Effect.flip(activate());
        assert.match(error.message, /enable --now t3code-gateway.service failed/);
        assert.match(error.message, /See journalctl -u t3code-gateway.service\.$/);
        assert.notMatch(error.message, /Rollback|Restored/);
        assert.notInclude(calls, "systemctl restart t3code-gateway.service");
      }),
    );

    it.effect.each(["ready", "timeout", "interrupt"] as const)(
      "restores previous units and checks the rollback listener (%s)",
      (outcome) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { at, activate, calls, listenerRead, rollbackListenerRead, manager, ...rest } =
            yield* fixture();
          yield* activate();
          const previousUnits = Object.entries(renderGatewayUnits(at("opt/t3code/current/t3"))).map(
            ([name, contents]) =>
              [at("etc/systemd/system", name), contents + "# Previous unit contents\n"] as const,
          );
          for (const [file, contents] of previousUnits) yield* fs.writeFileString(file, contents);
          manager.active =
            "t3code-gateway.service loaded active running Gateway\nt3code@alice.service loaded active running Backend\n";
          manager.listenerUid = 1001;
          manager.rollbackListenerUid = outcome === "timeout" ? 1001 : 123;
          calls.length = 0;
          const update = yield* Effect.forkScoped(
            activate(Effect.sync(() => void calls.push("restore runtime"))),
          );
          yield* Effect.raceFirst(
            Deferred.await(listenerRead),
            Fiber.await(update).pipe(Effect.flatMap(Effect.die)),
          );
          if (outcome === "interrupt") {
            yield* Fiber.interrupt(update);
          } else {
            yield* TestClock.adjust("20 seconds");
          }
          const rollbackRead =
            outcome === "interrupt"
              ? yield* Deferred.isDone(rollbackListenerRead)
              : yield* Effect.raceFirst(
                  Deferred.await(rollbackListenerRead).pipe(Effect.as(true)),
                  Fiber.await(update).pipe(Effect.as(false)),
                );
          assert.isTrue(rollbackRead, "the rollback must check for the restored listener");
          if (outcome === "timeout") yield* TestClock.adjust("20 seconds");
          if (outcome !== "interrupt") {
            const error = yield* Effect.flip(Fiber.join(update));
            assert.match(
              error.message,
              outcome === "ready" ? /Restored the previous runtime/ : /Rollback failed/,
            );
            assert.include(error.message, "See journalctl -u t3code-gateway.service");
          }
          for (const [file, contents] of previousUnits) {
            assert.equal(yield* fs.readFileString(file), contents);
          }
          assert.equal(rest.gatewayRestarts(), 2);
          assert.deepEqual(calls.slice(-5), [
            "restore runtime",
            "systemctl daemon-reload",
            "systemctl show --property=FragmentPath --value t3code-gateway.service",
            "systemctl reset-failed t3code-gateway.service",
            "systemctl restart t3code-gateway.service",
          ]);
          assert.notInclude(calls, "systemctl try-restart t3code@alice.service");
        }),
    );

    it.effect("reports failed backend states without rolling back the gateway", () =>
      Effect.gen(function* () {
        const { activate, calls, manager } = yield* fixture();
        yield* activate();
        manager.active = "t3code@alice.service loaded active running Backend\n";
        manager.failBackendRestart = true;
        const reports: Array<string> = [];
        const error = yield* Effect.flip(
          activate(Effect.sync(() => void calls.push("restore runtime"))).pipe(
            capture("log", reports),
          ),
        );
        assert.match(error.message, /try-restart t3code@alice.service/);
        assert.deepEqual(reports, ["t3code@alice.service: failed"]);
        assert.notInclude(calls, "restore runtime");
        assert.include(calls, "systemctl is-active t3code@alice.service");
      }),
    );

    it.effect("refuses to replace or remove a unit without the installer marker", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, calls, preflight, uninstall } = yield* fixture();
        const unit = at("etc/systemd/system", GATEWAY_USER_UNIT_TEMPLATE);
        const manualUnit = "[Unit]\nDescription=Manual backend\n";
        yield* fs.writeFileString(unit, manualUnit);
        for (const operation of [preflight, uninstall]) {
          assert.match((yield* Effect.flip(operation)).message, /Refusing.*unmanaged unit/);
        }
        assert.deepEqual(calls, []);
        assert.equal(yield* fs.readFileString(unit), manualUnit);

        yield* fs.remove(unit);
        yield* fs.symlink(at("elsewhere"), at("etc/systemd/system", GATEWAY_UNIT));
        assert.match((yield* Effect.flip(preflight)).message, /Expected a regular file/);
        assert.deepEqual(calls, []);
      }),
    );

    it.effect.each([GATEWAY_UNIT, GATEWAY_USER_UNIT_TEMPLATE])(
      "refuses first install when an effective %s already exists elsewhere",
      (unit) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { at, calls, manager, paths, preflight } = yield* fixture();
          const fragment = at("run/systemd/system", unit);
          manager.fragments.set(unit, fragment);
          const error = yield* Effect.flip(preflight);
          assert.include(error.message, unit);
          assert.include(error.message, fragment);
          assert.deepEqual(yield* fs.readDirectory(paths.unitDir), []);
          assert.isFalse(
            calls.some((call) => /systemctl (daemon-reload|enable|restart)\b/.test(call)),
          );
        }),
    );

    it.effect("refuses an installed runtime whose gateway unit systemd did not load", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, preflight } = yield* fixture();
        yield* fs.makeDirectory(at("opt/t3code"), { recursive: true });
        yield* fs.symlink("0.1.0", at("opt/t3code/current"));
        assert.match(
          (yield* Effect.flip(preflight)).message,
          /did not load the installer-marked unit/,
        );
      }),
    );

    it.effect.each(["update", "uninstall", "unmarked update", "unmarked uninstall"] as const)(
      "refuses an unmanaged gateway update or skips it on uninstall (%s)",
      (command) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { at, activate, calls, manager, preflight, uninstall } = yield* fixture();
          yield* activate();
          const unitPath = at("etc/systemd/system", GATEWAY_UNIT);
          const fragment = at("run/systemd/system", GATEWAY_UNIT);
          const manualUnit = "[Unit]\nDescription=Manual gateway\n";
          const unmarked = command.startsWith("unmarked");
          if (unmarked) {
            yield* fs.writeFileString(unitPath, manualUnit);
          } else {
            manager.fragments.set(GATEWAY_UNIT, fragment);
          }
          manager.active = manager.loaded = `${GATEWAY_UNIT} loaded active running Gateway\n`;
          const wants = at("etc/systemd/system/multi-user.target.wants");
          yield* fs.makeDirectory(wants);
          const link = at("etc/systemd/system/multi-user.target.wants", GATEWAY_UNIT);
          yield* fs.symlink(unmarked ? unitPath : fragment, link);
          calls.length = 0;
          const reports: Array<string> = [];
          const isUninstall = command.endsWith("uninstall");
          const operation = isUninstall
            ? uninstall
            : Effect.flip(preflight).pipe(
                Effect.map((error) => assert.include(error.message, GATEWAY_UNIT)),
              );
          yield* operation.pipe(capture("warn", reports));
          assert.deepEqual(
            calls.filter((call) =>
              /systemctl (stop|disable|enable|restart|reset-failed)\b/.test(call),
            ),
            [],
          );
          if (isUninstall) {
            assert.isTrue(reports.some((report) => report.includes(`Skipping ${GATEWAY_UNIT}`)));
          } else {
            assert.notInclude(calls, "systemctl daemon-reload");
          }
          assert.equal(yield* fs.readLink(link), unmarked ? unitPath : fragment);
          if (unmarked) assert.equal(yield* fs.readFileString(unitPath), manualUnit);
        }),
    );

    it.effect.each([false, true])(
      "stops and removes managed units on repeated uninstall (gateway symlink: %s)",
      (symlinkedGateway) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { join } = yield* Path.Path;
          const { at, activate, calls, manager, paths, uninstall } = yield* fixture();
          yield* activate();
          const gatewayFile = at("etc/systemd/system", GATEWAY_UNIT);
          const sentinel = at("manual.service");
          const sentinelContents = renderGatewayUnits(at("opt/t3code/current/t3"))[GATEWAY_UNIT];
          if (symlinkedGateway) {
            yield* fs.writeFileString(sentinel, sentinelContents);
            yield* fs.remove(gatewayFile);
            yield* fs.symlink(sentinel, gatewayFile);
            manager.fragments.set(GATEWAY_UNIT, sentinel);
          }
          manager.loaded =
            "t3code-gateway.service loaded active running\nt3code@alice.service loaded active running\n";
          const wants = at("etc/systemd/system", "multi-user.target.wants");
          const runtimeWants = at("run/systemd/system", "multi-user.target.wants");
          yield* fs.makeDirectory(wants);
          yield* fs.makeDirectory(runtimeWants, { recursive: true });
          yield* fs.symlink("../t3code-gateway.service", join(wants, GATEWAY_UNIT));
          for (const unit of ["t3code@alice.service", "t3code@bob.service"]) {
            yield* fs.symlink("../t3code@.service", join(wants, unit));
          }
          yield* fs.symlink("../t3code@.service", join(runtimeWants, "t3code@carol.service"));
          const custom = "t3code@custom.service";
          manager.loaded += `${custom} loaded active running Custom\n`;
          manager.fragments.set(custom, at("etc/systemd/system", custom));
          for (const link of [join(wants, custom), join(runtimeWants, custom)]) {
            yield* fs.symlink(at("etc/systemd/system", custom), link);
          }
          const reports: Array<string> = [];
          calls.length = 0;
          yield* uninstall.pipe(capture("warn", reports));
          assert.isTrue(reports.some((report) => report.includes(`Skipping ${custom}`)));
          if (symlinkedGateway) {
            assert.isTrue(reports.some((report) => report.includes(`Skipping ${GATEWAY_UNIT}`)));
            assert.equal(yield* fs.readLink(gatewayFile), sentinel);
            assert.equal(yield* fs.readFileString(sentinel), sentinelContents);
          }
          const gateway = symlinkedGateway ? "" : " t3code-gateway.service";
          assert.deepEqual(
            calls.filter((call) => !call.startsWith("systemctl show ")),
            [
              "systemctl list-units --plain --all --no-legend --no-pager t3code-gateway.service t3code@*.service t3code-gateway-helper.socket t3code-gateway-helper@*.service",
              `systemctl stop${gateway} t3code@alice.service`,
              `systemctl disable${gateway} t3code@alice.service t3code@bob.service`,
              "systemctl disable --runtime t3code@carol.service",
              "systemctl daemon-reload",
            ],
          );
          assert.sameMembers(
            yield* fs.readDirectory(paths.unitDir),
            symlinkedGateway
              ? ["multi-user.target.wants", GATEWAY_UNIT]
              : ["multi-user.target.wants"],
          );
          assert.sameMembers(
            yield* fs.readDirectory(wants),
            symlinkedGateway ? [custom, GATEWAY_UNIT] : [custom],
          );
          assert.deepEqual(yield* fs.readDirectory(runtimeWants), [custom]);

          calls.length = 0;
          yield* uninstall;
          assert.lengthOf(
            calls.filter((call) => !call.startsWith("systemctl show ")),
            2,
          );
          assert.equal(calls.at(-1), "systemctl daemon-reload");
        }),
    );

    it.effect("enables, disables and reports one user's backend", () =>
      Effect.gen(function* () {
        const { calls, manager, platform, provide } = yield* fixture();
        const alice = { name: "alice", accountId: 1001, home: "/home/alice" };
        yield* provide(platform.services.enableUser(alice, "/opt/t3code/current/t3"));
        assert.equal(yield* provide(platform.services.userState("alice")), "active");
        manager.failAll = true;
        const error = yield* Effect.flip(provide(platform.services.disableUser("alice")));
        assert.equal(
          error.message,
          "systemctl could not disable --now t3code@alice.service (exit 1).",
        );

        assert.deepEqual(calls, [
          "systemctl enable --now t3code@alice.service",
          "systemctl is-active t3code@alice.service",
          "systemctl disable --now t3code@alice.service",
        ]);
      }),
    );

    it.effect("creates the gateway account once and requires a nologin non-root account", () =>
      Effect.gen(function* () {
        const { calls, manager, platform, provide } = yield* fixture();
        assert.equal(yield* provide(platform.services.ensureGatewayAccount), 123);
        assert.equal(yield* provide(platform.services.ensureGatewayAccount), 123);
        assert.deepEqual(calls, [
          "getent passwd t3code",
          "useradd --system --no-create-home --shell /usr/sbin/nologin t3code",
          "getent passwd t3code",
          "getent passwd t3code",
        ]);
        for (const entry of ["t3code:x:0:0::/:/usr/sbin/nologin", "t3code:x:123:123::/:/bin/sh"]) {
          manager.passwd.set("t3code", entry);
          const error = yield* Effect.flip(provide(platform.services.ensureGatewayAccount));
          assert.include(error.message, "non-root account with a nologin shell");
        }
      }),
    );
  });

  it.layer(NodeServices.layer)("accounts and ownership", (it) => {
    it.effect(
      "looks up enrollable users and rejects reserved, root, unknown or homeless ones",
      () =>
        Effect.gen(function* () {
          const { at, calls, manager, platform, provide } = yield* fixture();
          manager.passwd.set("alice", `alice:x:1001:1002::${at()}:/bin/sh`);
          manager.passwd.set("1001", `alice:x:1001:1002::${at()}:/bin/sh`);
          manager.passwd.set("bob", `bob:x:1003:1003::${at("missing-home")}:/bin/sh`);
          manager.passwd.set("root", `root:x:0:0::${at()}:/bin/sh`);
          assert.deepEqual(yield* provide(platform.lookupUser("alice")), {
            name: "alice",
            accountId: 1001,
            home: at(),
          });
          assert.equal(yield* provide(platform.accountName(1001)), "alice");
          for (const [user, expected] of [
            ["t3code", /reserved for the gateway/],
            ["bob", /home directory for bob does not exist/],
            ["root", /root and cannot be enrolled/],
            ["carol", /Linux user carol was not found/],
          ] as const) {
            assert.match(
              (yield* Effect.flip(provide(platform.lookupUser(user)))).message,
              expected,
            );
          }
          assert.notInclude(calls, "getent passwd t3code");
        }),
    );

    it.effect("secures directories for root or the user's own uid and primary group", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, manager, ownership, platform, provide } = yield* fixture();
        manager.passwd.set("alice", `alice:x:1001:1002::${at()}:/bin/sh`);
        const alice = { name: "alice", accountId: 1001, home: at() };
        const shared = at("var/lib/t3code/pairing");
        const own = at("var/lib/t3code/pairing/alice");
        yield* provide(platform.secureDirectory(shared, "admin"));
        yield* fs.chmod(shared, 0o700);
        yield* provide(platform.secureDirectory(shared, "admin"));
        yield* provide(platform.secureDirectory(own, alice));
        assert.deepEqual(ownership.get(shared), [0, 0]);
        assert.deepEqual(ownership.get(own), [1001, 1002]);
        for (const directory of [shared, own]) {
          assert.equal((yield* fs.stat(directory)).mode & 0o777, 0o755);
        }
        const moved = provide(platform.secureDirectory(own, { ...alice, accountId: 1005 }));
        assert.include((yield* Effect.flip(moved)).message, "no longer has uid 1005");
      }),
    );

    it.effect("trusts only root-owned entries that others cannot write", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, owners, platform, provide } = yield* fixture();
        const file = at("etc/t3code/gateway.json");
        const directory = at("etc/t3code");
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(file, "{}");
        for (const [entry, kind, uid, mode, ancestor, trusted] of [
          [file, "File", 0, 0o644, false, true],
          [file, "File", 1001, 0o644, false, false],
          [file, "File", 0, 0o664, false, false],
          [file, "File", 0, 0o646, false, false],
          [directory, "Directory", 0, 0o755, false, true],
          [directory, "Directory", 0, 0o775, false, false],
          [directory, "Directory", 0, 0o1777, false, false],
          [directory, "Directory", 0, 0o1777, true, true],
          [file, "Directory", 0, 0o644, false, false],
        ] as const) {
          owners.set(entry, uid);
          yield* fs.chmod(entry, mode);
          const result = yield* Effect.result(
            provide(platform.checkAdminOwned(entry, kind, { ancestor })),
          );
          assert.equal(
            Result.isSuccess(result) ? result.success : "rejected",
            trusted || "rejected",
          );
        }
        assert.isFalse(yield* provide(platform.checkAdminOwned(at("absent"), "File")));
      }),
    );

    it.effect("trusts archive entries owned by root or the invoking admin", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, owners, platform, provide } = yield* fixture();
        const file = at("archive/node_modules/native.node");
        const directory = at("archive");
        yield* fs.makeDirectory(at("archive/node_modules"), { recursive: true });
        yield* fs.writeFileString(file, "native addon");
        for (const [entry, kind, uid, mode, ancestor, trusted] of [
          [file, "File", 1001, 0o644, false, true],
          [file, "File", 1002, 0o644, false, false],
          [file, "File", 1001, 0o664, false, false],
          [directory, "Directory", 0, 0o775, false, false],
          [directory, "Directory", 0, 0o1777, false, false],
          [directory, "Directory", 0, 0o1777, true, true],
        ] as const) {
          owners.set(entry, uid);
          yield* fs.chmod(entry, mode);
          const result = yield* Effect.result(
            provide(platform.checkRuntimeSource(entry, kind, { ancestor })),
          );
          assert.propertyVal(result, "_tag", trusted ? "Success" : "Failure");
          if (!trusted && result._tag === "Failure") {
            assert.include(
              result.failure.message,
              `trusted ownership and no group or world write access: ${entry}`,
            );
          }
        }
      }),
    );

    it.effect("removes a pairing folder with coreutils on one file system", () =>
      Effect.gen(function* () {
        const { calls, manager, platform, provide } = yield* fixture();
        yield* provide(platform.removeTree("/var/lib/t3code/pairing/alice"));
        assert.deepEqual(calls, [
          "rm --recursive --force --one-file-system -- /var/lib/t3code/pairing/alice",
        ]);
        manager.failAll = true;
        const error = yield* Effect.flip(
          provide(platform.removeTree("/var/lib/t3code/pairing/alice")),
        );
        assert.include(error.message, "Could not remove pairing directory");
      }),
    );

    it.effect("reads listeners from both proc TCP tables", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { platform } = yield* fixture();
        const procTable = (address: string, port: number) =>
          `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid\n0: ${address}:${port.toString(16)} ${"0".repeat(address.length)}:0000 0A 0:0 0:0 0 1002\n`;
        const listeners = yield* platform.listeners.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, encoding) =>
              file === "/proc/net/tcp"
                ? Effect.succeed(procTable("0100007F", 3801))
                : file === "/proc/net/tcp6"
                  ? Effect.succeed(procTable("0".repeat(32), 3802))
                  : fs.readFileString(file, encoding),
          }),
          Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.die("no tools") }),
        );
        assert.deepEqual(listeners, [
          { port: 3801, owner: 1002 },
          { port: 3802, owner: 1002 },
        ]);
      }),
    );
  });
});
