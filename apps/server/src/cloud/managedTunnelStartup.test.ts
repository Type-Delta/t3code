import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  makeDesiredLinkObserver,
  makeDesiredLinkWorker,
  retryManagedTunnelRegistration,
  watchManagedTunnelOrigin,
} from "./managedTunnelStartup.ts";

it.effect("interrupts a stuck registration before handling changed CLI intent", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const next = yield* Deferred.make<string | null>();
    const change = yield* makeDesiredLinkWorker(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(stopped, undefined)),
      ),
      (mode) => Deferred.succeed(next, mode).pipe(Effect.asVoid),
    );
    yield* Deferred.await(started);
    yield* change("publish_only", 0);
    yield* Deferred.await(stopped);
    expect(yield* Deferred.await(next)).toBe("publish_only");
  }).pipe(Effect.scoped),
);

it.effect("reconciles new and renewed CLI intent without relinking on unchanged state", () =>
  Effect.gen(function* () {
    const unlinked = { mode: null, revoked: false, revision: null, generation: 0 } as const;
    let state: {
      mode: "managed" | "publish_only" | null;
      revoked: boolean;
      revision: string | null;
      generation: number;
    } = unlinked;
    let reconciliations = 0;
    let unlinks = 0;
    let unlinkGeneration = -1;
    const observe = makeDesiredLinkObserver(
      unlinked,
      Effect.sync(() => state),
      (mode, generation) =>
        Effect.sync(() => {
          if (mode !== null) reconciliations += 1;
          else {
            unlinks += 1;
            unlinkGeneration = generation;
          }
        }),
    );
    state = { mode: "managed", revoked: false, revision: "1", generation: 0 };
    yield* observe;
    yield* observe;
    expect(reconciliations).toBe(1);
    state = { mode: "managed", revoked: true, revision: "1", generation: 0 };
    yield* observe;
    expect(reconciliations).toBe(1);
    state = { mode: "managed", revoked: false, revision: "1", generation: 0 };
    yield* observe;
    expect(reconciliations).toBe(1);
    state = { mode: "managed", revoked: false, revision: "2", generation: 0 };
    yield* observe;
    expect(reconciliations).toBe(2);
    state = { ...unlinked, generation: 1 };
    yield* observe;
    expect(reconciliations).toBe(2);
    expect(unlinks).toBe(1);
    expect(unlinkGeneration).toBe(0);
    state = { mode: "publish_only", revoked: false, revision: "3", generation: 0 };
    yield* observe;
    expect(reconciliations).toBe(3);
  }),
);

describe("retryManagedTunnelRegistration", () => {
  it.effect("does not fall back or retry when registration is permanently rejected", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let fallbacks = 0;
      const error = yield* Effect.flip(
        retryManagedTunnelRegistration(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail("not authorized");
          }),
          () => false,
          Effect.sync(() => {
            fallbacks += 1;
          }),
        ),
      );
      expect(error).toBe("not authorized");
      expect(attempts).toBe(1);
      expect(fallbacks).toBe(0);
    }),
  );
});

describe("watchManagedTunnelOrigin", () => {
  const localOrigin = "http://127.0.0.1:3773";

  /** Runs the watcher for `minutes`, serving each check the next ingress in `ingress`. */
  const watch = (input: {
    readonly ingress: ReadonlyArray<string | null>;
    readonly minutes: number;
    readonly failRegistration?: boolean;
  }) =>
    Effect.gen(function* () {
      let checks = 0;
      const registeredAtMinute: Array<number> = [];
      let minute = 0;
      const fiber = yield* watchManagedTunnelOrigin({
        localOrigin,
        readIngressOrigin: Effect.sync(
          () => input.ingress[Math.min(checks++, input.ingress.length - 1)] ?? null,
        ),
        register: Effect.suspend(() => {
          registeredAtMinute.push(minute);
          return input.failRegistration ? Effect.fail("relay unavailable") : Effect.void;
        }),
      }).pipe(Effect.forkChild);
      while (minute < input.minutes) {
        minute += 1;
        yield* TestClock.adjust("1 minute");
      }
      yield* Fiber.interrupt(fiber);
      return { checks, registeredAtMinute };
    });

  it.effect("leaves a matching or unknown ingress alone", () =>
    Effect.gen(function* () {
      const result = yield* watch({
        ingress: [null, `${localOrigin}/`, localOrigin],
        minutes: 5,
      });
      expect(result.checks).toBe(5);
      expect(result.registeredAtMinute).toEqual([]);
    }),
  );

  it.effect("keeps checking after a failed registration", () =>
    Effect.gen(function* () {
      const result = yield* watch({
        ingress: ["http://127.0.0.1:46169", "http://127.0.0.1:46169", localOrigin],
        minutes: 8,
        failRegistration: true,
      });
      expect(result.registeredAtMinute).toEqual([1, 3]);
      // Minutes 1, 3, and 7; the match at 7 restores the one-minute interval.
      expect(result.checks).toBe(4);
    }),
  );

  it.effect("backs off while the relay keeps routing elsewhere", () =>
    Effect.gen(function* () {
      const result = yield* watch({ ingress: ["http://127.0.0.1:46169"], minutes: 20 });
      expect(result.registeredAtMinute).toEqual([1, 3, 7, 15]);
    }),
  );

  it.effect("keeps the backoff when one check cannot read the ingress", () =>
    Effect.gen(function* () {
      const result = yield* watch({
        ingress: ["http://127.0.0.1:46169", null, "http://127.0.0.1:46169"],
        minutes: 10,
      });
      expect(result.registeredAtMinute).toEqual([1, 5, 9]);
    }),
  );
});
