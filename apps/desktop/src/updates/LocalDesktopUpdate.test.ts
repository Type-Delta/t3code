import { describe, expect, it } from "vite-plus/test";

import {
  getDesktopLocalUpdateStateForStep,
  localDesktopBuildPowerShell,
  localDesktopUpdatePowerShell,
} from "./LocalDesktopUpdate.ts";

describe("local desktop update", () => {
  it("fetches and merges locally before the required checks and installer build", () => {
    expect(localDesktopUpdatePowerShell).toContain("git fetch $remote");
    expect(localDesktopUpdatePowerShell).toContain("git merge --no-edit $remoteHead");
    expect(localDesktopUpdatePowerShell).toContain("vp check");
    expect(localDesktopUpdatePowerShell).toContain("vp run typecheck");
    expect(localDesktopUpdatePowerShell).toContain("vp run update:local");
    expect(localDesktopUpdatePowerShell).toContain('Invoke-UpdateStep "fetch"');
    expect(localDesktopUpdatePowerShell).toContain('Invoke-UpdateStep "typecheck"');
    expect(localDesktopUpdatePowerShell).toContain("::t3-local-update::open-installer");
    expect(localDesktopUpdatePowerShell).not.toContain("Read-Host");
    expect(localDesktopUpdatePowerShell).not.toContain("git push");
  });

  it("parks uncommitted work in an exact temporary stash and restores it on every exit path", () => {
    const script = localDesktopUpdatePowerShell;
    const stashAt = script.indexOf("git stash push --include-untracked --message $StashMessage");
    const fetchAt = script.indexOf("git fetch $remote");
    const restoreAt = script.lastIndexOf("Restore-LocalChanges");
    expect(script).toContain("git stash apply --index $StashObject");
    expect(stashAt).toBeGreaterThan(-1);
    expect(stashAt).toBeLessThan(fetchAt);
    expect(restoreAt).toBeGreaterThan(script.indexOf("vp run update:local"));
    expect(script).toContain("if ($changes) { Save-LocalChanges }");
    expect(script).toContain("git rev-parse --verify --quiet refs/stash");
    expect(script).toContain("if ((Get-StashHead) -ne $StashObject)");
    expect(script).toContain("git rev-parse --verify --quiet MERGE_HEAD");
    expect(script.indexOf("git merge --abort")).toBeLessThan(restoreAt);
    expect(script).toContain("::t3-local-update-failed::");
    expect(script).not.toContain("git stash pop");
    expect(script).not.toContain("git reset --hard");
    expect(script).not.toContain("git clean");
    expect(script).not.toContain("uncommitted changes. Commit or stash");
  });

  it("reports milestone progress only after a real update step starts", () => {
    expect(getDesktopLocalUpdateStateForStep("fetch")).toMatchObject({
      status: "running",
      step: "fetch",
      progressPercent: 25,
    });
    expect(getDesktopLocalUpdateStateForStep("stash").progressPercent).toBeLessThan(25);
    expect(getDesktopLocalUpdateStateForStep("restore").progressPercent).toBeGreaterThan(92);
    expect(getDesktopLocalUpdateStateForStep("completed")).toMatchObject({
      status: "completed",
      step: "completed",
      progressPercent: 100,
    });
  });

  it("falls back to origin for forks that track their own remote", () => {
    expect(localDesktopUpdatePowerShell).toContain('$remotes -contains "upstream"');
    expect(localDesktopUpdatePowerShell).toContain('elseif ($remotes -contains "origin")');
    expect(localDesktopUpdatePowerShell).toContain("git remote set-head $remote --auto");
  });

  it("builds from the checkout as-is without touching Git history or the working tree", () => {
    expect(localDesktopBuildPowerShell).toContain("vp run update:local");
    expect(localDesktopBuildPowerShell).toContain("::t3-local-update::build");
    expect(localDesktopBuildPowerShell).not.toContain("git fetch");
    expect(localDesktopBuildPowerShell).not.toContain("git merge");
    expect(localDesktopBuildPowerShell).not.toContain("git stash");
  });
});
