import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadCreateToolInput,
  ThreadCreateToolResult,
  ThreadListModelsToolInput,
  ThreadListModelsToolResult,
  ThreadListToolInput,
  ThreadReadToolInput,
  ThreadReadToolResult,
  ThreadSendMessageToolInput,
  ThreadToolError,
  ThreadWaitToolInput,
  ThreadWaitToolResult,
} from "./threadTools.ts";

const decodeCreateInput = Schema.decodeUnknownSync(ThreadCreateToolInput);
const decodeCreateResult = Schema.decodeUnknownSync(ThreadCreateToolResult);
const decodeListInput = Schema.decodeUnknownSync(ThreadListToolInput);
const decodeListModelsInput = Schema.decodeUnknownSync(ThreadListModelsToolInput);
const decodeListModelsResult = Schema.decodeUnknownSync(ThreadListModelsToolResult);
const decodeReadInput = Schema.decodeUnknownSync(ThreadReadToolInput);
const decodeReadResult = Schema.decodeUnknownSync(ThreadReadToolResult);
const decodeSendInput = Schema.decodeUnknownSync(ThreadSendMessageToolInput);
const decodeWaitInput = Schema.decodeUnknownSync(ThreadWaitToolInput);
const decodeWaitResult = Schema.decodeUnknownSync(ThreadWaitToolResult);
const decodeError = Schema.decodeUnknownSync(ThreadToolError);

const modelSelection = { instanceId: "codex", model: "gpt-5.6-sol" } as const;

const thread = {
  threadId: "thread-1",
  title: "Investigate failure",
  status: "running",
  project: {
    projectId: "project-1",
    title: "T3 Code",
    workspaceRoot: "C:/workspace/t3code",
  },
  modelSelection,
  branch: "agent/fix",
  worktreePath: "C:/workspace/t3code-worktree",
  pinned: false,
  settled: false,
  snoozedUntil: null,
  updatedAt: "2026-08-24T12:00:00.000Z",
  progress: { step: "Run focused tests", completedSteps: 1, totalSteps: 3 },
} as const;

describe("thread tool inputs", () => {
  it("decodes create targets and model selections", () => {
    const input = decodeCreateInput({
      prompt: "Investigate the failing test.",
      target: {
        projectId: "project-1",
        environment: { type: "worktree", baseBranch: "main", startFromOrigin: true },
      },
      title: "Fix the test",
      modelSelection,
    });

    expect(input.target?.environment).toEqual({
      type: "worktree",
      baseBranch: "main",
      startFromOrigin: true,
    });
    expect(input.modelSelection).toEqual(modelSelection);
  });

  it("keeps handler-owned list and read defaults undefined", () => {
    expect(decodeListInput({})).not.toHaveProperty("limit");
    expect(decodeReadInput({ threadId: "thread-1" })).not.toHaveProperty("turnLimit");
    expect(decodeReadInput({ threadId: "thread-1" })).not.toHaveProperty("includeOutputs");
    expect(decodeReadInput({ threadId: "thread-1" })).not.toHaveProperty("maxOutputCharsPerItem");
  });

  it("accepts an absent, built-in, or custom driver filter", () => {
    expect(decodeListModelsInput({})).not.toHaveProperty("driver");
    expect(decodeListModelsInput({ driver: "codex" }).driver).toBe("codex");
    expect(decodeListModelsInput({ driver: "ollama_remote" }).driver).toBe("ollama_remote");
  });

  it("rejects malformed driver filters", () => {
    expect(() => decodeListModelsInput({ driver: "open code" })).toThrow();
    expect(() => decodeListModelsInput({ driver: "1codex" })).toThrow();
    expect(() => decodeListModelsInput({ driver: "codex/remote" })).toThrow();
  });

  it("rejects blank prompts and bounded list or read inputs", () => {
    expect(() => decodeCreateInput({ prompt: " \n " })).toThrow();
    expect(() => decodeListInput({ limit: 201 })).toThrow();
    expect(() => decodeReadInput({ threadId: "thread-1", turnLimit: 51 })).toThrow();
    expect(() =>
      decodeReadInput({ threadId: "thread-1", maxOutputCharsPerItem: 20_001 }),
    ).toThrow();
  });

  it("preserves a nonblank message and optional model selection", () => {
    const input = decodeSendInput({
      threadId: "thread-1",
      message: "  Please run the focused test.  ",
      modelSelection,
    });

    expect(input.message).toBe("  Please run the focused test.  ");
    expect(input.modelSelection).toEqual(modelSelection);
  });

  it("allows an immediate wait and caps the target set and timeout", () => {
    const immediate = decodeWaitInput({
      targets: [{ threadId: "thread-1", afterCursor: " event-7 " }],
      timeoutMs: 0,
    });

    expect(immediate.targets[0]?.afterCursor).toBe("event-7");
    expect(() => decodeWaitInput({ targets: [], timeoutMs: 0 })).toThrow();
    expect(() =>
      decodeWaitInput({
        targets: Array.from({ length: 9 }, (_, index) => ({ threadId: `thread-${index}` })),
        timeoutMs: 0,
      }),
    ).toThrow();
    expect(() =>
      decodeWaitInput({ targets: [{ threadId: "thread-1" }], timeoutMs: 300_001 }),
    ).toThrow();
  });
});

describe("thread tool results", () => {
  it("groups complete model catalogs by provider instance", () => {
    const result = decodeListModelsResult({
      environmentId: "environment-1",
      providers: [
        {
          instanceId: "codex_personal",
          driver: "codex",
          displayName: "Personal Codex",
          models: [
            {
              slug: "gpt-5.3-codex",
              name: "GPT-5.3 Codex",
              description: "Previous-generation coding model",
              shortName: "5.3",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
              metadata: {
                contextWindowTokens: 200000,
                maxOutputTokens: 100000,
                source: "codex-app-server",
              },
            },
          ],
        },
        {
          instanceId: "codex_work",
          driver: "codex",
          displayName: "Work Codex",
          models: [
            {
              slug: "company-codex",
              name: "Company Codex",
              subProvider: "internal-gateway",
              isCustom: true,
              isDefault: true,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning effort",
                    type: "select",
                    options: [
                      {
                        id: "high",
                        label: "High",
                        description: "Use more reasoning",
                        isDefault: true,
                      },
                    ],
                    currentValue: "high",
                    promptInjectedValues: ["high"],
                  },
                ],
              },
              metadata: {
                contextWindowTokens: 400000,
                maxContextWindowTokens: 500000,
                maxOutputTokens: 120000,
                source: "custom-config",
              },
            },
          ],
        },
      ],
    });

    expect(result.providers.map(({ instanceId, driver }) => ({ instanceId, driver }))).toEqual([
      { instanceId: "codex_personal", driver: "codex" },
      { instanceId: "codex_work", driver: "codex" },
    ]);
    expect(result.providers[0]?.models[0]).toMatchObject({
      slug: "gpt-5.3-codex",
      isCustom: false,
      isLegacy: true,
      metadata: { source: "codex-app-server" },
    });
    expect(result.providers[1]?.models[0]).toMatchObject({
      slug: "company-codex",
      subProvider: "internal-gateway",
      isCustom: true,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            currentValue: "high",
            promptInjectedValues: ["high"],
          },
        ],
      },
      metadata: {
        contextWindowTokens: 400000,
        maxContextWindowTokens: 500000,
        maxOutputTokens: 120000,
        source: "custom-config",
      },
    });
  });

  it("keeps identifiers and cursors in a create result", () => {
    expect(
      decodeCreateResult({
        environmentId: "environment-1",
        projectId: "project-1",
        threadId: "thread-1",
        eventCursor: "event-1",
        status: "queued",
        branch: null,
        worktreePath: null,
      }),
    ).toMatchObject({ environmentId: "environment-1", threadId: "thread-1", status: "queued" });
  });

  it("decodes paginated reads with optional activity output truncation", () => {
    const result = decodeReadResult({
      environmentId: "environment-1",
      thread,
      messages: [
        {
          messageId: "message-1",
          role: "assistant",
          text: "The focused test passes.",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-24T12:00:01.000Z",
          truncated: true,
        },
      ],
      activities: [
        {
          activityId: "event-1",
          kind: "command.output",
          tone: "tool",
          summary: "Ran the focused test",
          turnId: "turn-1",
          createdAt: "2026-08-24T12:00:02.000Z",
          output: "pass\n",
          truncated: true,
        },
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: "turn-1",
          planMarkdown: "1. Run the test",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-08-24T12:00:00.000Z",
          updatedAt: "2026-08-24T12:00:00.000Z",
        },
      ],
      olderCursor: null,
      eventCursor: "event-2",
    });

    expect(result.thread.progress).toEqual({
      step: "Run focused tests",
      completedSteps: 1,
      totalSteps: 3,
    });
    expect(result.activities[0]?.truncated).toBe(true);
    expect(result.olderCursor).toBeNull();
  });

  it("returns wait outcomes with a matching terminal target", () => {
    const result = decodeWaitResult({
      reason: "attention",
      target: {
        threadId: "thread-1",
        status: "attention",
        attentionReason: "approval",
        eventCursor: "event-3",
        latestAssistantMessage: "Need approval to continue.",
      },
      targets: [
        { threadId: "thread-1", status: "attention", eventCursor: "event-3" },
        { threadId: "thread-2", status: "running", eventCursor: "event-2" },
      ],
    });

    expect(result.target?.attentionReason).toBe("approval");
    expect(result.targets[1]?.status).toBe("running");
  });
});

describe("thread tool errors", () => {
  it("decodes each stable failure tag", () => {
    expect(
      decodeError({
        _tag: "ThreadToolNotFoundError",
        operation: "read",
        resource: "thread",
        resourceId: "thread-404",
      }).message,
    ).toBe("The requested thread was not found.");
    expect(
      decodeError({
        _tag: "ThreadToolInvalidInputError",
        operation: "send",
        reason: "message is blank",
      })._tag,
    ).toBe("ThreadToolInvalidInputError");
    expect(
      decodeError({
        _tag: "ThreadToolInvalidTargetError",
        reason: "worktree target requires a repository",
      })._tag,
    ).toBe("ThreadToolInvalidTargetError");
    expect(
      decodeError({
        _tag: "ThreadToolSelfSendForbiddenError",
        sourceThreadId: "thread-1",
        targetThreadId: "thread-1",
      }).message,
    ).toBe("A thread cannot send a message to itself.");
    expect(
      decodeError({
        _tag: "ThreadToolOperationFailureError",
        operation: "wait",
        reason: "subscription ended",
      }).message,
    ).toBe("The wait operation failed: subscription ended");
  });
});
