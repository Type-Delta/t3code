// oxlint-disable t3code/no-test-in-loop -- These cases intentionally exercise independent provider/process variants.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { spawnProviderProcess, withExecutablePathRecovery } from "./executableRecovery.ts";

const missingPath = NodePath.join(NodeOS.tmpdir(), "t3-missing-executable-recovery", "gone.exe");

describe("provider executable recovery", () => {
  for (const command of ["codex", "cursor-agent", "grok", "opencode"]) {
    it.effect(`recovers a missing PATH executable for ${command} before any work runs`, () => {
      let resolutions = 0;
      return Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawnProviderProcess(
          spawner,
          command,
          [
            "-e",
            "process.stdout.write(process.env.T3_RECOVERY_TEST + ':' + process.argv[1])",
            "once",
          ],
          { env: { T3_RECOVERY_TEST: "recovered" }, extendEnv: true },
        );
        const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.runCollect);
        assert.equal(Array.from(output).join(""), "recovered:once");
        assert.equal(Number(yield* child.exitCode), 0);
        assert.equal(resolutions, 2);
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(SpawnExecutableResolution, () => {
          resolutions += 1;
          return resolutions === 1 ? missingPath : process.execPath;
        }),
      );
    });
  }

  for (const command of ["codex", missingPath, "./missing/codex", "C:codex.exe"]) {
    it.effect(`stops after the allowed launch attempts for ${command}`, () => {
      let resolutions = 0;
      return Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const error = yield* spawnProviderProcess(spawner, command, [], {}).pipe(Effect.flip);
        assert.instanceOf(error, PlatformError.PlatformError);
        assert.equal(error.reason._tag, "NotFound");
        assert.equal(resolutions, command === "codex" ? 2 : 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(SpawnExecutableResolution, () => {
          resolutions += 1;
          return missingPath;
        }),
      );
    });
  }

  it.effect("preserves unrelated launch failures without retrying", () => {
    const error = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
    });
    let retries = 0;
    return Effect.gen(function* () {
      const result = yield* withExecutablePathRecovery("codex", Effect.fail(error), () => {
        retries += 1;
        return Effect.fail(error);
      }).pipe(Effect.flip);
      assert.strictEqual(result, error);
      assert.equal(retries, 0);
    });
  });

  it.effect("does not retry a process that starts and then reports ENOENT", () => {
    let resolutions = 0;
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawnProviderProcess(
        spawner,
        "codex",
        ["-e", "process.stderr.write('ENOENT'); process.exit(1)"],
        {},
      );
      const errorOutput = yield* child.stderr.pipe(Stream.decodeText(), Stream.runCollect);
      assert.equal(Array.from(errorOutput).join(""), "ENOENT");
      assert.equal(Number(yield* child.exitCode), 1);
      assert.equal(resolutions, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => {
        resolutions += 1;
        return process.execPath;
      }),
    );
  });

  it.effect("does not mistake a missing runtime resource for a missing executable", () => {
    const error = PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "readFile",
    });
    return Effect.gen(function* () {
      const result = yield* withExecutablePathRecovery("codex", Effect.fail(error), () =>
        Effect.die("must not retry a resource read"),
      ).pipe(Effect.flip);
      assert.strictEqual(result, error);
    });
  });
});
