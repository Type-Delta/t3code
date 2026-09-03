import { describe, expect, it } from "vite-plus/test";

import { localDesktopUpdatePowerShell } from "./LocalDesktopUpdate.ts";

describe("local desktop update", () => {
  it("fetches and merges locally before the required checks and installer build", () => {
    expect(localDesktopUpdatePowerShell).toContain("git fetch $remote");
    expect(localDesktopUpdatePowerShell).toContain("git merge --no-edit $remoteHead");
    expect(localDesktopUpdatePowerShell).toContain("vp check");
    expect(localDesktopUpdatePowerShell).toContain("vp run typecheck");
    expect(localDesktopUpdatePowerShell).toContain("vp run update:local");
    expect(localDesktopUpdatePowerShell).not.toContain("git push");
  });

  it("falls back to origin for forks that track their own remote", () => {
    expect(localDesktopUpdatePowerShell).toContain('$remotes -contains "upstream"');
    expect(localDesktopUpdatePowerShell).toContain('elseif ($remotes -contains "origin")');
    expect(localDesktopUpdatePowerShell).toContain("git remote set-head $remote --auto");
  });
});
