import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import {
  emptyGatewayConfig,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_PAIRING_DIR_ENV,
  GATEWAY_UNIT,
  GATEWAY_USER_UNIT_TEMPLATE,
} from "./GatewayConfig.ts";
import { installGateway, renderGatewayUnits, uninstallGateway } from "./gatewayInstall.ts";

it("renders the gateway and per-user systemd units", () => {
  const units = renderGatewayUnits();
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
EnvironmentFile=/etc/t3code/users/%i.env
ExecStart=/opt/t3code/current/t3 gateway run-backend
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`,
  );
});

const fixture = Effect.fn("gatewayInstallTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-install-" });
  const at = (...parts: ReadonlyArray<string>) => path.join(directory, ...parts);
  const layout = {
    installRoot: at("opt", "t3code"),
    launcher: at("usr", "local", "bin", "t3"),
    unitDir: at("etc", "systemd", "system"),
    runtimeUnitDir: at("run", "systemd", "system"),
    configDir: at("etc", "t3code"),
    configPath: at("etc", "t3code", "gateway.json"),
    userEnvDir: at("etc", "t3code", "users"),
    pairingDir: at("var", "lib", "t3code", "pairing"),
  };
  for (const dir of [
    "opt",
    "usr/local/bin",
    "etc/systemd/system",
    "var/lib",
    "archive/client",
    "archive/node_modules",
    "archive/resource-monitor",
    "archive/lib",
  ]) {
    yield* fs.makeDirectory(at(dir), { recursive: true, mode: 0o755 });
  }
  const executable = at("archive", "t3");
  yield* fs.writeFileString(executable, "fake executable", { mode: 0o755 });
  yield* fs.writeFileString(at("archive/client/index.html"), "web client", { mode: 0o644 });
  yield* fs.writeFileString(at("archive/node_modules/native.node"), "native addon", {
    mode: 0o644,
  });
  yield* fs.writeFileString(at("archive/resource-monitor/t3-resource-monitor"), "monitor", {
    mode: 0o755,
  });
  yield* fs.writeFileString(at("archive/lib/libatomic.so.1"), "libatomic", { mode: 0o644 });

  const calls: string[] = [];
  const callerPath = at("caller-bin");
  const manager = {
    active: "",
    loaded: "",
    fragments: new Map<string, string>(),
    failEnable: false,
    listenerUid: 123,
    listenerPort: emptyGatewayConfig.listen.port,
    failBackendRestart: false,
    rollbackListenerUid: undefined as number | undefined,
  };
  const listenerRead = yield* Deferred.make<void>();
  const rollbackListenerRead = yield* Deferred.make<void>();
  const sourceOwners = new Map<string, number>();
  const gatewayRestarts: string[] = [];
  let account = false;
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    const { command, args, env } = input;
    assert.equal(env?.PATH ?? callerPath, "/usr/sbin:/usr/bin:/sbin:/bin");
    calls.push([command, ...args].join(" "));
    if (command === "diff") return processRunner.run(input);

    let stdout = "";
    let stderr = "";
    let code = 0;
    let disabled: ReadonlyArray<string> = [];
    let recordGatewayRestart = false;
    switch (command) {
      case "getent":
        stdout = account ? "t3code:x:123:123::/nonexistent:/usr/sbin/nologin\n" : "";
        code = account ? 0 : 2;
        break;
      case "useradd":
        account = true;
        break;
      case "systemctl":
        switch (args[0]) {
          case "list-units":
            stdout = args.includes("--state=active") ? manager.active : manager.loaded;
            break;
          case "enable":
            code = manager.failEnable ? 1 : 0;
            break;
          case "restart":
            recordGatewayRestart = args.includes(GATEWAY_UNIT);
            break;
          case "try-restart":
            code = manager.failBackendRestart ? 1 : 0;
            break;
          case "is-active":
            stdout = manager.failBackendRestart ? "failed\n" : "active\n";
            code = manager.failBackendRestart ? 3 : 0;
            break;
          case "stop":
            manager.loaded = "";
            break;
          case "disable": {
            const runtime = args[1] === "--runtime";
            const unitDir = runtime ? layout.runtimeUnitDir : layout.unitDir;
            disabled = args
              .slice(runtime ? 2 : 1)
              .map((unit) => path.join(unitDir, "multi-user.target.wants", unit));
            break;
          }
        }
        break;
    }
    return Effect.gen(function* () {
      if (command === "systemctl" && (args[0] === "show" || args[0] === "cat")) {
        const unit = args.at(-1)!;
        const file = path.join(
          layout.unitDir,
          unit === GATEWAY_UNIT ? GATEWAY_UNIT : GATEWAY_USER_UNIT_TEMPLATE,
        );
        const fragment = manager.fragments.get(unit) ?? ((yield* fs.exists(file)) ? file : "");
        if (args[0] === "show") {
          stdout = fragment + "\n";
        } else if (fragment) {
          stdout = `# ${fragment}\n[Unit]\n`;
        } else {
          code = 1;
          stderr = `No files found for ${unit}.\n`;
        }
      }
      if (recordGatewayRestart) {
        gatewayRestarts.push(yield* fs.readLink(at("opt/t3code/current")));
        if (gatewayRestarts.length === 2 && manager.rollbackListenerUid !== undefined) {
          manager.listenerUid = manager.rollbackListenerUid;
        }
      }
      yield* Effect.forEach(disabled, (file) => fs.remove(file), { discard: true });
      return {
        stdout,
        stderr,
        code: ExitCode(code),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }).pipe(Effect.orDie);
  };
  const stagedFs: FileSystem.FileSystem = {
    ...fs,
    lstat: (file) =>
      fs.lstat(file).pipe(
        Effect.map((info) => ({
          ...info,
          uid: Option.some(sourceOwners.get(file) ?? 0),
          mode: directory.startsWith(file + "/") ? info.mode & ~0o022 : info.mode,
        })),
      ),
    readFileString: (file, encoding) => {
      if (file === "/proc/net/tcp") {
        return (
          gatewayRestarts.length === 0
            ? Effect.void
            : Deferred.succeed(
                gatewayRestarts.length === 1 ? listenerRead : rollbackListenerRead,
                undefined,
              )
        ).pipe(
          Effect.as(
            `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid\n0: 00000000:${manager.listenerPort.toString(16)} 00000000:0000 0A 0:0 0:0 0 ${manager.listenerUid}\n`,
          ),
        );
      }
      if (file === "/proc/net/tcp6") return Effect.succeed("");
      return fs.readFileString(file, encoding);
    },
    chown: () => Effect.void,
  };
  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, stagedFs),
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 0),
      Effect.provideService(HostProcess.Environment, { SUDO_UID: "1001", PATH: callerPath }),
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.ExecutablePath, executable),
    );

  return {
    at,
    calls,
    executable,
    layout,
    manager,
    gatewayRestarts,
    listenerRead,
    rollbackListenerRead,
    sourceOwners,
    provide,
    install: provide(installGateway(layout)),
    uninstall: provide(uninstallGateway(layout)),
  };
});

const testServices = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const unitLookups = [
  "systemctl show --property=FragmentPath --value t3code-gateway.service",
  "systemctl cat --no-pager t3code@.service",
];

describe("gateway installation", () => {
  it.live(
    "installs the full archive and reuses identical builds while restarting running units",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, install, calls, layout, manager } = yield* fixture();
        const current = at("opt/t3code/current");

        yield* install;
        const first = yield* fs.readLink(current);
        assert.equal(yield* fs.readLink(layout.launcher), at("opt/t3code/current/t3"));
        assert.equal(yield* fs.readFileString(layout.launcher), "fake executable");
        assert.equal((yield* fs.stat(layout.launcher)).mode & 0o777, 0o755);
        assert.equal(
          yield* fs.readFileString(at("opt/t3code/current/lib/libatomic.so.1")),
          "libatomic",
        );
        assert.equal(
          yield* fs.readFileString(at("opt/t3code/current/node_modules/native.node")),
          "native addon",
        );
        assert.equal(
          yield* fs.readFileString(at("opt/t3code/current/resource-monitor/t3-resource-monitor")),
          "monitor",
        );
        for (const [name, contents] of Object.entries(renderGatewayUnits(layout))) {
          const file = at("etc/systemd/system", name);
          assert.equal(yield* fs.readFileString(file), contents);
          assert.equal((yield* fs.stat(file)).mode & 0o777, 0o644);
        }
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(layout.configPath)),
          emptyGatewayConfig,
        );
        assert.equal((yield* fs.stat(layout.configPath)).mode & 0o777, 0o644);
        assert.equal((yield* fs.stat(layout.pairingDir)).mode & 0o777, 0o755);
        assert.deepEqual(calls, [
          ...unitLookups,
          "getent passwd t3code",
          "useradd --system --no-create-home --shell /usr/sbin/nologin t3code",
          "getent passwd t3code",
          "systemctl daemon-reload",
          "systemctl list-units --plain --state=active --no-legend --no-pager t3code-gateway.service t3code@*.service",
          "systemctl show --property=FragmentPath --value t3code-gateway.service",
          "systemctl reset-failed t3code-gateway.service",
          "systemctl enable --now t3code-gateway.service",
        ]);

        manager.listenerPort = 3774;
        const config = JSON.stringify({
          ...emptyGatewayConfig,
          listen: { ...emptyGatewayConfig.listen, port: manager.listenerPort },
          publicUrl: "http://t3.local:3774",
        });
        yield* fs.writeFileString(layout.configPath, config);
        yield* fs.chmod(layout.configPath, 0o600);
        yield* fs.writeFileString(at("etc/t3code/users/alice.env"), "T3CODE_PORT=3801\n");
        manager.active =
          "t3code-gateway.service loaded active running Gateway\nt3code@alice.service loaded active running Backend\n";
        manager.active += "t3code@custom.service loaded active running Custom\n";
        manager.fragments.set(
          "t3code@custom.service",
          at("etc/systemd/system/t3code@custom.service"),
        );
        const reports: string[] = [];
        yield* install.pipe(
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args) => {
              reports.push(args.join(" "));
            },
          })),
        );
        assert.isTrue(reports.some((report) => report.includes("Skipping t3code@custom.service")));
        assert.equal((yield* fs.stat(layout.configPath)).mode & 0o777, 0o644);
        assert.equal(yield* fs.readLink(current), first);
        assert.equal(calls.filter((call) => call.startsWith("useradd ")).length, 1);
        assert.deepEqual(calls.slice(-6), [
          "systemctl restart t3code-gateway.service",
          "systemctl show --property=FragmentPath --value t3code@alice.service",
          "systemctl show --property=FragmentPath --value t3code@custom.service",
          "systemctl reset-failed t3code@alice.service",
          "systemctl try-restart t3code@alice.service",
          "systemctl is-active t3code@alice.service",
        ]);

        yield* fs.writeFileString(at("archive/client/index.html"), "updated web client");
        yield* install;
        const updated = yield* fs.readLink(current);
        assert.notEqual(updated, first);
        assert.equal(
          yield* fs.readFileString(at("opt/t3code/current/client/index.html")),
          "updated web client",
        );
        assert.equal(
          yield* fs.readFileString(at("opt/t3code", first, "client/index.html")),
          "web client",
        );
        assert.equal(yield* fs.readFileString(layout.configPath), config);
        assert.equal(
          yield* fs.readFileString(at("etc/t3code/users/alice.env")),
          "T3CODE_PORT=3801\n",
        );
        const monitor = at("archive/resource-monitor/t3-resource-monitor");
        yield* fs.chmod(monitor, 0o644);
        yield* install;
        const updatedMode = yield* fs.readLink(current);
        assert.notEqual(updatedMode, updated);
        assert.equal(
          (yield* fs.stat(at("opt/t3code/current/resource-monitor/t3-resource-monitor"))).mode &
            0o111,
          0,
        );
        yield* install;
        assert.equal(yield* fs.readLink(current), updatedMode);
        assert.equal(yield* fs.readLink(at("opt/t3code/previous")), updated);
        assert.sameMembers(yield* fs.readDirectory(layout.installRoot), [
          ".t3code-gateway-install",
          "current",
          "previous",
          updated,
          updatedMode,
        ]);
      }).pipe(Effect.provide(testServices)),
  );

  it.live("repairs a failed start on retry without creating a second runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { install, layout, manager } = yield* fixture();
      manager.failEnable = true;
      assert.match((yield* Effect.flip(install)).message, /journalctl -u t3code-gateway/);
      const files = yield* fs.readDirectory(layout.installRoot);
      assert.lengthOf(files, 3);
      manager.failEnable = false;
      yield* install;
      assert.sameMembers(yield* fs.readDirectory(layout.installRoot), files);
    }).pipe(Effect.provide(testServices)),
  );

  it.effect.each(["ready", "timeout", "interrupt"] as const)(
    "restores previous units and checks the rollback listener (%s)",
    (outcome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const {
          at,
          calls,
          install,
          layout,
          listenerRead,
          rollbackListenerRead,
          manager,
          gatewayRestarts,
        } = yield* fixture();
        yield* install;
        const current = at("opt/t3code/current");
        const first = yield* fs.readLink(current);
        const previousUnits = Object.entries(renderGatewayUnits(layout)).map(
          ([name, contents]) =>
            [at("etc/systemd/system", name), contents + "# Previous unit contents\n"] as const,
        );
        for (const [file, contents] of previousUnits) yield* fs.writeFileString(file, contents);
        yield* fs.writeFileString(at("archive/client/index.html"), "updated web client");
        manager.active =
          "t3code-gateway.service loaded active running Gateway\nt3code@alice.service loaded active running Backend\n";
        manager.listenerUid = 1001;
        manager.rollbackListenerUid = outcome === "timeout" ? 1001 : 123;
        calls.length = 0;
        const update = yield* Effect.forkScoped(install);
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
        assert.equal(yield* fs.readLink(current), first);
        for (const [file, contents] of previousUnits) {
          assert.equal(yield* fs.readFileString(file), contents);
        }
        assert.lengthOf(gatewayRestarts, 2);
        assert.notEqual(gatewayRestarts[0], first);
        assert.equal(gatewayRestarts[1], first);
        assert.deepEqual(calls.slice(-4), [
          "systemctl daemon-reload",
          "systemctl show --property=FragmentPath --value t3code-gateway.service",
          "systemctl reset-failed t3code-gateway.service",
          "systemctl restart t3code-gateway.service",
        ]);
        assert.notInclude(calls, "systemctl try-restart t3code@alice.service");
      }).pipe(Effect.provide(testServices)),
  );

  it.effect("rejects an existing config with an unsafe owner or mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { calls, install, layout, sourceOwners } = yield* fixture();
      yield* fs.makeDirectory(layout.configDir, { recursive: true, mode: 0o755 });
      yield* fs.writeFileString(layout.configPath, JSON.stringify(emptyGatewayConfig));
      for (const [uid, mode] of [
        [1001, 0o644],
        [0, 0o664],
        [0, 0o646],
      ] as const) {
        sourceOwners.set(layout.configPath, uid);
        yield* fs.chmod(layout.configPath, mode);
        calls.length = 0;
        assert.match((yield* Effect.flip(install)).message, /root-owned regular file/);
        assert.deepEqual(calls, unitLookups);
      }
    }).pipe(Effect.provide(testServices)),
  );

  it.effect("preserves and reports unexpected entries when pruning after install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, install } = yield* fixture();
      yield* install;
      const unexpected = at("opt/t3code/99.99.99");
      const unrelated = at("opt/t3code/notes");
      yield* fs.symlink("current", unexpected);
      yield* fs.writeFileString(unrelated, "notes");
      yield* fs.writeFileString(at("archive/client/index.html"), "updated web client");
      const reports: string[] = [];
      yield* install.pipe(
        Effect.updateService(Console.Console, (console) => ({
          ...console,
          warn: (...args) => {
            reports.push(args.join(" "));
          },
        })),
      );
      assert.equal(yield* fs.readLink(unexpected), "current");
      assert.equal(yield* fs.readFileString(unrelated), "notes");
      for (const file of [unexpected, unrelated]) {
        assert.isTrue(reports.some((report) => report.includes(file)));
      }
    }).pipe(Effect.provide(testServices)),
  );

  it.effect("refuses to adopt or delete a non-empty unmarked install root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, layout, uninstall } = yield* fixture();
      const unrelated = at("opt/t3code/1.2.3");
      yield* fs.makeDirectory(unrelated, { recursive: true, mode: 0o755 });
      assert.match((yield* Effect.flip(install)).message, /unmanaged install root/);
      assert.deepEqual(calls, []);
      yield* uninstall;
      assert.deepEqual(yield* fs.readDirectory(layout.installRoot), ["1.2.3"]);
    }).pipe(Effect.provide(testServices)),
  );

  it.effect.each([
    ["install", GATEWAY_CONFIG_PATH_ENV],
    ["install", GATEWAY_PAIRING_DIR_ENV],
    ["uninstall", GATEWAY_CONFIG_PATH_ENV],
    ["uninstall", GATEWAY_PAIRING_DIR_ENV],
  ] as const)("rejects %s with a %s override", ([command, variable]) =>
    Effect.gen(function* () {
      const { at, calls, layout, provide } = yield* fixture();
      const operation = command === "install" ? installGateway(layout) : uninstallGateway(layout);
      const error = yield* Effect.flip(
        provide(
          operation.pipe(
            Effect.provideService(HostProcess.Environment, {
              SUDO_UID: "1001",
              [variable]: at("override"),
            }),
          ),
        ),
      );
      assert.include(error.message, variable);
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(testServices)),
  );

  it.effect.each(["update", "uninstall", "unmarked update", "unmarked uninstall"] as const)(
    "refuses an unmanaged gateway update or skips it on uninstall (%s)",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, calls, install, manager, uninstall } = yield* fixture();
        yield* install;
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
        const reports: string[] = [];
        const isUninstall = command.endsWith("uninstall");
        const operation = isUninstall
          ? uninstall
          : Effect.flip(install).pipe(
              Effect.map((error) => assert.include(error.message, GATEWAY_UNIT)),
            );
        yield* operation.pipe(
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args) => {
              reports.push(args.join(" "));
            },
          })),
        );
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
        if (unmarked) {
          assert.equal(yield* fs.readFileString(unitPath), manualUnit);
        }
      }).pipe(Effect.provide(testServices)),
  );

  it.effect.each([GATEWAY_UNIT, GATEWAY_USER_UNIT_TEMPLATE])(
    "refuses first install when an effective %s already exists elsewhere",
    (unit) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, calls, install, layout, manager } = yield* fixture();
        const fragment = at("run/systemd/system", unit);
        manager.fragments.set(unit, fragment);
        const error = yield* Effect.flip(install);
        assert.include(error.message, unit);
        assert.include(error.message, fragment);
        assert.isFalse(yield* fs.exists(layout.installRoot));
        assert.deepEqual(yield* fs.readDirectory(layout.unitDir), []);
        assert.isFalse(
          calls.some((call) => /systemctl (daemon-reload|enable|restart)\b/.test(call)),
        );
      }).pipe(Effect.provide(testServices)),
  );

  it.effect("reports failed backend states without rolling back the gateway", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, manager } = yield* fixture();
      const current = at("opt/t3code/current");
      yield* install;
      const first = yield* fs.readLink(current);
      yield* fs.writeFileString(at("archive/client/index.html"), "updated web client");
      manager.active = "t3code@alice.service loaded active running Backend\n";
      manager.failBackendRestart = true;
      const reports: string[] = [];
      const result = yield* Effect.flip(install).pipe(
        Effect.updateService(Console.Console, (console) => ({
          ...console,
          log: (...args) => {
            reports.push(args.join(" "));
          },
        })),
      );
      assert.match(result.message, /try-restart t3code@alice.service/);
      assert.deepEqual(reports, ["t3code@alice.service: failed"]);
      assert.notEqual(yield* fs.readLink(current), first);
      assert.include(calls, "systemctl is-active t3code@alice.service");
    }).pipe(Effect.provide(testServices)),
  );

  it.effect("refuses to replace or remove a unit without the installer marker", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, uninstall } = yield* fixture();
      const unit = at("etc/systemd/system", GATEWAY_USER_UNIT_TEMPLATE);
      const manualUnit = "[Unit]\nDescription=Manual backend\n";
      yield* fs.writeFileString(unit, manualUnit);
      for (const operation of [install, uninstall]) {
        assert.match((yield* Effect.flip(operation)).message, /Refusing.*unmanaged unit/);
      }
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(unit), manualUnit);
    }).pipe(Effect.provide(testServices)),
  );

  it.effect("rejects archives with untrusted writable entries and accepts the invoking admin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, sourceOwners } = yield* fixture();
      const native = at("archive/node_modules/native.node");
      yield* fs.chmod(at("archive"), 0o775);
      assert.match((yield* Effect.flip(install)).message, /trusted ownership.*archive/);
      yield* fs.chmod(at("archive"), 0o755);
      sourceOwners.set(native, 1002);
      assert.match((yield* Effect.flip(install)).message, /trusted ownership.*native.node/);
      sourceOwners.set(native, 1001);
      yield* fs.chmod(native, 0o664);
      assert.match((yield* Effect.flip(install)).message, /trusted ownership.*native.node/);
      assert.deepEqual(calls, [...unitLookups, ...unitLookups]);
      yield* fs.chmod(native, 0o644);
      yield* install;
    }).pipe(Effect.provide(testServices)),
  );

  it.effect.each([false, true])(
    "stops and removes managed units on repeated uninstall (gateway symlink: %s)",
    (symlinkedGateway) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, calls, install, layout, manager, uninstall } = yield* fixture();
        yield* install;
        const gatewayFile = at("etc/systemd/system", GATEWAY_UNIT);
        const sentinel = at("manual.service");
        const sentinelContents = renderGatewayUnits(layout)[GATEWAY_UNIT];
        if (symlinkedGateway) {
          yield* fs.writeFileString(sentinel, sentinelContents);
          yield* fs.remove(gatewayFile);
          yield* fs.symlink(sentinel, gatewayFile);
          manager.fragments.set(GATEWAY_UNIT, sentinel);
        }
        yield* fs.writeFileString(at("var/lib/t3code/pairing/marker"), "pairing");
        manager.loaded =
          "t3code-gateway.service loaded active running\nt3code@alice.service loaded active running\n";
        const wants = at("etc/systemd/system", "multi-user.target.wants");
        const runtimeWants = at("run/systemd/system", "multi-user.target.wants");
        yield* fs.makeDirectory(wants);
        yield* fs.makeDirectory(runtimeWants, { recursive: true });
        yield* fs.symlink(
          "../t3code-gateway.service",
          at("etc/systemd/system/multi-user.target.wants", GATEWAY_UNIT),
        );
        for (const unit of ["t3code@alice.service", "t3code@bob.service"]) {
          yield* fs.symlink(
            "../t3code@.service",
            at("etc/systemd/system/multi-user.target.wants", unit),
          );
        }
        yield* fs.symlink(
          "../t3code@.service",
          at("run/systemd/system/multi-user.target.wants", "t3code@carol.service"),
        );
        const custom = "t3code@custom.service";
        manager.loaded += `${custom} loaded active running Custom\n`;
        manager.fragments.set(custom, at("etc/systemd/system", custom));
        for (const link of [
          at("etc/systemd/system/multi-user.target.wants", custom),
          at("run/systemd/system/multi-user.target.wants", custom),
        ]) {
          yield* fs.symlink(at("etc/systemd/system", custom), link);
        }
        const reports: string[] = [];
        calls.length = 0;
        yield* uninstall.pipe(
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args) => {
              reports.push(args.join(" "));
            },
          })),
        );
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
            "systemctl list-units --plain --all --no-legend --no-pager t3code-gateway.service t3code@*.service",
            `systemctl stop${gateway} t3code@alice.service`,
            `systemctl disable${gateway} t3code@alice.service t3code@bob.service`,
            "systemctl disable --runtime t3code@carol.service",
            "systemctl daemon-reload",
          ],
        );
        assert.isFalse(yield* fs.exists(layout.installRoot));
        assert.isFalse(yield* fs.exists(layout.launcher));
        assert.sameMembers(
          yield* fs.readDirectory(layout.unitDir),
          symlinkedGateway
            ? ["multi-user.target.wants", GATEWAY_UNIT]
            : ["multi-user.target.wants"],
        );
        assert.sameMembers(
          yield* fs.readDirectory(wants),
          symlinkedGateway ? [custom, GATEWAY_UNIT] : [custom],
        );
        assert.deepEqual(yield* fs.readDirectory(runtimeWants), [custom]);
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(layout.configPath)),
          emptyGatewayConfig,
        );
        assert.equal(yield* fs.readFileString(at("var/lib/t3code/pairing/marker")), "pairing");

        calls.length = 0;
        yield* uninstall;
        assert.lengthOf(
          calls.filter((call) => !call.startsWith("systemctl show ")),
          2,
        );
        assert.equal(calls.at(-1), "systemctl daemon-reload");
      }).pipe(Effect.provide(testServices)),
  );

  it.effect(
    "preserves unrelated launchers, including broken symlinks outside the install root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, calls, install, layout, uninstall } = yield* fixture();
        yield* fs.writeFileString(layout.launcher, "another t3");
        assert.match((yield* Effect.flip(install)).message, /already occupies/);
        assert.deepEqual(calls, []);
        yield* uninstall;
        assert.equal(yield* fs.readFileString(layout.launcher), "another t3");

        yield* fs.remove(layout.launcher);
        const outside = at("opt/t3code-other/missing");
        yield* fs.symlink(outside, layout.launcher);
        assert.match((yield* Effect.flip(install)).message, /already occupies/);
        yield* uninstall;
        assert.equal(yield* fs.readLink(layout.launcher), outside);
      }).pipe(Effect.provide(testServices)),
  );

  it.effect("rejects symlinked install roots, unit files, and runtime entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, layout, uninstall } = yield* fixture();
      const sentinel = at("archive/client/index.html");
      yield* fs.symlink(at("archive"), layout.installRoot);
      assert.match((yield* Effect.flip(install)).message, /Expected a root-owned directory/);
      assert.match((yield* Effect.flip(uninstall)).message, /Expected a root-owned directory/);
      yield* fs.remove(layout.installRoot);

      const unit = at("etc/systemd/system", GATEWAY_UNIT);
      yield* fs.symlink(sentinel, unit);
      assert.match((yield* Effect.flip(install)).message, /Expected a regular file/);
      assert.deepEqual(calls, []);
      yield* fs.remove(unit);
      yield* fs.symlink(sentinel, at("archive/node_modules/extra"));
      assert.match((yield* Effect.flip(install)).message, /Unexpected runtime entry/);
      assert.notInclude(calls, "systemctl daemon-reload");
      assert.deepEqual(yield* fs.readDirectory(layout.installRoot), [".t3code-gateway-install"]);
      assert.equal(yield* fs.readFileString(sentinel), "web client");
    }).pipe(Effect.provide(testServices)),
  );

  it.effect("checks Linux, root, and archive requirements before calling a system tool", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, layout, provide } = yield* fixture();
      for (const [operation, error] of [
        [
          provide(installGateway(layout).pipe(Effect.provideService(HostProcess.UserId, 1234))),
          /as root/,
        ],
        [
          provide(
            uninstallGateway(layout).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
          ),
          /requires Linux/,
        ],
        [
          provide(
            installGateway(layout).pipe(Effect.provideService(HostProcess.IsExecutable, false)),
          ),
          /build-cli-archive.ts --platform linux --arch/,
        ],
      ] as const) {
        assert.match((yield* Effect.flip(operation)).message, error);
      }
      yield* fs.remove(at("archive/client/index.html"));
      assert.match((yield* Effect.flip(install)).message, /missing client\/index.html/);
      assert.deepEqual(calls, []);
      assert.isFalse(yield* fs.exists(layout.installRoot));
    }).pipe(Effect.provide(testServices)),
  );
});
