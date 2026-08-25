import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  OrchestrationMessageRole,
  OrchestrationProposedPlan,
  OrchestrationThreadActivityTone,
} from "./orchestration.ts";

const THREAD_TOOL_LIST_LIMIT = 200;
const THREAD_TOOL_READ_TURN_LIMIT = 50;
const THREAD_TOOL_MAX_OUTPUT_CHARS = 20_000;
const THREAD_TOOL_MAX_WAIT_TARGETS = 8;
const THREAD_TOOL_MAX_WAIT_TIMEOUT_MS = 300_000;
const THREAD_TOOL_MAX_PROMPT_CHARS = 120_000;

const ThreadToolCursor = TrimmedNonEmptyString;
const ThreadToolText = Schema.String.check(
  Schema.isMaxLength(THREAD_TOOL_MAX_PROMPT_CHARS),
  Schema.makeFilter((value) => value.trim().length > 0 || "Text must not be blank."),
);
const ThreadToolOperation = Schema.Literals(["create", "list", "read", "send", "wait"]);

export const ThreadToolStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "attention",
  "completed",
]);
export type ThreadToolStatus = typeof ThreadToolStatus.Type;

export const ThreadToolAttentionReason = Schema.Literals([
  "approval",
  "user-input",
  "error",
  "interrupted",
]);
export type ThreadToolAttentionReason = typeof ThreadToolAttentionReason.Type;

const ThreadToolProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});

const ThreadToolProgress = Schema.Struct({
  step: TrimmedNonEmptyString,
  completedSteps: NonNegativeInt,
  totalSteps: NonNegativeInt,
});

export const ThreadToolSummary = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  status: ThreadToolStatus,
  attentionReason: Schema.optionalKey(ThreadToolAttentionReason),
  project: ThreadToolProject,
  modelSelection: ModelSelection,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  pinned: Schema.Boolean,
  settled: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  progress: Schema.optionalKey(ThreadToolProgress),
});
export type ThreadToolSummary = typeof ThreadToolSummary.Type;

const ThreadCreateToolEnvironment = Schema.Union([
  Schema.Struct({ type: Schema.Literal("local") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseBranch: Schema.optionalKey(TrimmedNonEmptyString),
    startFromOrigin: Schema.optionalKey(Schema.Boolean),
  }),
]);

const ThreadCreateToolTarget = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  environment: Schema.optionalKey(ThreadCreateToolEnvironment),
});

export const ThreadCreateToolInput = Schema.Struct({
  prompt: ThreadToolText,
  target: Schema.optionalKey(ThreadCreateToolTarget),
  title: Schema.optionalKey(TrimmedNonEmptyString),
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type ThreadCreateToolInput = typeof ThreadCreateToolInput.Type;

export const ThreadCreateToolResult = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  eventCursor: ThreadToolCursor,
  status: Schema.Literal("queued"),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadCreateToolResult = typeof ThreadCreateToolResult.Type;

export const ThreadListToolInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(THREAD_TOOL_LIST_LIMIT))),
});
export type ThreadListToolInput = typeof ThreadListToolInput.Type;

export const ThreadListToolResult = Schema.Struct({
  environmentId: EnvironmentId,
  threads: Schema.Array(ThreadToolSummary),
});
export type ThreadListToolResult = typeof ThreadListToolResult.Type;

export const ThreadReadToolInput = Schema.Struct({
  threadId: ThreadId,
  cursor: Schema.optionalKey(ThreadToolCursor),
  turnLimit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(THREAD_TOOL_READ_TURN_LIMIT)),
  ),
  includeOutputs: Schema.optionalKey(Schema.Boolean),
  maxOutputCharsPerItem: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(THREAD_TOOL_MAX_OUTPUT_CHARS)),
  ),
});
export type ThreadReadToolInput = typeof ThreadReadToolInput.Type;

const ThreadToolMessage = Schema.Struct({
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  truncated: Schema.optionalKey(Schema.Boolean),
});

const ThreadToolActivity = Schema.Struct({
  activityId: EventId,
  kind: TrimmedNonEmptyString,
  tone: OrchestrationThreadActivityTone,
  summary: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  output: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
});

export const ThreadReadToolResult = Schema.Struct({
  environmentId: EnvironmentId,
  thread: ThreadToolSummary,
  messages: Schema.Array(ThreadToolMessage),
  activities: Schema.Array(ThreadToolActivity),
  proposedPlans: Schema.Array(OrchestrationProposedPlan),
  olderCursor: Schema.NullOr(ThreadToolCursor),
  eventCursor: ThreadToolCursor,
});
export type ThreadReadToolResult = typeof ThreadReadToolResult.Type;

export const ThreadSendMessageToolInput = Schema.Struct({
  threadId: ThreadId,
  message: ThreadToolText,
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type ThreadSendMessageToolInput = typeof ThreadSendMessageToolInput.Type;

export const ThreadSendMessageToolResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  eventCursor: ThreadToolCursor,
  status: Schema.Literals(["queued", "running"]),
});
export type ThreadSendMessageToolResult = typeof ThreadSendMessageToolResult.Type;

const ThreadWaitToolTarget = Schema.Struct({
  threadId: ThreadId,
  afterCursor: Schema.optionalKey(ThreadToolCursor),
});

export const ThreadWaitToolInput = Schema.Struct({
  targets: Schema.Array(ThreadWaitToolTarget).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THREAD_TOOL_MAX_WAIT_TARGETS),
  ),
  timeoutMs: NonNegativeInt.check(Schema.isLessThanOrEqualTo(THREAD_TOOL_MAX_WAIT_TIMEOUT_MS)),
});
export type ThreadWaitToolInput = typeof ThreadWaitToolInput.Type;

const ThreadWaitToolTargetResult = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["completed", "attention"]),
  attentionReason: Schema.optionalKey(ThreadToolAttentionReason),
  eventCursor: ThreadToolCursor,
  latestAssistantMessage: Schema.optionalKey(Schema.String),
});

const ThreadWaitToolTargetState = Schema.Struct({
  threadId: ThreadId,
  status: ThreadToolStatus,
  eventCursor: ThreadToolCursor,
});

export const ThreadWaitToolResult = Schema.Struct({
  reason: Schema.Literals(["completed", "attention", "timeout", "caller-message"]),
  target: Schema.optionalKey(ThreadWaitToolTargetResult),
  targets: Schema.Array(ThreadWaitToolTargetState),
});
export type ThreadWaitToolResult = typeof ThreadWaitToolResult.Type;

export class ThreadToolNotFoundError extends Schema.TaggedErrorClass<ThreadToolNotFoundError>()(
  "ThreadToolNotFoundError",
  {
    operation: ThreadToolOperation,
    resource: Schema.Literals(["project", "thread"]),
    resourceId: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `The requested ${this.resource} was not found.`;
  }
}

export class ThreadToolInvalidInputError extends Schema.TaggedErrorClass<ThreadToolInvalidInputError>()(
  "ThreadToolInvalidInputError",
  {
    operation: ThreadToolOperation,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `The ${this.operation} input is invalid.`;
  }
}

export class ThreadToolInvalidTargetError extends Schema.TaggedErrorClass<ThreadToolInvalidTargetError>()(
  "ThreadToolInvalidTargetError",
  {
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return "The requested thread target is invalid.";
  }
}

export class ThreadToolSelfSendForbiddenError extends Schema.TaggedErrorClass<ThreadToolSelfSendForbiddenError>()(
  "ThreadToolSelfSendForbiddenError",
  {
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
  },
) {
  override get message(): string {
    return "A thread cannot send a message to itself.";
  }
}

export class ThreadToolOperationFailureError extends Schema.TaggedErrorClass<ThreadToolOperationFailureError>()(
  "ThreadToolOperationFailureError",
  {
    operation: ThreadToolOperation,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `The ${this.operation} operation failed: ${this.reason}`;
  }
}

export const ThreadToolError = Schema.Union([
  ThreadToolNotFoundError,
  ThreadToolInvalidInputError,
  ThreadToolInvalidTargetError,
  ThreadToolSelfSendForbiddenError,
  ThreadToolOperationFailureError,
]);
export type ThreadToolError = typeof ThreadToolError.Type;
