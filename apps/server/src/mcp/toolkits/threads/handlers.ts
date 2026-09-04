import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  ThreadToolInvalidInputError,
  ThreadToolNotFoundError,
  ThreadToolOperationFailureError,
  ThreadToolSelfSendForbiddenError,
  type OrchestrationProjectShell,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
  type ProviderDriverKind,
  type ThreadToolAttentionReason,
  type ThreadToolStatus,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { projectThreadDetailSnapshot } from "../../../orchestration/ActivityPayloadProjection.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ThreadCommandDispatcher from "../../../orchestration/ThreadCommandDispatcher.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadToolkit } from "./tools.ts";

type ThreadToolOperation = McpInvocationContext.McpThreadToolOperation;

const DEFAULT_READ_TURN_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_OUTPUT_CHARS = 8_000;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const operationFailure = (operation: ThreadToolOperation, cause: unknown) =>
  new ThreadToolOperationFailureError({
    operation,
    reason:
      cause instanceof Error && cause.message.trim().length > 0
        ? cause.message
        : `Unable to ${operation} threads.`,
  });

const getCursor = (snapshot: OrchestrationThreadDetailSnapshot): string =>
  String(snapshot.page?.threadSequence ?? snapshot.snapshotSequence);

const deriveTitle = (prompt: string) => {
  const compact = prompt.trim().replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
};

const toSortableTimestamp = (value: string | null | undefined) => {
  if (value == null) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
};

const getLatestUserActivityTimestamp = (thread: OrchestrationThreadShell) =>
  toSortableTimestamp(thread.latestUserMessageAt) ??
  toSortableTimestamp(thread.updatedAt) ??
  toSortableTimestamp(thread.createdAt) ??
  Number.NEGATIVE_INFINITY;

const sortPinnedThreads = (threads: ReadonlyArray<OrchestrationThreadShell>) => {
  const keyed: Array<OrchestrationThreadShell> = [];
  const keyless: Array<OrchestrationThreadShell> = [];
  for (const thread of threads) {
    (thread.pinOrderKey != null ? keyed : keyless).push(thread);
  }
  keyed.sort((left, right) => {
    const leftKey = left.pinOrderKey!;
    const rightKey = right.pinOrderKey!;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left.id.localeCompare(right.id);
  });
  keyless.sort(
    (left, right) =>
      (toSortableTimestamp(right.createdAt) ?? 0) - (toSortableTimestamp(left.createdAt) ?? 0) ||
      left.id.localeCompare(right.id),
  );
  return [...keyed, ...keyless];
};

const hasQueuedTurnStart = (thread: OrchestrationThreadShell, now: string) => {
  if (thread.latestUserMessageAt === null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const nowAt = Date.parse(now);
  if (
    Number.isNaN(messageAt) ||
    Number.isNaN(nowAt) ||
    Math.abs(nowAt - messageAt) > QUEUED_TURN_START_GRACE_MS
  ) {
    return false;
  }
  const turn = thread.latestTurn;
  return (
    turn === null ||
    [turn.requestedAt, turn.startedAt, turn.completedAt].every(
      (candidate) => candidate === null || Date.parse(candidate) < messageAt,
    )
  );
};

const getThreadStatus = (
  thread: OrchestrationThreadShell,
  now: string,
): { readonly status: ThreadToolStatus; readonly attentionReason?: ThreadToolAttentionReason } => {
  if (thread.hasPendingApprovals) {
    return { status: "attention", attentionReason: "approval" };
  }
  if (thread.hasPendingUserInput) {
    return { status: "attention", attentionReason: "user-input" };
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return { status: "attention", attentionReason: "error" };
  }
  if (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt === null) {
    return { status: "attention", attentionReason: "interrupted" };
  }
  if (thread.session?.status === "starting") {
    return { status: "queued" };
  }
  if (
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null
  ) {
    return { status: "running" };
  }
  if (hasQueuedTurnStart(thread, now)) {
    return { status: "queued" };
  }
  if (
    thread.latestTurn?.state === "completed" ||
    (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null) ||
    thread.session?.status === "ready" ||
    thread.session?.status === "idle"
  ) {
    return { status: "completed" };
  }
  return { status: "idle" };
};

const toThreadSummary = (
  thread: OrchestrationThreadShell,
  project: OrchestrationProjectShell,
  now: string,
) => ({
  threadId: thread.id,
  title: thread.title,
  ...getThreadStatus(thread, now),
  project: {
    projectId: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
  },
  modelSelection: thread.modelSelection,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  pinned: thread.pinnedAt != null,
  settled: thread.settledOverride === "settled" || thread.settledAt !== null,
  snoozedUntil: thread.snoozedUntil ?? null,
  updatedAt: thread.updatedAt,
  ...(thread.planProgress ? { progress: thread.planProgress } : {}),
});

const truncateOutput = (payload: unknown, limit: number) => {
  const output = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (!output) {
    return {};
  }
  return output.length <= limit
    ? { output }
    : { output: output.slice(0, limit), truncated: true as const };
};

const truncateText = (text: string, limit: number) =>
  text.length <= limit ? { text } : { text: text.slice(0, limit), truncated: true as const };

const findLatestAssistantMessage = (snapshot: OrchestrationThreadDetailSnapshot) =>
  snapshot.thread.messages.findLast((message) => message.role === "assistant")?.text;

const getThreadSnapshot = Effect.fn("ThreadToolkit.getThreadSnapshot")(function* (
  operation: ThreadToolOperation,
  threadId: ThreadId,
  turnLimit: number,
  beforeCursor?: string,
) {
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const snapshot = yield* query
    .getThreadDetailSnapshot(threadId, {
      turnLimit,
      ...(beforeCursor === undefined ? {} : { beforeCursor }),
    })
    .pipe(Effect.mapError((error) => operationFailure(operation, error)));
  if (Option.isNone(snapshot)) {
    return yield* new ThreadToolNotFoundError({
      operation,
      resource: "thread",
      resourceId: threadId,
    });
  }
  return snapshot.value;
});

const getThreadShell = Effect.fn("ThreadToolkit.getThreadShell")(function* (
  operation: ThreadToolOperation,
  threadId: ThreadId,
) {
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const shell = yield* query
    .getThreadShellById(threadId)
    .pipe(Effect.mapError((error) => operationFailure(operation, error)));
  if (Option.isNone(shell)) {
    return yield* new ThreadToolNotFoundError({
      operation,
      resource: "thread",
      resourceId: threadId,
    });
  }
  return shell.value;
});

const getProjectShell = Effect.fn("ThreadToolkit.getProjectShell")(function* (
  operation: ThreadToolOperation,
  projectId: OrchestrationProjectShell["id"],
) {
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const project = yield* query
    .getProjectShellById(projectId)
    .pipe(Effect.mapError((error) => operationFailure(operation, error)));
  if (Option.isNone(project)) {
    return yield* new ThreadToolNotFoundError({
      operation,
      resource: "project",
      resourceId: projectId,
    });
  }
  return project.value;
});

const getThreadWithProject = Effect.fn("ThreadToolkit.getThreadWithProject")(function* (
  operation: ThreadToolOperation,
  threadId: ThreadId,
) {
  const thread = yield* getThreadShell(operation, threadId);
  const project = yield* getProjectShell(operation, thread.projectId);
  return { thread, project };
});

const newId = Effect.fn("ThreadToolkit.newId")(function* (operation: ThreadToolOperation) {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4.pipe(
    Effect.mapError((error) => operationFailure(operation, error)),
  );
});

const readThread = Effect.fn("ThreadToolkit.readThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly cursor?: string;
  readonly turnLimit?: number;
  readonly includeOutputs?: boolean;
  readonly maxOutputCharsPerItem?: number;
}) {
  const invocation = yield* McpInvocationContext.requireThreadMcpCapability("read");
  const snapshot = yield* getThreadSnapshot(
    "read",
    input.threadId,
    input.turnLimit ?? DEFAULT_READ_TURN_LIMIT,
    input.cursor,
  );
  const { thread: shell, project } = yield* getThreadWithProject("read", input.threadId);
  const projected = projectThreadDetailSnapshot(snapshot);
  const currentTime = yield* nowIso;
  const outputLimit = input.maxOutputCharsPerItem ?? DEFAULT_OUTPUT_CHARS;

  return {
    environmentId: invocation.environmentId,
    thread: toThreadSummary(shell, project, currentTime),
    messages: projected.thread.messages.map((message) => ({
      messageId: message.id,
      role: message.role,
      ...truncateText(message.text, outputLimit),
      turnId: message.turnId,
      streaming: message.streaming,
      createdAt: message.createdAt,
    })),
    activities: projected.thread.activities.map((activity) => ({
      activityId: activity.id,
      kind: activity.kind,
      tone: activity.tone,
      summary: activity.summary,
      turnId: activity.turnId,
      createdAt: activity.createdAt,
      ...(input.includeOutputs ? truncateOutput(activity.payload, outputLimit) : {}),
    })),
    proposedPlans: projected.thread.proposedPlans,
    olderCursor: projected.page?.beforeCursor ?? null,
    eventCursor: getCursor(projected),
  };
});

const createThread = Effect.fn("ThreadToolkit.createThread")(function* (input: {
  readonly prompt: string;
  readonly target?: {
    readonly projectId?: OrchestrationProjectShell["id"];
    readonly environment?:
      | { readonly type: "local" }
      | {
          readonly type: "worktree";
          readonly baseBranch?: string;
          readonly startFromOrigin?: boolean;
        };
  };
  readonly title?: string;
  readonly modelSelection?: OrchestrationThreadShell["modelSelection"];
}) {
  const invocation = yield* McpInvocationContext.requireThreadMcpCapability("create");
  const provider = McpInvocationContext.getProviderSessionPrincipal(invocation);
  const management = McpInvocationContext.isManagementKeyPrincipal(invocation.principal)
    ? invocation.principal
    : undefined;
  if (!provider && input.target?.projectId === undefined) {
    return yield* new ThreadToolInvalidInputError({
      operation: "create",
      reason: "A management key must provide target.projectId when creating a thread.",
    });
  }
  const caller = provider ? yield* getThreadShell("create", provider.threadId) : undefined;
  const project = yield* getProjectShell("create", input.target?.projectId ?? caller!.projectId);
  let modelSelection = input.modelSelection;
  if (modelSelection === undefined) {
    if (provider !== undefined) {
      modelSelection = caller!.modelSelection;
    } else if (project.defaultModelSelection !== null) {
      modelSelection = project.defaultModelSelection;
    } else {
      return yield* new ThreadToolInvalidInputError({
        operation: "create",
        reason:
          "A management create requires modelSelection or a default model selection on the target project.",
      });
    }
  }
  const threadId = ThreadId.make(yield* newId("create"));
  const commandId = CommandId.make(`mcp:create:${yield* newId("create")}`);
  const messageId = MessageId.make(yield* newId("create"));
  const createdAt = yield* nowIso;
  const title = input.title ?? deriveTitle(input.prompt);
  const environment = input.target?.environment ?? { type: "local" as const };
  const isWorktree = environment.type === "worktree";
  const isCallerProject = provider !== undefined && project.id === caller!.projectId;
  let baseBranch: string | null = provider ? caller!.branch : null;
  let worktreeBranch: string | undefined;

  if (isWorktree) {
    if (environment.baseBranch !== undefined) {
      baseBranch = environment.baseBranch;
    } else {
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* gitWorkflow
        .status({ cwd: project.workspaceRoot })
        .pipe(Effect.mapError((error) => operationFailure("create", error)));
      baseBranch = status.refName;
    }
    if (baseBranch === null) {
      return yield* new ThreadToolInvalidInputError({
        operation: "create",
        reason: "A worktree needs a current or explicit base branch.",
      });
    }
    worktreeBranch = buildTemporaryWorktreeBranchName(() => threadId);
  }

  const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;
  const dispatched = yield* dispatcher
    .dispatch(
      {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        modelSelection,
        titleSeed: title,
        runtimeMode: provider ? caller!.runtimeMode : DEFAULT_RUNTIME_MODE,
        interactionMode: provider ? caller!.interactionMode : "default",
        bootstrap: {
          createThread: {
            projectId: project.id,
            title,
            modelSelection,
            runtimeMode: provider ? caller!.runtimeMode : DEFAULT_RUNTIME_MODE,
            interactionMode: provider ? caller!.interactionMode : "default",
            branch: isWorktree ? baseBranch : isCallerProject ? caller!.branch : null,
            worktreePath: isCallerProject && !isWorktree ? caller!.worktreePath : null,
            createdAt,
          },
          ...(isWorktree
            ? {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: baseBranch!,
                  branch: worktreeBranch,
                  ...(environment.startFromOrigin ? { startFromOrigin: true } : {}),
                },
                runSetupScript: true,
              }
            : {}),
        },
        createdAt,
      },
      McpInvocationContext.getManagementOrigin(invocation),
    )
    .pipe(Effect.mapError((error) => operationFailure("create", error)));
  if (management !== undefined) {
    yield* Effect.logInfo("MCP management thread operation dispatched").pipe(
      Effect.annotateLogs({
        operation: "create_thread",
        managementApiKeyId: management.keyId,
        managementApiKeyName: management.name,
        targetThreadId: threadId,
      }),
    );
  }
  const created = yield* getThreadShell("create", threadId);

  return {
    environmentId: invocation.environmentId,
    projectId: project.id,
    threadId,
    eventCursor: String(dispatched.sequence),
    status: "queued" as const,
    branch: created.branch,
    worktreePath: created.worktreePath,
  };
});

const listThreads = Effect.fn("ThreadToolkit.listThreads")(function* (input: {
  readonly projectId?: OrchestrationProjectShell["id"];
  readonly limit?: number;
}) {
  const invocation = yield* McpInvocationContext.requireThreadMcpCapability("list");
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const snapshot = yield* query
    .getShellSnapshot()
    .pipe(Effect.mapError((error) => operationFailure("list", error)));
  const projects = new Map(snapshot.projects.map((project) => [project.id, project] as const));
  const visibleThreads = snapshot.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      (input.projectId === undefined || thread.projectId === input.projectId) &&
      projects.has(thread.projectId),
  );
  const currentTime = yield* nowIso;
  const threads = [
    ...sortPinnedThreads(visibleThreads.filter((thread) => thread.pinnedAt != null)),
    ...visibleThreads
      .filter((thread) => thread.pinnedAt == null)
      .toSorted(
        (left, right) =>
          getLatestUserActivityTimestamp(right) - getLatestUserActivityTimestamp(left) ||
          right.id.localeCompare(left.id),
      ),
  ]
    .slice(0, input.limit ?? DEFAULT_LIST_LIMIT)
    .map((thread) => toThreadSummary(thread, projects.get(thread.projectId)!, currentTime));

  return { environmentId: invocation.environmentId, threads };
});

const listModels = Effect.fn("ThreadToolkit.listModels")(function* (input: {
  readonly driver?: ProviderDriverKind;
}) {
  const invocation = yield* McpInvocationContext.requireThreadMcpCapability("list_models");
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providers = (yield* providerRegistry.getProviders)
    .filter(
      (provider) =>
        provider.enabled &&
        provider.status === "ready" &&
        provider.availability !== "unavailable" &&
        (input.driver === undefined || provider.driver === input.driver),
    )
    .map(({ instanceId, driver, displayName, models }) => ({
      instanceId,
      driver,
      ...(displayName === undefined ? {} : { displayName }),
      models,
    }));

  return { environmentId: invocation.environmentId, providers };
});

const sendMessageToThread = Effect.fn("ThreadToolkit.sendMessageToThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly message: string;
  readonly modelSelection?: OrchestrationThreadShell["modelSelection"];
}) {
  const invocation = yield* McpInvocationContext.requireThreadMcpCapability("send");
  const provider = McpInvocationContext.getProviderSessionPrincipal(invocation);
  const management = McpInvocationContext.isManagementKeyPrincipal(invocation.principal)
    ? invocation.principal
    : undefined;
  if (provider?.threadId === input.threadId) {
    return yield* new ThreadToolSelfSendForbiddenError({
      sourceThreadId: provider.threadId,
      targetThreadId: input.threadId,
    });
  }
  const target = yield* getThreadShell("send", input.threadId);
  const dispatcher = yield* ThreadCommandDispatcher.ThreadCommandDispatcher;

  if (input.modelSelection !== undefined) {
    yield* dispatcher
      .dispatch(
        {
          type: "thread.meta.update",
          commandId: CommandId.make(`mcp:send-model:${yield* newId("send")}`),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        },
        McpInvocationContext.getManagementOrigin(invocation),
      )
      .pipe(Effect.mapError((error) => operationFailure("send", error)));
  }

  const createdAt = yield* nowIso;
  const dispatched = yield* dispatcher
    .dispatch(
      {
        type: "thread.turn.start",
        commandId: CommandId.make(`mcp:send:${yield* newId("send")}`),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(yield* newId("send")),
          role: "user",
          text: input.message,
          attachments: [],
        },
        modelSelection: input.modelSelection ?? target.modelSelection,
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        createdAt,
      },
      McpInvocationContext.getManagementOrigin(invocation),
    )
    .pipe(Effect.mapError((error) => operationFailure("send", error)));
  if (management !== undefined) {
    yield* Effect.logInfo("MCP management thread operation dispatched").pipe(
      Effect.annotateLogs({
        operation: "send_message_to_thread",
        managementApiKeyId: management.keyId,
        managementApiKeyName: management.name,
        targetThreadId: input.threadId,
      }),
    );
  }
  const updated = yield* getThreadShell("send", input.threadId);
  const currentTime = yield* nowIso;

  return {
    environmentId: invocation.environmentId,
    threadId: input.threadId,
    eventCursor: String(dispatched.sequence),
    status:
      getThreadStatus(updated, currentTime).status === "running"
        ? ("running" as const)
        : ("queued" as const),
  };
});

const waitThreads = Effect.fn("ThreadToolkit.waitThreads")(function* (input: {
  readonly targets: ReadonlyArray<{ readonly threadId: ThreadId; readonly afterCursor?: string }>;
  readonly timeoutMs: number;
}) {
  const invocation = yield* McpInvocationContext.requireThreadMcpCapability("wait");
  const provider = McpInvocationContext.getProviderSessionPrincipal(invocation);
  const callerThreadId = provider?.threadId;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const targetIds = new Set(input.targets.map((target) => target.threadId));
  const events = yield* Queue.bounded<ThreadId>(targetIds.size);
  const pendingTargetIds = yield* Ref.make(new Set<ThreadId>());
  const callerMessage = yield* Deferred.make<void>();
  const enqueueTarget = Effect.fn("ThreadToolkit.waitThreads.enqueueTarget")(function* (
    threadId: ThreadId,
  ) {
    const newlyPending = yield* Ref.modify(pendingTargetIds, (pending) => {
      if (pending.has(threadId)) return [false, pending] as const;
      return [true, new Set(pending).add(threadId)] as const;
    });
    if (newlyPending) {
      yield* Queue.offer(events, threadId);
    }
  });
  yield* Effect.forkScoped(
    engine.streamDomainEvents.pipe(
      Stream.filter((event) => {
        if (event.aggregateKind !== "thread") return false;
        if (targetIds.has(ThreadId.make(event.aggregateId))) return true;
        return (
          callerThreadId !== undefined &&
          event.aggregateId === callerThreadId &&
          event.type === "thread.message-sent" &&
          event.payload.role === "user"
        );
      }),
      Stream.runForEach((event) => {
        if (
          callerThreadId !== undefined &&
          event.aggregateId === callerThreadId &&
          event.type === "thread.message-sent" &&
          event.payload.role === "user"
        ) {
          return Deferred.succeed(callerMessage, undefined).pipe(Effect.asVoid);
        }
        return enqueueTarget(ThreadId.make(event.aggregateId));
      }),
    ),
    { startImmediately: true },
  );

  type WaitState = {
    readonly summary: ReturnType<typeof toThreadSummary>;
    readonly eventCursor: string;
    readonly latestAssistantMessage?: string;
  };
  const loadState = Effect.fn("ThreadToolkit.waitThreads.loadState")(function* (
    threadId: ThreadId,
  ) {
    const snapshot = yield* getThreadSnapshot("wait", threadId, 1);
    const { thread, project } = yield* getThreadWithProject("wait", threadId);
    const latestAssistantMessage = findLatestAssistantMessage(snapshot);
    const currentTime = yield* nowIso;
    return {
      summary: toThreadSummary(thread, project, currentTime),
      eventCursor: getCursor(snapshot),
      ...(latestAssistantMessage
        ? {
            latestAssistantMessage: truncateText(latestAssistantMessage, DEFAULT_OUTPUT_CHARS).text,
          }
        : {}),
    };
  });
  const states = new Map<ThreadId, WaitState>();
  for (const target of input.targets) {
    states.set(target.threadId, yield* loadState(target.threadId));
  }
  const result = (
    reason: "completed" | "attention" | "timeout" | "caller-message",
    target?: {
      readonly threadId: ThreadId;
      readonly summary: ReturnType<typeof toThreadSummary>;
      readonly eventCursor: string;
      readonly latestAssistantMessage?: string;
    },
  ) => ({
    reason,
    ...(target && (target.summary.status === "completed" || target.summary.status === "attention")
      ? {
          target: {
            threadId: target.threadId,
            status: target.summary.status,
            ...(target.summary.attentionReason
              ? { attentionReason: target.summary.attentionReason }
              : {}),
            eventCursor: target.eventCursor,
            ...(target.latestAssistantMessage
              ? { latestAssistantMessage: target.latestAssistantMessage }
              : {}),
          },
        }
      : {}),
    targets: input.targets.map((entry) => {
      const state = states.get(entry.threadId)!;
      return {
        threadId: entry.threadId,
        status: state.summary.status,
        eventCursor: state.eventCursor,
      };
    }),
  });
  if (Option.isSome(yield* Deferred.poll(callerMessage))) {
    return result("caller-message");
  }
  const terminalInitial = input.targets.find((target) => {
    const state = states.get(target.threadId)!;
    return (
      (state.summary.status === "completed" || state.summary.status === "attention") &&
      target.afterCursor !== state.eventCursor
    );
  });
  if (terminalInitial) {
    const state = states.get(terminalInitial.threadId)!;
    return result(state.summary.status === "attention" ? "attention" : "completed", {
      threadId: terminalInitial.threadId,
      ...state,
    });
  }
  if (input.timeoutMs === 0) {
    return result("timeout");
  }
  if (Option.isSome(yield* Deferred.poll(callerMessage))) {
    return result("caller-message");
  }

  const deadline = (yield* Clock.currentTimeMillis) + input.timeoutMs;
  while (true) {
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) {
      return result("timeout");
    }
    const event = yield* Effect.raceFirst(
      Queue.take(events),
      Deferred.await(callerMessage).pipe(Effect.as(undefined)),
    ).pipe(Effect.timeoutOption(Duration.millis(remaining)));
    if (Option.isNone(event)) {
      return result("timeout");
    }
    if (event.value === undefined || Option.isSome(yield* Deferred.poll(callerMessage))) {
      return result("caller-message");
    }
    const eventThreadId = event.value;
    yield* Ref.update(pendingTargetIds, (pending) => {
      const next = new Set(pending);
      next.delete(eventThreadId);
      return next;
    });
    const state = yield* loadState(eventThreadId);
    states.set(eventThreadId, state);
    const target = input.targets.find((entry) => entry.threadId === eventThreadId)!;
    yield* Effect.yieldNow;
    if (Option.isSome(yield* Deferred.poll(callerMessage))) {
      return result("caller-message");
    }
    if (
      (state.summary.status === "completed" || state.summary.status === "attention") &&
      target.afterCursor !== state.eventCursor
    ) {
      return result(state.summary.status === "attention" ? "attention" : "completed", {
        threadId: target.threadId,
        ...state,
      });
    }
  }
});

const handlers = {
  create_thread: createThread,
  list_models: listModels,
  list_threads: listThreads,
  read_thread: readThread,
  send_message_to_thread: sendMessageToThread,
  wait_threads: (input) => Effect.scoped(waitThreads(input)),
} satisfies Parameters<typeof ThreadToolkit.toLayer>[0];

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer(handlers);
