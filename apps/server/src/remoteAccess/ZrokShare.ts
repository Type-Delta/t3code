import type { AdvertisedEndpoint, ZrokShareStatus } from "@t3tools/contracts";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { formatHostForUrl } from "../startupAccess.ts";

const START_TIMEOUT = "20 seconds";
const STOP_GRACE = "2 seconds";
const ANNOUNCEMENT = "access your zrok share at the following endpoints:";
const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const ANSI_ESCAPE = new RegExp(
  `${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\))`,
  "gu",
);
const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString);

export function resolveZrokTarget(
  config: Pick<ServerConfig.ServerConfig["Service"], "host" | "port">,
): string {
  const host =
    config.host === "0.0.0.0"
      ? "127.0.0.1"
      : config.host === "::" || config.host === "[::]"
        ? "::1"
        : (config.host ?? "127.0.0.1");
  return `http://${formatHostForUrl(host)}:${config.port}`;
}

export function parseZrokHeadlessEndpoint(output: string): string | null {
  const clean = output.replace(ANSI_ESCAPE, "");
  const messages = [clean];
  for (const line of clean.split(/\r?\n/u)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "msg" in parsed &&
        typeof parsed.msg === "string"
      ) {
        messages.push(parsed.msg);
      }
    } catch {
      // Plain-text zrok logs are handled below.
    }
  }

  for (const message of messages) {
    const announcementIndex = message.toLowerCase().indexOf(ANNOUNCEMENT);
    if (announcementIndex === -1) continue;
    const candidate = message
      .slice(announcementIndex + ANNOUNCEMENT.length)
      .match(/^\s*(https?:\/\/\S+)/iu)?.[1];
    if (!candidate) continue;
    const decoded = decodeUrl(candidate);
    if (
      Option.isSome(decoded) &&
      (decoded.value.protocol === "http:" || decoded.value.protocol === "https:")
    ) {
      return decoded.value.href;
    }
  }
  return null;
}

function endpointFor(publicUrl: string): AdvertisedEndpoint {
  const httpUrl = new URL(publicUrl);
  const wsUrl = new URL(publicUrl);
  wsUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return {
    id: "zrok",
    label: "zrok",
    provider: { id: "zrok", label: "zrok", kind: "tunnel", isAddon: false },
    httpBaseUrl: httpUrl.href,
    wsBaseUrl: wsUrl.href,
    reachability: "public",
    compatibility: {
      hostedHttpsApp: httpUrl.protocol === "https:" ? "compatible" : "mixed-content-blocked",
      desktopApp: "compatible",
    },
    source: "server",
    status: "available",
  };
}

const stoppedStatus = (): ZrokShareStatus => ({
  state: "stopped",
  publicUrl: null,
  message: null,
  endpoint: null,
});

export class ZrokShare extends Context.Service<
  ZrokShare,
  {
    readonly getStatus: Effect.Effect<ZrokShareStatus>;
    readonly start: Effect.Effect<ZrokShareStatus>;
    readonly stop: Effect.Effect<ZrokShareStatus>;
  }
>()("t3/remoteAccess/ZrokShare") {}

interface ActiveShare {
  readonly attempt: number;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const serviceScope = yield* Scope.make("sequential");
  const lock = yield* Semaphore.make(1);
  const processLock = yield* Semaphore.make(1);
  let status = stoppedStatus();
  let active: ActiveShare | null = null;
  let pending: Deferred.Deferred<ZrokShareStatus> | null = null;
  let stopping: Deferred.Deferred<ZrokShareStatus> | null = null;
  let queuedStop: Deferred.Deferred<ZrokShareStatus> | null = null;
  let generation = 0;

  const closeActive = (share: ActiveShare) =>
    share.child.kill({ killSignal: "SIGTERM", forceKillAfter: STOP_GRACE }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.andThen(Scope.close(share.scope, Exit.void)),
      Effect.ignore,
    );

  const getStatus = lock.withPermits(1)(Effect.sync(() => status));

  const finishAttempt = (
    attempt: number,
    deferred: Deferred.Deferred<ZrokShareStatus>,
    nextStatus: ZrokShareStatus,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (generation === attempt) {
          status = nextStatus;
          pending = null;
        }
        yield* Deferred.succeed(deferred, status);
        return status;
      }),
    );

  const launch = Effect.fn("ZrokShare.launch")(function* (
    attempt: number,
    deferred: Deferred.Deferred<ZrokShareStatus>,
  ) {
    const target = resolveZrokTarget(config);
    const shareScope = yield* Scope.make("sequential");
    const spawnResult = yield* processLock.withPermits(1)(
      Effect.gen(function* () {
        const isCurrent = yield* lock.withPermits(1)(
          Effect.sync(() => {
            const current = generation === attempt && pending === deferred;
            if (current) {
              status = { state: "starting", publicUrl: null, message: null, endpoint: null };
            }
            return current;
          }),
        );
        if (!isCurrent) return { type: "stale" as const };

        const executable =
          resolveExecutable("zrok2", hostPlatform, hostEnvironment) ??
          resolveExecutable("zrok", hostPlatform, hostEnvironment);
        if (!executable) return { type: "unavailable" as const };

        const spawned = yield* Effect.result(
          Effect.gen(function* () {
            const command = yield* resolveSpawnCommand(
              executable,
              ["share", "public", "--headless", "--force-local", target],
              { env: hostEnvironment, extendEnv: true },
            );
            return yield* spawner.spawn(
              ChildProcess.make(command.command, command.args, {
                env: hostEnvironment,
                extendEnv: true,
                shell: false,
                stderr: "pipe",
                stdout: "pipe",
              }),
            );
          }).pipe(
            Effect.provideService(Scope.Scope, shareScope),
            Effect.provideService(HostProcessPlatform, hostPlatform),
            Effect.provideService(HostProcessEnvironment, hostEnvironment),
            Effect.provideService(SpawnExecutableResolution, resolveExecutable),
          ),
        );
        if (Result.isFailure(spawned)) return { type: "unavailable" as const };

        const share = { attempt, child: spawned.success, scope: shareScope } satisfies ActiveShare;
        const accepted = yield* lock.withPermits(1)(
          Effect.sync(() => {
            if (generation !== attempt || pending !== deferred) return false;
            active = share;
            return true;
          }),
        );
        if (!accepted) {
          yield* closeActive(share);
          return { type: "stale" as const };
        }
        return { type: "active" as const, share };
      }),
    );

    if (spawnResult.type !== "active") {
      yield* Scope.close(shareScope, Exit.void).pipe(Effect.ignore);
      if (spawnResult.type === "stale") return yield* Deferred.await(deferred);
      return yield* finishAttempt(attempt, deferred, {
        state: "unavailable",
        publicUrl: null,
        message: "zrok is not installed or unavailable.",
        endpoint: null,
      });
    }

    const share = spawnResult.share;

    const endpoint = yield* Deferred.make<string, never>();
    let announcement = "";
    yield* Effect.forkIn(Stream.runDrain(share.child.stdout), shareScope);
    yield* Effect.forkIn(
      share.child.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            announcement = `${announcement}\n${line}`.slice(-4096);
            return parseZrokHeadlessEndpoint(announcement);
          }).pipe(
            Effect.flatMap((parsed) =>
              parsed ? Deferred.succeed(endpoint, parsed).pipe(Effect.asVoid) : Effect.void,
            ),
          ),
        ),
        Effect.catchCause(() => Effect.void),
      ),
      shareScope,
    );

    const readiness = yield* Effect.raceAll([
      Deferred.await(endpoint).pipe(
        Effect.map((publicUrl) => ({ type: "ready" as const, publicUrl })),
      ),
      Effect.result(share.child.exitCode).pipe(Effect.as({ type: "exit" as const })),
      Effect.sleep(START_TIMEOUT).pipe(Effect.as({ type: "timeout" as const })),
    ]);

    if (readiness.type !== "ready") {
      yield* closeActive(share);
      yield* lock.withPermits(1)(
        Effect.sync(() => {
          if (active?.attempt === attempt) active = null;
        }),
      );
      return yield* finishAttempt(attempt, deferred, {
        state: "failed",
        publicUrl: null,
        message:
          readiness.type === "timeout"
            ? "zrok did not announce a public URL in time."
            : "The zrok share stopped before it became ready.",
        endpoint: null,
      });
    }

    const running: ZrokShareStatus = {
      state: "running",
      publicUrl: readiness.publicUrl,
      message: null,
      endpoint: endpointFor(readiness.publicUrl),
    };
    const result = yield* finishAttempt(attempt, deferred, running);
    if (result.state !== "running") return result;

    yield* Effect.forkIn(
      Effect.result(share.child.exitCode).pipe(
        Effect.andThen(
          lock.withPermits(1)(
            Effect.sync(() => {
              if (active?.attempt !== attempt) return;
              active = null;
              status = {
                state: "failed",
                publicUrl: null,
                message: "The zrok share stopped unexpectedly.",
                endpoint: null,
              };
            }),
          ),
        ),
        Effect.andThen(Scope.close(shareScope, Exit.void)),
        Effect.catchCause(() => Effect.void),
      ),
      serviceScope,
    );
    return result;
  });

  let stop: Effect.Effect<ZrokShareStatus>;
  stop = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const decision = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (queuedStop) return { type: "wait" as const, deferred: queuedStop };
          if (stopping && pending) {
            const deferred = yield* Deferred.make<ZrokShareStatus, never>();
            queuedStop = deferred;
            return {
              type: "queue" as const,
              deferred,
              afterStart: pending,
            };
          }
          if (stopping) return { type: "wait" as const, deferred: stopping };
          const deferred = yield* Deferred.make<ZrokShareStatus, never>();
          const currentPending = pending;
          generation += 1;
          stopping = deferred;
          pending = null;
          if (currentPending) yield* Deferred.succeed(currentPending, stoppedStatus());
          return { type: "stop" as const, deferred };
        }),
      );

      if (decision.type === "stop") {
        yield* Effect.forkIn(
          processLock.withPermits(1)(
            Effect.gen(function* () {
              const toStop = yield* lock.withPermits(1)(
                Effect.sync(() => {
                  const current = active;
                  active = null;
                  return current;
                }),
              );
              if (toStop) yield* closeActive(toStop);
              const stopped = stoppedStatus();
              yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  status = stopped;
                  stopping = null;
                  yield* Deferred.succeed(decision.deferred, stopped);
                }),
              );
            }),
          ),
          serviceScope,
        );
      } else if (decision.type === "queue") {
        yield* Effect.forkIn(
          Deferred.await(decision.afterStart).pipe(
            Effect.andThen(
              lock.withPermits(1)(
                Effect.sync(() => {
                  if (queuedStop === decision.deferred) queuedStop = null;
                }),
              ),
            ),
            Effect.andThen(stop),
            Effect.flatMap((stopped) => Deferred.succeed(decision.deferred, stopped)),
            Effect.asVoid,
          ),
          serviceScope,
        );
      }
      return yield* restore(Deferred.await(decision.deferred));
    }),
  ).pipe(Effect.withSpan("ZrokShare.stop"));

  const start = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const decision = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (!stopping && status.state === "running") return { type: "done" as const, status };
          if (pending) return { type: "wait" as const, deferred: pending };
          const deferred = yield* Deferred.make<ZrokShareStatus, never>();
          generation += 1;
          pending = deferred;
          status = { state: "starting", publicUrl: null, message: null, endpoint: null };
          return {
            type: "launch" as const,
            attempt: generation,
            deferred,
            waitForStop: stopping,
          };
        }),
      );
      if (decision.type === "done") return decision.status;
      if (decision.type === "launch") {
        yield* Effect.forkIn(
          (decision.waitForStop ? Deferred.await(decision.waitForStop) : Effect.void).pipe(
            Effect.andThen(launch(decision.attempt, decision.deferred)),
            Effect.catchCause(() => Effect.void),
          ),
          serviceScope,
        );
      }
      return yield* restore(Deferred.await(decision.deferred));
    }),
  ).pipe(Effect.withSpan("ZrokShare.start"));

  const service = ZrokShare.of({ getStatus, start, stop });
  yield* Effect.addFinalizer(() =>
    service.stop.pipe(Effect.andThen(Scope.close(serviceScope, Exit.void)), Effect.asVoid),
  );
  return service;
});

export const layer = Layer.effect(ZrokShare, make);
