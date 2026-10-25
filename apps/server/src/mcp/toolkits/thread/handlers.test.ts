import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ManagementApiKeyId,
  type ManagementApiKeyScope,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadToolkitHandlersLive } from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("mcp-thread-tools-environment");
const projectId = ProjectId.make("mcp-thread-tools-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const sourceThreadId = ThreadId.make("mcp-thread-tools-source");
const targetThreadId = ThreadId.make("mcp-thread-tools-target");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };

const managementInvocation = (scopes: ReadonlyArray<ManagementApiKeyScope>) =>
  ({
    environmentId,
    principal: {
      type: "management-key" as const,
      keyId: ManagementApiKeyId.make("mcp-thread-tools-management"),
      name: "Thread tools",
      scopes: new Set(scopes),
    },
    issuedAt: 1,
  }) satisfies McpInvocationContext.McpInvocationScope;

const projectionFor = (threadId: ThreadId): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    contextTransfers: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const makeToolkit = (
  invocation: McpInvocationContext.McpInvocationScope,
  dispatched: Array<unknown>,
  options: {
    readonly matches?: ReadonlyArray<ThreadSearch.ThreadSearchHit>;
    readonly caller?: OrchestrationV2ThreadShell | null;
    readonly scheduledTasks?: ReadonlyArray<ScheduledTask>;
    readonly onRunScheduledTask?: () => void;
  } = {},
) => {
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: (threadId) => Effect.succeed(projectionFor(threadId)),
      getThreadShell: (threadId) =>
        Effect.succeed(
          (options.caller ?? { ...projectionFor(threadId).thread, deletedAt: null }) as never,
        ),
      getProjectThreadRecords: (request) => Effect.succeed(projectionFor(request.threadId)),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 17, storedEvents: [] };
        }),
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({
      searchThreads: (input) =>
        Effect.succeed({
          matches: (options.matches ?? [])
            .filter((match) => input.projectId === undefined || match.projectId === input.projectId)
            .slice(0, input.limit ?? 50),
        }),
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: options.scheduledTasks ?? [] }),
      runNow: () =>
        Effect.sync(() => {
          const task = options.scheduledTasks?.[0];
          if (task === undefined) throw new Error("No scheduled task fixture was provided");
          options.onRunScheduledTask?.();
          return { task, threadId: task.threadId };
        }),
    }),
  );
  return {
    toolkit: ThreadToolkit.pipe(
      Effect.provide(
        Layer.provide(McpToolAccess.HandlersLayer.layer(ThreadToolkitHandlersLive), dependencies),
      ),
    ),
    dependencies,
  };
};

it.effect("requires management keys to scope reads and mutations to explicit threads", () =>
  Effect.gen(function* () {
    const dispatched: Array<unknown> = [];
    const readKey = managementInvocation(["threads:read"]);
    const { toolkit: toolkitEffect, dependencies } = makeToolkit(readKey, dispatched);
    const toolkit = yield* toolkitEffect;

    const missingTarget = yield* toolkit
      .handle("t3_thread_configuration", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(missingTarget.at(-1)?.result).toMatchObject({ code: "target_required" });

    const configuration = yield* toolkit
      .handle("t3_thread_configuration", { threadId: targetThreadId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(configuration.at(-1)?.result).toMatchObject({
      threadId: targetThreadId,
      modelSelection,
    });

    const deniedMutation = yield* toolkit
      .handle("t3_thread_organize", { threadId: targetThreadId, action: "pin" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(deniedMutation.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);
  }),
);

it.effect("runs management-key thread mutations without inventing a provider caller", () =>
  Effect.gen(function* () {
    const dispatched: Array<unknown> = [];
    const { toolkit: toolkitEffect, dependencies } = makeToolkit(
      managementInvocation(["threads:message"]),
      dispatched,
    );
    const toolkit = yield* toolkitEffect;

    const organized = yield* toolkit
      .handle("t3_thread_organize", { threadId: targetThreadId, action: "pin" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(organized.at(-1)?.result).toMatchObject({ sequence: 17 });

    const configured = yield* toolkit
      .handle("t3_thread_configure", {
        threadId: targetThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(configured.at(-1)?.result).toMatchObject({ sequence: 17 });

    const forked = yield* toolkit
      .handle("t3_thread_fork", {
        threadId: sourceThreadId,
        sourcePoint: { type: "latest_stable" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(forked.at(-1)?.result).toMatchObject({ sequence: 17 });

    const merged = yield* toolkit
      .handle("t3_thread_merge_back", {
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(merged.at(-1)?.result).toMatchObject({ sequence: 17, targetThreadId });

    expect(dispatched).toHaveLength(4);
    expect(dispatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thread.pin", threadId: targetThreadId }),
        expect.objectContaining({ type: "thread.fork", sourceThreadId }),
        expect.objectContaining({ type: "thread.merge_back", sourceThreadId, targetThreadId }),
      ]),
    );
  }),
);

it.effect("allows global provider search across projects while keeping project search local", () =>
  Effect.gen(function* () {
    const otherProjectId = ProjectId.make("mcp-thread-tools-other-project");
    const otherThreadId = ThreadId.make("mcp-thread-tools-other-thread");
    const matches: ReadonlyArray<ThreadSearch.ThreadSearchHit> = [
      {
        threadId: otherThreadId,
        projectId: otherProjectId,
        title: "Another project",
        source: "user",
        snippet: "needle in another project",
        messageCreatedAt: null,
      },
      {
        threadId: targetThreadId,
        projectId,
        title: "This project",
        source: "assistant",
        snippet: "needle in this project",
        messageCreatedAt: null,
      },
    ];
    const caller = {
      id: sourceThreadId,
      projectId,
      deletedAt: null,
    } as unknown as OrchestrationV2ThreadShell;
    const providerScope = (mcpToolScope: "global" | "project") =>
      ({
        environmentId,
        principal: {
          type: "provider-session" as const,
          threadId: sourceThreadId,
          providerSessionId: "mcp-thread-tools-provider-session",
          providerInstanceId,
        },
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "mcp-thread-tools-provider-session",
          providerInstanceId,
        },
        capabilities: new Set(["orchestration" as const]),
        mcpToolScope,
        issuedAt: 1,
      }) satisfies McpInvocationContext.McpInvocationScope;

    const global = makeToolkit(providerScope("global"), [], { matches, caller });
    const globalToolkit = yield* global.toolkit;
    const globalResult = yield* globalToolkit
      .handle("t3_thread_search", { query: "needle" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(global.dependencies));
    expect(globalResult.at(-1)?.result).toMatchObject({ matches });

    const project = makeToolkit(providerScope("project"), [], { matches, caller });
    const projectToolkit = yield* project.toolkit;
    const projectResult = yield* projectToolkit
      .handle("t3_thread_search", { query: "needle", limit: 1 })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(project.dependencies));
    expect(projectResult.at(-1)?.result).toMatchObject({ matches: [matches[1]] });
  }),
);

it.effect(
  "scopes run_scheduled_task_now by project while preserving global and management callers",
  () =>
    Effect.gen(function* () {
      const foreignProjectId = ProjectId.make("mcp-thread-tools-foreign-project");
      let runs = 0;
      const foreignTask = {
        id: "mcp-thread-tools-foreign-task",
        projectId: foreignProjectId,
        threadId: null,
        lastRunStatus: "never",
        runCount: 0,
        nextRunAt: null,
      } as unknown as ScheduledTask;
      const caller = {
        id: sourceThreadId,
        projectId,
        deletedAt: null,
        archivedAt: null,
        activeRunId: "run-active",
        providerInstanceId,
        runtimeMode: "full-access",
        interactionMode: "default",
      } as unknown as OrchestrationV2ThreadShell;
      const providerScope = (mcpToolScope: "global" | "project") =>
        ({
          environmentId,
          principal: {
            type: "provider-session" as const,
            threadId: sourceThreadId,
            providerSessionId: "mcp-thread-tools-provider-session",
            providerInstanceId,
          },
          thread: {
            threadId: sourceThreadId,
            providerSessionId: "mcp-thread-tools-provider-session",
            providerInstanceId,
          },
          capabilities: new Set(["orchestration" as const]),
          mcpToolScope,
          issuedAt: 1,
        }) satisfies McpInvocationContext.McpInvocationScope;
      const run = (invocation: McpInvocationContext.McpInvocationScope) => {
        const harness = makeToolkit(invocation, [], {
          caller,
          scheduledTasks: [foreignTask],
          onRunScheduledTask: () => runs++,
        });
        return Effect.gen(function* () {
          const toolkit = yield* harness.toolkit;
          return yield* toolkit
            .handle("run_scheduled_task_now", { taskId: foreignTask.id })
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(harness.dependencies));
        });
      };

      const denied = yield* run(providerScope("project"));
      expect(denied.at(-1)?.result).toMatchObject({ code: "invalid_request" });
      expect(runs).toBe(0);
      const global = yield* run(providerScope("global"));
      expect(global.at(-1)?.result).toMatchObject({ taskId: foreignTask.id });
      expect(runs).toBe(1);
      const management = yield* run(managementInvocation(["threads:message"]));
      expect(management.at(-1)?.result).toMatchObject({ taskId: foreignTask.id });
      expect(runs).toBe(2);
    }),
);
