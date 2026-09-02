import {
  ThreadCreateToolInput,
  ThreadCreateToolResult,
  ThreadListModelsToolInput,
  ThreadListModelsToolResult,
  ThreadListToolInput,
  ThreadListToolResult,
  ThreadReadToolInput,
  ThreadReadToolResult,
  ThreadSendMessageToolInput,
  ThreadSendMessageToolResult,
  ThreadToolError,
  ThreadWaitToolInput,
  ThreadWaitToolResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ThreadCommandDispatcher from "../../../orchestration/ThreadCommandDispatcher.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  Crypto.Crypto,
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ThreadCommandDispatcher.ThreadCommandDispatcher,
  OrchestrationEngine.OrchestrationEngineService,
  GitWorkflowService.GitWorkflowService,
];

export const CreateThreadTool = Tool.make("create_thread", {
  description:
    "Create a thread in this environment, send its first user message, and optionally start it in a new worktree.",
  parameters: ThreadCreateToolInput,
  success: ThreadCreateToolResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ListThreadsTool = Tool.make("list_threads", {
  description:
    "List active threads in this environment. Pinned threads appear first, then the most recent user activity.",
  parameters: ThreadListToolInput,
  success: ThreadListToolResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ListModelsTool = Tool.make("list_models", {
  description:
    "List models accepted by the currently enabled and ready provider instances, optionally filtered by driver.",
  parameters: ThreadListModelsToolInput,
  success: ThreadListModelsToolResult,
  failure: ThreadToolError,
  dependencies: [McpInvocationContext.McpInvocationContext, ProviderRegistry.ProviderRegistry],
})
  .annotate(Tool.Title, "List models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ReadThreadTool = Tool.make("read_thread", {
  description:
    "Read one active thread. Use cursor to page backward through its turn history. Outputs stay hidden unless includeOutputs is true.",
  parameters: ThreadReadToolInput,
  success: ThreadReadToolResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SendMessageToThreadTool = Tool.make("send_message_to_thread", {
  description:
    "Send a user message to another active thread in this environment. A supplied modelSelection updates that thread before the turn starts.",
  parameters: ThreadSendMessageToolInput,
  success: ThreadSendMessageToolResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send message to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WaitThreadsTool = Tool.make("wait_threads", {
  description:
    "Wait for up to eight threads to complete or need attention. Returns immediately when timeoutMs is zero or a new user message reaches this calling thread.",
  parameters: ThreadWaitToolInput,
  success: ThreadWaitToolResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadToolkit = Toolkit.make(
  CreateThreadTool,
  ListModelsTool,
  ListThreadsTool,
  ReadThreadTool,
  SendMessageToThreadTool,
  WaitThreadsTool,
);
