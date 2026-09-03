import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadAutoResumeFireCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-auto-resume");
const TURN_ID = TurnId.make("turn-usage-limit");
const USER_MESSAGE_ID = MessageId.make("user-original");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");

const makeUserMessage = (
  id: MessageId = USER_MESSAGE_ID,
): OrchestrationThread["messages"][number] => ({
  id,
  role: "user",
  text: "Work until the task is complete.",
  turnId: null,
  streaming: false,
  createdAt: "2025-12-30T23:00:00.000Z",
  updatedAt: "2025-12-30T23:00:00.000Z",
});

const makeThread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread => ({
  id: THREAD_ID,
  projectId: ProjectId.make("project-auto-resume"),
  title: "Auto-resume",
  modelSelection: {
    instanceId: PROVIDER_INSTANCE_ID,
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId: TURN_ID,
    state: "completed",
    requestedAt: "2025-12-31T00:00:00.000Z",
    startedAt: "2025-12-31T00:00:01.000Z",
    completedAt: "2025-12-31T00:10:00.000Z",
    assistantMessageId: null,
  },
  createdAt: "2025-12-30T22:00:00.000Z",
  updatedAt: "2025-12-31T00:10:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: "2099-01-01T00:00:00.000Z",
  snoozedAt: "2025-12-31T00:10:01.000Z",
  pinnedAt: null,
  pinOrderKey: null,
  deletedAt: null,
  messages: [makeUserMessage()],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: THREAD_ID,
    status: "stopped",
    providerName: "codex",
    providerInstanceId: PROVIDER_INSTANCE_ID,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2025-12-31T00:10:00.000Z",
  },
  ...overrides,
});

const makeReadModel = (overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel => ({
  snapshotSequence: 10,
  projects: [],
  threads: [makeThread(overrides)],
  updatedAt: NOW,
});

const makeCommand = (
  overrides: Partial<ThreadAutoResumeFireCommand> = {},
): ThreadAutoResumeFireCommand => ({
  type: "thread.auto-resume.fire",
  commandId: CommandId.make(
    "server:auto-resume-fire:auto-resume:thread-auto-resume:turn-usage-limit",
  ),
  threadId: THREAD_ID,
  scheduleId: "auto-resume:thread-auto-resume:turn-usage-limit",
  scheduledSequence: 10,
  sourceTurnId: TURN_ID,
  expectedUserMessageId: USER_MESSAGE_ID,
  providerInstanceId: PROVIDER_INSTANCE_ID,
  messageId: MessageId.make("auto-resume-message:thread-auto-resume:turn-usage-limit"),
  createdAt: NOW,
  ...overrides,
});

it.layer(NodeServices.layer)("auto-resume fire decider", (it) => {
  it.effect(
    "emits the scoped resume instructions and one turn-start intent, even when snoozed",
    () =>
      Effect.gen(function* () {
        const result = yield* decideOrchestrationCommand({
          command: makeCommand(),
          readModel: makeReadModel(),
        });
        const events = Array.isArray(result) ? result : [result];

        expect(events).toHaveLength(2);
        expect(events.map((event) => event.type)).toEqual([
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
        const message = events[0];
        const turnStart = events[1];
        if (
          message?.type !== "thread.message-sent" ||
          turnStart?.type !== "thread.turn-start-requested"
        ) {
          throw new Error("Expected the auto-resume message and turn-start events");
        }
        expect(message.payload.text).toBe(`[T3 Code automatic resume]

The previous turn stopped because the provider usage limit was reached. The limit has now reset.

Resume only the work already requested in this thread. Inspect current workspace, artifacts and any subagent status. Identify incomplete checklist items or interrupted operations, repair any partial state, and continue from where the turn stopped.

Do not repeat completed work, start new work, or expand the user's requested scope. If the requested work is already complete, report completion and stop.`);
        expect(message.payload.messageId).toBe(makeCommand().messageId);
        expect(turnStart.payload.messageId).toBe(makeCommand().messageId);
        expect(turnStart.causationEventId).toBe(message.eventId);
        expect(turnStart.payload.modelSelection).toEqual(makeThread().modelSelection);
      }),
  );

  it.effect("rejects a schedule when any compare-and-fire precondition is stale", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<
        readonly [string, OrchestrationReadModel, ThreadAutoResumeFireCommand?]
      > = [
        [
          "latest user message changed",
          makeReadModel({ messages: [makeUserMessage(MessageId.make("user-newer"))] }),
        ],
        [
          "provider instance changed",
          makeReadModel({
            modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
          }),
        ],
        [
          "source turn changed",
          makeReadModel({
            latestTurn: { ...makeThread().latestTurn!, turnId: TurnId.make("turn-newer") },
          }),
        ],
        [
          "active work started",
          makeReadModel({
            session: { ...makeThread().session!, status: "running" },
          }),
        ],
        ["manual settle acknowledged", makeReadModel({ settledOverride: "settled" })],
      ];

      for (const [label, readModel, command] of cases) {
        const error = yield* Effect.flip(
          decideOrchestrationCommand({
            command: command ?? makeCommand(),
            readModel,
          }),
        );
        expect(error._tag, label).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
});
