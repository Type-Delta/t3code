import { sha256 } from "@noble/hashes/sha2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

import * as RelayClient from "./relayClient.ts";

const testPlatform = process.env.OS === "Windows_NT" ? "win32" : "linux";
const windowsHost = testPlatform === "win32";
const testExecutableName = testPlatform === "win32" ? "cloudflared.exe" : "cloudflared";

const layerHostRuntime = (env: Record<string, string> = {}) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, testPlatform),
    Layer.succeed(HostProcessArchitecture, "x64"),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

function makeHandle(exitCode = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerHttpClient = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

const layerSpawner = (commands: Array<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        commands.push(ChildProcess.isStandardCommand(command) ? command.command : "piped-command");
        // The pinned Windows executable rejects --version but accepts the version subcommand.
        return makeHandle(
          ChildProcess.isStandardCommand(command) && command.args.includes("--version") ? 1 : 0,
        );
      }),
    ),
  );

describe("RelayClient", () => {
  it.effect("resolves explicit overrides before managed and PATH executables", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const overridePath = `${baseDir}/override-cloudflared${testPlatform === "win32" ? ".exe" : ""}`;
      yield* fileSystem.writeFileString(overridePath, "override");
      yield* fileSystem.chmod(overridePath, 0o755);
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
      });

      expect(
        yield* manager.resolve.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: { PATH: "", T3CODE_CLOUDFLARED_PATH: overridePath },
            }),
          ),
        ),
      ).toEqual({
        status: "available",
        executablePath: overridePath,
        source: "override",
        version: RelayClient.CLOUDFLARED_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new Uint8Array()),
          layerSpawner([]),
          layerHostRuntime(),
        ),
      ),
    ),
  );

  it.effect.skipIf(windowsHost)(
    "downloads, verifies, validates, and atomically installs the managed executable",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const bytes = new TextEncoder().encode("test-cloudflared-binary");
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: {
            url: "https://example.test/cloudflared",
            sha256: Hex.encode(sha256(bytes)),
            archive: "binary",
          },
        });

        const progress: Array<string> = [];
        const installed = yield* manager.installWithProgress((event) =>
          Effect.sync(() => {
            if (event.type === "progress") {
              progress.push(event.stage);
            }
          }),
        );
        const managedPath = path.join(
          baseDir,
          "tools",
          "cloudflared",
          RelayClient.CLOUDFLARED_VERSION,
          `${testPlatform}-x64`,
          testExecutableName,
        );
        expect(installed).toEqual({
          status: "available",
          executablePath: managedPath,
          source: "managed",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
        expect(new TextDecoder().decode(yield* fileSystem.readFile(managedPath))).toBe(
          "test-cloudflared-binary",
        );
        expect(progress).toEqual([
          "checking",
          "waiting_for_lock",
          "downloading",
          "verifying",
          "installing",
          "validating",
          "activating",
        ]);
        expect(yield* manager.resolve).toEqual(installed);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new TextEncoder().encode("test-cloudflared-binary")),
            layerSpawner([]),
            layerHostRuntime(),
          ),
        ),
      ),
  );

  it.effect("rejects downloads whose checksum does not match the pinned manifest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(new TextEncoder().encode("expected"))),
          archive: "binary",
        },
      });

      const error = yield* manager.install.pipe(Effect.flip);
      expect(error).toBeInstanceOf(RelayClient.RelayClientInstallError);
      expect(error.reason).toBe("invalid_checksum");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new TextEncoder().encode("tampered")),
          layerSpawner([]),
          layerHostRuntime(),
        ),
      ),
    ),
  );

  it.effect.skipIf(windowsHost)("serializes concurrent installs within one runtime", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(bytes)),
          archive: "binary",
        },
      });

      const [first, second] = yield* Effect.all([manager.install, manager.install], {
        concurrency: "unbounded",
      });
      expect(second).toEqual(first);
      expect(commands).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(bytes),
          layerSpawner(commands),
          layerHostRuntime(),
        ),
      ),
    );
  });

  it.effect("observes PATH changes after the manager has been constructed", () => {
    const env = { PATH: "" };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const binDir = path.join(baseDir, "bin");
      const executablePath = path.join(binDir, testExecutableName);
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
      });

      expect(yield* manager.resolve).toEqual({
        status: "missing",
        version: RelayClient.CLOUDFLARED_VERSION,
      });

      yield* fileSystem.makeDirectory(binDir);
      yield* fileSystem.writeFileString(executablePath, "cloudflared");
      yield* fileSystem.chmod(executablePath, 0o755);
      env.PATH = binDir;

      expect(yield* manager.resolve).toEqual({
        status: "available",
        executablePath,
        source: "path",
        version: RelayClient.CLOUDFLARED_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new Uint8Array()),
          layerSpawner([]),
          layerHostRuntime(env),
        ),
      ),
    );
  });
});
