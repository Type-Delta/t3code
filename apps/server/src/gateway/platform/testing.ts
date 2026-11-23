// @effect-diagnostics nodeBuiltinImport:off -- the fake layout is built synchronously.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import { GatewayPlatformError, type GatewayPlatform } from "./GatewayPlatform.ts";

/** Node services, with a ProcessRunner that fails the test: neutral code never runs OS tools. */
export const testGatewayServices = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(ProcessRunner.ProcessRunner, {
    run: Effect.fn("TestGatewayPlatform.run")(function* ({ command }) {
      return yield* Effect.die(`Neutral gateway code ran ${command}.`);
    }),
  }),
);

/** POSIX mode bits and file owners. On Windows chmod only toggles read-only and owners read as 0. */
export const posixOwnership = HostProcess.Platform.defaultValue() !== "win32";

/** A scoped temporary directory reached without symlinks, as macOS keeps them below `/var`. */
export const makeTestGatewayRoot = Effect.fn("TestGatewayPlatform.root")(function* (
  prefix: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }));
});

const asPlatformError = Effect.mapError(
  (error: { readonly message: string }) => new GatewayPlatformError({ message: error.message }),
);

/**
 * A GatewayPlatform over real files below `root` for neutral gateway tests. Ownership always
 * passes; `calls` records directory securing, tree removal and every service call.
 */
export const makeTestGatewayPlatform = (root: string) => {
  const calls: Array<string> = [];
  const record = (call: string) => Effect.sync(() => void calls.push(call));
  const checkKind = Effect.fn("TestGatewayPlatform.checkKind")(function* (
    file: string,
    kind: "File" | "Directory",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(file);
    if (exists && (yield* fs.lstat(file)).type !== kind) {
      return yield* new GatewayPlatformError({ message: `Expected a ${kind} at ${file}.` });
    }
    return exists;
  }, asPlatformError);
  const platform: GatewayPlatform = {
    name: "linux",
    layout: {
      installRoot: NodePath.join(root, "install"),
      launcher: NodePath.join(root, "bin", "t3"),
      configPath: NodePath.join(root, "config", "gateway.json"),
      pairingDir: NodePath.join(root, "data", "pairing"),
      executableName: "t3",
      runtimeEntries: [
        ["client", "Directory"],
        ["lib", "Directory"],
        ["client/index.html", "File"],
      ],
    },
    currentAccount: Effect.succeed(1001),
    isAdmin: Effect.succeed(true),
    lookupUser: (name) => Effect.succeed({ name, accountId: 1001, home: root }),
    checkAdminOwned: checkKind,
    checkRuntimeSource: (file, kind) => Effect.asVoid(checkKind(file, kind)),
    secureDirectory: Effect.fn("TestGatewayPlatform.secureDirectory")(function* (directory, owner) {
      const fs = yield* FileSystem.FileSystem;
      yield* record(`secure ${directory} ${owner === "admin" ? owner : owner.name}`);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.chmod(directory, 0o755);
    }, asPlatformError),
    secureRuntimeFile: Effect.fn("TestGatewayPlatform.secureRuntimeFile")(function* (
      file,
      executable,
    ) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.chmod(file, executable ? 0o755 : 0o644);
    }, asPlatformError),
    removeTree: Effect.fn("TestGatewayPlatform.removeTree")(function* (directory) {
      const fs = yield* FileSystem.FileSystem;
      yield* record(`remove ${directory}`);
      yield* fs.remove(directory, { recursive: true, force: true });
    }, asPlatformError),
    replaceLink: Effect.fn("TestGatewayPlatform.replaceLink")(function* (target, link) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.symlink(target, `${link}.staged`);
      // Windows cannot rename over a directory link; the win32 adapter moves it aside first.
      if (!posixOwnership) yield* fs.remove(link, { force: true });
      yield* fs.rename(`${link}.staged`, link);
    }, asPlatformError),
    listeners: Effect.succeed([]),
    makeConnectionOwner: Effect.succeed(async () => undefined),
    markerAttribution: "file-owner",
    services: {
      ensureGatewayAccount: Effect.as(record("ensureGatewayAccount"), 999),
      preflight: record("preflight"),
      activate: ({ users }) => record(`activate ${users.map((user) => user.name).join(",")}`),
      enableUser: (user) => record(`enableUser ${user.name}`),
      disableUser: (user) => record(`disableUser ${user}`),
      userState: () => Effect.succeed("active"),
      uninstall: record("uninstall"),
      logHint: "the test log",
    },
  };
  return { platform, calls };
};
