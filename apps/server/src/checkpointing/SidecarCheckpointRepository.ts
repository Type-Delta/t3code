/**
 * Private, bare-Git backing store for `t3-sidecar:v1:` checkpoint locators.
 *
 * This module intentionally never asks project Git to resolve a sidecar ref
 * and never places an index, ref, object, or reflog below a worktree's `.git`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { CheckpointRef, VcsProcessExitError, type VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointRepositoryIdentity from "./CheckpointRepositoryIdentity.ts";

export const SIDECAR_CHECKPOINT_REF_PREFIX = "t3-sidecar:v1:";

const IDENTITY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export interface SidecarCheckpointLocator {
  readonly repositoryKey: string;
  readonly worktreeKey: string;
  readonly snapshotId: string;
}

export interface SidecarCaptureInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface SidecarCaptureMetadata {
  readonly commitOid: string;
  readonly treeOid: string;
  readonly repositoryKey: string;
  readonly worktreeKey: string;
}

export interface SidecarRestoreInput extends SidecarCaptureInput {
  readonly fallbackToHead?: boolean;
}

export interface SidecarDiffInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
}

export interface SidecarImportLegacyInput {
  readonly cwd: string;
  readonly legacyCheckpointRef: CheckpointRef;
  readonly sidecarCheckpointRef: CheckpointRef;
}

export interface SidecarImportLegacyResult {
  readonly checkpointRef: CheckpointRef;
  readonly commitOid: string;
  readonly treeOid: string;
  readonly alreadyImported: boolean;
}

/** Construct the opaque locator persisted by checkpoint projections. */
export const sidecarCheckpointRef = (
  identity: Pick<
    CheckpointRepositoryIdentity.CheckpointRepositoryIdentity,
    "repositoryKey" | "worktreeKey"
  >,
  snapshotId: string,
): CheckpointRef => {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error("Invalid sidecar checkpoint snapshot id.");
  }
  return CheckpointRef.make(
    `${SIDECAR_CHECKPOINT_REF_PREFIX}${identity.repositoryKey}.${identity.worktreeKey}.${snapshotId}`,
  );
};

/** Resolve an ownership-bound locator for a workspace. */
export const sidecarCheckpointRefForWorkspace = Effect.fn(
  "SidecarCheckpointRepository.sidecarCheckpointRefForWorkspace",
)(function* (cwd: string, snapshotId: string) {
  const identities = yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
  return sidecarCheckpointRef(yield* identities.resolve(cwd), snapshotId);
});

/** A locator parser kept at the storage boundary; callers keep it opaque. */
const parseSidecarCheckpointRef = (
  checkpointRef: CheckpointRef,
): SidecarCheckpointLocator | undefined => {
  const value = String(checkpointRef);
  if (!value.startsWith(SIDECAR_CHECKPOINT_REF_PREFIX)) return undefined;
  const payload = value.slice(SIDECAR_CHECKPOINT_REF_PREFIX.length);
  const firstSeparator = payload.indexOf(".");
  const secondSeparator = payload.indexOf(".", firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) return undefined;
  const repositoryKey = payload.slice(0, firstSeparator);
  const worktreeKey = payload.slice(firstSeparator + 1, secondSeparator);
  const snapshotId = payload.slice(secondSeparator + 1);
  return IDENTITY_KEY_PATTERN.test(repositoryKey) &&
    IDENTITY_KEY_PATTERN.test(worktreeKey) &&
    SNAPSHOT_ID_PATTERN.test(snapshotId)
    ? { repositoryKey, worktreeKey, snapshotId }
    : undefined;
};

export const isSidecarCheckpointRef = (checkpointRef: CheckpointRef): boolean =>
  String(checkpointRef).startsWith(SIDECAR_CHECKPOINT_REF_PREFIX);

/** Narrow storage-boundary discriminator used by CheckpointStore. */
export const sidecarSnapshotId = (checkpointRef: CheckpointRef): string | undefined =>
  parseSidecarCheckpointRef(checkpointRef)?.snapshotId;

const sidecarRef = (locator: SidecarCheckpointLocator) =>
  `refs/t3/s/${NodeCrypto.createHash("sha256")
    .update(`${locator.worktreeKey}\0${locator.snapshotId}`)
    .digest("hex")}`;
const CHECKPOINT_PATHS_MAX_BYTES = 64 * 1024 * 1024;

export class SidecarCheckpointRepository extends Context.Service<
  SidecarCheckpointRepository,
  {
    readonly allocate: (input: {
      readonly cwd: string;
      readonly snapshotId: string;
    }) => Effect.Effect<CheckpointRef, VcsError>;
    readonly capture: (
      input: SidecarCaptureInput,
    ) => Effect.Effect<void, VcsError | PlatformError.PlatformError>;
    readonly captureWithMetadata: (
      input: SidecarCaptureInput,
    ) => Effect.Effect<SidecarCaptureMetadata, VcsError | PlatformError.PlatformError>;
    readonly has: (
      input: SidecarCaptureInput,
    ) => Effect.Effect<boolean, VcsError | PlatformError.PlatformError>;
    readonly restore: (
      input: SidecarRestoreInput,
    ) => Effect.Effect<boolean, VcsError | PlatformError.PlatformError>;
    readonly diff: (
      input: SidecarDiffInput,
    ) => Effect.Effect<string, VcsError | PlatformError.PlatformError>;
    readonly importLegacy: (
      input: SidecarImportLegacyInput,
    ) => Effect.Effect<SidecarImportLegacyResult, VcsError | PlatformError.PlatformError>;
    readonly delete: (input: {
      readonly cwd: string;
      readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
    }) => Effect.Effect<void, VcsError | PlatformError.PlatformError>;
    /** Run maintenance only in T3's private bare repository. */
    readonly gc: (input: {
      readonly cwd: string;
    }) => Effect.Effect<boolean, VcsError | PlatformError.PlatformError>;
  }
>()("t3/checkpointing/SidecarCheckpointRepository") {}

const checkpointError = (operation: string, cwd: string, detail: string) =>
  new VcsProcessExitError({ operation, command: "git", cwd, exitCode: 1, detail });

const locatorForIdentity = (
  operation: string,
  cwd: string,
  checkpointRef: CheckpointRef,
  identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity,
) => {
  const locator = parseSidecarCheckpointRef(checkpointRef);
  if (!locator) {
    return Effect.fail(checkpointError(operation, cwd, "Invalid sidecar checkpoint locator."));
  }
  if (
    locator.repositoryKey !== identity.repositoryKey ||
    locator.worktreeKey !== identity.worktreeKey
  ) {
    return Effect.fail(
      checkpointError(
        operation,
        cwd,
        "Sidecar checkpoint locator does not belong to this repository worktree.",
      ),
    );
  }
  return Effect.succeed(locator);
};

const relativePathIsSafe = (relativePath: string) =>
  relativePath.length > 0 &&
  !relativePath.includes("\\") &&
  !relativePath.startsWith("/") &&
  !relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const identities = yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver;
  const repositoryLocks = new Map<string, Semaphore.Semaphore>();

  /**
   * `git gc --prune=now` is not safe while another process is creating
   * unreachable objects. Keep writers and maintenance mutually exclusive per
   * sidecar repository without serializing independent repository families.
   */
  const withRepositoryLock = <A, E, R>(
    repositoryKey: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    let lock = repositoryLocks.get(repositoryKey);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      repositoryLocks.set(repositoryKey, lock);
    }
    return lock.withPermits(1)(effect);
  };

  const git = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly maxOutputBytes?: number;
    },
  ) =>
    process.run({
      operation,
      command: "git",
      args,
      cwd,
      spawnCwd: globalThis.process.cwd(),
      env: options?.env ?? CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
      ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options?.allowNonZeroExit === undefined
        ? {}
        : { allowNonZeroExit: options.allowNonZeroExit }),
      timeoutMs: 30_000,
      maxOutputBytes: options?.maxOutputBytes ?? 16 * 1024 * 1024,
    });

  const sidecarGitArgs = (gitDir: string, worktree: string, args: ReadonlyArray<string>) => [
    `--git-dir=${gitDir}`,
    `--work-tree=${worktree}`,
    ...args,
  ];

  const repositoryDirectory = (repositoryKey: string) =>
    path.join(config.checkpointsDir, "repositories", `${repositoryKey}.git`);

  const restrictPermissions = (target: string) =>
    fileSystem.chmod(target, 0o700).pipe(Effect.orElseSucceed(() => undefined));

  const removeTemporaryPath = (temporaryPath: string, cwd: string) =>
    fileSystem.remove(temporaryPath, { recursive: true, force: true }).pipe(
      Effect.mapError(() =>
        checkpointError(
          "SidecarCheckpointRepository.cleanup",
          cwd,
          "Failed to remove checkpoint temporary data.",
        ),
      ),
      Effect.ignore,
    );

  const ensureRepository = Effect.fn("SidecarCheckpointRepository.ensureRepository")(function* (
    cwd: string,
    identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity,
  ) {
    const gitDir = repositoryDirectory(identity.repositoryKey);
    const exists = yield* fileSystem.exists(gitDir);
    if (!exists) {
      yield* fileSystem
        .makeDirectory(path.dirname(gitDir), { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError(() =>
            checkpointError(
              "SidecarCheckpointRepository.createDirectory",
              cwd,
              "Unable to create sidecar repository directory.",
            ),
          ),
        );
      yield* git("SidecarCheckpointRepository.init", cwd, [
        "init",
        "--bare",
        `--object-format=${identity.objectFormat}`,
        gitDir,
      ]);
    }
    yield* restrictPermissions(config.checkpointsDir);
    yield* restrictPermissions(path.dirname(gitDir));
    yield* restrictPermissions(gitDir);

    // A bare repository has no remotes unless configured explicitly. Remove
    // any remote if a stale/corrupt state directory is encountered.
    const remotes = yield* git(
      "SidecarCheckpointRepository.listRemotes",
      cwd,
      sidecarGitArgs(gitDir, identity.worktreeRoot, ["remote"]),
    );
    yield* Effect.forEach(
      remotes.stdout
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean),
      (remote) =>
        git(
          "SidecarCheckpointRepository.removeRemote",
          cwd,
          sidecarGitArgs(gitDir, identity.worktreeRoot, ["remote", "remove", remote]),
        ),
      { discard: true },
    );

    // Only worktree interpretation is copied. The project config itself is
    // never copied, so credentials, hooks, filters, remotes and signing stay
    // outside this repository.
    for (const key of [
      "core.fileMode",
      "core.symlinks",
      "core.ignoreCase",
      "core.precomposeUnicode",
    ]) {
      const source = yield* git(
        "SidecarCheckpointRepository.readWorktreeConfig",
        cwd,
        ["-C", identity.worktreeRoot, "config", "--get", key],
        { allowNonZeroExit: true, maxOutputBytes: 4_096 },
      );
      if (source.exitCode === 0 && source.stdout.trim()) {
        yield* git("SidecarCheckpointRepository.writeWorktreeConfig", cwd, [
          ...sidecarGitArgs(gitDir, identity.worktreeRoot, [
            "config",
            "--local",
            key,
            source.stdout.trim(),
          ]),
        ]);
      }
    }
    return gitDir;
  });

  const resolveCommit = (
    cwd: string,
    gitDir: string,
    worktree: string,
    locator: SidecarCheckpointLocator,
  ) =>
    git(
      "SidecarCheckpointRepository.resolveCommit",
      cwd,
      sidecarGitArgs(gitDir, worktree, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${sidecarRef(locator)}^{commit}`,
      ]),
      { allowNonZeroExit: true, maxOutputBytes: 4_096 },
    ).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? result.stdout.trim() || undefined : undefined,
      ),
    );

  interface SnapshotEntry {
    readonly mode: string;
    readonly type: string;
    readonly relativePath: string;
  }

  const snapshotEntries = (cwd: string, gitDir: string, worktree: string, commit: string) =>
    git(
      "SidecarCheckpointRepository.snapshotEntries",
      cwd,
      sidecarGitArgs(gitDir, worktree, ["ls-tree", "-rz", commit]),
      { maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES },
    ).pipe(
      Effect.flatMap((result) => {
        const entries: Array<SnapshotEntry> = [];
        for (const record of result.stdout.split("\0").filter(Boolean)) {
          const tab = record.indexOf("\t");
          const header = tab < 0 ? [] : record.slice(0, tab).split(" ");
          const relativePath = tab < 0 ? "" : record.slice(tab + 1);
          const [mode, type] = header;
          if (
            !mode ||
            !type ||
            !["blob", "commit"].includes(type) ||
            !relativePathIsSafe(relativePath)
          ) {
            return Effect.fail(
              checkpointError(
                "SidecarCheckpointRepository.snapshotEntries",
                cwd,
                "Checkpoint contains an unsafe or unsupported tree entry.",
              ),
            );
          }
          entries.push({ mode, type, relativePath });
        }
        return Effect.succeed(entries);
      }),
    );

  const workspacePaths = (cwd: string, worktree: string) =>
    git(
      "SidecarCheckpointRepository.workspacePaths",
      cwd,
      ["-C", worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES },
    ).pipe(
      Effect.map((result) => result.stdout.split("\0").filter(Boolean)),
      Effect.flatMap((paths) =>
        paths.every(relativePathIsSafe)
          ? Effect.succeed(paths)
          : Effect.fail(
              checkpointError(
                "SidecarCheckpointRepository.workspacePaths",
                cwd,
                "Git returned an unsafe workspace path.",
              ),
            ),
      ),
    );

  const validateWorkspacePath = (worktree: string, relativePath: string) => {
    const absolutePath = path.resolve(worktree, relativePath);
    const relative = path.relative(worktree, absolutePath);
    return relativePathIsSafe(relative.replaceAll("\\", "/")) && !path.isAbsolute(relative)
      ? Effect.succeed(absolutePath)
      : Effect.fail(
          checkpointError(
            "SidecarCheckpointRepository.validatePath",
            worktree,
            "Checkpoint path escapes its worktree.",
          ),
        );
  };

  const lstat = (operation: string, cwd: string, target: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.lstat(target),
      catch: () => checkpointError(operation, cwd, "Unable to inspect a checkpoint path."),
    });

  const pathExistsWithoutFollowing = (target: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await NodeFSP.lstat(target);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error);
        }
      },
      catch: () =>
        checkpointError(
          "SidecarCheckpointRepository.pathExists",
          target,
          "Unable to inspect a checkpoint path.",
        ),
    });

  const validateExistingAncestors = Effect.fn(
    "SidecarCheckpointRepository.validateExistingAncestors",
  )(function* (cwd: string, worktree: string, relativePaths: ReadonlyArray<string>) {
    const inspected = new Set<string>();
    for (const relativePath of relativePaths) {
      const segments = relativePath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const ancestor = path.join(worktree, ...segments.slice(0, index));
        if (inspected.has(ancestor)) continue;
        inspected.add(ancestor);
        if (!(yield* pathExistsWithoutFollowing(ancestor))) continue;
        const info = yield* lstat("SidecarCheckpointRepository.validateAncestors", cwd, ancestor);
        if (info.isSymbolicLink()) {
          return yield* checkpointError(
            "SidecarCheckpointRepository.validateAncestors",
            cwd,
            "Checkpoint path has a symbolic-link ancestor.",
          );
        }
      }
    }
  });

  const isWithin = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };

  const validatePreparedEntries = Effect.fn("SidecarCheckpointRepository.validatePreparedEntries")(
    function* (cwd: string, preparedRoot: string, entries: ReadonlyArray<SnapshotEntry>) {
      for (const entry of entries) {
        if (entry.type === "commit") continue;
        const preparedPath = path.resolve(preparedRoot, entry.relativePath);
        if (!isWithin(preparedRoot, preparedPath)) {
          return yield* checkpointError(
            "SidecarCheckpointRepository.validatePrepared",
            cwd,
            "Prepared checkpoint path escapes its temporary root.",
          );
        }
        const info = yield* lstat(
          "SidecarCheckpointRepository.validatePrepared",
          cwd,
          preparedPath,
        );
        if (!info.isSymbolicLink()) continue;
        const target = yield* fileSystem.readLink(preparedPath);
        const resolvedTarget = path.resolve(path.dirname(preparedPath), target);
        if (path.isAbsolute(target) || !isWithin(preparedRoot, resolvedTarget)) {
          return yield* checkpointError(
            "SidecarCheckpointRepository.validatePrepared",
            cwd,
            "Checkpoint symbolic link escapes its worktree.",
          );
        }
      }
    },
  );

  const capture: SidecarCheckpointRepository["Service"]["capture"] = Effect.fn(
    "SidecarCheckpointRepository.capture",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    return yield* withRepositoryLock(
      identity.repositoryKey,
      Effect.gen(function* () {
        const locator = yield* locatorForIdentity(
          "SidecarCheckpointRepository.capture",
          input.cwd,
          input.checkpointRef,
          identity,
        );
        const gitDir = yield* ensureRepository(input.cwd, identity);
        if (yield* resolveCommit(input.cwd, gitDir, identity.worktreeRoot, locator)) return;

        const temporaryDir = path.join(config.checkpointsDir, "tmp", NodeCrypto.randomUUID());
        const indexPath = path.join(temporaryDir, "index");
        const verificationIndexPath = path.join(temporaryDir, "verification-index");
        const pathsFile = path.join(temporaryDir, "paths.z");
        const verificationPathsFile = path.join(temporaryDir, "verification-paths.z");
        const baseEnvironment = {
          ...CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
          GIT_AUTHOR_NAME: "T3 Code",
          GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
          GIT_COMMITTER_NAME: "T3 Code",
          GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        };
        yield* Effect.gen(function* () {
          yield* fileSystem
            .makeDirectory(temporaryDir, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.mapError(() =>
                checkpointError(
                  "SidecarCheckpointRepository.capture",
                  input.cwd,
                  "Unable to create sidecar temporary directory.",
                ),
              ),
            );
          const buildVerificationTree = Effect.fn(
            "SidecarCheckpointRepository.capture.buildVerificationTree",
          )(function* (index: string, pathspecFile: string, operationSuffix: string) {
            const paths = yield* workspacePaths(input.cwd, identity.worktreeRoot);
            yield* fileSystem
              .writeFileString(pathspecFile, paths.length === 0 ? "" : `${paths.join("\0")}\0`)
              .pipe(
                Effect.mapError(() =>
                  checkpointError(
                    "SidecarCheckpointRepository.capture",
                    input.cwd,
                    "Unable to write checkpoint pathspec file.",
                  ),
                ),
              );
            const environment = { ...baseEnvironment, GIT_INDEX_FILE: index };
            yield* git(
              `SidecarCheckpointRepository.capture.emptyIndex.${operationSuffix}`,
              input.cwd,
              sidecarGitArgs(gitDir, identity.worktreeRoot, ["read-tree", "--empty"]),
              { env: environment },
            );
            if (paths.length > 0) {
              yield* git(
                `SidecarCheckpointRepository.capture.add.${operationSuffix}`,
                input.cwd,
                sidecarGitArgs(gitDir, identity.worktreeRoot, [
                  "add",
                  "--force",
                  `--pathspec-from-file=${pathspecFile}`,
                  "--pathspec-file-nul",
                ]),
                { env: environment },
              );
            }
            const tree = yield* git(
              `SidecarCheckpointRepository.capture.writeTree.${operationSuffix}`,
              input.cwd,
              sidecarGitArgs(gitDir, identity.worktreeRoot, ["write-tree"]),
              { env: environment, maxOutputBytes: 4_096 },
            );
            return tree.stdout.trim();
          });
          const treeOid = yield* buildVerificationTree(indexPath, pathsFile, "initial");
          if (!treeOid)
            return yield* checkpointError(
              "SidecarCheckpointRepository.capture",
              input.cwd,
              "Sidecar write-tree returned no object id.",
            );
          const verificationTreeOid = yield* buildVerificationTree(
            verificationIndexPath,
            verificationPathsFile,
            "verification",
          );
          if (!verificationTreeOid || verificationTreeOid !== treeOid) {
            return yield* checkpointError(
              "SidecarCheckpointRepository.capture",
              input.cwd,
              "Checkpoint workspace changed during capture verification.",
            );
          }
          const commit = yield* git(
            "SidecarCheckpointRepository.capture.commitTree",
            input.cwd,
            sidecarGitArgs(gitDir, identity.worktreeRoot, [
              "commit-tree",
              treeOid,
              "-m",
              `t3 checkpoint schema=v1 snapshot=${locator.snapshotId} worktree=${identity.worktreeKey}`,
            ]),
            { env: baseEnvironment, maxOutputBytes: 4_096 },
          );
          const commitOid = commit.stdout.trim();
          const verificationTree = yield* git(
            "SidecarCheckpointRepository.capture.verify",
            input.cwd,
            sidecarGitArgs(gitDir, identity.worktreeRoot, ["rev-parse", `${commitOid}^{tree}`]),
            { maxOutputBytes: 4_096 },
          );
          if (!commitOid || verificationTree.stdout.trim() !== treeOid) {
            return yield* checkpointError(
              "SidecarCheckpointRepository.capture",
              input.cwd,
              "Sidecar checkpoint verification failed.",
            );
          }
          const publish = yield* git(
            "SidecarCheckpointRepository.capture.publish",
            input.cwd,
            sidecarGitArgs(gitDir, identity.worktreeRoot, [
              "update-ref",
              sidecarRef(locator),
              commitOid,
            ]),
            { allowNonZeroExit: true },
          );
          if (publish.exitCode !== 0) {
            return yield* checkpointError(
              "SidecarCheckpointRepository.capture.publish",
              input.cwd,
              "Unable to publish the sidecar checkpoint.",
            );
          }
        }).pipe(Effect.ensuring(removeTemporaryPath(temporaryDir, input.cwd)));
      }),
    );
  });

  const allocate: SidecarCheckpointRepository["Service"]["allocate"] = Effect.fn(
    "SidecarCheckpointRepository.allocate",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    if (!SNAPSHOT_ID_PATTERN.test(input.snapshotId)) {
      return yield* checkpointError(
        "SidecarCheckpointRepository.allocate",
        input.cwd,
        "Invalid sidecar checkpoint snapshot id.",
      );
    }
    return sidecarCheckpointRef(identity, input.snapshotId);
  });

  const captureWithMetadata: SidecarCheckpointRepository["Service"]["captureWithMetadata"] =
    Effect.fn("SidecarCheckpointRepository.captureWithMetadata")(function* (input) {
      yield* capture(input);
      const identity = yield* identities.resolve(input.cwd);
      const locator = yield* locatorForIdentity(
        "SidecarCheckpointRepository.captureWithMetadata",
        input.cwd,
        input.checkpointRef,
        identity,
      );
      const gitDir = repositoryDirectory(identity.repositoryKey);
      const commitOid = yield* resolveCommit(input.cwd, gitDir, identity.worktreeRoot, locator);
      if (!commitOid) {
        return yield* checkpointError(
          "SidecarCheckpointRepository.captureWithMetadata",
          input.cwd,
          "Published sidecar checkpoint is unavailable.",
        );
      }
      const tree = yield* git(
        "SidecarCheckpointRepository.captureWithMetadata",
        input.cwd,
        sidecarGitArgs(gitDir, identity.worktreeRoot, ["rev-parse", `${commitOid}^{tree}`]),
        { maxOutputBytes: 4_096 },
      );
      const treeOid = tree.stdout.trim();
      if (!treeOid) {
        return yield* checkpointError(
          "SidecarCheckpointRepository.captureWithMetadata",
          input.cwd,
          "Published sidecar checkpoint tree is unavailable.",
        );
      }
      return {
        commitOid,
        treeOid,
        repositoryKey: identity.repositoryKey,
        worktreeKey: identity.worktreeKey,
      };
    });

  const has: SidecarCheckpointRepository["Service"]["has"] = Effect.fn(
    "SidecarCheckpointRepository.has",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    const locator = yield* locatorForIdentity(
      "SidecarCheckpointRepository.has",
      input.cwd,
      input.checkpointRef,
      identity,
    );
    const gitDir = repositoryDirectory(identity.repositoryKey);
    if (!(yield* fileSystem.exists(gitDir))) return false;
    return (yield* resolveCommit(input.cwd, gitDir, identity.worktreeRoot, locator)) !== undefined;
  });

  const restore: SidecarCheckpointRepository["Service"]["restore"] = Effect.fn(
    "SidecarCheckpointRepository.restore",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    const locator = yield* locatorForIdentity(
      "SidecarCheckpointRepository.restore",
      input.cwd,
      input.checkpointRef,
      identity,
    );
    const gitDir = repositoryDirectory(identity.repositoryKey);
    if (!(yield* fileSystem.exists(gitDir))) return false;
    const commit = yield* resolveCommit(input.cwd, gitDir, identity.worktreeRoot, locator);
    if (!commit) return false;
    const [entries, currentPaths] = yield* Effect.all([
      snapshotEntries(input.cwd, gitDir, identity.worktreeRoot, commit),
      workspacePaths(input.cwd, identity.worktreeRoot),
    ]);
    const targetPaths = entries.map((entry) => entry.relativePath);
    const targetPathSet = new Set(targetPaths);
    const stalePaths = currentPaths.filter((relativePath) => !targetPathSet.has(relativePath));
    const temporaryDir = path.join(config.checkpointsDir, "tmp", NodeCrypto.randomUUID());
    const indexPath = path.join(temporaryDir, "index");
    const preparedRoot = path.join(temporaryDir, "prepared");
    const stagedWorkspacePaths: Array<string> = [];
    const environment = {
      ...CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
      GIT_INDEX_FILE: indexPath,
    };
    yield* Effect.gen(function* () {
      yield* fileSystem
        .makeDirectory(preparedRoot, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError(() =>
            checkpointError(
              "SidecarCheckpointRepository.restore",
              input.cwd,
              "Unable to create restore temporary directory.",
            ),
          ),
        );
      yield* git(
        "SidecarCheckpointRepository.restore.readTree",
        input.cwd,
        sidecarGitArgs(gitDir, identity.worktreeRoot, ["read-tree", commit]),
        { env: environment },
      );
      // Fully materialize the candidate away from the workspace. Nothing is
      // deleted until Git has proven every blob/symlink can be checked out.
      yield* git(
        "SidecarCheckpointRepository.restore.prepare",
        input.cwd,
        sidecarGitArgs(gitDir, identity.worktreeRoot, [
          "checkout-index",
          "--all",
          "--force",
          `--prefix=${preparedRoot}${path.sep}`,
        ]),
        { env: environment },
      );
      yield* validatePreparedEntries(input.cwd, preparedRoot, entries);
      yield* validateExistingAncestors(input.cwd, identity.worktreeRoot, [
        ...targetPaths,
        ...stalePaths,
      ]);

      // Refuse directory-to-file replacement: it could recursively remove
      // ignored content which Git intentionally omitted from currentPaths.
      for (const entry of entries) {
        if (entry.type === "commit") continue;
        const target = yield* validateWorkspacePath(identity.worktreeRoot, entry.relativePath);
        if (!(yield* pathExistsWithoutFollowing(target))) continue;
        const info = yield* lstat(
          "SidecarCheckpointRepository.restore.preflight",
          input.cwd,
          target,
        );
        if (info.isDirectory() && !info.isSymbolicLink()) {
          return yield* checkpointError(
            "SidecarCheckpointRepository.restore.preflight",
            input.cwd,
            "Checkpoint file is obstructed by a workspace directory.",
          );
        }
      }

      // Stage every target as a temporary sibling first. This keeps failures
      // during copy/symlink creation from partially replacing the workspace
      // and lets the final application use same-filesystem atomic renames.
      const preparedTargets: Array<{
        readonly target: string;
        readonly staged: string;
      }> = [];
      for (const entry of entries) {
        if (entry.type === "commit") continue;
        const source = yield* validateWorkspacePath(preparedRoot, entry.relativePath);
        const target = yield* validateWorkspacePath(identity.worktreeRoot, entry.relativePath);
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        const staged = path.join(
          path.dirname(target),
          `.t3-checkpoint-restore-${NodeCrypto.randomUUID()}`,
        );
        stagedWorkspacePaths.push(staged);
        const info = yield* lstat("SidecarCheckpointRepository.restore.stage", input.cwd, source);
        if (info.isSymbolicLink()) {
          yield* fileSystem.symlink(yield* fileSystem.readLink(source), staged);
        } else {
          yield* fileSystem.copyFile(source, staged);
          yield* fileSystem
            .chmod(staged, entry.mode === "100755" ? 0o755 : 0o644)
            .pipe(Effect.orElseSucceed(() => undefined));
        }
        preparedTargets.push({ target, staged });
      }

      // Delete only Git-classified tracked/non-ignored paths absent from the
      // checkpoint. Ignored files are never enumerated and therefore survive.
      for (const relativePath of [...stalePaths].sort(
        (left, right) => right.split("/").length - left.split("/").length,
      )) {
        const absolutePath = yield* validateWorkspacePath(identity.worktreeRoot, relativePath);
        yield* fileSystem
          .remove(absolutePath, { recursive: false, force: true })
          .pipe(
            Effect.mapError(() =>
              checkpointError(
                "SidecarCheckpointRepository.restore.apply",
                input.cwd,
                "Unable to remove a stale checkpoint path.",
              ),
            ),
          );
      }

      for (const { target, staged } of preparedTargets) {
        yield* fileSystem.remove(target, { recursive: false, force: true });
        yield* fileSystem.rename(staged, target);
      }
    }).pipe(
      Effect.ensuring(
        Effect.forEach(
          stagedWorkspacePaths,
          (staged) => fileSystem.remove(staged, { recursive: false, force: true }),
          { discard: true },
        ).pipe(Effect.ignore),
      ),
      Effect.ensuring(removeTemporaryPath(temporaryDir, input.cwd)),
    );
    return true;
  });

  const diff: SidecarCheckpointRepository["Service"]["diff"] = Effect.fn(
    "SidecarCheckpointRepository.diff",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    const gitDir = repositoryDirectory(identity.repositoryKey);
    return yield* withRepositoryLock(
      identity.repositoryKey,
      Effect.gen(function* () {
        if (!(yield* fileSystem.exists(gitDir)))
          return yield* checkpointError(
            "SidecarCheckpointRepository.diff",
            input.cwd,
            "Sidecar repository is unavailable.",
          );
        const resolveRevision = Effect.fn("SidecarCheckpointRepository.resolveDiffRevision")(
          function* (checkpointRef: CheckpointRef, fallbackToHead: boolean) {
            if (isSidecarCheckpointRef(checkpointRef)) {
              const locator = yield* locatorForIdentity(
                "SidecarCheckpointRepository.diff",
                input.cwd,
                checkpointRef,
                identity,
              );
              return yield* resolveCommit(input.cwd, gitDir, identity.worktreeRoot, locator);
            }
            const result = yield* git(
              "SidecarCheckpointRepository.resolveLegacyDiffRevision",
              input.cwd,
              [
                "-C",
                identity.worktreeRoot,
                "rev-parse",
                "--verify",
                "--quiet",
                `${checkpointRef}^{commit}`,
              ],
              { allowNonZeroExit: true, maxOutputBytes: 4_096 },
            );
            let commit = result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
            let sourceRevision = String(checkpointRef);
            if (!commit && fallbackToHead) {
              const head = yield* git(
                "SidecarCheckpointRepository.resolveLegacyDiffHead",
                input.cwd,
                ["-C", identity.worktreeRoot, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
                { allowNonZeroExit: true, maxOutputBytes: 4_096 },
              );
              commit = head.exitCode === 0 ? head.stdout.trim() || undefined : undefined;
              sourceRevision = "HEAD";
            }
            if (!commit) return undefined;

            // Copy the exact legacy revision into T3's object database. An
            // operation-local project alternate would make this diff depend on the
            // user's future history and garbage collection, violating sidecar
            // isolation. The repository lock also prevents sidecar prune-now from
            // racing this deliberately unreferenced compatibility object.
            yield* git(
              "SidecarCheckpointRepository.copyLegacyDiffRevision",
              input.cwd,
              sidecarGitArgs(gitDir, identity.worktreeRoot, [
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                identity.commonDir,
                sourceRevision,
              ]),
            );
            const copied = yield* git(
              "SidecarCheckpointRepository.verifyLegacyDiffRevision",
              input.cwd,
              sidecarGitArgs(gitDir, identity.worktreeRoot, [
                "rev-parse",
                "--verify",
                "--quiet",
                `${commit}^{commit}`,
              ]),
              { allowNonZeroExit: true, maxOutputBytes: 4_096 },
            );
            return copied.exitCode === 0 && copied.stdout.trim() === commit ? commit : undefined;
          },
        );
        const [fromCommit, toCommit] = yield* Effect.all([
          resolveRevision(input.fromCheckpointRef, input.fallbackFromToHead === true),
          resolveRevision(input.toCheckpointRef, false),
        ]);
        if (!fromCommit || !toCommit)
          return yield* checkpointError(
            "SidecarCheckpointRepository.diff",
            input.cwd,
            "Sidecar checkpoint is unavailable.",
          );
        const result = yield* git(
          "SidecarCheckpointRepository.diff",
          input.cwd,
          sidecarGitArgs(gitDir, identity.worktreeRoot, [
            "diff",
            "--binary",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
            fromCommit,
            toCommit,
          ]),
          { allowNonZeroExit: true, maxOutputBytes: 10_000_000 },
        );
        if (result.exitCode !== 0)
          return yield* checkpointError(
            "SidecarCheckpointRepository.diff",
            input.cwd,
            "Sidecar diff failed.",
          );
        return result.stdout;
      }),
    );
  });

  const deleteCheckpoints: SidecarCheckpointRepository["Service"]["delete"] = Effect.fn(
    "SidecarCheckpointRepository.delete",
  )(function* (input) {
    if (input.checkpointRefs.length === 0) return;
    const identity = yield* identities.resolve(input.cwd);
    const locators = yield* Effect.forEach(input.checkpointRefs, (checkpointRef) =>
      locatorForIdentity("SidecarCheckpointRepository.delete", input.cwd, checkpointRef, identity),
    );
    const gitDir = repositoryDirectory(identity.repositoryKey);
    if (!(yield* fileSystem.exists(gitDir))) return;
    yield* withRepositoryLock(
      identity.repositoryKey,
      Effect.forEach(
        locators,
        (locator) =>
          git(
            "SidecarCheckpointRepository.delete",
            input.cwd,
            sidecarGitArgs(gitDir, identity.worktreeRoot, [
              "update-ref",
              "-d",
              sidecarRef(locator),
            ]),
            { allowNonZeroExit: true },
          ),
        { discard: true },
      ),
    );
  });

  const importLegacy: SidecarCheckpointRepository["Service"]["importLegacy"] = Effect.fn(
    "SidecarCheckpointRepository.importLegacy",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    return yield* withRepositoryLock(
      identity.repositoryKey,
      Effect.gen(function* () {
        const locator = yield* locatorForIdentity(
          "SidecarCheckpointRepository.importLegacy",
          input.cwd,
          input.sidecarCheckpointRef,
          identity,
        );
        const gitDir = yield* ensureRepository(input.cwd, identity);
        const legacyCommitResult = yield* git(
          "SidecarCheckpointRepository.importLegacy.resolve",
          input.cwd,
          [
            "-C",
            identity.worktreeRoot,
            "rev-parse",
            "--verify",
            "--quiet",
            `${input.legacyCheckpointRef}^{commit}`,
          ],
          { allowNonZeroExit: true, maxOutputBytes: 4_096 },
        );
        const commitOid = legacyCommitResult.stdout.trim();
        if (legacyCommitResult.exitCode !== 0 || !commitOid) {
          return yield* checkpointError(
            "SidecarCheckpointRepository.importLegacy",
            input.cwd,
            "Legacy checkpoint is unavailable.",
          );
        }
        const legacyTree = yield* git(
          "SidecarCheckpointRepository.importLegacy.resolveTree",
          input.cwd,
          ["-C", identity.worktreeRoot, "rev-parse", `${commitOid}^{tree}`],
          { maxOutputBytes: 4_096 },
        );
        const treeOid = legacyTree.stdout.trim();
        const existingCommit = yield* resolveCommit(
          input.cwd,
          gitDir,
          identity.worktreeRoot,
          locator,
        );
        if (existingCommit) {
          const existingTree = yield* git(
            "SidecarCheckpointRepository.importLegacy.verifyExisting",
            input.cwd,
            sidecarGitArgs(gitDir, identity.worktreeRoot, [
              "rev-parse",
              `${existingCommit}^{tree}`,
            ]),
            { maxOutputBytes: 4_096 },
          );
          if (existingTree.stdout.trim() !== treeOid) {
            return yield* checkpointError(
              "SidecarCheckpointRepository.importLegacy",
              input.cwd,
              "Existing sidecar checkpoint does not match the legacy tree.",
            );
          }
          return {
            checkpointRef: input.sidecarCheckpointRef,
            commitOid: existingCommit,
            treeOid,
            alreadyImported: true,
          };
        }

        // Fetch only the known projected ref. No remote is added and FETCH_HEAD
        // is not persisted. Unknown refs remain undiscovered and untouched.
        yield* git(
          "SidecarCheckpointRepository.importLegacy.fetch",
          input.cwd,
          sidecarGitArgs(gitDir, identity.worktreeRoot, [
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            identity.commonDir,
            String(input.legacyCheckpointRef),
          ]),
        );
        const importedTree = yield* git(
          "SidecarCheckpointRepository.importLegacy.verifyTree",
          input.cwd,
          sidecarGitArgs(gitDir, identity.worktreeRoot, ["rev-parse", `${commitOid}^{tree}`]),
          { maxOutputBytes: 4_096 },
        );
        if (importedTree.stdout.trim() !== treeOid) {
          return yield* checkpointError(
            "SidecarCheckpointRepository.importLegacy",
            input.cwd,
            "Imported checkpoint tree verification failed.",
          );
        }
        yield* git(
          "SidecarCheckpointRepository.importLegacy.publish",
          input.cwd,
          sidecarGitArgs(gitDir, identity.worktreeRoot, [
            "update-ref",
            sidecarRef(locator),
            commitOid,
          ]),
        );
        return {
          checkpointRef: input.sidecarCheckpointRef,
          commitOid,
          treeOid,
          alreadyImported: false,
        };
      }),
    );
  });

  const gc: SidecarCheckpointRepository["Service"]["gc"] = Effect.fn(
    "SidecarCheckpointRepository.gc",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    const gitDir = repositoryDirectory(identity.repositoryKey);
    if (!(yield* fileSystem.exists(gitDir))) return false;
    return yield* withRepositoryLock(
      identity.repositoryKey,
      git(
        "SidecarCheckpointRepository.gc",
        input.cwd,
        sidecarGitArgs(gitDir, identity.worktreeRoot, ["gc", "--prune=now"]),
      ).pipe(Effect.as(true)),
    );
  });

  return SidecarCheckpointRepository.of({
    allocate,
    capture,
    captureWithMetadata,
    has,
    restore,
    diff,
    importLegacy,
    delete: deleteCheckpoints,
    gc,
  });
});

export const layer = Layer.effect(SidecarCheckpointRepository, make).pipe(
  Layer.provide(CheckpointRepositoryIdentity.layer),
);
