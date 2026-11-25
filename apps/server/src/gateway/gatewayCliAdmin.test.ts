import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { GatewayPlatformError } from "./platform/GatewayPlatform.ts";
import {
  makeTestGatewayPlatform,
  makeTestGatewayRoot,
  posixOwnership,
  testGatewayServices,
} from "./platform/testing.ts";
import {
  emptyGatewayConfig,
  GATEWAY_BACKEND_PORT_RANGE,
  GATEWAY_CONFIG_PATH_ENV,
  GATEWAY_PAIRING_DIR_ENV,
} from "./GatewayConfig.ts";
import {
  addGatewayUser,
  enrollGatewayUser,
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

it.effect("accepts Windows SID account ids in the version 1 config", () =>
  Effect.gen(function* () {
    const config = yield* addGatewayUser(emptyGatewayConfig, "alice", "S-1-5-21-100-200-300-1001");
    assert.equal(config.users.alice?.uid, "S-1-5-21-100-200-300-1001");
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
      ["user0", 2000, undefined, "account id has changed"],
    ] as const) {
      const error = yield* Effect.flip(addGatewayUser(full, user, uid, port));
      assert.include(error.message, expected);
    }
  }),
);

const fixture = Effect.fn("gatewayCliAdminTest.fixture")(function* () {
  const root = yield* makeTestGatewayRoot("t3-gateway-admin-");
  return { root, ...makeTestGatewayPlatform(root) };
});

const untrusted = (path: string) =>
  new GatewayPlatformError({ message: `Expected a root-owned directory at ${path}.` });

it.layer(testGatewayServices)("gateway administration", (it) => {
  it.effect("creates and repairs the enrolled user's pairing directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, platform, calls } = yield* fixture();
      const { configPath, pairingDir } = platform.layout;
      const userDir = path.join(pairingDir, "alice");
      const enroll = enrollGatewayUser(platform, "alice", 3801);
      assert.equal(yield* enroll, 3801);
      const marker = path.join(userDir, "marker");
      yield* fs.writeFileString(marker, "");
      yield* fs.chmod(configPath, 0o600);
      assert.equal(yield* enroll, 3801);
      if (posixOwnership) assert.equal((yield* fs.stat(configPath)).mode & 0o777, 0o644);
      assert.isTrue(yield* fs.exists(marker));
      assert.deepEqual(calls.slice(-5), [
        `secure ${path.dirname(configPath)} admin`,
        `secure ${path.dirname(pairingDir)} admin`,
        `secure ${pairingDir} admin`,
        `secure ${userDir} alice`,
        "enableUser alice",
      ]);

      // An override pairing dir that already exists keeps its own mode.
      const override = path.join(root, "override");
      yield* fs.makeDirectory(override, { mode: 0o751 });
      yield* fs.chmod(override, 0o751);
      calls.length = 0;
      yield* enrollGatewayUser(platform, "alice").pipe(
        Effect.provideService(HostProcess.Environment, { [GATEWAY_PAIRING_DIR_ENV]: override }),
      );
      assert.notInclude(calls, `secure ${override} admin`);
      assert.include(calls, `secure ${path.join(override, "alice")} alice`);
      if (posixOwnership) assert.equal((yield* fs.stat(override)).mode & 0o777, 0o751);
    }),
  );

  it.effect("rejects an unknown user before touching config or services", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, platform, calls } = yield* fixture();
      const error = yield* Effect.flip(
        enrollGatewayUser(
          {
            ...platform,
            lookupUser: (name) =>
              Effect.fail(new GatewayPlatformError({ message: `${name} was not found.` })),
          },
          "alice",
        ),
      );
      assert.include(error.message, "alice was not found");
      assert.deepEqual(yield* fs.readDirectory(root), []);
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("rejects untrusted config or override ancestors before enrollment or cleanup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, platform, calls } = yield* fixture();
      const config = JSON.stringify(emptyGatewayConfig);
      yield* fs.makeDirectory(path.dirname(platform.layout.configPath));
      yield* fs.writeFileString(platform.layout.configPath, config);
      const unsafe = path.join(root, "shared");
      yield* fs.makeDirectory(unsafe);
      for (const [rejected, env] of [
        [platform.layout.configPath, {}],
        [unsafe, { [GATEWAY_CONFIG_PATH_ENV]: path.join(unsafe, "missing", "gateway.json") }],
        [unsafe, { [GATEWAY_PAIRING_DIR_ENV]: path.join(unsafe, "missing", "pairing") }],
      ] as const) {
        const guarded = {
          ...platform,
          checkAdminOwned: (
            file: string,
            kind: "File" | "Directory",
            options?: { readonly ancestor?: boolean },
          ) =>
            file === rejected
              ? Effect.fail(untrusted(file))
              : platform.checkAdminOwned(file, kind, options),
        };
        for (const command of [
          enrollGatewayUser(guarded, "alice"),
          unenrollGatewayUser(guarded, "alice"),
        ]) {
          const error = yield* Effect.flip(
            command.pipe(Effect.provideService(HostProcess.Environment, env)),
          );
          assert.include(error.message, rejected);
        }
      }
      assert.deepEqual(yield* fs.readDirectory(unsafe), []);
      assert.equal(yield* fs.readFileString(platform.layout.configPath), config);
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("rejects administration without admin rights", () =>
    Effect.gen(function* () {
      const { platform, calls } = yield* fixture();
      const user = { ...platform, isAdmin: Effect.succeed(false) };
      for (const command of [
        enrollGatewayUser(user, "alice"),
        unenrollGatewayUser(user, "alice"),
      ]) {
        assert.match((yield* Effect.flip(command)).message, /as root or an elevated administrator/);
      }
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("rejects explicit ports another process listens on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { platform } = yield* fixture();
      const { first } = GATEWAY_BACKEND_PORT_RANGE;
      const listening = {
        ...platform,
        listeners: Effect.succeed([
          { port: first, owner: 1002 },
          { port: first + 1, owner: 1003 },
        ]),
      };
      for (const port of [first, first + 1]) {
        const error = yield* Effect.flip(enrollGatewayUser(listening, "alice", port));
        assert.include(error.message, "must be unused");
      }
      assert.isFalse(yield* fs.exists(platform.layout.configPath));
      assert.equal(yield* enrollGatewayUser(listening, "alice"), first + 2);
    }),
  );

  it.effect("retries all cleanup after the routing entry has been removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { platform, calls } = yield* fixture();
      const { configPath, pairingDir } = platform.layout;
      const userDir = path.join(pairingDir, "alice");
      const config = yield* addGatewayUser(emptyGatewayConfig, "alice", 1001);
      yield* fs.makeDirectory(path.dirname(configPath));
      yield* fs.writeFileString(configPath, JSON.stringify(config));
      yield* fs.makeDirectory(userDir, { recursive: true });
      yield* fs.writeFileString(path.join(userDir, "marker"), "");
      const warnings: Array<string> = [];
      const remove = unenrollGatewayUser(
        {
          ...platform,
          services: {
            ...platform.services,
            disableUser: (user) =>
              Effect.gen(function* () {
                calls.push(`disableUser ${user}`);
                assert.deepEqual(
                  (yield* readGatewayConfig(configPath).pipe(Effect.orDie)).users,
                  {},
                );
                return yield* new GatewayPlatformError({ message: `Could not stop ${user}.` });
              }),
          },
        },
        "alice",
      ).pipe(
        Effect.updateService(Console.Console, (console) => ({
          ...console,
          warn: (...args) => {
            warnings.push(args.join(" "));
          },
        })),
      );
      yield* remove;
      assert.isFalse(yield* fs.exists(userDir));
      const configWithoutAlice = JSON.stringify(emptyGatewayConfig);
      yield* fs.writeFileString(configPath, configWithoutAlice);
      yield* fs.makeDirectory(userDir);
      yield* remove;
      assert.isFalse(yield* fs.exists(userDir));
      assert.equal(yield* fs.readFileString(configPath), configWithoutAlice);
      assert.deepEqual(warnings, [
        "Warning: Could not stop alice.",
        "Warning: Could not stop alice.",
      ]);
      assert.deepEqual(calls, [
        `remove ${userDir}`,
        "disableUser alice",
        `remove ${userDir}`,
        "disableUser alice",
      ]);
      yield* fs.writeFileString(configPath, "{ not json");
      yield* Effect.flip(remove);
      assert.lengthOf(warnings, 2);
    }),
  );
});
