import { CommandId, EventId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  CheckpointNavigationError,
  CheckpointNavigationService,
} from "../../checkpointing/CheckpointNavigationService.ts";
import { CheckpointNavigationReactor } from "../Services/CheckpointNavigationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const isCheckpointNavigationError = Schema.is(CheckpointNavigationError);

export function checkpointNavigationFailureDetails(cause: Cause.Cause<unknown>): {
  readonly code: string;
  readonly operationId: string | null;
} {
  const failure = Option.getOrNull(Cause.findErrorOption(cause));
  return failure !== null && isCheckpointNavigationError(failure)
    ? { code: failure.code, operationId: failure.operationId }
    : { code: "navigation-failed", operationId: null };
}

const make = Effect.gen(function* () {
  const navigation = yield* CheckpointNavigationService;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${id}`)));
  const activityId = crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  const handleRequested = Effect.fn("CheckpointNavigationReactor.handleRequested")(
    function* (
      event: Extract<
        import("@t3tools/contracts").OrchestrationEvent,
        { type: "thread.checkpoint-navigation-requested" }
      >,
    ) {
      const result = yield* navigation
        .navigate({
          commandId: event.commandId ?? event.eventId,
          threadId: event.payload.threadId,
          kind: event.payload.kind,
          ...(event.payload.targetTurnCount === null
            ? {}
            : { targetTurnCount: event.payload.targetTurnCount }),
          ...(event.payload.filesOnlyConfirmed === undefined
            ? {}
            : { filesOnlyConfirmed: event.payload.filesOnlyConfirmed }),
        })
        .pipe(Effect.exit);

      if (result._tag === "Success") {
        if (result.value.status === "completed") {
          yield* engine.dispatch({
            type: "thread.checkpoint.navigation.complete",
            commandId: yield* commandId("checkpoint-navigation-complete"),
            threadId: event.payload.threadId,
            operationId: result.value.operationId,
            kind: result.value.kind,
            targetEntryId: result.value.targetEntryId,
            cursorVersion: result.value.cursorVersion,
            createdAt: event.payload.createdAt,
          });
          return;
        }
        if (result.value.status === "files-restored") {
          // A completion event clears the client's transient navigation state and
          // triggers an authoritative refetch. Its cursor version is deliberately
          // unchanged because this operation does not navigate the conversation.
          yield* engine.dispatch({
            type: "thread.checkpoint.navigation.complete",
            commandId: yield* commandId("checkpoint-files-restore-complete"),
            threadId: event.payload.threadId,
            operationId: result.value.operationId,
            kind: result.value.kind,
            targetEntryId: result.value.targetEntryId,
            cursorVersion: result.value.cursorVersion,
            createdAt: event.payload.createdAt,
          });
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: yield* commandId("checkpoint-files-restored"),
            threadId: event.payload.threadId,
            activity: {
              id: yield* activityId,
              tone: "info",
              kind: "checkpoint.files-restored",
              summary: "Workspace files restored; chat history was not reverted",
              payload: {
                kind: result.value.kind,
                targetEntryId: result.value.targetEntryId,
                filesOnly: true,
              },
              turnId: null,
              createdAt: event.payload.createdAt,
            },
            createdAt: event.payload.createdAt,
          });
          return;
        }
        // No-op navigation is still terminal. Publish the unchanged cursor so
        // clients clear their requested state and perform the same authoritative
        // refetch as a navigation that moved the cursor.
        yield* engine.dispatch({
          type: "thread.checkpoint.navigation.complete",
          commandId: yield* commandId("checkpoint-navigation-noop-complete"),
          threadId: event.payload.threadId,
          operationId: result.value.operationId,
          kind: result.value.kind,
          targetEntryId: result.value.targetEntryId,
          cursorVersion: result.value.cursorVersion,
          createdAt: event.payload.createdAt,
        });
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: yield* commandId("checkpoint-navigation-noop"),
          threadId: event.payload.threadId,
          activity: {
            id: yield* activityId,
            tone: "info",
            kind: "checkpoint.navigation.noop",
            summary:
              result.value.reason === "baseline"
                ? "Already at the first checkpoint"
                : result.value.reason === "tip"
                  ? "Already at the latest checkpoint"
                  : "Already at this checkpoint",
            payload: { kind: result.value.kind, reason: result.value.reason },
            turnId: null,
            createdAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        return;
      }

      const error = result.cause;
      const failure = checkpointNavigationFailureDetails(error);
      yield* engine.dispatch({
        type: "thread.checkpoint.navigation.fail",
        commandId: yield* commandId("checkpoint-navigation-fail"),
        threadId: event.payload.threadId,
        operationId: failure.operationId,
        kind: event.payload.kind,
        code: failure.code,
        createdAt: event.payload.createdAt,
      });
      yield* Effect.logWarning("Checkpoint navigation failed", {
        threadId: event.payload.threadId,
        kind: event.payload.kind,
        cause: error,
      });
    },
    Effect.catchCause((cause) => Effect.logError("Checkpoint navigation reactor failed", cause)),
  );

  const start = () =>
    Effect.gen(function* () {
      yield* navigation
        .recover()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Checkpoint navigation recovery failed", cause),
          ),
        );
      const domainEvents = yield* engine.subscribeDomainEvents;
      yield* Stream.runForEach(domainEvents, (event) =>
        event.type === "thread.checkpoint-navigation-requested"
          ? handleRequested(event)
          : Effect.void,
      ).pipe(Effect.forkScoped, Effect.asVoid);
    });

  return CheckpointNavigationReactor.of({ start });
});

export const CheckpointNavigationReactorLive = Layer.effect(CheckpointNavigationReactor, make);
