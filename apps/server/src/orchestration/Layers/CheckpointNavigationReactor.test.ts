import { CommandId, EventId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointNavigationError,
  CheckpointNavigationService,
} from "../../checkpointing/CheckpointNavigationService.ts";
import { CheckpointNavigationReactor as CheckpointNavigationReactorService } from "../Services/CheckpointNavigationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  CheckpointNavigationReactorLive,
  checkpointNavigationFailureDetails,
} from "./CheckpointNavigationReactor.ts";

describe("checkpointNavigationFailureDetails", () => {
  it("preserves typed navigation codes and operation ids", () => {
    expect(
      checkpointNavigationFailureDetails(
        Cause.fail(
          new CheckpointNavigationError({
            code: "cursor-version-conflict",
            detail: "The cursor changed concurrently.",
            operationId: "operation-1",
          }),
        ),
      ),
    ).toEqual({
      code: "cursor-version-conflict",
      operationId: "operation-1",
    });
  });

  it("uses a stable fallback for defects", () => {
    expect(checkpointNavigationFailureDetails(Cause.die(new Error("boom")))).toEqual({
      code: "navigation-failed",
      operationId: null,
    });
  });
});

effectIt.effect(
  "publishes completion before the informational activity for a navigation no-op",
  () => {
    const threadId = ThreadId.make("thread-navigation-noop");
    const requested = {
      eventId: EventId.make("event-navigation-requested"),
      sequence: 1,
      occurredAt: "2026-07-16T00:00:00.000Z",
      commandId: CommandId.make("request-navigation-noop"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.checkpoint-navigation-requested",
      payload: {
        threadId,
        kind: "undo",
        targetTurnCount: null,
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    } as const;
    const dispatched: OrchestrationCommand[] = [];

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const activityPublished = yield* Deferred.make<void>();
          const navigationLayer = Layer.succeed(CheckpointNavigationService, {
            navigate: () =>
              Effect.succeed({
                status: "noop",
                operationId: "request-navigation-noop",
                kind: "undo",
                reason: "baseline",
                targetEntryId: "entry-1",
                cursorVersion: 7,
              } as const),
            recover: () => Effect.succeed([]),
            abandonForwardHistory: () => Effect.die("unexpected abandonForwardHistory"),
          });
          const engineLayer = Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            readThreadEvents: () => Stream.empty,
            getThreadReplayStats: () =>
              Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
            latestSequence: Effect.succeed(0),
            streamDomainEvents: Stream.make(requested),
            subscribeDomainEvents: Effect.succeed(Stream.make(requested)),
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "thread.activity.append") {
                  yield* Deferred.succeed(activityPublished, undefined);
                }
                return { sequence: dispatched.length };
              }),
          });
          const layer = CheckpointNavigationReactorLive.pipe(
            Layer.provide(Layer.mergeAll(navigationLayer, engineLayer, NodeServices.layer)),
          );
          const reactor = yield* CheckpointNavigationReactorService.pipe(Effect.provide(layer));
          yield* reactor.start();
          yield* Deferred.await(activityPublished);
        }),
      );

      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.checkpoint.navigation.complete",
        "thread.activity.append",
      ]);
      expect(dispatched[0]).toMatchObject({
        type: "thread.checkpoint.navigation.complete",
        threadId,
        operationId: "request-navigation-noop",
        kind: "undo",
        targetEntryId: "entry-1",
        cursorVersion: 7,
      });
    });
  },
);
