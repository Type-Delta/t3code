import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadCommandDispatcher from "../../../orchestration/ThreadCommandDispatcher.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadToolkitHandlersLive } from "./handlers.ts";
import { ReadThreadTool, ThreadToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("thread-tools-environment");
const projectId = ProjectId.make("thread-tools-project");
const threadId = ThreadId.make("thread-tools-target");
const callerThreadId = ThreadId.make("thread-tools-caller");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const now = "2026-08-24T00:00:00.000Z";
const project = {
  id: projectId,
  title: "Thread tools",
  workspaceRoot: "/work/thread-tools",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  faviconPath: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};
const shell = {
  id: threadId,
  projectId,
  title: "Target thread",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  titleRegeneration: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
  planProgress: null,
};
const detail = {
  snapshotSequence: 7,
  thread: {
    ...shell,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("thread-tools-user-message"),
        role: "user",
        text: "private user prompt that must be bounded",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: MessageId.make("thread-tools-message"),
        role: "assistant",
        text: "private assistant output that must be bounded",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    proposedPlans: [],
    activities: [
      {
        id: EventId.make("thread-tools-activity"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Command completed",
        payload: { data: { rawOutput: "private output that must be bounded" } },
        turnId: null,
        createdAt: now,
      },
    ],
    checkpoints: [],
  },
  page: {
    beforeCursor: null,
    hasMore: false,
    snapshotSequence: 7,
    threadSequence: 6,
    turnLimit: 1,
  },
};
const query = {
  getThreadDetailSnapshot: () => Effect.succeed(Option.some(detail)),
  getThreadShellById: () => Effect.succeed(Option.some(shell)),
  getProjectShellById: () => Effect.succeed(Option.some(project)),
} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const allowedInvocation = {
  environmentId,
  threadId: callerThreadId,
  providerSessionId: "thread-tools-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["threads"] as const),
  issuedAt: 1,
};
const ThreadToolkitTestLayer = McpServer.toolkit(ThreadToolkit).pipe(
  Layer.provide(ThreadToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it("describes the read pagination argument as cursor", () => {
  expect(ReadThreadTool.description).toContain("Use cursor");
  expect(ReadThreadTool.description).not.toContain("olderCursor");
});

it.effect("hides projected activity payloads unless outputs are requested", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const read = (arguments_: Record<string, unknown>) =>
      server
        .callTool({ name: "read_thread", arguments: arguments_ })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
          Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, query),
        );

    const hidden = yield* read({ threadId });
    expect(hidden.isError).toBe(false);
    expect(hidden.structuredContent).toMatchObject({ eventCursor: "6" });
    expect(
      (hidden.structuredContent as { activities: ReadonlyArray<Record<string, unknown>> })
        .activities[0],
    ).not.toHaveProperty("output");

    const included = yield* read({ threadId, includeOutputs: true, maxOutputCharsPerItem: 12 });
    expect(included.isError).toBe(false);
    expect(
      (included.structuredContent as { messages: ReadonlyArray<Record<string, unknown>> }).messages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "private user", truncated: true }),
        expect.objectContaining({ text: "private assi", truncated: true }),
      ]),
    );
    expect(
      (included.structuredContent as { activities: ReadonlyArray<Record<string, unknown>> })
        .activities[0],
    ).toMatchObject({ output: '{"data":{"ra', truncated: true });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("applies handler defaults when read options are omitted", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const text = "x".repeat(8_001);
    let requestedTurnLimit: number | undefined;
    const defaultDetail = {
      ...detail,
      thread: {
        ...detail.thread,
        messages: detail.thread.messages.map((message) => ({ ...message, text })),
      },
    };
    const defaultQuery = {
      getThreadDetailSnapshot: (_threadId: ThreadId, options: { readonly turnLimit: number }) => {
        requestedTurnLimit = options.turnLimit;
        return Effect.succeed(Option.some(defaultDetail));
      },
      getThreadShellById: () => Effect.succeed(Option.some(shell)),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

    const read = yield* server
      .callTool({ name: "read_thread", arguments: { threadId } })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, defaultQuery),
      );

    expect(read.isError).toBe(false);
    expect(requestedTurnLimit).toBe(10);
    expect(
      (read.structuredContent as { messages: ReadonlyArray<Record<string, unknown>> }).messages[0],
    ).toMatchObject({ text: text.slice(0, 8_000), truncated: true });
    expect(
      (read.structuredContent as { activities: ReadonlyArray<Record<string, unknown>> })
        .activities[0],
    ).not.toHaveProperty("output");
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("enforces thread capability and forbids self-send", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const withoutThreads = yield* server.callTool({ name: "list_threads", arguments: {} }).pipe(
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...allowedInvocation,
        capabilities: new Set(["preview"] as const),
      }),
    );
    expect(withoutThreads.isError).toBe(true);
    expect(withoutThreads.content).toEqual([
      {
        type: "text",
        text: "The list operation failed: MCP credential does not grant the threads capability.",
      },
    ]);

    const selfSend = yield* server
      .callTool({
        name: "send_message_to_thread",
        arguments: { threadId: callerThreadId, message: "Hi" },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
      );
    expect(selfSend.isError).toBe(true);
    expect(selfSend.content).toEqual([
      { type: "text", text: "A thread cannot send a message to itself." },
    ]);
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("lists pinned threads by pin order and defaults to 50 latest user-active threads", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const pinnedA = ThreadId.make("thread-tools-pinned-a");
    const pinnedB = ThreadId.make("thread-tools-pinned-b");
    const pinnedKeyless = ThreadId.make("thread-tools-pinned-keyless");
    const recentUser = ThreadId.make("thread-tools-recent-user");
    const olderUser = ThreadId.make("thread-tools-older-user");
    const threads = [
      {
        ...shell,
        id: pinnedB,
        pinnedAt: now,
        pinOrderKey: "b",
        createdAt: "2026-08-20T00:00:00.000Z",
      },
      { ...shell, id: pinnedKeyless, pinnedAt: now, createdAt: "2026-08-23T00:00:00.000Z" },
      {
        ...shell,
        id: recentUser,
        latestUserMessageAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      },
      {
        ...shell,
        id: olderUser,
        latestUserMessageAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      },
      {
        ...shell,
        id: pinnedA,
        pinnedAt: now,
        pinOrderKey: "a",
        createdAt: "2026-08-20T00:00:00.000Z",
      },
      ...Array.from({ length: 50 }, (_, index) => ({
        ...shell,
        id: ThreadId.make(`thread-tools-filler-${index}`),
        latestUserMessageAt: "2026-08-21T00:00:00.000Z",
      })),
    ];
    const listQuery = {
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 7, projects: [project], threads, updatedAt: now }),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

    const listed = yield* server
      .callTool({ name: "list_threads", arguments: {} })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, listQuery),
      );

    expect(listed.isError).toBe(false);
    const listedThreads = (
      listed.structuredContent as { threads: ReadonlyArray<{ readonly threadId: ThreadId }> }
    ).threads;
    expect(listedThreads).toHaveLength(50);
    expect(listedThreads.slice(0, 5).map((thread) => thread.threadId)).toEqual([
      pinnedA,
      pinnedB,
      pinnedKeyless,
      recentUser,
      olderUser,
    ]);
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("classifies projected running, queued, background, and completion states", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const currentTime = DateTime.formatIso(yield* DateTime.now);
    const runningId = ThreadId.make("thread-tools-status-running");
    const queuedId = ThreadId.make("thread-tools-status-queued");
    const backgroundId = ThreadId.make("thread-tools-status-background");
    const legacyId = ThreadId.make("thread-tools-status-legacy");
    const readyId = ThreadId.make("thread-tools-status-ready");
    const interruptedId = ThreadId.make("thread-tools-status-interrupted");
    const runningTurn = {
      turnId: TurnId.make("thread-tools-running-turn"),
      state: "running" as const,
      requestedAt: currentTime,
      startedAt: currentTime,
      completedAt: null,
      assistantMessageId: null,
    };
    const readySession = {
      threadId: readyId,
      status: "ready" as const,
      providerName: "Codex",
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: currentTime,
    };
    const listQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 7,
          projects: [project],
          threads: [
            { ...shell, id: runningId, latestTurn: runningTurn },
            { ...shell, id: queuedId, latestUserMessageAt: currentTime },
            { ...shell, id: backgroundId, backgroundLiveness: "monitoring" as const },
            { ...shell, id: legacyId, backgroundLiveness: undefined },
            { ...shell, id: readyId, session: readySession },
            {
              ...shell,
              id: interruptedId,
              latestTurn: {
                ...runningTurn,
                state: "interrupted" as const,
                completedAt: currentTime,
              },
            },
          ],
          updatedAt: now,
        }),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

    const listed = yield* server
      .callTool({ name: "list_threads", arguments: {} })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, listQuery),
      );

    expect(listed.isError).toBe(false);
    const statusByThread = new Map(
      (
        listed.structuredContent as {
          threads: ReadonlyArray<{ readonly threadId: ThreadId; readonly status: string }>;
        }
      ).threads.map((thread) => [thread.threadId, thread.status]),
    );
    expect(statusByThread).toEqual(
      new Map([
        [runningId, "running"],
        [queuedId, "queued"],
        [backgroundId, "running"],
        [legacyId, "idle"],
        [readyId, "completed"],
        [interruptedId, "completed"],
      ]),
    );
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("keeps local checkout metadata only when creating in the caller project", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const caller = {
      ...shell,
      id: callerThreadId,
      branch: "feature/current",
      worktreePath: "/work/current",
    };
    const otherProject = {
      ...project,
      id: ProjectId.make("thread-tools-other-project"),
      title: "Other project",
    };
    const dispatched: Array<unknown> = [];
    const created = { ...shell, id: ThreadId.make("00000000-0000-4000-8000-000000000000") };
    const createQuery = {
      getThreadShellById: (id: ThreadId) =>
        Effect.succeed(Option.some(id === callerThreadId ? caller : created)),
      getProjectShellById: (id: ProjectId) =>
        Effect.succeed(Option.some(id === otherProject.id ? otherProject : project)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const dispatcher = ThreadCommandDispatcher.ThreadCommandDispatcher.of({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    });
    const crypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) => Effect.succeed(data),
    });
    const create = (arguments_: Record<string, unknown>) =>
      server
        .callTool({ name: "create_thread", arguments: arguments_ })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
          Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, createQuery),
          Effect.provideService(ThreadCommandDispatcher.ThreadCommandDispatcher, dispatcher),
          Effect.provideService(Crypto.Crypto, crypto),
        );

    expect((yield* create({ prompt: "Continue this checkout." })).isError).toBe(false);
    expect(
      (yield* create({ prompt: "Start elsewhere.", target: { projectId: otherProject.id } }))
        .isError,
    ).toBe(false);

    const createThread = (command: unknown) =>
      (command as { readonly bootstrap: { readonly createThread: Record<string, unknown> } })
        .bootstrap.createThread;
    expect(createThread(dispatched[0])).toMatchObject({
      projectId,
      branch: "feature/current",
      worktreePath: "/work/current",
    });
    expect(createThread(dispatched[1])).toMatchObject({
      projectId: otherProject.id,
      branch: null,
      worktreePath: null,
    });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("waits from a thread sequence cursor and exits for a caller message", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const callerMessage = {
      aggregateKind: "thread",
      aggregateId: callerThreadId,
      type: "thread.message-sent",
      payload: { role: "user" },
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    const engine = OrchestrationEngine.OrchestrationEngineService.of({
      dispatch: () => Effect.die("unused"),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.make(callerMessage),
      latestSequence: Effect.succeed(7),
    });

    const waited = yield* server
      .callTool({
        name: "wait_threads",
        arguments: { targets: [{ threadId, afterCursor: "6" }], timeoutMs: 1_000 },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, query),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
      );
    expect(waited.isError).toBe(false);
    expect(waited.structuredContent).toEqual({
      reason: "caller-message",
      targets: [{ threadId, status: "idle", eventCursor: "6" }],
    });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("ignores non-user caller events when the caller is not a target", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const callerEvent = {
      aggregateKind: "thread",
      aggregateId: callerThreadId,
      type: "thread.message-sent",
      payload: { role: "assistant" },
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    const targetEvent = {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.activity.appended",
      payload: {},
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    const callerShell = { ...shell, id: callerThreadId, hasPendingApprovals: true };
    let callerDetailLoads = 0;
    let targetDetailLoads = 0;
    const completedTurn = {
      turnId: TurnId.make("thread-tools-caller-routing-completed-turn"),
      state: "completed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    };
    const waitQuery = {
      getThreadDetailSnapshot: (id: ThreadId) => {
        if (id === callerThreadId) {
          callerDetailLoads += 1;
          return Effect.succeed(Option.some(detail));
        }
        targetDetailLoads += 1;
        const sequence = 5 + targetDetailLoads;
        return Effect.succeed(
          Option.some({
            ...detail,
            snapshotSequence: sequence,
            page: { ...detail.page, snapshotSequence: sequence, threadSequence: sequence },
          }),
        );
      },
      getThreadShellById: (id: ThreadId) =>
        Effect.succeed(
          Option.some(
            id === callerThreadId
              ? callerShell
              : { ...shell, ...(targetDetailLoads >= 2 ? { latestTurn: completedTurn } : {}) },
          ),
        ),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const engine = OrchestrationEngine.OrchestrationEngineService.of({
      dispatch: () => Effect.die("unused"),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.make(callerEvent, targetEvent),
      latestSequence: Effect.succeed(7),
    });

    const waited = yield* server
      .callTool({
        name: "wait_threads",
        arguments: { targets: [{ threadId, afterCursor: "6" }], timeoutMs: 1_000 },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, waitQuery),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
      );

    expect(waited.isError).toBe(false);
    expect(callerDetailLoads).toBe(0);
    expect(waited.structuredContent).toMatchObject({
      reason: "completed",
      target: { threadId, status: "completed", eventCursor: "7" },
      targets: [{ threadId, status: "completed", eventCursor: "7" }],
    });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("subscribes to hot wait events before loading target state", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const eventPubSub = yield* PubSub.unbounded<import("@t3tools/contracts").OrchestrationEvent>();
    const callerMessage = {
      aggregateKind: "thread",
      aggregateId: callerThreadId,
      type: "thread.message-sent",
      payload: { role: "user" },
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    let delivered = false;
    let loaded = false;
    const hotQuery = {
      getThreadDetailSnapshot: () =>
        Effect.gen(function* () {
          if (!loaded) {
            loaded = true;
            delivered = yield* PubSub.publish(eventPubSub, callerMessage);
          }
          return Option.some(detail);
        }),
      getThreadShellById: () => Effect.succeed(Option.some(shell)),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const engine = OrchestrationEngine.OrchestrationEngineService.of({
      dispatch: () => Effect.die("unused"),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromPubSub(eventPubSub),
      latestSequence: Effect.succeed(7),
    });

    const waited = yield* server
      .callTool({
        name: "wait_threads",
        arguments: { targets: [{ threadId, afterCursor: "6" }], timeoutMs: 1_000 },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, hotQuery),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
      );

    expect(delivered).toBe(true);
    expect(waited.structuredContent).toEqual({
      reason: "caller-message",
      targets: [{ threadId, status: "idle", eventCursor: "6" }],
    });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("coalesces hot target events while preserving caller-message exit", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const targetEvent = {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.activity.appended",
      payload: {},
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    const callerMessage = {
      aggregateKind: "thread",
      aggregateId: callerThreadId,
      type: "thread.message-sent",
      payload: { role: "user" },
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    let detailLoads = 0;
    const coalescingQuery = {
      getThreadDetailSnapshot: () =>
        Effect.sync(() => {
          detailLoads += 1;
          return Option.some(detail);
        }),
      getThreadShellById: () => Effect.succeed(Option.some(shell)),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const engine = OrchestrationEngine.OrchestrationEngineService.of({
      dispatch: () => Effect.die("unused"),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.make(
        ...Array.from({ length: 200 }, () => targetEvent),
        callerMessage,
      ),
      latestSequence: Effect.succeed(7),
    });

    const waited = yield* server
      .callTool({
        name: "wait_threads",
        arguments: { targets: [{ threadId, afterCursor: "6" }], timeoutMs: 1_000 },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, coalescingQuery),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
      );

    expect(detailLoads).toBe(2);
    expect(waited.structuredContent).toEqual({
      reason: "caller-message",
      targets: [{ threadId, status: "idle", eventCursor: "6" }],
    });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("refreshes a target again when an event lands during its state load", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const followups = yield* PubSub.unbounded<import("@t3tools/contracts").OrchestrationEvent>();
    const targetEvent = {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.activity.appended",
      payload: {},
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    let detailLoads = 0;
    const completedTurn = {
      turnId: TurnId.make("thread-tools-completed-turn"),
      state: "completed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    };
    const followupQuery = {
      getThreadDetailSnapshot: () =>
        Effect.sync(() => {
          detailLoads += 1;
          const sequence = 5 + detailLoads;
          return Option.some({
            ...detail,
            snapshotSequence: sequence,
            page: { ...detail.page, snapshotSequence: sequence, threadSequence: sequence },
          });
        }),
      getThreadShellById: () =>
        detailLoads === 2
          ? PubSub.publish(followups, targetEvent).pipe(Effect.as(Option.some(shell)))
          : Effect.succeed(
              Option.some({ ...shell, ...(detailLoads >= 3 ? { latestTurn: completedTurn } : {}) }),
            ),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const engine = OrchestrationEngine.OrchestrationEngineService.of({
      dispatch: () => Effect.die("unused"),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.concat(Stream.make(targetEvent), Stream.fromPubSub(followups)),
      latestSequence: Effect.succeed(8),
    });

    const waited = yield* server
      .callTool({
        name: "wait_threads",
        arguments: { targets: [{ threadId, afterCursor: "6" }], timeoutMs: 1_000 },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, followupQuery),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
      );

    expect(detailLoads).toBe(3);
    expect(waited.structuredContent).toMatchObject({
      reason: "completed",
      target: { threadId, status: "completed", eventCursor: "8" },
    });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);
