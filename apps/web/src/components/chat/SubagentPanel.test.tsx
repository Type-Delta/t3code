import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import type { SubagentPanelRunSummary } from "../../session-logic";
import { SubagentPanel } from "./SubagentPanel";

const captured = vi.hoisted(() => ({
  liveFollowEnabled: [] as boolean[],
  timelineEntries: [] as ReadonlyArray<unknown>[],
}));

vi.mock("./MessagesTimeline", () => ({
  MessagesTimeline: (props: {
    liveFollowEnabled: boolean;
    timelineEntries: ReadonlyArray<unknown>;
  }) => {
    captured.liveFollowEnabled.push(props.liveFollowEnabled);
    captured.timelineEntries.push(props.timelineEntries);
    return null;
  },
}));

const run: SubagentPanelRunSummary = {
  id: "child-1",
  title: "Reviewer",
  prompt: "Review it",
  status: "running",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:01:00.000Z",
};

function render(
  status: SubagentPanelRunSummary["status"],
  activities: ReadonlyArray<OrchestrationThreadActivity> = [],
): void {
  renderToStaticMarkup(
    <SubagentPanel
      run={{ ...run, status }}
      messages={[]}
      activities={activities}
      environmentId={EnvironmentId.make("environment-1")}
      routeThreadKey="thread-1"
      markdownCwd={undefined}
      workspaceRoot={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      onOpenSubagent={() => undefined}
    />,
  );
}

describe("SubagentPanel", () => {
  beforeEach(() => {
    captured.liveFollowEnabled.length = 0;
    captured.timelineEntries.length = 0;
  });

  it("follows live output only while the child is working", () => {
    render("running");
    render("idle");

    expect(captured.liveFollowEnabled).toEqual([true, false]);
  });

  it("renders native tool activity attributed to the child agent", () => {
    render("running", [
      {
        id: EventId.make("tool-1"),
        createdAt: "2026-08-08T00:00:30.000Z",
        tone: "tool",
        kind: "tool.completed",
        summary: "Read file",
        payload: { itemType: "dynamic_tool_call", agentId: "child-1" },
        turnId: null,
      },
    ]);

    expect(captured.timelineEntries[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "work",
          entry: expect.objectContaining({ label: "Read file" }),
        }),
      ]),
    );
  });
});
