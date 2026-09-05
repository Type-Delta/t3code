// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type VcsError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointRepositoryIdentity from "./CheckpointRepositoryIdentity.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const SidecarTestLayer = SidecarCheckpointRepository.layer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(
    CheckpointRepositoryIdentity.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ),
  Layer.provideMerge(SidecarTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

const makeSidecarRef = Effect.fn("CheckpointStore.test.makeSidecarRef")(function* (
  cwd: string,
  snapshotId: string,
) {
  const identityResolver = yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
  return SidecarCheckpointRepository.sidecarCheckpointRef(
    yield* identityResolver.resolve(cwd),
    snapshotId,
  );
});

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStore.layer", (it) => {
  describe("isGitRepository", () => {
    it.effect("returns false when no Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false);
      }),
    );

    it.effect("returns true when a Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true);
      }),
    );

    it.effect("returns true from a directory nested inside a Git repository", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const nested = NodePath.join(tmp, "apps", "server");
        yield* Effect.promise(() => NodeFSP.mkdir(nested, { recursive: true }));
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(nested)).toBe(true);
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("falls back from a missing sidecar locator to HEAD", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-sidecar-head-fallback-");
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const missingFrom = yield* makeSidecarRef(tmp, "missing-from");
        const toCheckpointRef = yield* makeSidecarRef(tmp, "captured-to");

        yield* writeTextFile(NodePath.join(tmp, "README.md"), "changed after HEAD\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef: missingFrom,
          toCheckpointRef,
          fallbackFromToHead: true,
          ignoreWhitespace: false,
        });

        expect(diff).toContain("README.md");
        expect(diff).toContain("+changed after HEAD");
        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef: missingFrom,
          toCheckpointRef,
          fallbackFromToHead: true,
          ignoreWhitespace: false,
          format: "numstat",
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: 1, deletions: 1 },
        ]);
      }),
    );

    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("keeps a/ and b/ patch prefixes when the repository disables them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.noprefix", "true"]);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-noprefix");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# changed\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = NodePath.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");

        for (const ignoreWhitespace of [false, true]) {
          const numstat = yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
            ignoreWhitespace,
            format: "numstat",
          });
          expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
            {
              path: "Component.tsx",
              additions: ignoreWhitespace ? 4 : 6,
              deletions: ignoreWhitespace ? 0 : 2,
            },
          ]);
        }
      }),
    );
  });

  describe("checkpoint file summaries", () => {
    it.effect("counts changes whose full patch exceeds the output limit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("large-checkpoint-summary");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const filePath = NodePath.join(tmp, "README.md");
        const lineCount = 20_000;
        yield* writeTextFile(filePath, `${"before".repeat(50)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(filePath, `${"after".repeat(60)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat",
        });

        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: lineCount, deletions: lineCount },
        ]);
        expect(numstat.length).toBeLessThan(100);
      }),
    );

    it.effect("preserves file paths and turn ranges without changing the user index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.renames", "copies"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-paths");
        const baseline = checkpointRefForThreadTurn(threadId, 0);
        const firstTurn = checkpointRefForThreadTurn(threadId, 1);
        const secondTurn = checkpointRefForThreadTurn(threadId, 2);
        const copiedText = Array.from({ length: 20 }, (_, index) => `copy line ${index}\n`).join(
          "",
        );
        const platform = yield* HostProcessPlatform;
        const renamedPath = platform === "win32" ? "renamed café.txt" : "renamed\tcafé\nname.txt";
        const addedPath = platform === "win32" ? "new café.txt" : "new\tfile\n名.txt";
        for (const [path, contents] of Object.entries({
          "copy-source.txt": copiedText,
          "deleted.txt": "delete me\n",
          "rename-old.txt": "before\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0before",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });

        yield* fileSystem.rename(
          NodePath.join(tmp, "rename-old.txt"),
          NodePath.join(tmp, renamedPath),
        );
        yield* fileSystem.remove(NodePath.join(tmp, "deleted.txt"));
        for (const [path, contents] of Object.entries({
          "copy-source.txt": `${copiedText}one more\n`,
          "copied.txt": copiedText,
          [renamedPath]: "after\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0after",
          "empty.txt": "",
          [addedPath]: "first\nsecond\n",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: firstTurn });
        const userIndex = yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"));
        const input = {
          cwd: tmp,
          fromCheckpointRef: baseline,
          toCheckpointRef: firstTurn,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };
        const firstSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints(input),
        );
        const expectedFiles = [
          { path: "binary.bin", additions: 0, deletions: 0 },
          { path: "copied.txt", additions: 0, deletions: 0 },
          { path: "copy-source.txt", additions: 1, deletions: 0 },
          { path: "deleted.txt", additions: 0, deletions: 1 },
          { path: "empty.txt", additions: 0, deletions: 0 },
          { path: addedPath, additions: 2, deletions: 0 },
          { path: renamedPath, additions: 1, deletions: 1 },
        ].toSorted((left, right) => left.path.localeCompare(right.path));
        expect(firstSummary).toEqual(expectedFiles);

        yield* fileSystem.remove(NodePath.join(tmp, "empty.txt"));
        yield* writeTextFile(NodePath.join(tmp, "copy-source.txt"), "replacement\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: secondTurn });
        const secondSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({
            ...input,
            fromCheckpointRef: firstTurn,
            toCheckpointRef: secondTurn,
          }),
        );
        expect(secondSummary).toEqual([
          { path: "copy-source.txt", additions: 1, deletions: 21 },
          { path: "empty.txt", additions: 0, deletions: 0 },
        ]);

        const inclusiveSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: secondTurn }),
        );
        expect(inclusiveSummary).toEqual(
          expectedFiles
            .filter((file) => file.path !== "empty.txt")
            .map((file) =>
              file.path === "copy-source.txt" ? { ...file, additions: 1, deletions: 20 } : file,
            ),
        );
        expect(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: baseline }),
        ).toBe("");
        expect(yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"))).toEqual(userIndex);
      }),
    );

    it.effect("uses HEAD for a missing baseline only when requested", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-fallback");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "changed\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });
        const input = {
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };

        const error = yield* Effect.flip(checkpointStore.diffCheckpoints(input));
        expect(error._tag).toBe("VcsProcessExitError");
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...input,
          fallbackFromToHead: true,
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: 1, deletions: 1 },
        ]);
      }),
    );
  });

  describe("sidecar checkpoints", () => {
    it.effect("captures and restores an unborn repository without creating project objects", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-sidecar-unborn-");
        yield* git(tmp, ["init"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointRef = yield* makeSidecarRef(tmp, "unborn-repository");
        const readme = NodePath.join(tmp, "README.md");
        const later = NodePath.join(tmp, "later.txt");
        yield* writeTextFile(readme, "unborn checkpoint\n");

        const refsBefore = yield* git(tmp, ["for-each-ref", "--format=%(refname) %(objectname)"]);
        const objectsBefore = yield* git(tmp, ["count-objects", "-v"]);
        const indexBefore = yield* git(tmp, ["diff", "--cached", "--name-only"]);
        const metadata = yield* checkpointStore.captureCheckpointWithMetadata({
          cwd: tmp,
          checkpointRef,
        });

        expect(metadata.commitOid).toMatch(/^[a-f0-9]{40,64}$/);
        expect(yield* git(tmp, ["rev-list", "--all"])).toBe("");
        expect(yield* git(tmp, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
          refsBefore,
        );
        expect(yield* git(tmp, ["count-objects", "-v"])).toBe(objectsBefore);
        expect(yield* git(tmp, ["diff", "--cached", "--name-only"])).toBe(indexBefore);

        yield* writeTextFile(readme, "later contents\n");
        yield* writeTextFile(later, "remove me\n");
        expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);
        expect((yield* fileSystem.readFileString(readme)).replaceAll("\r\n", "\n")).toBe(
          "unborn checkpoint\n",
        );
        expect(yield* fileSystem.exists(later)).toBe(false);
        expect(yield* git(tmp, ["rev-list", "--all"])).toBe("");
        expect(yield* git(tmp, ["count-objects", "-v"])).toBe(objectsBefore);
      }),
    );

    it.effect("captures a tracked gitlink without polluting either project object store", () =>
      Effect.gen(function* () {
        const root = yield* makeTmpDir("checkpoint-sidecar-gitlink-");
        const parent = NodePath.join(root, "parent");
        const submoduleSource = NodePath.join(root, "submodule-source");
        const submodule = NodePath.join(parent, "deps", "submodule");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(parent, { recursive: true });
        yield* fileSystem.makeDirectory(submoduleSource, { recursive: true });
        yield* initRepoWithCommit(parent);
        yield* initRepoWithCommit(submoduleSource);
        yield* git(parent, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          submoduleSource,
          "deps/submodule",
        ]);
        yield* git(parent, ["commit", "-m", "add tracked submodule"]);

        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const checkpointRef = yield* makeSidecarRef(parent, "tracked-gitlink");
        const parentRefsBefore = yield* git(parent, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ]);
        const parentObjectsBefore = yield* git(parent, ["count-objects", "-v"]);
        const submoduleRefsBefore = yield* git(submodule, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ]);
        const submoduleObjectsBefore = yield* git(submodule, ["count-objects", "-v"]);

        const metadata = yield* checkpointStore.captureCheckpointWithMetadata({
          cwd: parent,
          checkpointRef,
        });
        const config = yield* ServerConfig.ServerConfig;
        const identities = yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
        const identity = yield* identities.resolve(parent);
        const sidecarGitDir = NodePath.join(
          config.checkpointsDir,
          "repositories",
          `${identity.repositoryKey}.git`,
        );
        expect(
          yield* git(parent, [
            `--git-dir=${sidecarGitDir}`,
            "ls-tree",
            metadata.treeOid,
            "deps/submodule",
          ]),
        ).toMatch(/^160000 commit [a-f0-9]{40,64}\tdeps\/submodule$/u);

        yield* writeTextFile(NodePath.join(parent, "README.md"), "later parent\n");
        yield* writeTextFile(NodePath.join(submodule, "README.md"), "dirty submodule remains\n");
        expect(yield* checkpointStore.restoreCheckpoint({ cwd: parent, checkpointRef })).toBe(true);
        expect(
          (yield* fileSystem.readFileString(NodePath.join(parent, "README.md"))).replaceAll(
            "\r\n",
            "\n",
          ),
        ).toBe("# test\n");
        expect(
          (yield* fileSystem.readFileString(NodePath.join(submodule, "README.md"))).replaceAll(
            "\r\n",
            "\n",
          ),
        ).toBe("dirty submodule remains\n");
        expect(yield* git(parent, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
          parentRefsBefore,
        );
        expect(yield* git(parent, ["count-objects", "-v"])).toBe(parentObjectsBefore);
        expect(yield* git(submodule, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
          submoduleRefsBefore,
        );
        expect(yield* git(submodule, ["count-objects", "-v"])).toBe(submoduleObjectsBefore);
      }),
    );

    it.effect("serializes concurrent captures from linked worktrees within a bounded wait", () =>
      Effect.gen(function* () {
        const root = yield* makeTmpDir("checkpoint-sidecar-concurrent-worktrees-");
        const primary = NodePath.join(root, "primary");
        const linked = NodePath.join(root, "linked");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(primary, { recursive: true });
        yield* initRepoWithCommit(primary);
        yield* git(primary, ["worktree", "add", "-b", "linked-concurrent", linked]);
        const identities = yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
        const primaryIdentity = yield* identities.resolve(primary);
        const linkedIdentity = yield* identities.resolve(linked);
        const primaryRef = SidecarCheckpointRepository.sidecarCheckpointRef(
          primaryIdentity,
          "concurrent-primary",
        );
        const linkedRef = SidecarCheckpointRepository.sidecarCheckpointRef(
          linkedIdentity,
          "concurrent-linked",
        );
        yield* writeTextFile(NodePath.join(primary, "README.md"), "concurrent primary\n");
        yield* writeTextFile(NodePath.join(linked, "README.md"), "concurrent linked\n");
        const refsBefore = yield* git(primary, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ]);
        const objectsBefore = yield* git(primary, ["count-objects", "-v"]);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        yield* Effect.all(
          [
            checkpointStore.captureCheckpoint({ cwd: primary, checkpointRef: primaryRef }),
            checkpointStore.captureCheckpoint({ cwd: linked, checkpointRef: linkedRef }),
          ],
          { concurrency: 2 },
        ).pipe(Effect.timeout("20 seconds"));

        expect(
          yield* checkpointStore.hasCheckpointRef({ cwd: primary, checkpointRef: primaryRef }),
        ).toBe(true);
        expect(
          yield* checkpointStore.hasCheckpointRef({ cwd: linked, checkpointRef: linkedRef }),
        ).toBe(true);
        expect(yield* git(primary, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
          refsBefore,
        );
        expect(yield* git(primary, ["count-objects", "-v"])).toBe(objectsBefore);
      }),
    );

    it.effect(
      "captures and restores without creating project refs or changing the real index",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir("checkpoint-sidecar-test-");
          yield* initRepoWithCommit(tmp);
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const checkpointRef = yield* makeSidecarRef(tmp, "sidecar-capture-1");
          const readme = NodePath.join(tmp, "README.md");
          const ignored = NodePath.join(tmp, "preserve.tmp");
          const later = NodePath.join(tmp, "later.txt");

          yield* writeTextFile(NodePath.join(tmp, ".gitignore"), "*.tmp\n");
          yield* writeTextFile(readme, "checkpoint contents\n");
          const headBefore = yield* git(tmp, ["rev-parse", "HEAD"]);
          const indexBefore = yield* git(tmp, ["diff", "--cached", "--name-only"]);

          const metadata = yield* checkpointStore.captureCheckpointWithMetadata({
            cwd: tmp,
            checkpointRef,
          });
          expect(metadata).toMatchObject({
            repositoryKey: expect.stringMatching(/^[a-f0-9]{64}$/),
            worktreeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
            commitOid: expect.stringMatching(/^[a-f0-9]{40,64}$/),
            treeOid: expect.stringMatching(/^[a-f0-9]{40,64}$/),
          });
          expect(yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef })).toBe(true);
          expect(yield* git(tmp, ["rev-parse", "HEAD"])).toBe(headBefore);
          expect(yield* git(tmp, ["diff", "--cached", "--name-only"])).toBe(indexBefore);
          expect(yield* git(tmp, ["for-each-ref", "refs/t3/sidecar"])).toBe("");

          yield* writeTextFile(readme, "later contents\n");
          yield* writeTextFile(later, "remove me\n");
          yield* writeTextFile(ignored, "preserve me\n");
          expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);

          const fileSystem = yield* FileSystem.FileSystem;
          expect((yield* fileSystem.readFileString(readme)).replaceAll("\r\n", "\n")).toBe(
            "checkpoint contents\n",
          );
          expect(yield* fileSystem.exists(later)).toBe(false);
          expect(yield* fileSystem.readFileString(ignored)).toBe("preserve me\n");
        }),
    );

    it.effect("preserves the real index while restoring staged and binary workspace content", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-sidecar-index-");
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointRef = yield* makeSidecarRef(tmp, "index-preservation");
        const stagedPath = NodePath.join(tmp, "staged.txt");
        const binaryPath = NodePath.join(tmp, "binary.dat");

        yield* writeTextFile(stagedPath, "staged index contents\n");
        yield* git(tmp, ["add", "staged.txt"]);
        yield* writeTextFile(stagedPath, "checkpoint worktree contents\n");
        yield* fileSystem.writeFile(binaryPath, Uint8Array.from([0, 1, 2, 255, 13, 10]));
        const indexBefore = yield* git(tmp, ["show", ":staged.txt"]);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(stagedPath, "later worktree contents\n");
        yield* fileSystem.writeFile(binaryPath, Uint8Array.from([9, 8, 7]));
        expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);

        expect((yield* fileSystem.readFileString(stagedPath)).replaceAll("\r\n", "\n")).toBe(
          "checkpoint worktree contents\n",
        );
        expect(Array.from(yield* fileSystem.readFile(binaryPath))).toEqual([0, 1, 2, 255, 13, 10]);
        expect(yield* git(tmp, ["show", ":staged.txt"])).toBe(indexBefore);
      }),
    );

    it.effect("rejects a capture whose verification tree observes a workspace mutation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-sidecar-verification-");
        yield* initRepoWithCommit(tmp);
        const realProcess = yield* VcsProcess.VcsProcess;
        const checkpointRef = yield* makeSidecarRef(tmp, "verification-race");
        let mutated = false;
        const sidecars = yield* SidecarCheckpointRepository.make.pipe(
          Effect.provideService(
            VcsProcess.VcsProcess,
            VcsProcess.VcsProcess.of({
              run: (input) =>
                realProcess.run(input).pipe(
                  Effect.tap(() => {
                    if (
                      mutated ||
                      input.operation !== "SidecarCheckpointRepository.capture.writeTree.initial"
                    ) {
                      return Effect.void;
                    }
                    mutated = true;
                    return Effect.promise(() =>
                      NodeFSP.writeFile(
                        NodePath.join(tmp, "README.md"),
                        "changed during capture\n",
                      ),
                    );
                  }),
                ),
            }),
          ),
        );

        const result = yield* Effect.result(sidecars.capture({ cwd: tmp, checkpointRef }));
        expect(mutated).toBe(true);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            operation: "SidecarCheckpointRepository.capture",
            detail: "Checkpoint workspace changed during capture verification.",
          },
        });
        expect(yield* sidecars.has({ cwd: tmp, checkpointRef })).toBe(false);
      }),
    );

    it.effect("keeps sidecar gc out of an in-flight rescue-style capture", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-sidecar-capture-gc-");
        yield* initRepoWithCommit(tmp);
        const realProcess = yield* VcsProcess.VcsProcess;
        const checkpointRef = yield* makeSidecarRef(tmp, "capture-gc-lock");
        const capturePaused = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        const gcStarted = yield* Deferred.make<void>();
        const sidecars = yield* SidecarCheckpointRepository.make.pipe(
          Effect.provideService(
            VcsProcess.VcsProcess,
            VcsProcess.VcsProcess.of({
              run: (input) => {
                if (input.operation === "SidecarCheckpointRepository.gc") {
                  return Deferred.succeed(gcStarted, undefined).pipe(
                    Effect.andThen(realProcess.run(input)),
                  );
                }
                return realProcess
                  .run(input)
                  .pipe(
                    Effect.tap(() =>
                      input.operation === "SidecarCheckpointRepository.capture.writeTree.initial"
                        ? Deferred.succeed(capturePaused, undefined).pipe(
                            Effect.andThen(Deferred.await(releaseCapture)),
                          )
                        : Effect.void,
                    ),
                  );
              },
            }),
          ),
        );

        const captureFiber = yield* Effect.forkChild(sidecars.capture({ cwd: tmp, checkpointRef }));
        yield* Deferred.await(capturePaused);
        const gcFiber = yield* Effect.forkChild(sidecars.gc({ cwd: tmp }));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(gcStarted)).toBe(false);
        yield* Deferred.succeed(releaseCapture, undefined);
        yield* Fiber.join(captureFiber);
        yield* Deferred.await(gcStarted);
        yield* Fiber.interrupt(gcFiber);
      }),
    );

    it.effect("keeps sidecar gc out of an in-flight legacy import", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-sidecar-import-gc-");
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const realProcess = yield* VcsProcess.VcsProcess;
        const legacyCheckpointRef = checkpointRefForThreadTurn(
          ThreadId.make("legacy-import-gc-thread"),
          1,
        );
        const sidecarCheckpointRef = yield* makeSidecarRef(tmp, "legacy-import-gc-lock");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: legacyCheckpointRef });
        const importPaused = yield* Deferred.make<void>();
        const releaseImport = yield* Deferred.make<void>();
        const gcStarted = yield* Deferred.make<void>();
        const sidecars = yield* SidecarCheckpointRepository.make.pipe(
          Effect.provideService(
            VcsProcess.VcsProcess,
            VcsProcess.VcsProcess.of({
              run: (input) => {
                if (input.operation === "SidecarCheckpointRepository.gc") {
                  return Deferred.succeed(gcStarted, undefined).pipe(
                    Effect.andThen(realProcess.run(input)),
                  );
                }
                return realProcess
                  .run(input)
                  .pipe(
                    Effect.tap(() =>
                      input.operation === "SidecarCheckpointRepository.importLegacy.fetch"
                        ? Deferred.succeed(importPaused, undefined).pipe(
                            Effect.andThen(Deferred.await(releaseImport)),
                          )
                        : Effect.void,
                    ),
                  );
              },
            }),
          ),
        );

        const importFiber = yield* Effect.forkChild(
          sidecars.importLegacy({ cwd: tmp, legacyCheckpointRef, sidecarCheckpointRef }),
        );
        yield* Deferred.await(importPaused);
        const gcFiber = yield* Effect.forkChild(sidecars.gc({ cwd: tmp }));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(gcStarted)).toBe(false);
        yield* Deferred.succeed(releaseImport, undefined);
        yield* Fiber.join(importFiber);
        yield* Deferred.await(gcStarted);
        yield* Fiber.interrupt(gcFiber);
      }),
    );

    it.effect("produces equivalent diffs across legacy and sidecar locators", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-sidecar-mixed-diff-");
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("mixed-diff-thread");
        const legacyFrom = checkpointRefForThreadTurn(threadId, 0);
        const legacyTo = checkpointRefForThreadTurn(threadId, 1);
        const sidecarFrom = yield* makeSidecarRef(tmp, "mixed-from");
        const sidecarTo = yield* makeSidecarRef(tmp, "mixed-to");

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: legacyFrom });
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: sidecarFrom });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "mixed checkpoint contents\n");
        yield* writeTextFile(NodePath.join(tmp, "added.txt"), "added\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: legacyTo });
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: sidecarTo });

        const expected = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef: legacyFrom,
          toCheckpointRef: legacyTo,
          ignoreWhitespace: false,
        });
        expect(
          yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef: legacyFrom,
            toCheckpointRef: sidecarTo,
            ignoreWhitespace: false,
          }),
        ).toBe(expected);
        expect(
          yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef: sidecarFrom,
            toCheckpointRef: legacyTo,
            ignoreWhitespace: false,
          }),
        ).toBe(expected);

        // Mixed diff compatibility copies only the requested legacy objects
        // into the sidecar instead of consulting the project through an
        // alternate object database.
        const config = yield* ServerConfig.ServerConfig;
        const identities = yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
        const identity = yield* identities.resolve(tmp);
        const legacyCommit = yield* git(tmp, ["rev-parse", `${legacyFrom}^{commit}`]);
        const sidecarGitDir = NodePath.join(
          config.checkpointsDir,
          "repositories",
          `${identity.repositoryKey}.git`,
        );
        expect(
          yield* git(tmp, [
            `--git-dir=${sidecarGitDir}`,
            "rev-parse",
            "--verify",
            `${legacyCommit}^{commit}`,
          ]),
        ).toBe(legacyCommit);
      }),
    );

    it.effect("imports a known legacy ref idempotently and verifies its tree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-sidecar-import-");
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const legacyCheckpointRef = checkpointRefForThreadTurn(
          ThreadId.make("legacy-import-thread"),
          2,
        );
        const sidecarCheckpointRef = yield* makeSidecarRef(tmp, "legacy-import");
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "legacy imported contents\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: legacyCheckpointRef });

        const first = yield* sidecars.importLegacy({
          cwd: tmp,
          legacyCheckpointRef,
          sidecarCheckpointRef,
        });
        const second = yield* sidecars.importLegacy({
          cwd: tmp,
          legacyCheckpointRef,
          sidecarCheckpointRef,
        });
        expect(first.alreadyImported).toBe(false);
        expect(second).toMatchObject({
          alreadyImported: true,
          commitOid: first.commitOid,
          treeOid: first.treeOid,
        });
        expect(
          yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef: legacyCheckpointRef,
            toCheckpointRef: sidecarCheckpointRef,
            ignoreWhitespace: false,
          }),
        ).toBe("");
      }),
    );

    it.effect(
      "binds locators to one linked worktree without polluting the shared project store",
      () =>
        Effect.gen(function* () {
          const root = yield* makeTmpDir("checkpoint-sidecar-worktrees-");
          const primary = NodePath.join(root, "primary repo");
          const linked = NodePath.join(root, "linked worktree");
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.makeDirectory(primary, { recursive: true });
          yield* initRepoWithCommit(primary);
          yield* git(primary, ["worktree", "add", "-b", "linked-test", linked]);
          const identities =
            yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
          const primaryIdentity = yield* identities.resolve(primary);
          const linkedIdentity = yield* identities.resolve(linked);
          expect(primaryIdentity.commonDir).toBe(linkedIdentity.commonDir);
          expect(primaryIdentity.repositoryKey).toBe(linkedIdentity.repositoryKey);
          expect(primaryIdentity.worktreeKey).not.toBe(linkedIdentity.worktreeKey);

          const refsBefore = yield* git(primary, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
          ]);
          const objectsBefore = yield* git(primary, ["count-objects", "-v"]);
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const primaryRef = SidecarCheckpointRepository.sidecarCheckpointRef(
            primaryIdentity,
            "same-snapshot-id",
          );
          const linkedRef = SidecarCheckpointRepository.sidecarCheckpointRef(
            linkedIdentity,
            "same-snapshot-id",
          );
          yield* writeTextFile(NodePath.join(primary, "README.md"), "primary checkpoint\n");
          yield* writeTextFile(NodePath.join(linked, "README.md"), "linked checkpoint\n");
          yield* checkpointStore.captureCheckpoint({ cwd: primary, checkpointRef: primaryRef });
          yield* checkpointStore.captureCheckpoint({ cwd: linked, checkpointRef: linkedRef });

          const ownershipError = yield* checkpointStore
            .hasCheckpointRef({ cwd: linked, checkpointRef: primaryRef })
            .pipe(Effect.flip);
          expect(ownershipError).toMatchObject({
            operation: "SidecarCheckpointRepository.has",
            detail: "Sidecar checkpoint locator does not belong to this repository worktree.",
          });

          yield* writeTextFile(NodePath.join(primary, "README.md"), "later primary\n");
          yield* writeTextFile(NodePath.join(linked, "README.md"), "later linked\n");
          yield* checkpointStore.restoreCheckpoint({ cwd: primary, checkpointRef: primaryRef });
          yield* checkpointStore.restoreCheckpoint({ cwd: linked, checkpointRef: linkedRef });
          expect(
            (yield* fileSystem.readFileString(NodePath.join(primary, "README.md"))).replaceAll(
              "\r\n",
              "\n",
            ),
          ).toBe("primary checkpoint\n");
          expect(
            (yield* fileSystem.readFileString(NodePath.join(linked, "README.md"))).replaceAll(
              "\r\n",
              "\n",
            ),
          ).toBe("linked checkpoint\n");
          expect(yield* git(primary, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
            refsBefore,
          );
          expect(yield* git(primary, ["count-objects", "-v"])).toBe(objectsBefore);
        }),
    );

    it.effect("rejects an escaping symlink before deleting current workspace files", () =>
      Effect.gen(function* () {
        const root = yield* makeTmpDir("checkpoint-sidecar-symlink-");
        const workspace = NodePath.join(root, "workspace");
        const outside = NodePath.join(root, "outside.txt");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(workspace, { recursive: true });
        yield* initRepoWithCommit(workspace);
        yield* writeTextFile(outside, "outside remains\n");
        const symlinkSupported = yield* fileSystem
          .symlink("../outside.txt", NodePath.join(workspace, "escape-link"))
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        if (!symlinkSupported) return;
        yield* git(workspace, ["config", "core.symlinks", "true"]);

        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const checkpointRef = yield* makeSidecarRef(workspace, "escaping-symlink");
        yield* checkpointStore.captureCheckpoint({ cwd: workspace, checkpointRef });
        yield* fileSystem.remove(NodePath.join(workspace, "escape-link"), { force: true });
        yield* writeTextFile(NodePath.join(workspace, "README.md"), "must remain later\n");
        yield* writeTextFile(NodePath.join(workspace, "later.txt"), "must not be deleted\n");

        const restoreError = yield* checkpointStore
          .restoreCheckpoint({ cwd: workspace, checkpointRef })
          .pipe(Effect.flip);
        expect(restoreError).toMatchObject({
          operation: "SidecarCheckpointRepository.validatePrepared",
          detail: "Checkpoint symbolic link escapes its worktree.",
        });
        expect(yield* fileSystem.readFileString(NodePath.join(workspace, "README.md"))).toBe(
          "must remain later\n",
        );
        expect(yield* fileSystem.readFileString(NodePath.join(workspace, "later.txt"))).toBe(
          "must not be deleted\n",
        );
        expect(yield* fileSystem.readFileString(outside)).toBe("outside remains\n");
      }),
    );

    it.effect("restores 120000 entries as plain files when core.symlinks is false", () =>
      Effect.gen(function* () {
        const root = yield* makeTmpDir("checkpoint-sidecar-symlink-false-");
        const workspace = NodePath.join(root, "workspace");
        const outside = NodePath.join(root, "outside.txt");
        const linkPath = NodePath.join(workspace, "portable-link");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(workspace, { recursive: true });
        yield* initRepoWithCommit(workspace);
        yield* git(workspace, ["config", "core.symlinks", "false"]);
        yield* writeTextFile(outside, "outside remains\n");
        yield* writeTextFile(linkPath, "../outside.txt");

        // Build a legacy tree with a real Git symlink entry without requiring
        // the host process to have symlink creation privileges.
        const blob = yield* git(workspace, ["hash-object", "-w", "--", "portable-link"]);
        yield* git(workspace, [
          "update-index",
          "--add",
          "--cacheinfo",
          `120000,${blob},portable-link`,
        ]);
        const tree = yield* git(workspace, ["write-tree"]);
        const commit = yield* git(workspace, ["commit-tree", tree, "-m", "portable symlink"]);
        const legacyCheckpointRef = checkpointRefForThreadTurn(
          ThreadId.make("portable-symlink-thread"),
          1,
        );
        yield* git(workspace, ["update-ref", String(legacyCheckpointRef), commit]);

        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const sidecarCheckpointRef = yield* makeSidecarRef(workspace, "portable-symlink");
        yield* sidecars.importLegacy({
          cwd: workspace,
          legacyCheckpointRef,
          sidecarCheckpointRef,
        });
        yield* writeTextFile(linkPath, "later contents\n");

        expect(
          yield* sidecars.restore({ cwd: workspace, checkpointRef: sidecarCheckpointRef }),
        ).toBe(true);
        expect((yield* Effect.promise(() => NodeFSP.lstat(linkPath))).isSymbolicLink()).toBe(false);
        expect(yield* fileSystem.readFileString(linkPath)).toBe("../outside.txt");
        expect(yield* fileSystem.readFileString(outside)).toBe("outside remains\n");
      }),
    );

    it.effect("keeps sidecar commits invisible to project refs and mirror clones", () =>
      Effect.gen(function* () {
        const root = yield* makeTmpDir("checkpoint-sidecar-mirror-");
        const workspace = NodePath.join(root, "workspace");
        const mirror = NodePath.join(root, "project-mirror.git");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(workspace, { recursive: true });
        yield* initRepoWithCommit(workspace);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const checkpointRef = yield* makeSidecarRef(workspace, "mirror-invisible");
        yield* writeTextFile(NodePath.join(workspace, "private.txt"), "sidecar only\n");
        yield* checkpointStore.captureCheckpoint({ cwd: workspace, checkpointRef });

        const config = yield* ServerConfig.ServerConfig;
        const identities = yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
        const identity = yield* identities.resolve(workspace);
        const sidecarGitDir = NodePath.join(
          config.checkpointsDir,
          "repositories",
          `${identity.repositoryKey}.git`,
        );
        const sidecarRefs = yield* git(workspace, [
          `--git-dir=${sidecarGitDir}`,
          "for-each-ref",
          "--format=%(objectname)",
          "refs/t3/s",
        ]);
        expect(sidecarRefs).toMatch(/^[a-f0-9]{40,64}$/);
        expect(yield* git(workspace, [`--git-dir=${sidecarGitDir}`, "remote"])).toBe("");

        yield* git(root, ["clone", "--mirror", workspace, mirror]);
        expect(yield* git(root, [`--git-dir=${mirror}`, "for-each-ref", "refs/t3"])).toBe("");
        expect(
          yield* git(root, [`--git-dir=${mirror}`, "rev-list", "--objects", "--all"]),
        ).not.toContain(sidecarRefs);
      }),
    );
  });
});
