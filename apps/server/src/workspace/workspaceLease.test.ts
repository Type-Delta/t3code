import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { withWorkspaceLease, type WorkspaceLeaseMode } from "./workspaceLease.ts";

it.effect.each<{
  readonly held: readonly [string | ReadonlyArray<string>, WorkspaceLeaseMode];
  readonly requested: readonly [string, WorkspaceLeaseMode];
  readonly waits: boolean;
}>([
  { held: ["/repo", "exclusive"], requested: ["/repo", "exclusive"], waits: true },
  { held: ["/repo", "exclusive"], requested: ["/repo/nested", "exclusive"], waits: false },
  { held: ["/repo", "shared"], requested: ["/repo", "shared"], waits: false },
  { held: ["/repo", "shared"], requested: ["/repo", "exclusive"], waits: false },
  { held: ["/repo", "checkout"], requested: ["/repo/nested", "shared"], waits: true },
  { held: ["/repo/nested", "exclusive"], requested: ["/repo", "checkout"], waits: true },
  { held: ["/home", "shared"], requested: ["/home/repo", "checkout"], waits: true },
  { held: ["/repo", "checkout"], requested: ["/repo-sibling", "exclusive"], waits: false },
  {
    held: [["/real/repo", "/alias/repo"], "checkout"],
    requested: ["/alias/repo", "exclusive"],
    waits: true,
  },
])("lease $requested waits for $held: $waits", ({ held, requested, waits }) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(held[0], Deferred.await(release), held[1]).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const request = yield* withWorkspaceLease(
      requested[0],
      Deferred.succeed(entered, undefined),
      requested[1],
    ).pipe(Effect.forkChild({ startImmediately: true }));
    assert.equal(yield* Deferred.isDone(entered), !waits);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(request);
    assert.isTrue(yield* Deferred.isDone(entered));
  }),
);
