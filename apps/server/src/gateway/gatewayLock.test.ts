import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import { lockGatewayPath } from "./gatewayCliAdmin.ts";
import { testGatewayServices } from "./platform/testing.ts";

const contention = vi.hoisted(() => Promise.withResolvers<void>());

// Windows refuses to rename a folder onto an existing one with EPERM.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof fs.renameSync = (from, to) => {
    if (fs.existsSync(to)) {
      contention.resolve();
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    fs.renameSync(from, to);
  };
  return { ...fs, renameSync, default: { ...fs, renameSync } };
});

it.layer(testGatewayServices)("gateway lock", (it) => {
  it.effect("waits for a held lock on Windows and reclaims one from an earlier boot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-lock-" });
      const file = path.join(root, "gateway.json");
      const lock = `${file}.selection-lock`;

      const held = yield* Scope.make();
      yield* lockGatewayPath(file).pipe(Scope.provide(held));
      const waiter = yield* lockGatewayPath(file).pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.promise(() => contention.promise);
      yield* Scope.close(held, Exit.void);
      yield* Fiber.join(waiter);
      assert.isFalse(yield* fs.exists(lock));

      yield* fs.makeDirectory(lock);
      yield* fs.writeFileString(
        path.join(lock, `${process.pid}.1.00000000-0000-4000-8000-000000000000`),
        "",
      );
      yield* Effect.scoped(lockGatewayPath(file));
      assert.isFalse(yield* fs.exists(lock));
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );
});
