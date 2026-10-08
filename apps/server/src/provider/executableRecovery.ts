import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

function isMissingExecutable(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error !== undefined && !seen.has(error)) {
    seen.add(error);
    if (
      error instanceof PlatformError.PlatformError &&
      error.reason._tag === "NotFound" &&
      error.reason.module === "ChildProcess" &&
      error.reason.method === "spawn"
    )
      return true;
    if (
      error instanceof ReferenceError &&
      error.message.startsWith("Claude Code native binary not found at ")
    )
      return true;
    if (
      Predicate.hasProperty(error, "code") &&
      error.code === "ENOENT" &&
      Predicate.hasProperty(error, "syscall") &&
      typeof error.syscall === "string" &&
      error.syscall.startsWith("spawn")
    )
      return true;
    error = Predicate.hasProperty(error, "cause") ? error.cause : undefined;
  }
  return false;
}

/** Retry launch failures once using a fresh PATH lookup; explicit paths remain authoritative. */
export function withExecutablePathRecovery<A, E, R, E2, R2>(
  command: string,
  launch: Effect.Effect<A, E, R>,
  recover: () => Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> {
  return launch.pipe(
    Effect.catch((error): Effect.Effect<A, E | E2, R2> =>
      command.includes("/") ||
      command.includes("\\") ||
      /^[a-z]:/iu.test(command) ||
      !isMissingExecutable(error)
        ? Effect.fail(error)
        : recover(),
    ),
  );
}

/** Resolve again only when the child could not start; never replay a running process. */
export const spawnProviderProcess = Effect.fn("spawnProviderProcess")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions,
) {
  const launch = Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(command, args, {
      ...(options.env ? { env: options.env } : {}),
      extendEnv: options.extendEnv ?? true,
    });
    return yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        ...options,
        shell: resolved.shell,
      }),
    );
  });
  return yield* withExecutablePathRecovery(command, launch, () => launch);
});
