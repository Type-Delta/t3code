import type { SubagentRunSummary } from "../../session-logic";

export function composerSubagentStatus(runs: ReadonlyArray<SubagentRunSummary>) {
  const failed = runs.some((run) => run.status === "failed");
  const working = runs.some((run) => run.status === "inProgress");
  return failed ? "failed" : working ? "working" : "completed";
}

export function composerSubagentLabel(count: number, compact = false): string {
  return `${count} ${compact ? "Sub" : "Subagents"}`;
}
