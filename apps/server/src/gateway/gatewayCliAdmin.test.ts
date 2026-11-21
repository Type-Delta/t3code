import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ExitCode } from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  emptyGatewayConfig,
  GATEWAY_BACKEND_PORT_RANGE,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_PAIRING_DIR_ENV,
  GATEWAY_USER_ENV_DIR,
} from "./GatewayConfig.ts";
import {
  addGatewayUser,
  enrollGatewayUser,
  gatewayUserEnv,
  readGatewayConfig,
  removeGatewayUser,
  unenrollGatewayUser,
} from "./gatewayCliAdmin.ts";

it.effect("allocates the first unused port and keeps an existing user's assignment", () =>
  Effect.gen(function* () {
    const alice = yield* addGatewayUser(emptyGatewayConfig, "alice", 1001);
    const both = yield* addGatewayUser(alice, "bob", 1002, 3803);
    assert.deepEqual(both.users, {
      alice: { uid: 1001, port: 3801 },
      bob: { uid: 1002, port: 3803 },
    });
    assert.strictEqual(yield* addGatewayUser(both, "alice", 1001, 3801), both);
    const changedPort = yield* Effect.flip(addGatewayUser(both, "alice", 1001, 3804));
    assert.include(changedPort.message, "Remove the gateway entry before adding it again");
    assert.strictEqual(removeGatewayUser(both, "unknown"), both);
    const remaining = removeGatewayUser(both, "alice");
    assert.deepEqual(remaining.users, { bob: { uid: 1002, port: 3803 } });
    const reused = yield* addGatewayUser(remaining, "carol", 1003);
    assert.deepEqual(reused.users.carol, { uid: 1003, port: 3801 });
    assert.equal(
      gatewayUserEnv(reused.users.carol!.port),
      "T3CODE_PORT=3801\nT3CODE_HOST=127.0.0.1\n",
    );
  }),
);

it.effect("skips occupied ports and the gateway listen port when allocating a backend port", () =>
  Effect.gen(function* () {
    const { first } = GATEWAY_BACKEND_PORT_RANGE;
    const config = { ...emptyGatewayConfig, listen: { ...emptyGatewayConfig.listen, port: first } };
    const occupied = [first + 1];
    const automatic = yield* addGatewayUser(config, "alice", 1001, undefined, occupied);
    assert.equal(automatic.users.alice?.port, first + 2);
    for (const port of [first, first + 1]) {
      const explicit = yield* Effect.flip(addGatewayUser(config, "alice", 1001, port, occupied));
      assert.include(explicit.message, "must be unused");
    }
  }),
);

it.effect("rejects uid conflicts and unavailable explicit or automatic ports", () =>
  Effect.gen(function* () {
    const { first, last } = GATEWAY_BACKEND_PORT_RANGE;
    const full = {
      ...emptyGatewayConfig,
      users: Object.fromEntries(
        Array.from({ length: last - first + 1 }, (_, index) => [
          `user${index}`,
          { uid: 1001 + index, port: first + index },
        ]),
      ),
    };
    for (const [user, uid, port, expected] of [
      ["alice", 2000, first, "must be unused"],
      ["alice", 2000, last + 1, "must be unused"],
      ["alice", 2000, undefined, "No gateway backend ports"],
      ["alice", 1001, undefined, "already enrolled"],
      ["root", 0, undefined, "is root"],
      ["user0", 2000, undefined, "uid has changed"],
    ] as const) {
      const error = yield* Effect.flip(addGatewayUser(full, user, uid, port));
      assert.include(error.message, expected);
    }
  }),
);

const trustedDirectories =
  (fs: FileSystem.FileSystem): FileSystem.FileSystem["lstat"] =>
  (file) =>
    fs
      .lstat(file)
      .pipe(Effect.map((info) => ({ ...info, uid: Option.some(0), mode: info.mode & ~0o022 })));

it.layer(NodeServices.layer)("gateway administration", (it) => {
  it.effect("creates and repairs the enrolled user's pairing directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-add-" });
      const configPath = path.join(directory, "gateway.json");
      const pairingDir = path.join(directory, "new-parent", "pairing");
      const userDir = path.join(pairingDir, "alice");
      const envDir = path.join(directory, "users");
      yield* fs.makeDirectory(envDir);
      const ownership = new Map<string, [number, number]>();
      const callerPath = path.join(directory, "caller-bin");
      const enroll = enrollGatewayUser("alice", 3801).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.UserId, 0),
        Effect.provideService(HostProcess.Environment, {
          [GATEWAY_CONFIG_PATH_ENV]: configPath,
          [GATEWAY_PAIRING_DIR_ENV]: pairingDir,
          PATH: callerPath,
        }),
        Effect.provideService(Path.Path, {
          ...path,
          join: (first, ...parts) =>
            path.join(first === GATEWAY_USER_ENV_DIR ? envDir : first, ...parts),
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          lstat: trustedDirectories(fs),
          readFileString: (filePath, encoding) =>
            filePath === "/proc/net/tcp" || filePath === "/proc/net/tcp6"
              ? Effect.succeed("")
              : fs.readFileString(filePath, encoding),
          chown: (filePath, uid, gid) =>
            fs.stat(filePath).pipe(
              Effect.tap(() => Effect.sync(() => ownership.set(filePath, [uid, gid]))),
              Effect.asVoid,
            ),
        }),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: ({ command, env }) => {
            assert.equal(env?.PATH ?? callerPath, "/usr/sbin:/usr/bin:/sbin:/bin");
            return Effect.succeed({
              stdout: command === "getent" ? `alice:x:1001:1002::${directory}:/bin/sh\n` : "",
              stderr: "",
              code: ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
      );
      yield* fs.chmod(directory, 0o700);
      assert.equal(yield* enroll, 3801);
      const marker = path.join(userDir, "marker");
      yield* fs.writeFileString(marker, "");
      yield* fs.chmod(userDir, 0o700);
      yield* fs.chmod(pairingDir, 0o751);
      yield* fs.chmod(configPath, 0o600);
      assert.equal(yield* enroll, 3801);
      assert.equal((yield* fs.stat(configPath)).mode & 0o777, 0o644);
      assert.isTrue(yield* fs.exists(marker));
      assert.deepEqual(ownership.get(pairingDir), [0, 0]);
      assert.deepEqual(ownership.get(userDir), [1001, 1002]);
      assert.equal((yield* fs.stat(directory)).mode & 0o777, 0o700);
      assert.isFalse(ownership.has(directory));
      assert.isFalse(ownership.has(path.dirname(pairingDir)));
      assert.equal((yield* fs.stat(pairingDir)).mode & 0o777, 0o751);
      for (const folder of [envDir, userDir]) {
        assert.equal((yield* fs.stat(folder)).mode & 0o777, 0o755);
      }
    }),
  );

  it.effect.each([
    ["t3code", /reserved for the gateway/],
    ["alice", /home directory.*does not exist/],
  ] as const)("rejects enrollment of %s before touching config or systemd", ([user, expected]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-add-" });
      const error = yield* Effect.flip(
        enrollGatewayUser(user).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.UserId, 0),
          Effect.provideService(HostProcess.Environment, {
            [GATEWAY_CONFIG_PATH_ENV]: path.join(directory, "missing", "gateway.json"),
          }),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            lstat: trustedDirectories(fs),
            chown: () => Effect.die("Unexpected ownership change"),
          }),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: ({ command }) => {
              assert.equal(command, "getent");
              return Effect.succeed({
                stdout: `${user}:x:1001:1001::${directory}/missing-home:/bin/sh\n`,
                stderr: "",
                code: ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        ),
      );
      assert.match(error.message, expected);
      assert.deepEqual(yield* fs.readDirectory(directory), []);
    }),
  );

  it.effect("rejects writable override ancestors before enrollment or cleanup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-paths-" });
      const unsafe = path.join(directory, "shared");
      yield* fs.makeDirectory(unsafe);
      for (const mode of [0o775, 0o1777]) {
        yield* fs.chmod(unsafe, mode);
        for (const env of [
          { [GATEWAY_CONFIG_PATH_ENV]: path.join(unsafe, "missing", "gateway.json") },
          { [GATEWAY_PAIRING_DIR_ENV]: path.join(unsafe, "missing", "pairing") },
        ]) {
          for (const command of [enrollGatewayUser("alice"), unenrollGatewayUser("alice")]) {
            const error = yield* Effect.flip(
              command.pipe(
                Effect.provideService(HostProcess.Platform, "linux"),
                Effect.provideService(HostProcess.UserId, 0),
                Effect.provideService(HostProcess.Environment, {
                  [GATEWAY_CONFIG_PATH_ENV]: path.join(directory, "gateway.json"),
                  ...env,
                }),
                Effect.provideService(FileSystem.FileSystem, {
                  ...fs,
                  lstat: (file) =>
                    file === unsafe
                      ? fs
                          .lstat(file)
                          .pipe(Effect.map((info) => ({ ...info, uid: Option.some(0) })))
                      : trustedDirectories(fs)(file),
                  remove: () => Effect.die("Unexpected filesystem cleanup"),
                }),
                Effect.provideService(ProcessRunner.ProcessRunner, {
                  run: () => Effect.die("Unexpected system tool call"),
                }),
              ),
            );
            assert.include(error.message, unsafe);
          }
        }
      }
      assert.deepEqual(yield* fs.readDirectory(unsafe), []);
    }),
  );

  it.effect("rejects add and remove with an unsafe config owner or mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-config-" });
      const configPath = path.join(directory, "gateway.json");
      const config = JSON.stringify(emptyGatewayConfig);
      yield* fs.writeFileString(configPath, config);
      for (const [uid, mode] of [
        [1001, 0o644],
        [0, 0o664],
        [0, 0o646],
      ] as const) {
        for (const command of [enrollGatewayUser("alice"), unenrollGatewayUser("alice")]) {
          const result = yield* Effect.result(
            command.pipe(
              Effect.provideService(HostProcess.Platform, "linux"),
              Effect.provideService(HostProcess.UserId, 0),
              Effect.provideService(HostProcess.Environment, {
                [GATEWAY_CONFIG_PATH_ENV]: configPath,
              }),
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                lstat: (file) =>
                  file === configPath
                    ? fs
                        .lstat(file)
                        .pipe(Effect.map((info) => ({ ...info, uid: Option.some(uid), mode })))
                    : trustedDirectories(fs)(file),
                chown: () => Effect.die("Unexpected ownership change"),
                remove: () => Effect.die("Unexpected filesystem cleanup"),
              }),
              Effect.provideService(ProcessRunner.ProcessRunner, {
                run: () => Effect.die("Unexpected system tool call"),
              }),
            ),
          );
          assert.propertyVal(result, "_tag", "Failure");
          if (result._tag === "Failure")
            assert.match(result.failure.message, /root-owned regular file/);
          assert.equal(yield* fs.readFileString(configPath), config);
        }
      }
    }),
  );

  it.effect("rejects explicit ports with a listener in either proc TCP table", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-add-" });
      const configPath = path.join(directory, "gateway.json");
      yield* fs.writeFileString(configPath, JSON.stringify(emptyGatewayConfig));
      const { first } = GATEWAY_BACKEND_PORT_RANGE;
      const procTable = (address: string, port: number) =>
        `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid\n0: ${address}:${port.toString(16)} ${"0".repeat(address.length)}:0000 0A 0:0 0:0 0 1002\n`;
      for (const port of [first, first + 1]) {
        const error = yield* Effect.flip(
          enrollGatewayUser("alice", port).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.UserId, 0),
            Effect.provideService(HostProcess.Environment, {
              [GATEWAY_CONFIG_PATH_ENV]: configPath,
            }),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              lstat: trustedDirectories(fs),
              readFileString: (filePath, encoding) => {
                if (filePath === "/proc/net/tcp")
                  return Effect.succeed(procTable("0100007F", first));
                if (filePath === "/proc/net/tcp6") {
                  return Effect.succeed(procTable("00000000000000000000000000000000", first + 1));
                }
                return fs.readFileString(filePath, encoding);
              },
              makeTempDirectory: () =>
                Effect.die("Enrollment attempted to write before validating listeners"),
            }),
            Effect.provideService(ProcessRunner.ProcessRunner, {
              run: ({ command, args }) => {
                assert.equal(command, "getent");
                assert.deepEqual(args, ["passwd", "alice"]);
                return Effect.succeed({
                  stdout: `alice:x:1001:1001::${directory}:/bin/sh\n`,
                  stderr: "",
                  code: ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                });
              },
            }),
          ),
        );
        assert.include(error.message, "must be unused");
      }
    }),
  );
});

it.effect("retries all cleanup after the routing entry has been removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-remove-" });
    const configPath = path.join(directory, "gateway.json");
    const envPath = path.join(directory, "alice.env");
    const pairingDir = path.join(directory, "pairing");
    const userDir = path.join(pairingDir, "alice");
    const config = yield* addGatewayUser(emptyGatewayConfig, "alice", 1001);
    yield* fs.writeFileString(configPath, JSON.stringify(config));
    yield* fs.writeFileString(envPath, gatewayUserEnv(config.users.alice!.port));
    yield* fs.makeDirectory(userDir, { recursive: true });
    yield* fs.writeFileString(path.join(userDir, "marker"), "");
    const otherUserDir = path.join(pairingDir, "bob");
    yield* fs.makeDirectory(otherUserDir);
    const otherMarker = path.join(otherUserDir, "marker");
    yield* fs.writeFileString(otherMarker, "");
    yield* fs.symlink(otherUserDir, path.join(userDir, "link"));
    const warnings: Array<string> = [];
    const callerPath = path.join(directory, "caller-bin");
    const remove = unenrollGatewayUser("alice").pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 0),
      Effect.provideService(HostProcess.Environment, {
        [GATEWAY_CONFIG_PATH_ENV]: configPath,
        [GATEWAY_PAIRING_DIR_ENV]: pairingDir,
        PATH: callerPath,
      }),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        lstat: trustedDirectories(fs),
        remove: (filePath, options) =>
          fs.remove(
            filePath === path.join(GATEWAY_USER_ENV_DIR, "alice.env") ? envPath : filePath,
            options,
          ),
      }),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: ({ command, args, env }) =>
          Effect.gen(function* () {
            assert.equal(env?.PATH ?? callerPath, "/usr/sbin:/usr/bin:/sbin:/bin");
            if (command === "rm") {
              assert.deepEqual(args, [
                "--recursive",
                "--force",
                "--one-file-system",
                "--",
                userDir,
              ]);
              yield* fs.remove(userDir, { recursive: true });
            } else {
              assert.equal(command, "systemctl");
              assert.deepEqual(args, ["disable", "--now", "t3code@alice.service"]);
              assert.deepEqual((yield* readGatewayConfig(configPath)).users, {});
              assert.isFalse(yield* fs.exists(envPath));
            }
            return {
              stdout: "",
              stderr: command === "systemctl" ? "Unit not found" : "",
              code: ExitCode(command === "systemctl" ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie),
      }),
      Effect.updateService(Console.Console, (console) => ({
        ...console,
        warn: (...args) => {
          warnings.push(args.join(" "));
        },
      })),
    );
    yield* remove;
    assert.isFalse(yield* fs.exists(userDir));
    assert.isTrue(yield* fs.exists(otherMarker));
    const configWithoutAlice = JSON.stringify(emptyGatewayConfig);
    yield* fs.writeFileString(configPath, configWithoutAlice);
    yield* fs.writeFileString(envPath, "");
    yield* fs.makeDirectory(userDir);
    yield* remove;
    assert.isFalse(yield* fs.exists(envPath));
    assert.isFalse(yield* fs.exists(userDir));
    assert.equal(yield* fs.readFileString(configPath), configWithoutAlice);
    assert.lengthOf(warnings, 2);
    assert.include(warnings[0], "systemctl could not disable --now t3code@alice.service");
    yield* fs.writeFileString(configPath, "{ not json");
    yield* fs.writeFileString(envPath, "");
    yield* Effect.flip(remove);
    assert.isTrue(yield* fs.exists(envPath));
    assert.lengthOf(warnings, 2);
  }).pipe(Effect.provide(NodeServices.layer)),
);
