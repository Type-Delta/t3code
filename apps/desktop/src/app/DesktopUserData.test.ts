import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("identifies a failed source read and preserves its cause", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const sourceState = path.join("/profiles", "t3code", "Local State");
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: sourceState,
    });
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(
      Effect.flip,
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (resourcePath) => Effect.succeed(resourcePath === sourceState),
          readFileString: () => Effect.fail(cause),
        }),
      ),
    );
    assert.equal(error.operation, "read");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("prefers the default t3code key when both V1 profiles have one", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
    for (const [name, key] of [
      ["t3code", "key-that-encrypted-v1-secrets"],
      ["T3 Code (Alpha)", "unused-alpha-key"],
    ] as const) {
      yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
      yield* fs.writeFileString(path.join(directory, name, "Local State"), key);
    }
    yield* resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: false,
      platform: "win32",
    });
    assert.equal(
      yield* fs.readFileString(path.join(directory, "t3code-v2", "Local State")),
      "key-that-encrypted-v1-secrets",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "t3code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
