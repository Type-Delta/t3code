#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

/** Per-platform artifact the local installer flow builds and then opens. */
export function resolveLocalInstallerTarget(
  platform: NodeJS.Platform,
  arch: string,
  version: string,
): { readonly script: string; readonly artifact: string } | null {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return {
      script: `dist:desktop:win:${arch}`,
      artifact: `T3-Code-${version}-${arch}.exe`,
    };
  }
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) {
    return {
      script: `dist:desktop:dmg:${arch}`,
      artifact: `T3-Code-${version}-${arch}.dmg`,
    };
  }
  if (platform === "linux" && arch === "x64") {
    return { script: "dist:desktop:linux", artifact: `T3-Code-${version}-x64.AppImage` };
  }
  return null;
}

export class UnsupportedLocalInstallTargetError extends Schema.TaggedErrorClass<UnsupportedLocalInstallTargetError>()(
  "UnsupportedLocalInstallTargetError",
  { platform: Schema.String, arch: Schema.String },
) {
  override get message(): string {
    return `No local desktop installer is defined for ${this.platform}/${this.arch}.`;
  }
}

export class LocalInstallCommandFailedError extends Schema.TaggedErrorClass<LocalInstallCommandFailedError>()(
  "LocalInstallCommandFailedError",
  { command: Schema.String, exitCode: Schema.Number },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export class MissingLocalInstallerError extends Schema.TaggedErrorClass<MissingLocalInstallerError>()(
  "MissingLocalInstallerError",
  { artifactPath: Schema.String },
) {
  override get message(): string {
    return `The build finished but ${this.artifactPath} was not found.`;
  }
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const version = serverPackageJson.version;

  const target = resolveLocalInstallerTarget(platform, arch, version);
  if (!target) {
    return yield* new UnsupportedLocalInstallTargetError({ platform, arch });
  }

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const artifactPath = path.join(repoRoot, "release", target.artifact);

  yield* Effect.log(`[install-local] Building ${target.artifact} via vp run ${target.script}...`);
  const build = yield* resolveSpawnCommand("vp", ["run", target.script]);
  const buildExit = yield* spawner
    .spawn(
      ChildProcess.make(build.command, build.args, {
        cwd: repoRoot,
        shell: build.shell,
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.flatMap((child) => child.exitCode),
      Effect.map(Number),
    );
  if (buildExit !== 0) {
    return yield* new LocalInstallCommandFailedError({
      command: `vp run ${target.script}`,
      exitCode: buildExit,
    });
  }

  if (!(yield* fs.exists(artifactPath))) {
    return yield* new MissingLocalInstallerError({ artifactPath });
  }

  yield* Effect.log(`[install-local] Opening ${artifactPath}`);
  const open =
    platform === "win32"
      ? { command: artifactPath, args: [] as ReadonlyArray<string>, shell: false }
      : platform === "darwin"
        ? { command: "open", args: [artifactPath], shell: false }
        : { command: "xdg-open", args: [artifactPath], shell: false };
  yield* spawner.spawn(
    ChildProcess.make(open.command, [...open.args], { cwd: repoRoot, shell: open.shell }),
  );
  yield* Effect.log("[install-local] Installer launched. Close T3 Code before continuing setup.");
});

// Importing this module (tests, tooling) must not kick off a desktop build.
if (
  process.argv[1] &&
  import.meta.filename.replaceAll("\\", "/") === process.argv[1].replaceAll("\\", "/")
) {
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer), Effect.scoped));
}
