import { describe, expect, it } from "vite-plus/test";

import type { SubagentRunSummary } from "../../session-logic";
import { composerSubagentLabel, composerSubagentStatus } from "./composerSubagentUtils";

const run = (id: string, status: SubagentRunSummary["status"]): SubagentRunSummary => ({
  id,
  title: id,
  prompt: "",
  status,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
});

describe("composer subagent controls", () => {
  it("summarizes active and failed runs ahead of completed runs", () => {
    expect(composerSubagentStatus([run("done", "completed")])).toBe("completed");
    expect(composerSubagentStatus([run("done", "completed"), run("active", "inProgress")])).toBe(
      "working",
    );
    expect(composerSubagentStatus([run("active", "inProgress"), run("failed", "failed")])).toBe(
      "failed",
    );
  });

  it("contracts the count label for a compact composer strip", () => {
    expect(composerSubagentLabel(3)).toBe("3 Subagents");
    expect(composerSubagentLabel(3, true)).toBe("3 Sub");
  });
});
