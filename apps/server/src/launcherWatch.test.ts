// @effect-diagnostics-next-line nodeBuiltinImport:off -- These tests drive a Node stdin boundary.
import * as NodeStream from "node:stream";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { awaitLauncherLoss, stopOnLauncherLoss } from "./launcherWatch.ts";

const launcherPid = 4100;
// Orphans are adopted by init or a subreaper, so the new parent is not always 1.
const subreaperPid = 1800;

const watch = (getParentPid: () => number, platform: NodeJS.Platform, startPid = launcherPid) =>
  awaitLauncherLoss({ launcherPid: startPid, getParentPid }).pipe(
    Effect.provideService(HostProcess.Platform, platform),
  );

it.effect("notices a launcher that was already gone when the watch began", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(watch(() => subreaperPid, "linux"));
    yield* Effect.yieldNow;
    yield* Fiber.join(fiber);
  }),
);

it.effect("exits when shutdown after launcher loss outlasts the grace period", () =>
  Effect.gen(function* () {
    let exits = 0;
    const cleanupDone = yield* Deferred.make<void>();
    const stuckCleanup = Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(cleanupDone)));
    const fiber = yield* Effect.forkChild(
      stopOnLauncherLoss(stuckCleanup, {
        launcherPid,
        getParentPid: () => subreaperPid,
        shutdownGrace: "5 seconds",
        exit: () => void exits++,
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("4 seconds");
    assert.strictEqual(exits, 0);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(exits, 1);
    yield* Deferred.succeed(cleanupDone, undefined);
    yield* Fiber.await(fiber);
  }),
);

it.effect.each([false, true])(
  "stops a Windows desktop backend on stdin EOF (already ended: %s)",
  (alreadyEnded) =>
    Effect.gen(function* () {
      const stdin = new NodeStream.PassThrough();
      yield* Effect.addFinalizer(() => Effect.sync(() => void stdin.destroy()));
      if (alreadyEnded) {
        yield* Effect.callback<void>((resume) => {
          stdin.once("end", () => resume(Effect.void));
          stdin.end();
          stdin.resume();
        });
      }
      const started = yield* Deferred.make<void>();
      const run = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      const backend = yield* stopOnLauncherLoss(run, {
        bootstrapFd: 3,
        stdin,
        exit: () => assert.fail("graceful shutdown should finish before the fallback"),
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.forkChild({ startImmediately: true }),
      );
      if (!alreadyEnded) {
        yield* Deferred.await(started);
        stdin.end();
      }
      const exit = yield* Fiber.await(backend);
      assert.isTrue(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause));
      assert.equal(stdin.listenerCount("end"), 0);
    }),
);

it.effect.each([
  { platform: "win32", bootstrapFd: undefined },
  { platform: "win32", bootstrapFd: 0 },
  { platform: "linux", bootstrapFd: 3 },
] as const)(
  "leaves stdin alone on $platform with bootstrap fd $bootstrapFd",
  ({ platform, bootstrapFd }) =>
    Effect.gen(function* () {
      const stdin = new NodeStream.PassThrough();
      yield* Effect.addFinalizer(() => Effect.sync(() => void stdin.destroy()));
      const watch = yield* awaitLauncherLoss({
        bootstrapFd,
        stdin,
        launcherPid,
        getParentPid: () => launcherPid,
      }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal(stdin.listenerCount("end"), 0);
      assert.isUndefined(watch.pollUnsafe());
    }),
);
