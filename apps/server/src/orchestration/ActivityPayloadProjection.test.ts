import {
  EventId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.js";

function makeSubagentActivity(data: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: EventId.make("subagent-activity"),
    tone: "tool",
    kind: "tool.started",
    summary: "Subagent task",
    payload: {
      itemType: "collab_agent_tool_call",
      data,
    },
    turnId: null,
    createdAt: "2026-08-04T00:00:00.000Z",
  };
}

describe("projectActivityPayload", () => {
  it("preserves Codex subagent model and reasoning effort", () => {
    const projected = projectActivityPayload(
      makeSubagentActivity({
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          prompt: "Review the change",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          receiverThreadIds: ["child-thread-1"],
          status: "inProgress",
          ignored: "large provider field",
        },
      }),
    );

    expect(projected.payload).toMatchObject({
      data: {
        item: {
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
    });
    expect(JSON.stringify(projected.payload)).not.toContain("large provider field");
  });

  it("projects Codex v2 subagent activity into the shared subagent shape", () => {
    const projected = projectActivityPayload({
      ...makeSubagentActivity({
        item: {
          type: "subAgentActivity",
          id: "spawn-1",
          kind: "started",
          agentThreadId: "child-thread-1",
          agentPath: "/root/reviewer",
        },
      }),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        data: {
          item: {
            type: "subAgentActivity",
            id: "spawn-1",
            kind: "started",
            agentThreadId: "child-thread-1",
            agentPath: "/root/reviewer",
          },
        },
      },
    });

    expect(projected.payload).toMatchObject({
      data: {
        item: {
          type: "subAgentActivity",
          tool: "spawnAgent",
          kind: "started",
          agentThreadId: "child-thread-1",
          agentPath: "/root/reviewer",
          receiverThreadIds: ["child-thread-1"],
          status: "inProgress",
        },
      },
    });
  });

  it("projects a Codex subagent interaction as a message rather than a spawn", () => {
    const projected = projectActivityPayload(
      makeSubagentActivity({
        item: {
          type: "subAgentActivity",
          kind: "interacted",
          agentThreadId: "parent-thread-1",
          agentPath: "/root",
        },
      }),
    );

    expect(projected.payload).toMatchObject({
      data: {
        item: {
          type: "subAgentActivity",
          tool: "sendInput",
          kind: "interacted",
          agentThreadId: "parent-thread-1",
        },
      },
    });
  });

  it("preserves Claude Task model and effort metadata", () => {
    const projected = projectActivityPayload(
      makeSubagentActivity({
        toolName: "Task",
        input: {
          prompt: "Review the change",
          model: "sonnet",
          effort: "max",
          ignored: "large provider field",
        },
      }),
    );

    expect(projected.payload).toMatchObject({
      data: {
        input: {
          model: "sonnet",
          effort: "max",
        },
      },
    });
    expect(JSON.stringify(projected.payload)).not.toContain("large provider field");
  });
});

function makeActivity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-1"),
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      makeActivity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );

    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      makeActivity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps preview normalization and fence-only fallback while scanning lines", () => {
    const preview = projectActivityPayload(
      makeActivity({
        itemType: "command_execution",
        data: { rawOutput: `\`\`\`\n  actual\tresult  \n${"x".repeat(5000)}` },
      }),
    );
    const fences = projectActivityPayload(
      makeActivity({
        itemType: "command_execution",
        data: { rawOutput: "```\r\n \t \n```\n" },
      }),
    );

    expect((preview.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "actual result",
    });
    expect((fences.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "2 lines",
    });
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      makeActivity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      makeActivity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude command input and result summaries", () => {
    const claude = projectActivityPayload(
      makeActivity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: {
            type: "tool_result",
            content: [
              { type: "text", text: "tests passed" },
              { type: "text", text: "x".repeat(5_000) },
            ],
          },
        },
      }),
    );
    const openCode = projectActivityPayload(
      makeActivity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: {
        toolName: "Bash",
        command: "vp test run",
        rawOutput: { content: "tests passed" },
      },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(250);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("keeps full Claude Read image paths through repeated projection", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const projected = projectActivityPayload(
      makeActivity({
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        data: {
          toolName: "Read",
          input: { file_path: imagePath },
          result: { content: "Image Size: 1280x720." },
        },
      }),
    );
    const projectedAgain = projectActivityPayload(projected);

    expect(projected.payload).toMatchObject({ data: { imagePath } });
    expect(projectedAgain.payload).toMatchObject({ data: { imagePath } });

    const textRead = projectActivityPayload(
      makeActivity({
        itemType: "dynamic_tool_call",
        data: { toolName: "Read", input: { file_path: "/workspace/src/index.ts" } },
      }),
    );
    expect(textRead.payload).not.toMatchObject({ data: { imagePath: expect.anything() } });
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      makeActivity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );

    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data", () => {
    const projected = projectActivityPayload(
      makeActivity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );

    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("passes task lifecycle payloads through untouched", () => {
    const source = makeActivity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });

    expect(projectActivityPayload(source).payload).toEqual(source.payload);
  });

  it("matches superseded tool updates by their composite lifecycle key", () => {
    const turnId = TurnId.make("turn-1");
    const activity = (id: string, kind: "tool.updated" | "tool.completed") => ({
      ...makeActivity({ itemType: "command_execution", title: "Run tests" }),
      id: EventId.make(id),
      kind,
      turnId,
    });
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 1,
      thread: {
        activities: [activity("update", "tool.updated"), activity("complete", "tool.completed")],
      },
    } as unknown as OrchestrationThreadDetailSnapshot);

    expect(projected.thread.activities.map(({ id }) => id)).toEqual(["complete"]);
  });
});
