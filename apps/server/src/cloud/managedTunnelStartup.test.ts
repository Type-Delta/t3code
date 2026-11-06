import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";

import {
  makeDesiredLinkObserver,
  makeDesiredLinkWorker,
  retryManagedTunnelRegistration,
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
