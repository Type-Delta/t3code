import { CommandId, MessageId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import {
  matchingAutoRetryTrigger,
  recordAutoRetryFailure,
  type AutoRetryFailureGuardState,
} from "./AutoRetry.ts";

function failureState(thread: OrchestrationV2ThreadShell, now: number): AutoRetryFailureGuardState {
  return {
    failuresAt: (thread.autoRetryFailureTimestamps ?? [])
      .map(DateTime.toEpochMillis)
      .filter((timestamp) => now - timestamp < 60_000),
    disabledUntil:
      thread.autoRetryDisabledUntil && DateTime.toEpochMillis(thread.autoRetryDisabledUntil) > now
        ? DateTime.toEpochMillis(thread.autoRetryDisabledUntil)
        : null,
  };
}

function retryCommand(thread: OrchestrationV2ThreadShell, runId: string, text: string) {
  const key = `${thread.id}:${runId}`;
  return {
    type: "message.dispatch" as const,
    commandId: CommandId.make(`auto-retry:${key}`),
    messageId: MessageId.make(`auto-retry:${key}`),
    threadId: thread.id,
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" as const },
    createdBy: "user" as const,
    creationSource: "server" as const,
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  return Effect.fn("AutoRetryWorker.sweep")(function* () {
    const settings = yield* settingsService.getSettings;
    if (!settings.autoRetry.enabled) return;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const snapshot = yield* projections.getShellSnapshot();
    for (const thread of snapshot.threads) {
      if (
        thread.status !== "failed" ||
        thread.latestRunId === null ||
        thread.archivedAt !== null ||
        thread.settledOverride === "settled" ||
        (thread.autoRetryDisabledUntil !== undefined &&
          thread.autoRetryDisabledUntil !== null &&
          DateTime.toEpochMillis(thread.autoRetryDisabledUntil) > nowMs) ||
        thread.autoRetryLastAttemptKey ===
          `${thread.latestRunId}:${thread.latestRunCompletedAt === null || thread.latestRunCompletedAt === undefined ? nowMs : DateTime.toEpochMillis(thread.latestRunCompletedAt)}`
      )
        continue;
      const attemptKey = `${thread.latestRunId}:${thread.latestRunCompletedAt === null || thread.latestRunCompletedAt === undefined ? nowMs : DateTime.toEpochMillis(thread.latestRunCompletedAt)}`;
      const trigger = matchingAutoRetryTrigger(settings.autoRetry, {
        errorMessage: thread.lastError ?? "",
        backend:
          settings.providerInstances[thread.providerInstanceId]?.driver ??
          thread.providerInstanceId,
        model: thread.modelSelection.model,
      });
      if (trigger === null) continue;
      const state = recordAutoRetryFailure(failureState(thread, nowMs), nowMs);
      const timestamps = state.failuresAt.map((timestamp) => DateTime.makeUnsafe(timestamp));
      if (state.disabledUntil !== null) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`auto-retry-disable:${thread.id}:${thread.latestRunId}`),
            threadId: thread.id,
            autoRetryLastAttemptKey: attemptKey,
            autoRetryFailureTimestamps: timestamps,
            autoRetryDisabledUntil: DateTime.makeUnsafe(state.disabledUntil),
            autoRetryDisabledReason: "Repeated failures detected.",
          })
          .pipe(Effect.ignore);
        continue;
      }
      const records = yield* projections.getThreadRecords(thread.id, ["runs", "messages"]);
      const run = records.runs.find((candidate) => candidate.id === thread.latestRunId);
      const message =
        run === undefined
          ? undefined
          : records.messages.find((candidate) => candidate.id === run.userMessageId);
      if (run === undefined || message === undefined) continue;
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`auto-retry-arm:${thread.id}:${thread.latestRunId}`),
          threadId: thread.id,
          autoRetryLastAttemptKey: attemptKey,
          autoRetryFailureTimestamps: timestamps,
        })
        .pipe(Effect.ignore);
      if (run.startedAt === null && run.workspacePreparation !== undefined) {
        yield* launches
          .retryPreparation({
            commandId: CommandId.make(`auto-retry-preparation:${thread.id}:${thread.latestRunId}`),
            threadId: thread.id,
            runId: thread.latestRunId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("auto-retry preparation dispatch failed", {
                threadId: thread.id,
                cause,
              }),
            ),
          );
        continue;
      }
      yield* threads
        .dispatch(retryCommand(thread, thread.latestRunId, trigger.message))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("auto-retry dispatch failed", { threadId: thread.id, cause }),
          ),
        );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("auto-retry", sweep());
  }),
);
