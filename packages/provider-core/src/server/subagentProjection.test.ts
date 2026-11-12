import { describe, expect, it } from "vite-plus/test";

import * as DateTime from "effect/DateTime";
import { RunId } from "@t3tools/contracts";

import { delegatedTaskCurrentRun, subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});

describe("delegatedTaskCurrentRun", () => {
  const completed = {
    ordinal: 1,
    status: "completed" as const,
    startedAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
  };
  it.each<{
    name: string;
    runs: Parameters<typeof delegatedTaskCurrentRun>[0];
    expected: number;
  }>([
    {
      name: "executing work before a newer completed run",
      runs: [
        { ...completed, status: "running" as const },
        { ...completed, ordinal: 2 },
      ],
      expected: 1,
    },
    {
      name: "eligible queued work before a newer completed run",
      runs: [
        { ...completed, status: "queued" as const, startedAt: null },
        { ...completed, ordinal: 2 },
      ],
      expected: 1,
    },
    {
      name: "latest executed result after a held follow-up",
      runs: [
        completed,
        { ...completed, ordinal: 2, status: "queued" as const, queueHeld: true, startedAt: null },
      ],
      expected: 1,
    },
    {
      name: "latest executed result after an unstarted cancelled follow-up",
      runs: [
        completed,
        { ...completed, ordinal: 2, status: "cancelled" as const, startedAt: null },
      ],
      expected: 1,
    },
    {
      name: "a failed restart continuation that never accepted its prompt",
      runs: [
        completed,
        {
          ...completed,
          ordinal: 2,
          status: "failed" as const,
          startedAt: null,
          restartContinuationOfRunId: RunId.make("run-original"),
        },
      ],
      expected: 2,
    },
  ])("reports $name", ({ runs, expected }) => {
    expect(delegatedTaskCurrentRun(runs)?.ordinal).toBe(expected);
  });
});
