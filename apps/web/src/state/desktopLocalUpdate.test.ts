import type { DesktopLocalUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatDesktopLocalUpdateProgress } from "./desktopLocalUpdate";

function stateForStep(
  step: DesktopLocalUpdateState["step"],
  progressPercent: number,
): DesktopLocalUpdateState {
  return { status: "running", step, progressPercent, message: null };
}

describe("formatDesktopLocalUpdateProgress", () => {
  it("falls back to Starting when there is no state yet", () => {
    expect(formatDesktopLocalUpdateProgress(null)).toBe("Starting");
  });

  it("renders the percent and a human label for each step", () => {
    expect(formatDesktopLocalUpdateProgress(stateForStep("merge", 40))).toBe(
      "40% — Merging changes",
    );
    expect(formatDesktopLocalUpdateProgress(stateForStep("build", 85))).toBe(
      "85% — Building installer",
    );
    expect(formatDesktopLocalUpdateProgress(stateForStep("completed", 100))).toBe(
      "100% — Completed",
    );
    expect(formatDesktopLocalUpdateProgress(stateForStep("up-to-date", 100))).toBe(
      "100% — Already up to date",
    );
  });
});
