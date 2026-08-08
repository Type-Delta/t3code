import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";

import { AgentsPanel } from "./AgentsPanel";
import { subagentPanelIsWorking, subagentPanelStatusLabel } from "./chat/SubagentPanel";
import {
  deriveSubagentTranscriptIds,
  findSubagentInPanelModel,
  resolveSubagentPanelRun,
} from "../session-logic";

const model: AgentPanelModel = {
  workflows: [],
  directAgents: [
    {
      id: "child-thread-1",
      kind: "subagent",
      title: "Reviewer",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      status: "completed",
      activationCount: 1,
      usage: null,
      progress: null,
      lastToolName: null,
      result: "Reviewed the change",
      error: null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: null,
      phases: [],
      runHandles: null,
      recentActivity: [],
      firstSeenAt: "2026-08-08T00:00:00.000Z",
      startedAt: "2026-08-08T00:00:00.000Z",
      completedAt: "2026-08-08T00:01:00.000Z",
      updatedAt: "2026-08-08T00:01:00.000Z",
    },
  ],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 1,
  totalTokens: 0,
  hasAgents: true,
  liveCount: 0,
};

describe("AgentsPanel", () => {
  it("uses native agent metadata for a transcript-backed surface", () => {
    const nativeAgent = findSubagentInPanelModel(model, "child-thread-1");
    const run = resolveSubagentPanelRun({
      runId: "child-thread-1",
      surfaceTitle: "Subagent",
      nativeAgent: nativeAgent ? { ...nativeAgent, status: "idle" } : undefined,
      threadCreatedAt: "2026-08-08T00:00:00.000Z",
      threadUpdatedAt: "2026-08-08T00:01:00.000Z",
    });

    expect(run).toMatchObject({ title: "Reviewer", status: "idle", prompt: "" });
    expect(subagentPanelStatusLabel(run.status)).toBe("Idle");
    expect(subagentPanelIsWorking(run.status)).toBe(false);
    expect(subagentPanelIsWorking("running")).toBe(true);
  });

  it("exposes the authoritative agent row as a transcript action", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={model}
        onOpenTranscript={() => undefined}
        transcriptAgentIds={deriveSubagentTranscriptIds([{ subagentId: "child-thread-1" }], [])}
      />,
    );

    expect(markup).toContain('aria-label="Open transcript for Reviewer"');
    expect(markup).not.toContain("disabled");
  });

  it("keeps workflow members without persisted transcripts noninteractive", () => {
    const baseAgent = model.directAgents[0]!;
    const workflowModel: AgentPanelModel = {
      ...model,
      workflows: [
        {
          workflow: {
            ...baseAgent,
            id: "workflow-1",
            kind: "workflow",
            title: "Review workflow",
            status: "running",
            completedAt: null,
          },
          phases: [],
          unphasedMembers: [
            {
              ...baseAgent,
              id: "workflow-child-1",
              kind: "workflow_agent",
              title: "Workflow reviewer",
              status: "running",
              parentAgentId: "workflow-1",
              completedAt: null,
            },
          ],
        },
      ],
      directAgents: [],
      runningCount: 2,
      settledCount: 0,
      liveCount: 2,
    };
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={workflowModel}
        onOpenTranscript={() => undefined}
        transcriptAgentIds={deriveSubagentTranscriptIds([], [])}
      />,
    );

    expect(markup).toContain("Workflow reviewer");
    expect(markup).not.toContain('aria-label="Open transcript for Workflow reviewer"');
  });
});
