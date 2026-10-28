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
    requestNamespace: "management:mcp-thread-tools-management",
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
      .handle("t3_thread_configure", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(missingTarget.at(-1)?.result).toMatchObject({ code: "target_required" });

    const configuration = yield* toolkit
      .handle("t3_thread_configure", { threadId: targetThreadId })
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
      .handle("t3_thread_transfer", {
        action: "fork",
        threadId: sourceThreadId,
        sourcePoint: { type: "latest_stable" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(forked.at(-1)?.result).toMatchObject({ sequence: 17 });

    const merged = yield* toolkit
      .handle("t3_thread_transfer", {
        action: "merge_back",
        threadId: sourceThreadId,
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

it.effect("searches a provider's explicitly selected project", () =>
  Effect.gen(function* () {
    const otherProject = ProjectId.make("project:other");
    const match: ThreadSearch.ThreadSearchHit = {
      threadId: targetThreadId,
      projectId: otherProject,
      title: "Other project",
      source: "user",
      snippet: "needle",
      messageCreatedAt: null,
    };
    const invocation = {
      environmentId,
      requestNamespace: "session",
      thread: { threadId: sourceThreadId, providerSessionId: "session", providerInstanceId },
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 1,
    } satisfies McpInvocationContext.McpInvocationScope;
    const { toolkit: toolkitEffect, dependencies } = makeToolkit(invocation, [], {
      matches: [match],
    });
    const toolkit = yield* toolkitEffect;
    const result = yield* toolkit
      .handle("t3_thread_search", { query: "needle", projectId: otherProject })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ matches: [match] });
  }),
);
