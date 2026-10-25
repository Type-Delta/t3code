import {
  GitRunStackedActionResult,
  GitResolvePullRequestResult,
  VcsStatusLocalResult,
} from "./git.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  VcsCreateWorktreeInput,
  VcsListWorktreesInput,
  VcsListWorktreesResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeListWorktreesResult = Schema.decodeUnknownSync(VcsListWorktreesResult);
const decodeListWorktreesInput = Schema.decodeUnknownSync(VcsListWorktreesInput);
const decodeVcsStatusLocalResult = Schema.decodeUnknownSync(VcsStatusLocalResult);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });
});

describe("VcsListWorktreesResult", () => {
  it("accepts an explicit snapshot refresh", () => {
    expect(decodeListWorktreesInput({ cwd: "/repo", refresh: true }).refresh).toBe(true);
  });

  it("decodes primary, branched, and detached worktrees", () => {
    const parsed = decodeListWorktreesResult({
      isRepo: true,
      worktrees: [
        { path: "/repo", head: "0123456789abcdef", branch: "main", isPrimary: true },
        {
          path: "/repo/worktrees/feature",
          head: "123456789abcdef0",
          branch: "feature/worktree",
          isPrimary: false,
        },
        {
          path: "/repo/worktrees/detached",
          head: "abcdef0123456789",
          branch: null,
          isPrimary: false,
        },
      ],
    });

    expect(parsed.worktrees[2]?.branch).toBeNull();
    expect(parsed.worktrees[2]?.head).toBe("abcdef0123456789");
    expect(parsed.worktrees[0]?.isPrimary).toBe(true);
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});
