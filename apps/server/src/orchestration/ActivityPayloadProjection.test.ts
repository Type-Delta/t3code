import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectActivityPayload } from "./ActivityPayloadProjection.js";

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
