import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import packageJson from "../../package.json" with { type: "json" };
import {
  emptyGatewayConfig,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_PAIRING_DIR_ENV,
} from "./GatewayConfig.ts";
import { installGateway, treesMatch, uninstallGateway } from "./gatewayInstall.ts";
import { GatewayPlatformError, type GatewayPlatform } from "./platform/GatewayPlatform.ts";
import {
  makeTestGatewayPlatform,
  makeTestGatewayRoot,
  posixOwnership,
  testGatewayServices,
} from "./platform/testing.ts";

it.layer(testGatewayServices)("runtime comparison", (it) => {
  it.effect("compares file contents and executable bits without diff", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-compare-" });
      const left = path.join(root, "left");
      const right = path.join(root, "right");
      yield* fs.makeDirectory(path.join(left, "bin"), { recursive: true });
      yield* fs.makeDirectory(path.join(right, "bin"), { recursive: true });
      yield* fs.writeFileString(path.join(left, "bin", "t3"), "same");
      yield* fs.writeFileString(path.join(right, "bin", "t3"), "same");
      yield* fs.chmod(path.join(left, "bin", "t3"), 0o755);
      yield* fs.chmod(path.join(right, "bin", "t3"), 0o755);
      assert.isTrue(yield* treesMatch(left, right));
      yield* fs.writeFileString(path.join(right, "bin", "t3"), "changed");
      assert.isFalse(yield* treesMatch(left, right));
    }),
  );
});

const fixture = Effect.fn("gatewayInstallTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* makeTestGatewayRoot("t3-gateway-install-");
  const at = (...parts: ReadonlyArray<string>) => path.join(root, ...parts);
  const { platform, calls } = makeTestGatewayPlatform(root);
  for (const dir of ["archive/client", "archive/lib"]) {
    yield* fs.makeDirectory(at(dir), { recursive: true });
  }
  const executable = at("archive", "t3");
  yield* fs.writeFileString(executable, "fake executable", { mode: 0o755 });
  yield* fs.writeFileString(at("archive/client/index.html"), "web client");
  yield* fs.writeFileString(at("archive/lib/native.node"), "native addon");
  yield* fs.writeFileString(at("archive/notes.txt"), "not a runtime entry");
  const provide = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    env: Record<string, string> = {},
    isExecutable = true,
  ) =>
    effect.pipe(
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(HostProcess.IsExecutable, isExecutable),
      Effect.provideService(HostProcess.ExecutablePath, executable),
    );
  const withPlatform = (changed: GatewayPlatform) => ({
    install: provide(installGateway(changed)),
    uninstall: provide(uninstallGateway(changed)),
  });
  return {
    at,
    calls,
    platform,
    layout: platform.layout,
    provide,
    withPlatform,
    ...withPlatform(platform),
  };
});

const capture = (reports: Array<string>) =>
  Effect.updateService(Console.Console, (console) => ({
    ...console,
    warn: (...args: ReadonlyArray<unknown>) => {
      reports.push(args.join(" "));
    },
  }));

const serviceCalls = (calls: ReadonlyArray<string>) =>
  calls.filter((call) => !call.startsWith("secure "));

it.layer(testGatewayServices)("gateway installation", (it) => {
  it.effect("installs the archive and reuses identical builds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, layout } = yield* fixture();
      const current = at("install/current");

      yield* install;
      const first = yield* fs.readLink(current);
      assert.equal(first, at("install", packageJson.version));
      assert.equal(yield* fs.readLink(layout.launcher), at("install/current/t3"));
      assert.equal(yield* fs.readFileString(layout.launcher), "fake executable");
      if (posixOwnership) assert.equal((yield* fs.stat(layout.launcher)).mode & 0o777, 0o755);
      assert.equal(yield* fs.readFileString(at("install/current/lib/native.node")), "native addon");
      assert.isFalse(yield* fs.exists(at("install/current/notes.txt")));
      assert.deepEqual(JSON.parse(yield* fs.readFileString(layout.configPath)), {
        ...emptyGatewayConfig,
        selfService: true,
      });
      if (posixOwnership) assert.equal((yield* fs.stat(layout.configPath)).mode & 0o777, 0o644);
      assert.isTrue(yield* fs.exists(layout.pairingDir));
      assert.deepEqual(serviceCalls(calls), ["preflight", "ensureGatewayAccount", "activate "]);
      // Only the staged root is secured; nested folders inherit it (one icacls run on Windows).
      assert.isFalse(calls.some((call) => /^secure .*[\\/]runtime[\\/]/.test(call)));
      if (posixOwnership)
        assert.equal((yield* fs.stat(at("install/current/lib"))).mode & 0o777, 0o755);

      // Enrolled users whose account still matches get their backends defined.
      const config = JSON.stringify({
        ...emptyGatewayConfig,
        users: { alice: { uid: 1001, port: 3801 }, bob: { uid: 1002, port: 3802 } },
        selfService: true,
      });
      yield* fs.writeFileString(layout.configPath, config);
      yield* fs.chmod(layout.configPath, 0o600);
      yield* install;
      if (posixOwnership) assert.equal((yield* fs.stat(layout.configPath)).mode & 0o777, 0o644);
      assert.equal(yield* fs.readFileString(layout.configPath), config);
      assert.equal(yield* fs.readLink(current), first);
      assert.equal(calls.at(-1), "activate alice");

      yield* fs.writeFileString(at("archive/client/index.html"), "updated web client");
      yield* install;
      const updated = yield* fs.readLink(current);
      assert.notEqual(updated, first);
      assert.equal(
        yield* fs.readFileString(at("install/current/client/index.html")),
        "updated web client",
      );
      assert.equal(yield* fs.readFileString(`${first}/client/index.html`), "web client");
      assert.equal(yield* fs.readLink(at("install/previous")), first);
      // An executable bit alone is a change; Windows has none, so the contents change there.
      if (posixOwnership) yield* fs.chmod(at("archive/lib/native.node"), 0o755);
      else yield* fs.writeFileString(at("archive/lib/native.node"), "native addon 2");
      yield* install;
      const updatedMode = yield* fs.readLink(current);
      assert.notEqual(updatedMode, updated);
      yield* install;
      assert.equal(yield* fs.readLink(current), updatedMode);
      assert.equal(yield* fs.readLink(at("install/previous")), updated);
      assert.sameMembers(yield* fs.readDirectory(layout.installRoot), [
        ".t3code-gateway-install",
        "current",
        "previous",
        packageJson.version + updated.slice(first.length),
        packageJson.version + updatedMode.slice(first.length),
      ]);
    }),
  );

  it.effect("repairs a failed first activation on retry without creating a second runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { layout, platform, withPlatform, install } = yield* fixture();
      const failing = withPlatform({
        ...platform,
        services: {
          ...platform.services,
          activate: ({ restorePreviousRuntime }) => {
            assert.isUndefined(restorePreviousRuntime);
            return Effect.fail(new GatewayPlatformError({ message: "did not start" }));
          },
        },
      });
      assert.equal((yield* Effect.flip(failing.install)).message, "did not start");
      const files = yield* fs.readDirectory(layout.installRoot);
      assert.lengthOf(files, 3);
      yield* install;
      assert.sameMembers(yield* fs.readDirectory(layout.installRoot), files);
    }),
  );

  it.effect("lets a failed update restore the previous runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, platform, withPlatform, install } = yield* fixture();
      yield* install;
      const current = at("install/current");
      const first = yield* fs.readLink(current);
      yield* fs.writeFileString(at("archive/client/index.html"), "updated web client");
      const failing = withPlatform({
        ...platform,
        services: {
          ...platform.services,
          activate: ({ restorePreviousRuntime }) =>
            Effect.gen(function* () {
              assert.notEqual(yield* fs.readLink(current).pipe(Effect.orDie), first);
              yield* restorePreviousRuntime ?? Effect.die("No rollback for an update");
              return yield* new GatewayPlatformError({ message: "rolled back" });
            }),
        },
      });
      assert.equal((yield* Effect.flip(failing.install)).message, "rolled back");
      assert.equal(yield* fs.readLink(current), first);
      assert.isFalse(yield* fs.exists(at("install/previous")));
    }),
  );

  it.effect("preserves and reports unexpected entries when pruning after install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, platform, withPlatform } = yield* fixture();
      // As on Windows, the launcher's folder sits inside the install root.
      const { install } = withPlatform({
        ...platform,
        layout: { ...platform.layout, launcher: at("install/bin/t3") },
      });
      yield* install;
      const unexpected = at("install/99.99.99");
      const unrelated = at("install/notes");
      yield* fs.symlink("current", unexpected);
      yield* fs.writeFileString(unrelated, "notes");
      // An old runtime that cannot be removed, like one still in use on Windows.
      const locked = at("install/0.0.0-old/lib");
      yield* fs.makeDirectory(locked, { recursive: true });
      yield* fs.writeFileString(at("install/0.0.0-old/lib/native.node"), "in use");
      yield* fs.writeFileString(at("archive/client/index.html"), "updated web client");
      const reports: Array<string> = [];
      yield* install.pipe(
        capture(reports),
        Effect.updateService(FileSystem.FileSystem, (files) => ({
          ...files,
          remove: (file, options) =>
            file === at("install/0.0.0-old")
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Busy",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: file,
                  }),
                )
              : files.remove(file, options),
        })),
      );
      assert.equal(yield* fs.readLink(unexpected), "current");
      assert.equal(yield* fs.readFileString(unrelated), "notes");
      assert.isTrue(yield* fs.exists(locked));
      for (const file of [unexpected, unrelated, at("install/0.0.0-old")]) {
        assert.isTrue(reports.some((report) => report.includes(file)));
      }
      assert.isFalse(reports.some((report) => report.includes(at("install/bin"))));
    }),
  );

  it.effect("refuses to adopt or delete a non-empty unmarked install root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, layout, uninstall } = yield* fixture();
      yield* fs.makeDirectory(at("install/1.2.3"), { recursive: true });
      assert.match((yield* Effect.flip(install)).message, /unmanaged install root/);
      assert.deepEqual(calls, []);
      yield* uninstall;
      assert.deepEqual(yield* fs.readDirectory(layout.installRoot), ["1.2.3"]);
    }),
  );

  it.effect.each([
    ["install", GATEWAY_CONFIG_PATH_ENV],
    ["install", GATEWAY_PAIRING_DIR_ENV],
    ["uninstall", GATEWAY_CONFIG_PATH_ENV],
    ["uninstall", GATEWAY_PAIRING_DIR_ENV],
  ] as const)("rejects %s with a %s override", ([command, variable]) =>
    Effect.gen(function* () {
      const { at, calls, platform, provide } = yield* fixture();
      const operation = command === "install" ? installGateway : uninstallGateway;
      const error = yield* Effect.flip(
        provide(operation(platform), { [variable]: at("override") }),
      );
      assert.include(error.message, variable);
      assert.deepEqual(calls, []);
    }),
  );

  it.effect(
    "preserves unrelated launchers, including broken symlinks outside the install root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { at, calls, install, layout, uninstall } = yield* fixture();
        yield* fs.makeDirectory(at("bin"));
        yield* fs.writeFileString(layout.launcher, "another t3");
        assert.match((yield* Effect.flip(install)).message, /already occupies/);
        assert.deepEqual(calls, []);
        yield* uninstall;
        assert.equal(yield* fs.readFileString(layout.launcher), "another t3");

        yield* fs.remove(layout.launcher);
        const outside = at("install-other/missing");
        yield* fs.symlink(outside, layout.launcher);
        assert.match((yield* Effect.flip(install)).message, /already occupies/);
        yield* uninstall;
        assert.equal(yield* fs.readLink(layout.launcher), outside);
      }),
  );

  it.effect("rejects a symlinked install root and runtime entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, layout, uninstall } = yield* fixture();
      const sentinel = at("archive/client/index.html");
      yield* fs.symlink(at("archive"), layout.installRoot);
      assert.include((yield* Effect.flip(install)).message, layout.installRoot);
      assert.include((yield* Effect.flip(uninstall)).message, layout.installRoot);
      yield* fs.remove(layout.installRoot);

      yield* fs.symlink(sentinel, at("archive/lib/extra"));
      assert.match((yield* Effect.flip(install)).message, /Unexpected runtime entry/);
      assert.notInclude(calls, "activate ");
      assert.deepEqual(yield* fs.readDirectory(layout.installRoot), [".t3code-gateway-install"]);
      assert.equal(yield* fs.readFileString(sentinel), "web client");
    }),
  );

  it.effect("rejects an untrusted archive entry before activating", () =>
    Effect.gen(function* () {
      const { at, calls, platform, withPlatform } = yield* fixture();
      const native = at("archive/lib/native.node");
      const { install } = withPlatform({
        ...platform,
        checkRuntimeSource: (file, kind, options) =>
          file === native
            ? Effect.fail(new GatewayPlatformError({ message: `Untrusted ${file}.` }))
            : platform.checkRuntimeSource(file, kind, options),
      });
      assert.include((yield* Effect.flip(install)).message, native);
      assert.notInclude(calls, "activate ");
    }),
  );

  it.effect("checks admin rights and archive requirements before any service call", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, layout, platform, provide, withPlatform } = yield* fixture();
      for (const [operation, error] of [
        [withPlatform({ ...platform, isAdmin: Effect.succeed(false) }).install, /as root/],
        [withPlatform({ ...platform, isAdmin: Effect.succeed(false) }).uninstall, /as root/],
        [
          provide(installGateway(platform), {}, false),
          /build-cli-archive.ts --platform linux --arch/,
        ],
      ] as const) {
        assert.match((yield* Effect.flip(operation)).message, error);
      }
      yield* fs.remove(at("archive/client/index.html"));
      assert.match((yield* Effect.flip(install)).message, /missing client\/index.html/);
      assert.deepEqual(calls, []);
      assert.isFalse(yield* fs.exists(layout.installRoot));
    }),
  );

  it.effect("finishes a partly failed uninstall or reinstalls over it", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { at, install, layout, uninstall } = yield* fixture();
      yield* install;
      const locked = at("install", packageJson.version);
      // Removes entries one by one in name order, like rm, until it reaches a locked runtime.
      const remove: FileSystem.FileSystem["remove"] = (file, options) =>
        file === locked
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Busy",
                module: "FileSystem",
                method: "remove",
                pathOrDescriptor: file,
              }),
            )
          : file === layout.installRoot
            ? Effect.gen(function* () {
                for (const name of (yield* files.readDirectory(file)).toSorted()) {
                  yield* remove(path.join(file, name), options);
                }
                yield* files.remove(file, options);
              })
            : files.remove(file, options);
      yield* Effect.flip(
        uninstall.pipe(Effect.updateService(FileSystem.FileSystem, (fs) => ({ ...fs, remove }))),
      );
      yield* install;
      assert.equal(yield* files.readFileString(layout.launcher), "fake executable");
      yield* uninstall;
      assert.isFalse(yield* files.exists(layout.installRoot));
    }),
  );

  it.effect("removes the runtime and keeps config and pairing data on repeated uninstall", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { at, calls, install, layout, uninstall } = yield* fixture();
      yield* install;
      const marker = at("data/pairing/marker");
      yield* fs.writeFileString(marker, "pairing");
      calls.length = 0;
      yield* uninstall;
      assert.deepEqual(calls, ["uninstall"]);
      assert.isFalse(yield* fs.exists(layout.installRoot));
      assert.isFalse(yield* fs.exists(layout.launcher));
      assert.deepEqual(JSON.parse(yield* fs.readFileString(layout.configPath)), {
        ...emptyGatewayConfig,
        selfService: true,
      });
      assert.equal(yield* fs.readFileString(marker), "pairing");
      yield* uninstall;
      assert.deepEqual(calls, ["uninstall", "uninstall"]);
    }),
  );
});
