import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ManagementApiKeyId,
  type ManagementApiKeyScope,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadCommandDispatcher from "../../../orchestration/ThreadCommandDispatcher.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadToolkitHandlersLive } from "./handlers.ts";
import { ListModelsTool, ReadThreadTool, ThreadToolkit } from "./tools.ts";

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
  principal: {
    type: "provider-session" as const,
    threadId: callerThreadId,
    providerSessionId: "thread-tools-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  issuedAt: 1,
};
const managementScopes = [
  "models:read",
  "threads:list",
  "threads:read",
  "threads:create",
  "threads:message",
  "threads:wait",
] satisfies ReadonlyArray<ManagementApiKeyScope>;
const managementInvocation = {
  environmentId,
  principal: {
    type: "management-key" as const,
    keyId: ManagementApiKeyId.make("thread-tools-management"),
    name: "Thread tools management",
    scopes: new Set<ManagementApiKeyScope>(managementScopes),
  },
  issuedAt: 1,
};
const provider = (
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName: instanceId,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});
const makeThreadToolkitTestLayer = (providers: ReadonlyArray<ServerProvider> = []) =>
  McpServer.toolkit(ThreadToolkit).pipe(
    Layer.provide(ThreadToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(makeProviderRegistryLayer(providers)),
  );
const ThreadToolkitTestLayer = makeThreadToolkitTestLayer();

it("describes the read pagination argument as cursor", () => {
  expect(ReadThreadTool.description).toContain("Use cursor");
  expect(ReadThreadTool.description).not.toContain("olderCursor");
});

it.effect("registers list_models as a readonly, idempotent, closed-world tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const listModels = server.tools.find(({ tool }) => tool.name === ListModelsTool.name);
    expect(listModels?.tool.annotations).toMatchObject({
      title: "List models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect(
  "lists selectable models by configured provider instance and filters by open driver slug",
  () => {
    const legacyModel = {
      slug: "claude-legacy",
      name: "Claude Legacy",
      isCustom: false,
      isLegacy: true,
      capabilities: null,
    };
    const customModel = {
      slug: "proxy/custom-model",
      name: "Custom Model",
      isCustom: true,
      capabilities: null,
    };
    const providers = [
      provider("claude-work", "claudeAgent", {
        displayName: "Claude Work",
        models: [legacyModel, customModel],
      }),
      provider("claude-personal", "claudeAgent", {
        displayName: "Claude Personal",
        models: [customModel],
      }),
      provider("custom-gateway", "acme-driver", {
        displayName: "Acme Gateway",
        models: [customModel, legacyModel],
      }),
      provider("disabled", "claudeAgent", { enabled: false, models: [customModel] }),
      provider("warning", "claudeAgent", { status: "warning", models: [customModel] }),
      provider("missing", "claudeAgent", {
        availability: "unavailable",
        enabled: false,
        installed: false,
        models: [customModel],
      }),
    ];
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (arguments_: Record<string, unknown>) =>
        server
          .callTool({ name: "list_models", arguments: arguments_ })
          .pipe(
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.provideService(McpInvocationContext.McpInvocationContext, allowedInvocation),
          );

      const all = yield* call({});
      expect(all.isError).toBe(false);
      expect(all.structuredContent).toEqual({
        environmentId,
        providers: [
          {
            instanceId: ProviderInstanceId.make("claude-work"),
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude Work",
            models: [legacyModel, customModel],
          },
          {
            instanceId: ProviderInstanceId.make("claude-personal"),
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude Personal",
            models: [customModel],
          },
          {
            instanceId: ProviderInstanceId.make("custom-gateway"),
            driver: ProviderDriverKind.make("acme-driver"),
            displayName: "Acme Gateway",
            models: [customModel, legacyModel],
          },
        ],
      });

      const claude = yield* call({ driver: "claudeAgent" });
      expect(
        (
          claude.structuredContent as {
            providers: ReadonlyArray<{ instanceId: string }>;
          }
        ).providers.map(({ instanceId }) => instanceId),
      ).toEqual(["claude-work", "claude-personal"]);

      const custom = yield* call({ driver: "acme-driver" });
      expect(custom.structuredContent).toMatchObject({
        providers: [{ instanceId: "custom-gateway", driver: "acme-driver" }],
      });
    }).pipe(Effect.provide(makeThreadToolkitTestLayer(providers)));
  },
);

it.effect("requires list capability for list_models", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const denied = yield* server.callTool({ name: "list_models", arguments: {} }).pipe(
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId,
        principal: {
          type: "management-key",
          keyId: ManagementApiKeyId.make("thread-tools-read-only"),
          name: "Read only",
          scopes: new Set<ManagementApiKeyScope>(),
        },
        issuedAt: 1,
      }),
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([
      {
        type: "text",
        text: "The list_models operation failed: MCP management key does not grant the models:read scope.",
      },
    ]);
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

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
        environmentId,
        principal: {
          type: "management-key",
          keyId: ManagementApiKeyId.make("thread-tools-read-only-2"),
          name: "Read only",
          scopes: new Set<ManagementApiKeyScope>(["models:read"]),
        },
        issuedAt: 1,
      }),
    );
    expect(withoutThreads.isError).toBe(true);
    expect(withoutThreads.content).toEqual([
      {
        type: "text",
        text: "The list operation failed: MCP management key does not grant the threads:list scope.",
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

it.effect("uses the normal create defaults for management keys and records their origin", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const managementProject = {
      ...project,
      defaultModelSelection: modelSelection,
    };
    const created = {
      ...shell,
      projectId,
      modelSelection,
      runtimeMode: "full-access" as const,
    };
    const dispatched: Array<{
      readonly command: unknown;
      readonly options: unknown;
    }> = [];
    const createQuery = {
      getThreadShellById: () => Effect.succeed(Option.some(created)),
      getProjectShellById: () => Effect.succeed(Option.some(managementProject)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const dispatcher = ThreadCommandDispatcher.ThreadCommandDispatcher.of({
      dispatch: (command, options) =>
        Effect.sync(() => {
          dispatched.push({ command, options });
          return { sequence: dispatched.length };
        }),
    });
    const crypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) => Effect.succeed(data),
    });

    const createdResult = yield* server
      .callTool({
        name: "create_thread",
        arguments: {
          prompt: "Create this from a durable management key.",
          target: { projectId },
        },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, managementInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, createQuery),
        Effect.provideService(ThreadCommandDispatcher.ThreadCommandDispatcher, dispatcher),
        Effect.provideService(Crypto.Crypto, crypto),
      );

    expect(createdResult.isError).toBe(false);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      options: {
        origin: {
          managementKey: {
            id: managementInvocation.principal.keyId,
            name: managementInvocation.principal.name,
          },
        },
      },
      command: {
        type: "thread.turn.start",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        },
      },
    });
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("logs management state-changing thread operations without token material", () => {
  const logs: Array<{
    readonly message: unknown;
    readonly annotations: Readonly<Record<string, unknown>>;
  }> = [];
  const logger = Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  const managementLogInvocation = managementInvocation;
  const created = { ...shell, runtimeMode: "full-access" as const };
  const queryForOperations = {
    getThreadShellById: () => Effect.succeed(Option.some(created)),
    getProjectShellById: () =>
      Effect.succeed(Option.some({ ...project, defaultModelSelection: modelSelection })),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  const dispatched: Array<unknown> = [];
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

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, managementLogInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, queryForOperations),
        Effect.provideService(ThreadCommandDispatcher.ThreadCommandDispatcher, dispatcher),
        Effect.provideService(Crypto.Crypto, crypto),
      );

    const createdResult = yield* provide(
      server.callTool({
        name: "create_thread",
        arguments: { prompt: "Create a managed thread.", target: { projectId } },
      }),
    );
    const sentResult = yield* provide(
      server.callTool({
        name: "send_message_to_thread",
        arguments: { threadId, message: "Send a managed message." },
      }),
    );

    expect(createdResult.isError).toBe(false);
    expect(sentResult.isError).toBe(false);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]).toMatchObject({
      type: "thread.turn.start",
      threadId,
      runtimeMode: "full-access",
    });
    const operationLogs = logs.filter(
      (log) =>
        log.annotations.operation === "create_thread" ||
        log.annotations.operation === "send_message_to_thread",
    );
    expect(operationLogs.map((log) => log.annotations)).toEqual([
      {
        operation: "create_thread",
        managementApiKeyId: managementLogInvocation.principal.keyId,
        managementApiKeyName: managementLogInvocation.principal.name,
        targetThreadId: expect.any(String),
      },
      {
        operation: "send_message_to_thread",
        managementApiKeyId: managementLogInvocation.principal.keyId,
        managementApiKeyName: managementLogInvocation.principal.name,
        targetThreadId: threadId,
      },
    ]);
    expect(
      logs.some((log) =>
        Object.values(log.annotations).some((value) => String(value).includes("t3mgmt_")),
      ),
    ).toBe(false);
  }).pipe(
    Effect.provide(
      Layer.merge(ThreadToolkitTestLayer, Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
});

it.effect("requires a project and a model default for management-key create", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const dispatched: Array<unknown> = [];
    const dispatcher = ThreadCommandDispatcher.ThreadCommandDispatcher.of({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    });
    const noDefaultQuery = {
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getThreadShellById: () => Effect.succeed(Option.some(shell)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const create = (arguments_: Record<string, unknown>) =>
      server
        .callTool({ name: "create_thread", arguments: arguments_ })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext.McpInvocationContext, managementInvocation),
          Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, noDefaultQuery),
          Effect.provideService(ThreadCommandDispatcher.ThreadCommandDispatcher, dispatcher),
        );

    const missingProject = yield* create({ prompt: "Needs a target project." });
    expect(missingProject.isError).toBe(true);
    expect(missingProject.content).toEqual([
      {
        type: "text",
        text: "The create input is invalid: A management key must provide target.projectId when creating a thread.",
      },
    ]);

    const missingModel = yield* create({ prompt: "Needs a model.", target: { projectId } });
    expect(missingModel.isError).toBe(true);
    expect(missingModel.content).toEqual([
      {
        type: "text",
        text: "The create input is invalid: A management create requires modelSelection or a default model selection on the target project.",
      },
    ]);
    expect(dispatched).toHaveLength(0);
  }).pipe(Effect.provide(ThreadToolkitTestLayer)),
);

it.effect("management-key waits ignore messages on an unrelated caller thread", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const events = yield* PubSub.unbounded<import("@t3tools/contracts").OrchestrationEvent>();
    const unrelatedCallerMessage = {
      aggregateKind: "thread",
      aggregateId: callerThreadId,
      type: "thread.message-sent",
      payload: { role: "user" },
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    const targetEvent = {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.activity.appended",
      payload: {},
    } as unknown as import("@t3tools/contracts").OrchestrationEvent;
    const completedTurn = {
      turnId: TurnId.make("thread-tools-management-completed-turn"),
      state: "completed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    };
    let detailLoads = 0;
    const waitQuery = {
      getThreadDetailSnapshot: () =>
        Effect.gen(function* () {
          detailLoads += 1;
          if (detailLoads === 1) {
            // The stream subscription is established before the initial state
            // load, so both events are available to the wait loop.
            yield* PubSub.publish(events, unrelatedCallerMessage);
            yield* PubSub.publish(events, targetEvent);
            return Option.some(detail);
          }
          return Option.some({
            ...detail,
            snapshotSequence: 8,
            page: { ...detail.page, snapshotSequence: 8, threadSequence: 7 },
          });
        }),
      getThreadShellById: () =>
        Effect.succeed(
          Option.some(detailLoads >= 2 ? { ...shell, latestTurn: completedTurn } : shell),
        ),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const engine = OrchestrationEngine.OrchestrationEngineService.of({
      dispatch: () => Effect.die("unused"),
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () =>
        Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
      streamDomainEvents: Stream.fromPubSub(events),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      latestSequence: Effect.succeed(8),
    });

    const waited = yield* server
      .callTool({
        name: "wait_threads",
        arguments: { targets: [{ threadId, afterCursor: "6" }], timeoutMs: 1_000 },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, managementInvocation),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, waitQuery),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
      );

    expect(waited.isError).toBe(false);
    expect(waited.structuredContent).toMatchObject({
      reason: "completed",
      target: { threadId, status: "completed", eventCursor: "7" },
      targets: [{ threadId, status: "completed", eventCursor: "7" }],
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
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () =>
        Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
      streamDomainEvents: Stream.make(callerMessage),
      subscribeDomainEvents: Effect.succeed(Stream.make(callerMessage)),
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
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () =>
        Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
      streamDomainEvents: Stream.make(callerEvent, targetEvent),
      subscribeDomainEvents: Effect.succeed(Stream.make(callerEvent, targetEvent)),
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
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () =>
        Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
      streamDomainEvents: Stream.fromPubSub(eventPubSub),
      subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
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
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () =>
        Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
      streamDomainEvents: Stream.make(
        ...Array.from({ length: 200 }, () => targetEvent),
        callerMessage,
      ),
      subscribeDomainEvents: Effect.succeed(
        Stream.make(...Array.from({ length: 200 }, () => targetEvent), callerMessage),
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
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () =>
        Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
      streamDomainEvents: Stream.concat(Stream.make(targetEvent), Stream.fromPubSub(followups)),
      subscribeDomainEvents: Effect.succeed(
        Stream.concat(Stream.make(targetEvent), Stream.fromPubSub(followups)),
      ),
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
