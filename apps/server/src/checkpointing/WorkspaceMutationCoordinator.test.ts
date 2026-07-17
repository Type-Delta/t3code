import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import {
  WorkspaceMutationCoordinator,
  WorkspaceMutationCoordinatorLive,
} from "./WorkspaceMutationCoordinator.ts";

it.layer(WorkspaceMutationCoordinatorLive)("WorkspaceMutationCoordinator", (it) => {
  it.effect("preempts overlapping captures and brackets mutation generations", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      const capture = yield* coordinator.beginCapture("worktree-a");
      assert.equal(capture.generation, 0);
      assert.isFalse(capture.signal.aborted);

      const mutation = yield* coordinator.beginMutation("worktree-a");
      assert.isTrue(capture.signal.aborted);
      assert.equal(yield* coordinator.getGeneration("worktree-a"), 1);
      assert.isFalse(yield* coordinator.completeCapture(capture));

      const duringMutation = yield* coordinator.beginCapture("worktree-a");
      assert.isTrue(duringMutation.signal.aborted);
      yield* coordinator.completeMutation(mutation);
      assert.equal(yield* coordinator.getGeneration("worktree-a"), 2);
      assert.isFalse(yield* coordinator.completeCapture(duringMutation));

      const stable = yield* coordinator.beginCapture("worktree-a");
      assert.isTrue(yield* coordinator.completeCapture(stable));
    }),
  );

  it.effect("closes the mutation interval when the protected effect fails", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      const result = yield* Effect.result(
        coordinator.withMutation("worktree-b", Effect.fail("expected")),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(yield* coordinator.getGeneration("worktree-b"), 2);
      const stable = yield* coordinator.beginCapture("worktree-b");
      assert.isTrue(yield* coordinator.completeCapture(stable));
    }),
  );

  it.effect("rebases a reclaimed capture before any post-restart workspace observation", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      const capture = yield* coordinator.beginCapture("worktree-reclaimed");

      assert.isTrue(yield* coordinator.reconcileCaptureGeneration("worktree-reclaimed", 17));
      assert.equal(yield* coordinator.getGeneration("worktree-reclaimed"), 17);
      assert.isTrue(yield* coordinator.completeCapture(capture));
    }),
  );

  it.effect("rejects an old durable generation after a local mutation", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      assert.equal(yield* coordinator.getGeneration("worktree-mutated"), 0);
      yield* coordinator.preemptCaptures("worktree-mutated");
      const capture = yield* coordinator.beginCapture("worktree-mutated");

      assert.isFalse(yield* coordinator.reconcileCaptureGeneration("worktree-mutated", 0));
      assert.isTrue(yield* coordinator.completeCapture(capture));
    }),
  );

  it.effect("runs an exclusive restore between active and newly starting mutations", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      const activeProviderMutation = yield* coordinator.beginMutation("worktree-exclusive");
      const restoreStarted = yield* Deferred.make<void>();
      const releaseRestore = yield* Deferred.make<void>();
      const nextMutationStarted = yield* Deferred.make<void>();

      const restoreFiber = yield* Effect.forkChild(
        coordinator.withMutation(
          "worktree-exclusive",
          Deferred.succeed(restoreStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRestore)),
          ),
        ),
      );
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.poll(restoreStarted)));

      yield* coordinator.completeMutation(activeProviderMutation);
      yield* Deferred.await(restoreStarted);

      const nextMutationFiber = yield* Effect.forkChild(
        coordinator
          .beginMutation("worktree-exclusive")
          .pipe(Effect.tap(() => Deferred.succeed(nextMutationStarted, undefined))),
      );
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.poll(nextMutationStarted)));

      yield* Deferred.succeed(releaseRestore, undefined);
      yield* Fiber.join(restoreFiber);
      const nextMutation = yield* Fiber.join(nextMutationFiber);
      yield* coordinator.completeMutation(nextMutation);
      assert.isTrue(Option.isSome(yield* Deferred.poll(nextMutationStarted)));
    }),
  );

  it.effect("gates provider dispatch without blocking provider completion events", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      assert.isTrue(
        yield* coordinator.prepareProviderMutation("thread-active", "worktree-provider-gate"),
      );
      assert.isTrue(yield* coordinator.bindProviderMutation("thread-active", "turn-active"));
      const restoreStarted = yield* Deferred.make<void>();
      const releaseRestore = yield* Deferred.make<void>();

      const restoreFiber = yield* Effect.forkChild(
        coordinator.withMutation(
          "worktree-provider-gate",
          Deferred.succeed(restoreStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRestore)),
          ),
        ),
      );
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.poll(restoreStarted)));

      const nextProviderPrepared = yield* Deferred.make<void>();
      const nextProviderFiber = yield* Effect.forkChild(
        coordinator
          .prepareProviderMutation("thread-next", "worktree-provider-gate")
          .pipe(Effect.tap(() => Deferred.succeed(nextProviderPrepared, undefined))),
      );
      yield* Effect.yieldNow;

      assert.isTrue(yield* coordinator.completeProviderMutation("thread-active", "turn-active"));
      yield* Deferred.await(restoreStarted);
      assert.isTrue(Option.isNone(yield* Deferred.poll(nextProviderPrepared)));

      yield* Deferred.succeed(releaseRestore, undefined);
      yield* Fiber.join(restoreFiber);
      assert.isTrue(yield* Fiber.join(nextProviderFiber));
      assert.isTrue(yield* coordinator.bindProviderMutation("thread-next", "turn-next"));
      assert.isTrue(yield* coordinator.completeProviderMutation("thread-next", "turn-next"));
    }),
  );

  it.effect("does not release a provider mutation for another turn", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      assert.isTrue(yield* coordinator.prepareProviderMutation("thread-owned", "worktree-owned"));
      assert.isTrue(yield* coordinator.bindProviderMutation("thread-owned", "turn-current"));

      assert.isFalse(yield* coordinator.completeProviderMutation("thread-owned", "turn-stale"));
      const duringMutation = yield* coordinator.beginCapture("worktree-owned");
      assert.isTrue(duringMutation.signal.aborted);
      assert.isFalse(yield* coordinator.completeCapture(duringMutation));

      assert.isTrue(yield* coordinator.completeProviderMutation("thread-owned", "turn-current"));
      const stable = yield* coordinator.beginCapture("worktree-owned");
      assert.isTrue(yield* coordinator.completeCapture(stable));
    }),
  );

  it.effect("consumes a matching terminal event observed before turn binding", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      assert.isTrue(yield* coordinator.prepareProviderMutation("thread-early", "worktree-early"));
      assert.isFalse(yield* coordinator.prepareProviderMutation("thread-early", "worktree-early"));
      assert.isTrue(yield* coordinator.completeProviderMutation("thread-early", "turn-early"));

      const beforeBinding = yield* coordinator.beginCapture("worktree-early");
      assert.isTrue(beforeBinding.signal.aborted);
      assert.isFalse(yield* coordinator.completeCapture(beforeBinding));

      assert.isTrue(yield* coordinator.bindProviderMutation("thread-early", "turn-early"));
      const stable = yield* coordinator.beginCapture("worktree-early");
      assert.isTrue(yield* coordinator.completeCapture(stable));
    }),
  );

  it.effect("signals when a provider mutation has fully released", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      assert.isTrue(
        yield* coordinator.prepareProviderMutation("thread-release", "worktree-release"),
      );
      assert.isTrue(yield* coordinator.bindProviderMutation("thread-release", "turn-release"));
      const released = yield* Deferred.make<void>();
      const waiter = yield* Effect.forkChild(
        coordinator
          .awaitProviderMutationRelease("thread-release")
          .pipe(Effect.tap(() => Deferred.succeed(released, undefined))),
      );
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.poll(released)));

      assert.isTrue(yield* coordinator.completeProviderMutation("thread-release", "turn-release"));
      yield* Fiber.join(waiter);
      assert.isTrue(Option.isSome(yield* Deferred.poll(released)));
      assert.isTrue(
        yield* coordinator.prepareProviderMutation("thread-release", "worktree-release"),
      );
      assert.isTrue(yield* coordinator.cancelProviderMutation("thread-release"));
    }),
  );

  it.effect("does not leak an interrupted runtime mutation acquisition", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkspaceMutationCoordinator;
      const ownerKey = "thread-runtime:turn-runtime";
      const fiber = yield* Effect.forkChild(
        coordinator.prepareRuntimeMutation(ownerKey, "worktree-runtime"),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      yield* coordinator.completeRuntimeMutation(ownerKey);

      const stable = yield* coordinator.beginCapture("worktree-runtime");
      assert.isTrue(yield* coordinator.completeCapture(stable));
    }),
  );
});
