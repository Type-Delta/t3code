/**
 * Private, bare-Git backing store for `t3-sidecar:v1:` checkpoint locators.
 *
 * This module intentionally never asks project Git to resolve a sidecar ref
 * and never places an index, ref, object, or reflog below a worktree's `.git`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import {
  CheckpointRef,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type VcsError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointRepositoryIdentity from "./CheckpointRepositoryIdentity.ts";
import { CheckpointObjectsUnavailableError, CheckpointSnapshotUnavailableError } from "./Errors.ts";
import * as OnlineObjects from "./SidecarOnlineObjects.ts";

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
  readonly format?: "patch" | "numstat";
  /** Limits the diff to these repository-relative paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /**
   * False never downloads evicted versions: numstat then lists changed paths
   * with unknown line counts, and a patch fails.
   */
  readonly allowNetwork?: boolean;
}

export interface SidecarAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
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

export interface SidecarRetainResult {
  readonly snapshots: number;
  readonly repositories: number;
  readonly bytes: number;
  /** One line per store that could not be cleaned; the others still were. */
  readonly failures: ReadonlyArray<string>;
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
/** Per-worktree capture indexes inside each private sidecar repository. */
const PERSISTED_INDEXES_DIRECTORY = "t3-indexes";
/** Remotes eviction relied on, and whether a disabled store fetched everything back. */
const ONLINE_STATE_FILE = "t3-online.json";
/** Present from deleting snapshots until a prune drops their objects. */
const PRUNE_PENDING_FILE = "t3-prune-pending";
/** Names stores retention detached into `checkpoints/tmp`, so a later pass can retry removing them. */
const DETACHED_STORE_PREFIX = "retained-";
const DETACHED_STORE_LEFT =
  "A removed snapshot store could not be deleted yet; the next cleanup retries.";
// A turn writes a few dozen loose objects, so packing waits for dozens of turns.
const LOOSE_OBJECT_LIMIT = 1_000;
// Full passes leave one pack; only incremental passes and large fetches add more.
const PACK_LIMIT = 8;
const MAINTENANCE_TIMEOUT_MS = 30 * 60_000;
// Stalled transfers end through Git's low-speed limit; this only caps a slow, live one.
const FETCH_TIMEOUT_MS = 15 * 60_000;
const LS_REMOTE_TIMEOUT_MS = 2 * 60_000;
const BACKOFF_INITIAL_MS = 60 * 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;
const TEMPORARY_ENTRY_TTL_MS = 60 * 60_000;
const OBJECT_LIST_MAX_BYTES = 1024 * 1024 * 1024;
const OBJECT_ID_LINE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?(?= |$)/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const LOW_SPEED_CONFIG = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30"];

type ObjectsOperation = CheckpointObjectsUnavailableError["operation"];
type ObjectsUnavailableReason = CheckpointObjectsUnavailableError["reason"];

const OnlineRemote = Schema.Struct({ name: Schema.String, url: Schema.String });
type OnlineRemote = typeof OnlineRemote.Type;
const OnlineState = Schema.Struct({
  remotes: Schema.Array(OnlineRemote),
  rehydrated: Schema.Boolean,
});
type OnlineState = typeof OnlineState.Type;
const decodeOnlineState = Schema.decodeUnknownEffect(Schema.fromJsonString(OnlineState));

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
    ) => Effect.Effect<
      boolean,
      VcsError | CheckpointObjectsUnavailableError | PlatformError.PlatformError
    >;
    /**
     * Makes every file version a restore writes local and keeps maintenance
     * from evicting them until the scope closes, so the restore needs no network.
     */
    readonly prepareRestore: (
      input: SidecarCaptureInput,
    ) => Effect.Effect<
      void,
      | VcsError
      | CheckpointObjectsUnavailableError
      | CheckpointSnapshotUnavailableError
      | PlatformError.PlatformError,
      Scope.Scope
    >;
    readonly diff: (
      input: SidecarDiffInput,
    ) => Effect.Effect<
      string,
      | VcsError
      | CheckpointObjectsUnavailableError
      | CheckpointSnapshotUnavailableError
      | PlatformError.PlatformError
    >;
    /** Same contract as `CheckpointStore.listAuthoredPaths`, for ranges with a sidecar end. */
    readonly authoredPaths: (
      input: SidecarAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, VcsError | PlatformError.PlatformError>;
    readonly importLegacy: (
      input: SidecarImportLegacyInput,
    ) => Effect.Effect<SidecarImportLegacyResult, VcsError | PlatformError.PlatformError>;
    readonly delete: (input: {
      readonly cwd: string;
      readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
    }) => Effect.Effect<void, VcsError | PlatformError.PlatformError>;
    /**
     * Packs loose objects and, with Online Snapshots on, evicts blobs the
     * project's remote holds. Capture schedules this in the background; `force`
     * skips the size thresholds.
     */
    readonly maintain: (input: {
      readonly cwd: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, VcsError>;
    /** Run maintenance only in T3's private bare repository. */
    readonly gc: (input: {
      readonly cwd: string;
    }) => Effect.Effect<boolean, VcsError | PlatformError.PlatformError>;
    /**
     * Deletes every stored snapshot no `live` locator names unless it was taken
     * at or after `protectedSince` (epoch ms), drops objects nothing else needs,
     * and removes emptied stores. Works on every store on disk, without a project checkout.
     */
    readonly retain: (input: {
      readonly live: Iterable<CheckpointRef>;
      readonly protectedSince: number;
    }) => Effect.Effect<SidecarRetainResult, PlatformError.PlatformError>;
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
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostPlatform = yield* HostProcess.Platform;
  const serviceScope = yield* Effect.scope;
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

  // A pass and gc of one sidecar never overlap. The single-flight map below
  // only coalesces requests; gc does not go through it.
  const maintenanceLocks = new Map<string, Semaphore.Semaphore>();
  const withMaintenanceLock = <A, E, R>(
    repositoryKey: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    let lock = maintenanceLocks.get(repositoryKey);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      maintenanceLocks.set(repositoryKey, lock);
    }
    return lock.withPermits(1)(effect);
  };

  /** Blobs a prepared restore will read, per sidecar; eviction never removes them. */
  const pins = new Map<string, Map<string, number>>();
  const pinnedOids = (repositoryKey: string): ReadonlyMap<string, number> =>
    pins.get(repositoryKey) ?? new Map();
  const pinObjects = (repositoryKey: string, oids: ReadonlyArray<string>) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const pinned = pins.get(repositoryKey) ?? new Map<string, number>();
        pins.set(repositoryKey, pinned);
        for (const oid of oids) pinned.set(oid, (pinned.get(oid) ?? 0) + 1);
      }),
      () =>
        Effect.sync(() => {
          const pinned = pins.get(repositoryKey);
          if (pinned === undefined) return;
          for (const oid of oids) {
            const count = (pinned.get(oid) ?? 1) - 1;
            if (count > 0) pinned.set(oid, count);
            else pinned.delete(oid);
          }
          if (pinned.size === 0) pins.delete(repositoryKey);
        }),
    );

  // Failed or timed-out background work waits 1h, doubling to 24h, instead of
  // rerunning after every capture.
  const backoffs = new Map<string, { readonly untilMs: number; readonly delayMs: number }>();
  const inBackoff = (key: string) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => (backoffs.get(key)?.untilMs ?? 0) > now));
  const backOff = (key: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        const delayMs = Math.min(
          BACKOFF_MAX_MS,
          (backoffs.get(key)?.delayMs ?? BACKOFF_INITIAL_MS / 2) * 2,
        );
        backoffs.set(key, { untilMs: now + delayMs, delayMs });
      }),
    );
  const clearBackoff = (key: string) => Effect.sync(() => backoffs.delete(key));

  const git = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly maxOutputBytes?: number;
      readonly outputMode?: "error" | "truncate";
      readonly timeoutMs?: number;
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
      timeoutMs: options?.timeoutMs ?? 30_000,
      maxOutputBytes: options?.maxOutputBytes ?? 16 * 1024 * 1024,
      outputMode: options?.outputMode ?? "truncate",
    });

  // `-C` keeps worktree-relative paths from gaining a prefix when the server's
  // own working directory is inside the worktree.
  const sidecarGitArgs = (gitDir: string, worktree: string, args: ReadonlyArray<string>) => [
    "-C",
    worktree,
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
    const keys = [
      "core.autocrlf",
      "core.eol",
      "core.filemode",
      "core.symlinks",
      "core.ignorecase",
      "core.precomposeunicode",
    ];
    const pattern = "^core\\.(autocrlf|eol|filemode|symlinks|ignorecase|precomposeunicode)$";
    // Batch optional settings: a missing key's nonzero exit triggers costly
    // process-tree cleanup on Windows. Read local values too to avoid no-op writes.
    const source = yield* git(
      "SidecarCheckpointRepository.readWorktreeConfig",
      cwd,
      ["-C", identity.worktreeRoot, "config", "--null", "--get-regexp", pattern],
      { allowNonZeroExit: true, maxOutputBytes: keys.length * 4_096, outputMode: "error" },
    );
    const destination = yield* git(
      "SidecarCheckpointRepository.readSidecarConfig",
      cwd,
      sidecarGitArgs(gitDir, identity.worktreeRoot, [
        "config",
        "--local",
        "--null",
        "--get-regexp",
        pattern,
      ]),
      { allowNonZeroExit: true, maxOutputBytes: keys.length * 4_096, outputMode: "error" },
    );
    for (const result of [source, destination]) {
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* checkpointError(
          "SidecarCheckpointRepository.readWorktreeConfig",
          cwd,
          "Unable to read Git worktree configuration.",
        );
      }
    }
    // Git lists global and included values before local overrides. Keep the
    // last value, matching `git config --get`, and retain empty settings as present.
    const values = (output: string) =>
      new Map(
        output
          .split("\0")
          .filter(Boolean)
          .map((record) => {
            const separator = record.indexOf("\n");
            return separator < 0
              ? ([record, ""] as const)
              : ([record.slice(0, separator), record.slice(separator + 1).trim()] as const);
          }),
      );
    const sourceValues = values(source.stdout);
    const destinationValues = values(destination.stdout);
    for (const key of keys) {
      const value = sourceValues.get(key);
      if (value && destinationValues.get(key) !== value) {
        yield* git("SidecarCheckpointRepository.writeWorktreeConfig", cwd, [
          ...sidecarGitArgs(gitDir, identity.worktreeRoot, ["config", "--local", key, value]),
        ]);
      } else if (
        value === undefined &&
        destinationValues.has(key) &&
        (key === "core.autocrlf" || key === "core.eol")
      ) {
        const cleared = yield* git(
          "SidecarCheckpointRepository.clearWorktreeConfig",
          cwd,
          sidecarGitArgs(gitDir, identity.worktreeRoot, ["config", "--local", "--unset-all", key]),
          { allowNonZeroExit: true, maxOutputBytes: 4_096 },
        );
        // Git exits 5 when the local value was already absent.
        if (cleared.exitCode !== 0 && cleared.exitCode !== 5) {
          return yield* checkpointError(
            "SidecarCheckpointRepository.clearWorktreeConfig",
            cwd,
            "Unable to clear inherited Git line-ending configuration.",
          );
        }
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

  const bareGitArgs = (gitDir: string, args: ReadonlyArray<string>) => [
    `--git-dir=${gitDir}`,
    ...args,
  ];

  /** Lets one sidecar command read project objects; nothing is persisted. */
  const projectObjectsEnvironment = (
    identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity,
  ): NodeJS.ProcessEnv => ({
    ...CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: OnlineObjects.alternateObjectDirectories(
      path.join(identity.commonDir, "objects"),
      hostPlatform,
    ),
  });

  const missingObjects = Effect.fn("SidecarCheckpointRepository.missingObjects")(function* (
    cwd: string,
    gitDir: string,
    oids: Iterable<string>,
    env?: NodeJS.ProcessEnv,
  ) {
    const unique = [...new Set(oids)];
    if (unique.length === 0) return [];
    const result = yield* git(
      "SidecarCheckpointRepository.missingObjects",
      cwd,
      bareGitArgs(gitDir, ["cat-file", "--batch-check=%(objectname)"]),
      {
        stdin: `${unique.join("\n")}\n`,
        ...(env === undefined ? {} : { env }),
        maxOutputBytes: unique.length * 80 + 4_096,
        outputMode: "error",
        timeoutMs: MAINTENANCE_TIMEOUT_MS,
      },
    );
    return result.stdout
      .split("\n")
      .filter((line) => line.endsWith(" missing"))
      .map((line) => line.slice(0, line.indexOf(" ")));
  });

  const readOnlineState = (gitDir: string) =>
    fileSystem.readFileString(path.join(gitDir, ONLINE_STATE_FILE)).pipe(
      Effect.flatMap(decodeOnlineState),
      Effect.orElseSucceed((): OnlineState | undefined => undefined),
    );

  const writeOnlineState = (gitDir: string, state: OnlineState) => {
    const target = path.join(gitDir, ONLINE_STATE_FILE);
    const staged = `${target}.${NodeCrypto.randomUUID()}.tmp`;
    return fileSystem
      .writeFileString(staged, JSON.stringify(state))
      .pipe(Effect.andThen(fileSystem.rename(staged, target)));
  };

  const projectRemoteUrl = (cwd: string, worktree: string, name: string) =>
    git(
      "SidecarCheckpointRepository.online.remoteUrl",
      cwd,
      ["-C", worktree, "remote", "get-url", name],
      { allowNonZeroExit: true, maxOutputBytes: 64 * 1024 },
    ).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "") || undefined),
      Effect.orElseSucceed(() => undefined),
    );

  /** The current branch's upstream remote, else `checkout.defaultRemote`, `origin`, or the sole remote. */
  const primaryRemote = Effect.fn("SidecarCheckpointRepository.primaryRemote")(function* (
    cwd: string,
    worktree: string,
  ) {
    const projectGit = (operation: string, args: ReadonlyArray<string>) =>
      git(operation, cwd, ["-C", worktree, ...args], {
        allowNonZeroExit: true,
        maxOutputBytes: 1024 * 1024,
      });
    const [branch, remoteConfig, remotes] = yield* Effect.all([
      projectGit("SidecarCheckpointRepository.online.branch", [
        "symbolic-ref",
        "-q",
        "--short",
        "HEAD",
      ]),
      projectGit("SidecarCheckpointRepository.online.remoteConfig", [
        "config",
        "--null",
        "--get-regexp",
        "^(branch\\..*\\.remote|checkout\\.defaultremote)$",
      ]),
      projectGit("SidecarCheckpointRepository.online.remotes", ["remote"]),
    ]);
    const configValues = new Map(
      remoteConfig.stdout
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const separator = record.indexOf("\n");
          return [record.slice(0, separator), record.slice(separator + 1)] as const;
        }),
    );
    const branchName = branch.exitCode === 0 ? branch.stdout.trim() : "";
    const name = OnlineObjects.selectPrimaryRemote({
      remotes: remotes.stdout
        .split("\n")
        .map((remote) => remote.trim())
        .filter(Boolean),
      upstreamRemote:
        branchName === "" ? undefined : configValues.get(`branch.${branchName}.remote`),
      defaultRemote: configValues.get("checkout.defaultremote"),
    });
    if (name === undefined) return undefined;
    const url = yield* projectRemoteUrl(cwd, worktree, name);
    return url === undefined ? undefined : ({ name, url } satisfies OnlineRemote);
  });

  /** Fetches objects by id; returns the failure reason, or undefined on success. */
  const fetchObjects = Effect.fn("SidecarCheckpointRepository.fetchObjects")(function* (
    cwd: string,
    gitDir: string,
    worktree: string,
    url: string,
    oids: ReadonlyArray<string>,
  ) {
    const transportConfig = (args: ReadonlyArray<string>) =>
      git(
        "SidecarCheckpointRepository.fetchObjects.transportConfig",
        cwd,
        [...args, "config", "-z", "--get-regexp", OnlineObjects.TRANSPORT_CONFIG_PATTERN],
        { allowNonZeroExit: true, maxOutputBytes: 1024 * 1024 },
      ).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout : "")));
    const [projectTransport, sidecarTransport] = yield* Effect.all([
      transportConfig(["-C", worktree]),
      transportConfig(sidecarGitArgs(gitDir, worktree, [])),
    ]);
    // `-C` resolves a relative remote path as the project does. With no refs in
    // common, negotiation would only list every snapshot as a useless "have".
    const stderr = yield* git(
      "SidecarCheckpointRepository.fetchObjects",
      cwd,
      [
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "fetch.negotiationAlgorithm=noop",
        ...LOW_SPEED_CONFIG,
        ...sidecarGitArgs(gitDir, worktree, [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--stdin",
          url,
        ]),
      ],
      {
        stdin: `${oids.join("\n")}\n`,
        env: {
          ...CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
          ...OnlineObjects.nonInteractiveNetworkEnvironment,
          ...OnlineObjects.transportConfigEnvironment(projectTransport, sidecarTransport),
        },
        allowNonZeroExit: true,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024,
      },
    ).pipe(
      Effect.map((result) => (result.exitCode === 0 ? undefined : result.stderr)),
      Effect.catchTags({
        VcsProcessTimeoutError: () => Effect.succeed("operation timed out"),
      }),
    );
    if (stderr === undefined) return undefined;
    const reason = OnlineObjects.classifyRemoteFailure(stderr);
    yield* Effect.logWarning("checkpoint object fetch failed", {
      reason,
      objectCount: oids.length,
      detail: OnlineObjects.redactUrlCredentials(stderr).slice(0, 2_000),
    });
    return reason;
  });

  const remoteDisplay = (remote: OnlineRemote) =>
    `${remote.name} (${OnlineObjects.remoteDisplayUrl(remote.url)})`;

  /**
   * Downloads missing blobs in one request per source: the project itself when
   * asked, then the primary remote, then every remote eviction relied on.
   */
  const hydrate = Effect.fn("SidecarCheckpointRepository.hydrate")(function* (input: {
    readonly operation: ObjectsOperation;
    readonly cwd: string;
    readonly identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity;
    readonly gitDir: string;
    readonly oids: Iterable<string>;
    /** Objects visible through this environment do not count as missing. */
    readonly env?: NodeJS.ProcessEnv;
    readonly fromProject?: boolean;
  }) {
    const worktree = input.identity.worktreeRoot;
    let missing = yield* missingObjects(input.cwd, input.gitDir, input.oids, input.env);
    if (missing.length === 0) return;
    const objectCount = missing.length;
    const state = yield* readOnlineState(input.gitDir);
    const primary = yield* primaryRemote(input.cwd, worktree).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const sources: Array<OnlineRemote> = input.fromProject
      ? [{ name: "project", url: input.identity.commonDir }]
      : [];
    for (const recorded of [...(primary ? [primary] : []), ...(state?.remotes ?? [])]) {
      // A recorded remote's current URL applies later URL changes and insteadOf rules.
      const url =
        recorded === primary
          ? recorded.url
          : ((yield* projectRemoteUrl(input.cwd, worktree, recorded.name)) ?? recorded.url);
      if (!sources.some((source) => source.url === url)) {
        sources.push({ name: recorded.name, url });
      }
    }
    const attempts: Array<{ readonly remote: string; readonly reason?: ObjectsUnavailableReason }> =
      [];
    for (const source of sources) {
      const reason = yield* fetchObjects(input.cwd, input.gitDir, worktree, source.url, missing);
      missing = yield* missingObjects(input.cwd, input.gitDir, missing, input.env);
      if (missing.length === 0) return;
      if (source.name !== "project") {
        attempts.push({ remote: remoteDisplay(source), ...(reason ? { reason } : {}) });
      }
    }
    // A fixable failure is more useful than "gone" from another remote.
    const fixable = attempts.find(
      (attempt) => attempt.reason !== undefined && attempt.reason !== "not-on-remote",
    );
    return yield* new CheckpointObjectsUnavailableError({
      operation: input.operation,
      objectCount,
      ...(attempts.length === 0
        ? { reason: "no-remote" as const }
        : fixable
          ? { reason: fixable.reason!, remote: fixable.remote }
          : {
              reason: "not-on-remote" as const,
              remote: attempts.map((attempt) => attempt.remote).join(", "),
            }),
    });
  });

  /**
   * Makes every blob of a snapshot readable before anything is written. A
   * workspace file whose raw bytes hash to a missing blob is that blob, so it
   * is stored again without a download.
   */
  const ensureSnapshotObjects = Effect.fn("SidecarCheckpointRepository.ensureSnapshotObjects")(
    function* (input: {
      readonly cwd: string;
      readonly identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity;
      readonly gitDir: string;
      readonly entries: ReadonlyArray<SnapshotEntry>;
    }) {
      const worktree = input.identity.worktreeRoot;
      const environment = projectObjectsEnvironment(input.identity);
      const files = input.entries.filter((entry) => entry.type === "blob");
      const missing = new Set(
        yield* missingObjects(
          input.cwd,
          input.gitDir,
          files.map((entry) => entry.oid),
          environment,
        ),
      );
      if (missing.size === 0) return;
      const candidates: Array<SnapshotEntry> = [];
      for (const entry of files) {
        // Paths with a newline cannot go through --stdin-paths; they are downloaded.
        if (
          !missing.has(entry.oid) ||
          entry.mode === "120000" ||
          entry.relativePath.includes("\n")
        ) {
          continue;
        }
        const info = yield* Effect.promise(() =>
          NodeFSP.lstat(path.join(worktree, entry.relativePath)).catch(() => undefined),
        );
        if (info?.isFile()) candidates.push(entry);
      }
      if (candidates.length > 0) {
        const hashArgs = ["hash-object", "--no-filters", "--stdin-paths"];
        const stdin = `${candidates.map((entry) => entry.relativePath).join("\n")}\n`;
        const hashed = yield* git(
          "SidecarCheckpointRepository.recoverFromWorkspace.hash",
          input.cwd,
          sidecarGitArgs(input.gitDir, worktree, hashArgs),
          { stdin, timeoutMs: MAINTENANCE_TIMEOUT_MS, maxOutputBytes: candidates.length * 80 },
        ).pipe(Effect.orElseSucceed(() => undefined));
        const oids = hashed?.stdout.split("\n") ?? [];
        const recovered = candidates.filter((entry, index) => oids[index] === entry.oid);
        if (recovered.length > 0) {
          yield* git(
            "SidecarCheckpointRepository.recoverFromWorkspace.write",
            input.cwd,
            sidecarGitArgs(input.gitDir, worktree, [
              "hash-object",
              "-w",
              "--no-filters",
              "--stdin-paths",
            ]),
            {
              stdin: `${recovered.map((entry) => entry.relativePath).join("\n")}\n`,
              timeoutMs: MAINTENANCE_TIMEOUT_MS,
              maxOutputBytes: recovered.length * 80,
            },
          );
        }
      }
      yield* hydrate({
        operation: "restore",
        cwd: input.cwd,
        identity: input.identity,
        gitDir: input.gitDir,
        oids: missing,
        env: environment,
      });
    },
  );

  interface SnapshotEntry {
    readonly mode: string;
    readonly type: string;
    readonly oid: string;
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
          const [mode, type, oid] = header;
          if (
            !mode ||
            !type ||
            !oid ||
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
          entries.push({ mode, type, oid, relativePath });
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
      Effect.filterOrFail(
        (paths) => paths.every(relativePathIsSafe),
        () =>
          checkpointError(
            "SidecarCheckpointRepository.workspacePaths",
            cwd,
            "Git returned an unsafe workspace path.",
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

  const listPacks = (packDirectory: string) =>
    fileSystem.readDirectory(packDirectory).pipe(
      Effect.orElseSucceed((): Array<string> => []),
      Effect.map((names) => {
        // A `.keep` marks a pack another Git process is still writing.
        const present = new Set(names);
        return names
          .filter((name) => name.endsWith(".idx") && !present.has(name.replace(/\.idx$/, ".keep")))
          .map((name) => name.slice(0, -".idx".length))
          .sort();
      }),
    );

  const listLooseObjects = Effect.fn("SidecarCheckpointRepository.listLooseObjects")(function* (
    objectsDirectory: string,
  ) {
    const loose: Array<{ readonly oid: string; readonly file: string }> = [];
    const prefixes = yield* fileSystem
      .readDirectory(objectsDirectory)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    for (const prefix of prefixes.filter((name) => /^[0-9a-f]{2}$/.test(name))) {
      const names = yield* fileSystem
        .readDirectory(path.join(objectsDirectory, prefix))
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      for (const name of names) {
        if (!/^[0-9a-f]{38}(?:[0-9a-f]{24})?$/.test(name)) continue;
        loose.push({ oid: `${prefix}${name}`, file: path.join(objectsDirectory, prefix, name) });
      }
    }
    return loose;
  });

  // Windows cannot delete a pack another process has open; the next pass retries.
  const removeIfPossible = (target: string) =>
    fileSystem.remove(target, { recursive: true, force: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Removes what interrupted Git commands and restores leave behind. Callers
   * hold the repository lock, so no sidecar fetch is in flight.
   */
  const removeLeftovers = Effect.fn("SidecarCheckpointRepository.removeLeftovers")(function* (
    gitDir: string,
  ) {
    const packDirectory = path.join(gitDir, "objects", "pack");
    for (const name of yield* fileSystem
      .readDirectory(packDirectory)
      .pipe(Effect.orElseSucceed((): Array<string> => []))) {
      if (name.startsWith("tmp_") || name.endsWith(".keep")) {
        yield* removeIfPossible(path.join(packDirectory, name));
      }
    }
    const temporaryDirectory = path.join(config.checkpointsDir, "tmp");
    const now = yield* Clock.currentTimeMillis;
    for (const name of yield* fileSystem
      .readDirectory(temporaryDirectory)
      .pipe(Effect.orElseSucceed((): Array<string> => []))) {
      const entry = path.join(temporaryDirectory, name);
      const modifiedMs = yield* Effect.promise(() =>
        NodeFSP.lstat(entry).then(
          (info) => info.mtimeMs,
          () => now,
        ),
      );
      if (now - modifiedMs > TEMPORARY_ENTRY_TTL_MS) yield* removeIfPossible(entry);
    }
  });

  const packThreads = Math.max(1, Math.floor(NodeOS.availableParallelism() / 2));

  const removePack = Effect.fnUntraced(function* (base: string) {
    if (!(yield* removeIfPossible(`${base}.idx`))) return;
    for (const extension of [".pack", ".rev", ".bitmap", ".mtimes", ".promisor"]) {
      yield* removeIfPossible(`${base}${extension}`);
    }
  });

  /**
   * Packs objects into one new pack, then deletes only what it listed first.
   * `loose`: loose objects. `full`: all stored objects but `evict`, unreachable
   * included. `reachable` drops unreachable ones, so it needs the repository
   * lock unless `prune` is set. Returns whether it swapped.
   */
  const repack = Effect.fn("SidecarCheckpointRepository.repack")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly repositoryKey: string;
    readonly gitDir: string;
    readonly mode: "loose" | "full" | "reachable";
    readonly evict: ReadonlySet<string>;
    /** Also keeps `keep`, locks only the swap, and swaps only while `unchanged` holds. */
    readonly prune?: {
      readonly keep: ReadonlyArray<string>;
      readonly unchanged: Effect.Effect<boolean, VcsError | PlatformError.PlatformError>;
    };
  }) {
    const objectsDirectory = path.join(input.gitDir, "objects");
    const packDirectory = path.join(objectsDirectory, "pack");
    const loose = yield* listLooseObjects(objectsDirectory);
    const packs = input.mode === "loose" ? [] : yield* listPacks(packDirectory);
    const objects: Array<string> = [];
    if (input.mode === "loose") {
      objects.push(...loose.map((object) => object.oid));
    } else {
      const listObjects = (operation: string, args: ReadonlyArray<string>) =>
        git(operation, input.cwd, bareGitArgs(input.gitDir, args), {
          maxOutputBytes: OBJECT_LIST_MAX_BYTES,
          outputMode: "error",
          timeoutMs: MAINTENANCE_TIMEOUT_MS,
        }).pipe(Effect.map((result) => result.stdout.split("\n")));
      // Path names let pack-objects pair versions of the same file as deltas.
      const seen = new Set<string>();
      const add = (line: string) => {
        const oid = OBJECT_ID_LINE.exec(line)?.[0];
        if (oid === undefined || seen.has(oid) || input.evict.has(oid)) return;
        seen.add(oid);
        objects.push(line);
      };
      for (const line of yield* listObjects(`${input.operation}.reachable`, [
        "rev-list",
        "--objects",
        "--all",
        "--missing=allow-any",
      ])) {
        add(line);
      }
      for (const oid of input.prune?.keep ?? []) add(oid);
      if (input.mode === "full") {
        for (const line of yield* listObjects(`${input.operation}.stored`, [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname)",
          "--unordered",
        ])) {
          add(line);
        }
      }
    }
    if (objects.length === 0 && loose.length === 0 && packs.length === 0) return true;
    let pack: string | undefined;
    if (objects.length > 0) {
      // A configured size limit would split the output into several packs.
      const written = yield* git(
        `${input.operation}.write`,
        input.cwd,
        bareGitArgs(input.gitDir, [
          "-c",
          "gc.auto=0",
          "-c",
          "pack.packSizeLimit=0",
          "-c",
          `pack.threads=${packThreads}`,
          "pack-objects",
          "-q",
          "--non-empty",
          path.join(packDirectory, "pack"),
        ]),
        {
          stdin: `${objects.join("\n")}\n`,
          timeoutMs: MAINTENANCE_TIMEOUT_MS,
          maxOutputBytes: 4_096,
        },
      );
      pack = written.stdout.trim();
      if (!OBJECT_ID.test(pack)) {
        return yield* checkpointError(
          `${input.operation}.write`,
          input.cwd,
          "pack-objects did not report exactly one pack.",
        );
      }
    }
    // Readers never see a missing object: the new pack is complete before
    // anything it replaces is deleted, and restore and diff hold this lock.
    const swap = Effect.gen(function* () {
      if (input.prune !== undefined && !(yield* input.prune.unchanged)) {
        if (pack !== undefined && !packs.includes(`pack-${pack}`)) {
          yield* removePack(path.join(packDirectory, `pack-${pack}`));
        }
        yield* Effect.logInfo("checkpoint prune deferred: the store changed while packing");
        return false;
      }
      const pinned = pinnedOids(input.repositoryKey);
      if ([...input.evict].some((oid) => pinned.has(oid))) {
        yield* Effect.logInfo("checkpoint eviction deferred: a prepared restore needs its blobs");
        return false;
      }
      for (const name of packs) {
        if (name !== `pack-${pack}`) yield* removePack(path.join(packDirectory, name));
      }
      for (const object of loose) yield* removeIfPossible(object.file);
      return true;
    });
    // gc already holds the repository lock.
    return yield* input.mode === "reachable" && input.prune === undefined
      ? swap
      : withRepositoryLock(input.repositoryKey, swap);
  });

  const blobListArgs = [
    "rev-list",
    "--objects",
    "--no-object-names",
    "--missing=print",
    "--filter=object:type=blob",
  ];
  const objectListOptions = {
    maxOutputBytes: OBJECT_LIST_MAX_BYTES,
    outputMode: "error" as const,
    timeoutMs: MAINTENANCE_TIMEOUT_MS,
  };

  /**
   * Blobs the primary remote provably holds, from remote-tracking refs whose
   * local tip matches the live remote. Fails when the remote cannot be checked.
   */
  const planEviction = Effect.fn("SidecarCheckpointRepository.planEviction")(function* (
    cwd: string,
    identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity,
    gitDir: string,
  ) {
    const worktree = identity.worktreeRoot;
    // Grafts can splice local commits into remote history; such a project is skipped.
    if (yield* fileSystem.exists(path.join(identity.commonDir, "info", "grafts"))) {
      return undefined;
    }
    const remote = yield* primaryRemote(cwd, worktree);
    if (remote === undefined) return undefined;
    const tracking = yield* git(
      "SidecarCheckpointRepository.online.trackingRefs",
      cwd,
      [
        "-C",
        worktree,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        `refs/remotes/${remote.name}/`,
      ],
      { maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES },
    );
    const trackingPrefix = `refs/remotes/${remote.name}/`;
    const trackingRefs = tracking.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(" ");
        return [
          line.slice(separator + 1).slice(trackingPrefix.length),
          line.slice(0, separator),
        ] as const;
      })
      .filter(([branchRef]) => branchRef !== "HEAD");
    const live = yield* git(
      "SidecarCheckpointRepository.online.lsRemote",
      cwd,
      [...LOW_SPEED_CONFIG, "-C", worktree, "ls-remote", "--heads", remote.name],
      {
        env: {
          ...CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
          ...OnlineObjects.nonInteractiveNetworkEnvironment,
        },
        allowNonZeroExit: true,
        timeoutMs: LS_REMOTE_TIMEOUT_MS,
        maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES,
      },
    );
    if (live.exitCode !== 0) {
      return yield* checkpointError(
        "SidecarCheckpointRepository.online.lsRemote",
        cwd,
        `Remote check failed (${OnlineObjects.classifyRemoteFailure(live.stderr)}): ${OnlineObjects.redactUrlCredentials(live.stderr).slice(0, 2_000)}`,
      );
    }
    const liveHeads = new Map(
      live.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [oid = "", ref = ""] = line.split("\t");
          return [ref.slice("refs/heads/".length), oid] as const;
        }),
    );
    const confirmed = trackingRefs
      .filter(([branchRef, oid]) => liveHeads.get(branchRef) === oid)
      .map(([, oid]) => oid);
    if (confirmed.length === 0) return undefined;

    // Replace refs would walk local objects as if they were the remote's.
    // A blobless clone prints remote blobs it lacks as `?<oid>`; they count too.
    const remoteBlobs = new Set(
      (yield* git(
        "SidecarCheckpointRepository.online.remoteBlobs",
        cwd,
        ["--no-replace-objects", "-C", worktree, ...blobListArgs, "--stdin"],
        { ...objectListOptions, stdin: `${confirmed.join("\n")}\n` },
      )).stdout
        .split("\n")
        .map((line) => (line.startsWith("?") ? line.slice(1) : line)),
    );
    const pinned = pinnedOids(identity.repositoryKey);
    const candidates = (yield* git(
      "SidecarCheckpointRepository.online.sidecarBlobs",
      cwd,
      bareGitArgs(gitDir, [...blobListArgs, "--all"]),
      objectListOptions,
    )).stdout
      .split("\n")
      .filter(
        (line) =>
          line !== "" && !line.startsWith("?") && remoteBlobs.has(line) && !pinned.has(line),
      );
    if (candidates.length === 0) return undefined;
    // The type filter still lists commits; keep blobs only.
    const types = yield* git(
      "SidecarCheckpointRepository.online.blobTypes",
      cwd,
      bareGitArgs(gitDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"]),
      { ...objectListOptions, stdin: `${candidates.join("\n")}\n` },
    );
    const evict = new Set(
      types.stdout
        .split("\n")
        .filter((line) => line.endsWith(" blob"))
        .map((line) => line.slice(0, line.indexOf(" "))),
    );
    const [canaryOid] = evict;
    if (canaryOid === undefined) return undefined;

    // Prove the remote serves objects by id, as hydration will ask, before
    // dropping any local copy.
    const canaryDir = path.join(config.checkpointsDir, "tmp", `${NodeCrypto.randomUUID()}.git`);
    const canaryFailure = yield* git("SidecarCheckpointRepository.online.canaryInit", cwd, [
      "init",
      "--bare",
      "-q",
      `--object-format=${identity.objectFormat}`,
      canaryDir,
    ]).pipe(
      Effect.andThen(fetchObjects(cwd, canaryDir, worktree, remote.url, [canaryOid])),
      Effect.ensuring(removeTemporaryPath(canaryDir, cwd)),
    );
    if (canaryFailure !== undefined) {
      return yield* checkpointError(
        "SidecarCheckpointRepository.online.canary",
        cwd,
        `The remote did not serve a blob by id (${canaryFailure}).`,
      );
    }
    return { evict, remote };
  });

  /** Downloads every evicted blob back, so a store with Online Snapshots off needs no remote. */
  const rehydrateStore = Effect.fn("SidecarCheckpointRepository.rehydrateStore")(function* (
    cwd: string,
    identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity,
    gitDir: string,
    state: OnlineState,
  ) {
    const missing = (yield* git(
      "SidecarCheckpointRepository.rehydrate.missing",
      cwd,
      bareGitArgs(gitDir, [...blobListArgs, "--all"]),
      objectListOptions,
    )).stdout
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
    // Fetches only add objects and this pass is the only swap, so no lock is held.
    yield* hydrate({
      operation: "restore",
      cwd,
      identity,
      gitDir,
      oids: missing,
      fromProject: true,
    });
    yield* writeOnlineState(gitDir, { ...state, rehydrated: true });
  });

  const maintenancePass = Effect.fn("SidecarCheckpointRepository.maintenancePass")(function* (
    cwd: string,
    identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity,
    force: boolean,
  ) {
    const key = identity.repositoryKey;
    const gitDir = repositoryDirectory(key);
    if (!(yield* fileSystem.exists(gitDir))) return;
    if (!force && (yield* inBackoff(key))) return;
    const counts = OnlineObjects.parseCountObjects(
      (yield* git(
        "SidecarCheckpointRepository.maintenance.countObjects",
        cwd,
        bareGitArgs(gitDir, ["count-objects", "-v"]),
        { maxOutputBytes: 4_096 },
      )).stdout,
    );
    const online = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.onlineSnapshots),
      Effect.orElseSucceed(() => false),
    );
    const state = yield* readOnlineState(gitDir);
    const rehydrate =
      !online && state !== undefined && state.remotes.length > 0 && !state.rehydrated;
    if (
      !force &&
      !rehydrate &&
      counts.looseObjects < LOOSE_OBJECT_LIMIT &&
      counts.packs < PACK_LIMIT
    ) {
      return;
    }
    yield* Effect.gen(function* () {
      yield* withRepositoryLock(key, removeLeftovers(gitDir));
      if (rehydrate) yield* rehydrateStore(cwd, identity, gitDir, state);
      const evictionKey = `${key}:eviction`;
      const eviction =
        online && (force || !(yield* inBackoff(evictionKey)))
          ? yield* planEviction(cwd, identity, gitDir).pipe(
              Effect.tap(() => clearBackoff(evictionKey)),
              Effect.catchCause((cause) =>
                Effect.logWarning("checkpoint eviction skipped", {
                  cause: Cause.pretty(cause),
                }).pipe(Effect.andThen(backOff(evictionKey)), Effect.as(undefined)),
              ),
            )
          : undefined;
      if (eviction !== undefined && eviction.evict.size > 0) {
        // Hydration must know every remote it may need before anything is deleted.
        const remotes = state?.remotes ?? [];
        yield* writeOnlineState(gitDir, {
          remotes: remotes.some(
            (remote) => remote.name === eviction.remote.name && remote.url === eviction.remote.url,
          )
            ? remotes
            : [
                ...remotes,
                {
                  name: eviction.remote.name,
                  url: OnlineObjects.credentialFreeUrl(eviction.remote.url),
                },
              ],
          rehydrated: false,
        });
      }
      const full = force || (eviction?.evict.size ?? 0) > 0 || counts.packs >= PACK_LIMIT;
      if (full || counts.looseObjects >= LOOSE_OBJECT_LIMIT) {
        yield* repack({
          operation: "SidecarCheckpointRepository.maintenance.repack",
          cwd,
          repositoryKey: key,
          gitDir,
          mode: full ? "full" : "loose",
          evict: eviction?.evict ?? new Set(),
        });
      }
      yield* clearBackoff(key);
    }).pipe(Effect.tapCause(() => backOff(key)));
  });

  interface MaintenanceRun {
    cwd: string;
    force: boolean;
    pending: boolean;
    readonly done: Deferred.Deferred<void>;
  }
  const maintenanceRuns = new Map<string, MaintenanceRun>();

  /**
   * Single-flight per sidecar: a request during a pass queues one more pass,
   * and every caller resumes once no pass is pending. Failures are only logged.
   */
  const maintainRepository = (
    identity: CheckpointRepositoryIdentity.CheckpointRepositoryIdentity,
    cwd: string,
    force: boolean,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      const key = identity.repositoryKey;
      const running = maintenanceRuns.get(key);
      if (running !== undefined) {
        running.pending = true;
        running.cwd = cwd;
        running.force ||= force;
        return Deferred.await(running.done);
      }
      const run: MaintenanceRun = { cwd, force, pending: true, done: Deferred.makeUnsafe() };
      maintenanceRuns.set(key, run);
      const loop: Effect.Effect<void> = Effect.suspend(() => {
        if (!run.pending) {
          maintenanceRuns.delete(key);
          return Effect.void;
        }
        const pass = maintenancePass(run.cwd, identity, run.force);
        run.pending = false;
        run.force = false;
        return withMaintenanceLock(key, pass).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("checkpoint sidecar maintenance failed", {
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.andThen(loop),
        );
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (maintenanceRuns.get(key) === run) maintenanceRuns.delete(key);
            return Deferred.succeed(run.done, undefined);
          }),
        ),
      );
    });

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
        // Captures cover the whole worktree without ignored paths, so an ignored
        // workspace with no capturable files would publish snapshots that miss its
        // edits. Negated rules can still re-include files below an ignored folder.
        const ignored = yield* git(
          "SidecarCheckpointRepository.capture.ignoredWorkspace",
          input.cwd,
          ["-C", input.cwd, "check-ignore", "--no-index", "-q", "."],
          { allowNonZeroExit: true },
        );
        if (ignored.exitCode !== 0 && ignored.exitCode !== 1) {
          return yield* checkpointError(
            "SidecarCheckpointRepository.capture.ignoredWorkspace",
            input.cwd,
            ignored.stderr.trim() || "git check-ignore failed",
          );
        }
        if (ignored.exitCode === 0) {
          const capturable = yield* git(
            "SidecarCheckpointRepository.capture.ignoredWorkspace",
            input.cwd,
            [
              "-C",
              input.cwd,
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "-z",
              "--",
              ".",
            ],
            { maxOutputBytes: 1 },
          );
          if (capturable.stdout.length === 0) {
            return yield* new VcsUnsupportedOperationError({
              operation: "SidecarCheckpointRepository.capture",
              kind: "git",
              detail: "The workspace directory is ignored by its Git repository.",
            });
          }
        }

        // A private index kept per worktree. Its stat cache lets update-index hash
        // only files changed since the last capture, as the project's own index
        // does, and the tree matches one built from an empty index.
        const indexDirectory = path.join(gitDir, PERSISTED_INDEXES_DIRECTORY, identity.worktreeKey);
        const indexPath = path.join(indexDirectory, "index");
        const indexKeyPath = path.join(indexDirectory, "key");
        const baseEnvironment = {
          ...CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
          GIT_AUTHOR_NAME: "T3 Code",
          GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
          GIT_COMMITTER_NAME: "T3 Code",
          GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        };
        const environment = { ...baseEnvironment, GIT_INDEX_FILE: indexPath };
        // Blobs depend on line-ending attributes and the sidecar's core settings.
        // When either changes, unchanged files must be hashed again.
        const persistedIndexKey = Effect.fn("SidecarCheckpointRepository.capture.indexKey")(
          function* (paths: ReadonlyArray<string>) {
            const hash = NodeCrypto.createHash("sha256");
            hash.update(
              yield* fileSystem
                .readFileString(path.join(gitDir, "config"))
                .pipe(Effect.orElseSucceed(() => "")),
            );
            for (const relativePath of paths) {
              if (relativePath !== ".gitattributes" && !relativePath.endsWith("/.gitattributes")) {
                continue;
              }
              const info = yield* lstat(
                "SidecarCheckpointRepository.capture.indexKey",
                input.cwd,
                path.join(identity.worktreeRoot, relativePath),
              );
              hash.update(
                `\0${relativePath}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\0${info.ino}`,
              );
            }
            return hash.digest("hex");
          },
        );
        yield* Effect.gen(function* () {
          yield* fileSystem
            .makeDirectory(indexDirectory, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.mapError(() =>
                checkpointError(
                  "SidecarCheckpointRepository.capture",
                  input.cwd,
                  "Unable to create the sidecar capture index directory.",
                ),
              ),
            );
          const buildTree = Effect.fn("SidecarCheckpointRepository.capture.buildTree")(
            function* (operationSuffix: string) {
              const [workspace, changed] = yield* Effect.all([
                workspacePaths(input.cwd, identity.worktreeRoot),
                git(
                  "SidecarCheckpointRepository.capture.changedPaths",
                  input.cwd,
                  ["-C", identity.worktreeRoot, "ls-files", "--modified", "-z"],
                  { maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES },
                ),
              ]);
              // A tracked file that is gone is a deletion. One replaced by a folder
              // is captured through the folder's own paths, unless the folder is a
              // repository and so a gitlink. Neither kind can be added.
              const removedPaths = new Set<string>();
              yield* Effect.forEach(
                changed.stdout.split("\0").filter(Boolean),
                (relativePath) =>
                  Effect.tryPromise({
                    try: async () => {
                      const lstatIfPresent = (target: string) =>
                        NodeFSP.lstat(target).catch((error: NodeJS.ErrnoException) =>
                          error.code === "ENOENT" || error.code === "ENOTDIR"
                            ? undefined
                            : Promise.reject(error),
                        );
                      const absolutePath = path.join(identity.worktreeRoot, relativePath);
                      const info = await lstatIfPresent(absolutePath);
                      if (
                        info === undefined ||
                        (info.isDirectory() &&
                          (await lstatIfPresent(path.join(absolutePath, ".git"))) === undefined)
                      ) {
                        removedPaths.add(relativePath);
                      }
                    },
                    catch: () =>
                      checkpointError(
                        "SidecarCheckpointRepository.capture.changedPaths",
                        input.cwd,
                        "Unable to inspect a checkpoint path.",
                      ),
                  }),
                { concurrency: 16, discard: true },
              );
              // An uninitialized submodule is an empty folder at a tracked gitlink.
              // Git reports it unmodified but update-index cannot add a folder
              // without its repository, so its recorded commit is staged instead.
              // Entries read `<mode> <oid> <stage>\t<path>`.
              const staged = yield* git(
                "SidecarCheckpointRepository.capture.gitlinks",
                input.cwd,
                ["-C", identity.worktreeRoot, "ls-files", "--stage", "-z"],
                { maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES },
              );
              const uninitializedGitlinks = new Map<string, string>();
              yield* Effect.forEach(
                staged.stdout.split("\0").filter((entry) => entry.startsWith("160000 ")),
                (entry) => {
                  const tab = entry.indexOf("\t");
                  const oid = entry.slice(7, entry.indexOf(" ", 7));
                  const relativePath = entry.slice(tab + 1);
                  if (removedPaths.has(relativePath)) return Effect.void;
                  const absolutePath = path.join(identity.worktreeRoot, relativePath);
                  return Effect.tryPromise({
                    // Only a real folder qualifies: a file or symlink in its place is
                    // ordinary content that update-index captures itself.
                    try: async () => {
                      const info = await NodeFSP.lstat(absolutePath).catch(
                        (error: NodeJS.ErrnoException) =>
                          error.code === "ENOENT" || error.code === "ENOTDIR"
                            ? undefined
                            : Promise.reject(error),
                      );
                      if (info === undefined || !info.isDirectory()) return;
                      await NodeFSP.lstat(path.join(absolutePath, ".git")).then(
                        () => undefined,
                        (error: NodeJS.ErrnoException) => {
                          if (error.code !== "ENOENT") throw error;
                          uninitializedGitlinks.set(relativePath, oid);
                        },
                      );
                    },
                    catch: () =>
                      checkpointError(
                        "SidecarCheckpointRepository.capture.gitlinks",
                        input.cwd,
                        "Unable to inspect a submodule path.",
                      ),
                  });
                },
                { concurrency: 16, discard: true },
              );
              const paths = workspace.filter((relativePath) => !removedPaths.has(relativePath));
              const addedPaths = paths.filter(
                (relativePath) => !uninitializedGitlinks.has(relativePath),
              );
              const indexKey = yield* persistedIndexKey(paths);
              const storedIndexKey = yield* fileSystem
                .readFileString(indexKeyPath)
                .pipe(Effect.orElseSucceed(() => ""));
              if (storedIndexKey !== indexKey) {
                yield* git(
                  `SidecarCheckpointRepository.capture.emptyIndex.${operationSuffix}`,
                  input.cwd,
                  sidecarGitArgs(gitDir, identity.worktreeRoot, ["read-tree", "--empty"]),
                  { env: environment },
                );
                yield* fileSystem
                  .writeFileString(indexKeyPath, indexKey)
                  .pipe(
                    Effect.mapError(() =>
                      checkpointError(
                        "SidecarCheckpointRepository.capture",
                        input.cwd,
                        "Unable to record the checkpoint index key.",
                      ),
                    ),
                  );
              } else {
                // Drop entries the workspace no longer has, such as deleted or
                // newly ignored files, so only current paths reach the tree.
                const pathSet = new Set(paths);
                const indexed = yield* git(
                  `SidecarCheckpointRepository.capture.indexedPaths.${operationSuffix}`,
                  input.cwd,
                  sidecarGitArgs(gitDir, identity.worktreeRoot, ["ls-files", "-z"]),
                  { env: environment, maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES },
                );
                const stalePaths = indexed.stdout
                  .split("\0")
                  .filter((relativePath) => relativePath.length > 0 && !pathSet.has(relativePath));
                if (stalePaths.length > 0) {
                  yield* git(
                    `SidecarCheckpointRepository.capture.removeStale.${operationSuffix}`,
                    input.cwd,
                    sidecarGitArgs(gitDir, identity.worktreeRoot, [
                      "update-index",
                      "--force-remove",
                      "-z",
                      "--stdin",
                    ]),
                    { env: environment, stdin: `${stalePaths.join("\0")}\0` },
                  );
                }
              }
              // update-index skips entries whose stat is unchanged, and unlike
              // `git add` it does not match every path against every pathspec.
              if (addedPaths.length > 0) {
                yield* git(
                  `SidecarCheckpointRepository.capture.add.${operationSuffix}`,
                  input.cwd,
                  sidecarGitArgs(gitDir, identity.worktreeRoot, [
                    "update-index",
                    "--add",
                    "--replace",
                    "-z",
                    "--stdin",
                  ]),
                  { env: environment, stdin: `${addedPaths.join("\0")}\0` },
                );
              }
              if (uninitializedGitlinks.size > 0) {
                yield* git(
                  `SidecarCheckpointRepository.capture.addGitlinks.${operationSuffix}`,
                  input.cwd,
                  sidecarGitArgs(gitDir, identity.worktreeRoot, [
                    "update-index",
                    "--add",
                    "-z",
                    "--index-info",
                  ]),
                  {
                    env: environment,
                    stdin: [...uninitializedGitlinks]
                      .map(([relativePath, oid]) => `160000 ${oid}\t${relativePath}\0`)
                      .join(""),
                  },
                );
              }
              // update-index wrote every entry's blob; only eviction (the remote has
              // it) or gc (which drops this index) can remove one afterwards.
              const tree = yield* git(
                `SidecarCheckpointRepository.capture.writeTree.${operationSuffix}`,
                input.cwd,
                sidecarGitArgs(gitDir, identity.worktreeRoot, ["write-tree", "--missing-ok"]),
                { env: environment, maxOutputBytes: 4_096 },
              );
              return tree.stdout.trim();
            },
            Effect.onError(() => removeTemporaryPath(indexDirectory, input.cwd)),
          );
          // The project HEAD at capture lets authoredPaths tell the turn's own
          // commits from ones a pull or rebase brought in.
          const head = yield* git(
            "SidecarCheckpointRepository.capture.head",
            input.cwd,
            ["-C", identity.worktreeRoot, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            { allowNonZeroExit: true, maxOutputBytes: 4_096 },
          );
          const headOid = head.exitCode === 0 ? head.stdout.trim() : "";
          const treeOid = yield* buildTree("initial");
          if (!treeOid)
            return yield* checkpointError(
              "SidecarCheckpointRepository.capture",
              input.cwd,
              "Sidecar write-tree returned no object id.",
            );
          // A second pass over the same index rehashes any file whose stat
          // changed since the first, so a concurrent edit changes the tree.
          const verificationTreeOid = yield* buildTree("verification");
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
              `t3 checkpoint schema=v1 snapshot=${locator.snapshotId} worktree=${identity.worktreeKey}${
                headOid === "" ? "" : ` head=${headOid}`
              }`,
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
          yield* Effect.forkIn(maintainRepository(identity, input.cwd, false), serviceScope);
        });
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
    return yield* withRepositoryLock(
      identity.repositoryKey,
      Effect.gen(function* () {
        const commit = yield* resolveCommit(input.cwd, gitDir, identity.worktreeRoot, locator);
        if (!commit) return false;
        const [entries, currentPaths] = yield* Effect.all([
          snapshotEntries(input.cwd, gitDir, identity.worktreeRoot, commit),
          workspacePaths(input.cwd, identity.worktreeRoot),
        ]);
        yield* ensureSnapshotObjects({ cwd: input.cwd, identity, gitDir, entries });
        const targetPaths = entries.map((entry) => entry.relativePath);
        const targetPathSet = new Set(targetPaths);
        const stalePaths = currentPaths.filter((relativePath) => !targetPathSet.has(relativePath));
        const temporaryDir = path.join(config.checkpointsDir, "tmp", NodeCrypto.randomUUID());
        const indexPath = path.join(temporaryDir, "index");
        const preparedRoot = path.join(temporaryDir, "prepared");
        const stagedWorkspacePaths: Array<string> = [];
        const environment = {
          ...projectObjectsEnvironment(identity),
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
            const info = yield* lstat(
              "SidecarCheckpointRepository.restore.stage",
              input.cwd,
              source,
            );
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
      }),
    );
  });

  const prepareRestore: SidecarCheckpointRepository["Service"]["prepareRestore"] = Effect.fn(
    "SidecarCheckpointRepository.prepareRestore",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    const locator = yield* locatorForIdentity(
      "SidecarCheckpointRepository.prepareRestore",
      input.cwd,
      input.checkpointRef,
      identity,
    );
    const gitDir = repositoryDirectory(identity.repositoryKey);
    // Retention may have removed it; failing here keeps a rollback from changing anything.
    const unavailable = new CheckpointSnapshotUnavailableError();
    if (!(yield* fileSystem.exists(gitDir))) return yield* unavailable;
    yield* withRepositoryLock(
      identity.repositoryKey,
      Effect.gen(function* () {
        const commit = yield* resolveCommit(input.cwd, gitDir, identity.worktreeRoot, locator);
        if (!commit) return yield* unavailable;
        const entries = yield* snapshotEntries(input.cwd, gitDir, identity.worktreeRoot, commit);
        yield* ensureSnapshotObjects({ cwd: input.cwd, identity, gitDir, entries });
        // Pinned under the lock, so no swap can run between the download and the pin.
        yield* pinObjects(
          identity.repositoryKey,
          entries.filter((entry) => entry.type === "blob").map((entry) => entry.oid),
        );
      }),
    );
  });

  const diff: SidecarCheckpointRepository["Service"]["diff"] = Effect.fn(
    "SidecarCheckpointRepository.diff",
  )(function* (input) {
    if (input.filePaths?.length === 0) return "";
    const identity = yield* identities.resolve(input.cwd);
    const gitDir = repositoryDirectory(identity.repositoryKey);
    const environment = projectObjectsEnvironment(identity);
    return yield* withRepositoryLock(
      identity.repositoryKey,
      Effect.gen(function* () {
        if (!(yield* fileSystem.exists(gitDir)))
          return yield* new CheckpointSnapshotUnavailableError();
        // A project revision is read through a per-command alternate. Fetching it
        // would copy the whole project history, since the sidecar has no refs in
        // common to negotiate with; a persistent alternate would break when the
        // project's own gc drops the revision.
        const projectRevision = Effect.fn(
          "SidecarCheckpointRepository.resolveWorktreeDiffRevision",
        )(function* (sourceRevision: string) {
          const resolved = yield* git(
            "SidecarCheckpointRepository.resolveWorktreeDiffRevision",
            input.cwd,
            [
              "-C",
              identity.worktreeRoot,
              "rev-parse",
              "--verify",
              "--quiet",
              `${sourceRevision}^{commit}`,
            ],
            { allowNonZeroExit: true, maxOutputBytes: 4_096 },
          );
          const commit = resolved.exitCode === 0 ? resolved.stdout.trim() || undefined : undefined;
          if (!commit) return undefined;
          const visible = yield* git(
            "SidecarCheckpointRepository.verifyWorktreeDiffRevision",
            input.cwd,
            sidecarGitArgs(gitDir, identity.worktreeRoot, [
              "rev-parse",
              "--verify",
              "--quiet",
              `${commit}^{commit}`,
            ]),
            { env: environment, allowNonZeroExit: true, maxOutputBytes: 4_096 },
          );
          return visible.exitCode === 0 && visible.stdout.trim() === commit ? commit : undefined;
        });
        const resolveRevision = Effect.fn("SidecarCheckpointRepository.resolveDiffRevision")(
          function* (checkpointRef: CheckpointRef, fallbackToHead: boolean) {
            if (isSidecarCheckpointRef(checkpointRef)) {
              const locator = yield* locatorForIdentity(
                "SidecarCheckpointRepository.diff",
                input.cwd,
                checkpointRef,
                identity,
              );
              const commit = yield* resolveCommit(
                input.cwd,
                gitDir,
                identity.worktreeRoot,
                locator,
              );
              return commit ?? (fallbackToHead ? yield* projectRevision("HEAD") : undefined);
            }
            return (
              (yield* projectRevision(String(checkpointRef))) ??
              (fallbackToHead ? yield* projectRevision("HEAD") : undefined)
            );
          },
        );
        const [fromCommit, toCommit] = yield* Effect.all([
          resolveRevision(input.fromCheckpointRef, input.fallbackFromToHead === true),
          resolveRevision(input.toCheckpointRef, false),
        ]);
        if (!fromCommit || !toCommit) {
          if (!isSidecarCheckpointRef(fromCommit ? input.toCheckpointRef : input.fromCheckpointRef))
            return yield* checkpointError(
              "SidecarCheckpointRepository.diff",
              input.cwd,
              "Checkpoint revision is unavailable.",
            );
          return yield* new CheckpointSnapshotUnavailableError();
        }
        const pathspec = input.filePaths
          ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`)]
          : [];
        // Only changed paths have their blobs read. Records read
        // `:<mode> <mode> <oid> <oid> <status>`, each followed by its paths.
        const changed = yield* git(
          "SidecarCheckpointRepository.diff.changedObjects",
          input.cwd,
          sidecarGitArgs(gitDir, identity.worktreeRoot, [
            "diff-tree",
            "-r",
            "--raw",
            "-z",
            "--no-renames",
            fromCommit,
            toCommit,
            ...pathspec,
          ]),
          { env: environment, maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES, outputMode: "error" },
        );
        const records = OnlineObjects.parseRawDiff(changed.stdout);
        const blobs = OnlineObjects.rawDiffBlobs(records);
        if (input.allowNetwork === false) {
          const missing = yield* missingObjects(input.cwd, gitDir, blobs, environment);
          if (missing.length > 0) {
            if (input.format !== "numstat") {
              return yield* checkpointError(
                "SidecarCheckpointRepository.diff",
                input.cwd,
                "Sidecar diff needs file versions that are not stored locally.",
              );
            }
            // Line counts need the evicted versions; the changed paths do not.
            return records.map((record) => `-\t-\t${record.path}\0`).join("");
          }
        } else {
          yield* hydrate({
            operation: "diff",
            cwd: input.cwd,
            identity,
            gitDir,
            oids: blobs,
            env: environment,
          });
        }
        const result = yield* git(
          "SidecarCheckpointRepository.diff",
          input.cwd,
          sidecarGitArgs(gitDir, identity.worktreeRoot, [
            "diff",
            ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--binary", "--patch"]),
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
            fromCommit,
            toCommit,
            ...pathspec,
          ]),
          {
            env: environment,
            allowNonZeroExit: true,
            maxOutputBytes: 10_000_000,
            outputMode: input.format === "numstat" ? "error" : "truncate",
          },
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

  const authoredPaths: SidecarCheckpointRepository["Service"]["authoredPaths"] = Effect.fn(
    "SidecarCheckpointRepository.authoredPaths",
  )(function* (input) {
    const operation = "SidecarCheckpointRepository.authoredPaths";
    const identity = yield* identities.resolve(input.cwd);
    const gitDir = repositoryDirectory(identity.repositoryKey);
    if (!(yield* fileSystem.exists(gitDir))) return null;
    // Each boundary as its commit, the project HEAD it recorded, and its capture time.
    const boundary = Effect.fn("SidecarCheckpointRepository.authoredPaths.boundary")(function* (
      checkpointRef: CheckpointRef,
    ) {
      if (!isSidecarCheckpointRef(checkpointRef)) {
        // In-repo checkpoints record HEAD as their parent.
        const result = yield* git(
          operation,
          input.cwd,
          [
            "-C",
            identity.worktreeRoot,
            "log",
            "--no-walk",
            "--format=%H %P %ct",
            `${checkpointRef}^{commit}`,
          ],
          { allowNonZeroExit: true, maxOutputBytes: 4_096 },
        );
        const [commit = "", head = "", time = ""] = result.stdout.trim().split(" ");
        return result.exitCode === 0 && commit !== "" ? { commit, head, time } : undefined;
      }
      const locator = yield* locatorForIdentity(operation, input.cwd, checkpointRef, identity);
      const commit = yield* resolveCommit(input.cwd, gitDir, identity.worktreeRoot, locator);
      if (!commit) return undefined;
      const result = yield* git(
        operation,
        input.cwd,
        sidecarGitArgs(gitDir, identity.worktreeRoot, [
          "log",
          "--no-walk",
          "--format=%ct %s",
          commit,
        ]),
        { maxOutputBytes: 4_096 },
      );
      const [time = "", ...subject] = result.stdout.trim().split(" ");
      const head = /(?:^| )head=([0-9a-f]+)$/.exec(subject.join(" "))?.[1] ?? "";
      return { commit, head, time };
    });
    const [from, to] = yield* Effect.all([
      boundary(input.fromCheckpointRef),
      boundary(input.toCheckpointRef),
    ]);
    if (!from || !to || from.head === "" || to.head === "" || from.head === to.head) return null;

    // Read-only queries in the project repository. The sidecar objects are an
    // alternate for this process alone, so nothing is written to the project.
    const environment = {
      ...CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, "objects"),
    };
    const listPaths = (args: ReadonlyArray<string>) =>
      git(
        operation,
        input.cwd,
        [
          "-C",
          identity.worktreeRoot,
          ...args,
          "--name-only",
          "-z",
          "--no-renames",
          "--no-ext-diff",
        ],
        { env: environment, maxOutputBytes: 10_000_000, outputMode: "error" },
      ).pipe(Effect.map((result) => result.stdout.split("\0")));
    // Uncommitted edits at either boundary, commits that left HEAD, and commits
    // made after the "from" capture belong to the turn; older commits were imported.
    const pathLists = yield* Effect.all(
      [
        listPaths(["diff", from.head, from.commit]),
        listPaths(["diff", to.head, to.commit]),
        listPaths(["log", "--format=", "--diff-merges=remerge", `${to.head}..${from.head}`]),
        listPaths([
          "log",
          "--format=",
          "--diff-merges=remerge",
          `--since=@${from.time}`,
          `${from.head}..${to.head}`,
        ]),
      ],
      { concurrency: "unbounded" },
    );
    return new Set(pathLists.flat().filter((entry) => entry.length > 0));
  });

  const maintain: SidecarCheckpointRepository["Service"]["maintain"] = Effect.fn(
    "SidecarCheckpointRepository.maintain",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    yield* maintainRepository(identity, input.cwd, input.force === true);
  });

  const gc: SidecarCheckpointRepository["Service"]["gc"] = Effect.fn(
    "SidecarCheckpointRepository.gc",
  )(function* (input) {
    const identity = yield* identities.resolve(input.cwd);
    const gitDir = repositoryDirectory(identity.repositoryKey);
    if (!(yield* fileSystem.exists(gitDir))) return false;
    // `git gc` cannot pack a store with evicted blobs, so gc repacks reachable
    // objects itself. Pruning can remove blobs only a capture index still names.
    return yield* withMaintenanceLock(
      identity.repositoryKey,
      withRepositoryLock(
        identity.repositoryKey,
        removeTemporaryPath(path.join(gitDir, PERSISTED_INDEXES_DIRECTORY), input.cwd).pipe(
          Effect.andThen(removeLeftovers(gitDir)),
          Effect.andThen(
            repack({
              operation: "SidecarCheckpointRepository.gc",
              cwd: input.cwd,
              repositoryKey: identity.repositoryKey,
              gitDir,
              mode: "reachable",
              evict: new Set(),
            }),
          ),
          Effect.andThen(
            git(
              "SidecarCheckpointRepository.gc.packRefs",
              input.cwd,
              bareGitArgs(gitDir, ["pack-refs", "--all", "--prune"]),
            ),
          ),
          Effect.as(true),
        ),
      ),
    );
  });

  const directoryBytes = (root: string) =>
    Effect.promise(async () => {
      let bytes = 0;
      const pending = [root];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true }).catch(
          () => [],
        )) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(target);
          else if (entry.isFile())
            bytes += (await NodeFSP.lstat(target).catch(() => undefined))?.size ?? 0;
        }
      }
      return bytes;
    });

  /**
   * Repacks what refs, persisted capture indexes, and pins still name. It packs
   * without the repository lock, so a capture, import, or pin in the meantime
   * cancels the swap and the next sweep tries again.
   */
  const prune = Effect.fn("SidecarCheckpointRepository.prune")(function* (
    repositoryKey: string,
    gitDir: string,
  ) {
    const cwd = config.checkpointsDir;
    const indexesDirectory = path.join(gitDir, PERSISTED_INDEXES_DIRECTORY);
    // An unreadable list must fail the prune, never read as "no indexes".
    const indexNames = fileSystem.readDirectory(indexesDirectory).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
      Effect.map((names) => names.sort()),
    );
    const fingerprint = Effect.gen(function* () {
      const refs = yield* git(
        "SidecarCheckpointRepository.prune.refs",
        cwd,
        bareGitArgs(gitDir, ["for-each-ref", "--format=%(objectname) %(refname)"]),
        { maxOutputBytes: OBJECT_LIST_MAX_BYTES, outputMode: "error" },
      );
      const indexes: Array<string> = [];
      for (const name of yield* indexNames) {
        indexes.push(
          yield* Effect.promise(() =>
            NodeFSP.readFile(path.join(indexesDirectory, name, "index")).then(
              (contents) =>
                `${name} ${NodeCrypto.createHash("sha256").update(contents).digest("hex")}`,
              () => `${name} -`,
            ),
          ),
        );
      }
      return [
        refs.stdout,
        indexes.join("\n"),
        [...pinnedOids(repositoryKey).keys()].sort().join("\n"),
      ].join("\0");
    });
    const before = yield* fingerprint;
    // The next capture reuses index entries without hashing, so their blobs stay.
    // Entries read `<mode> <oid> <stage>\t<path>`; gitlinks name project commits.
    const named = new Set(pinnedOids(repositoryKey).keys());
    for (const name of yield* indexNames) {
      const listed = yield* git(
        "SidecarCheckpointRepository.prune.indexEntries",
        cwd,
        bareGitArgs(gitDir, ["ls-files", "--stage", "-z"]),
        {
          env: {
            ...CheckpointRepositoryIdentity.sanitizedGitEnvironment(),
            GIT_INDEX_FILE: path.join(indexesDirectory, name, "index"),
          },
          maxOutputBytes: CHECKPOINT_PATHS_MAX_BYTES,
          outputMode: "error",
        },
      );
      for (const entry of listed.stdout.split("\0")) {
        const [mode, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
        if (mode !== undefined && mode !== "160000" && oid !== undefined && OBJECT_ID.test(oid)) {
          named.add(oid);
        }
      }
    }
    // Evicted blobs are missing on purpose and stay that way.
    const missing = new Set(yield* missingObjects(cwd, gitDir, named));
    return yield* repack({
      operation: "SidecarCheckpointRepository.prune.repack",
      cwd,
      repositoryKey,
      gitDir,
      mode: "reachable",
      evict: new Set(),
      prune: {
        keep: [...named].filter((oid) => !missing.has(oid)),
        unchanged: fingerprint.pipe(Effect.map((after) => after === before)),
      },
    });
  });

  const retainRepository = Effect.fn("SidecarCheckpointRepository.retainRepository")(function* (
    repositoryKey: string,
    live: ReadonlySet<string>,
    cutoffMs: number,
  ) {
    const cwd = config.checkpointsDir;
    const gitDir = repositoryDirectory(repositoryKey);
    const pendingPath = path.join(gitDir, PRUNE_PENDING_FILE);
    const old = (timeMs: number) => timeMs > 0 && timeMs < cutoffMs;
    // Capture time is the commit's committer date; a young snapshot may not be in projections yet.
    const expired = git(
      "SidecarCheckpointRepository.retain.refs",
      cwd,
      bareGitArgs(gitDir, [
        "for-each-ref",
        "--format=%(objectname) %(committerdate:unix) %(refname)",
        "refs/t3/s/",
      ]),
      { maxOutputBytes: OBJECT_LIST_MAX_BYTES, outputMode: "error" },
    ).pipe(
      Effect.map((result) => {
        const refs = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [oid = "", seconds = "", ref = ""] = line.split(" ");
            return { oid, ref, capturedAtMs: Number(seconds) * 1_000 };
          });
        return {
          count: refs.length,
          stale: refs.filter((ref) => !live.has(ref.ref) && old(ref.capturedAtMs)),
        };
      }),
    );
    const modifiedMs = Effect.promise(() =>
      NodeFSP.lstat(gitDir).then(
        (info) => info.mtimeMs,
        () => Number.POSITIVE_INFINITY,
      ),
    );
    return yield* withMaintenanceLock(
      repositoryKey,
      Effect.gen(function* () {
        const pending = yield* fileSystem.exists(pendingPath);
        const listed = yield* expired;
        if (
          !pending &&
          (listed.count === 0 ? !old(yield* modifiedMs) : listed.stale.length === 0)
        ) {
          return { snapshots: 0, removed: false, left: false, bytes: 0 };
        }
        const bytesBefore = yield* directoryBytes(gitDir);
        const outcome = yield* withRepositoryLock(
          repositoryKey,
          Effect.gen(function* () {
            const { count, stale } = yield* expired;
            if (
              count === stale.length &&
              (count > 0 || old(yield* modifiedMs)) &&
              !pins.has(repositoryKey)
            ) {
              // A rename detaches the store at once; Windows may keep files open after it.
              const detached = path.join(
                config.checkpointsDir,
                "tmp",
                `${DETACHED_STORE_PREFIX}${NodeCrypto.randomUUID()}.git`,
              );
              yield* fileSystem.makeDirectory(path.dirname(detached), { recursive: true });
              yield* fileSystem.rename(gitDir, detached);
              return {
                snapshots: count,
                removed: true,
                left: !(yield* removeIfPossible(detached)),
              };
            }
            if (stale.length > 0) {
              yield* fileSystem.writeFileString(pendingPath, "");
              yield* git(
                "SidecarCheckpointRepository.retain.deleteRefs",
                cwd,
                bareGitArgs(gitDir, ["update-ref", "--stdin"]),
                { stdin: stale.map((ref) => `delete ${ref.ref} ${ref.oid}\n`).join("") },
              );
            }
            return { snapshots: stale.length, removed: false, left: false };
          }),
        );
        if (!outcome.removed && (pending || outcome.snapshots > 0)) {
          if (yield* prune(repositoryKey, gitDir)) {
            yield* fileSystem.remove(pendingPath, { force: true });
          }
        }
        if (outcome.left) return { ...outcome, bytes: 0 };
        const bytesAfter = outcome.removed ? 0 : yield* directoryBytes(gitDir);
        return { ...outcome, bytes: Math.max(0, bytesBefore - bytesAfter) };
      }),
    );
  });

  const retain: SidecarCheckpointRepository["Service"]["retain"] = Effect.fn(
    "SidecarCheckpointRepository.retain",
  )(function* (input) {
    const live = new Map<string, Set<string>>();
    for (const checkpointRef of input.live) {
      const locator = parseSidecarCheckpointRef(checkpointRef);
      if (locator === undefined) continue;
      const refs = live.get(locator.repositoryKey) ?? new Set<string>();
      refs.add(sidecarRef(locator));
      live.set(locator.repositoryKey, refs);
    }
    // Git records whole seconds; the extra second absorbs clock skew between processes.
    const cutoffMs = Math.floor(input.protectedSince / 1_000) * 1_000 - 1_000;
    const repositoriesDirectory = path.join(config.checkpointsDir, "repositories");
    const names = (yield* fileSystem.exists(repositoriesDirectory))
      ? yield* fileSystem.readDirectory(repositoriesDirectory)
      : [];
    let snapshots = 0;
    let repositories = 0;
    let bytes = 0;
    const failures: Array<string> = [];
    const temporaryDirectory = path.join(config.checkpointsDir, "tmp");
    for (const name of yield* fileSystem
      .readDirectory(temporaryDirectory)
      .pipe(Effect.orElseSucceed((): Array<string> => []))) {
      if (!name.startsWith(DETACHED_STORE_PREFIX)) continue;
      const detached = path.join(temporaryDirectory, name);
      const detachedBytes = yield* directoryBytes(detached);
      if (yield* removeIfPossible(detached)) {
        repositories++;
        bytes += detachedBytes;
      } else {
        failures.push(DETACHED_STORE_LEFT);
      }
    }
    for (const name of names.sort()) {
      const repositoryKey = name.slice(0, -".git".length);
      if (!name.endsWith(".git") || !IDENTITY_KEY_PATTERN.test(repositoryKey)) continue;
      yield* retainRepository(repositoryKey, live.get(repositoryKey) ?? new Set(), cutoffMs).pipe(
        Effect.map((outcome) => {
          snapshots += outcome.snapshots;
          bytes += outcome.bytes;
          if (outcome.left) failures.push(DETACHED_STORE_LEFT);
          else if (outcome.snapshots > 0 || outcome.removed) repositories++;
        }),
        Effect.catch((error) =>
          Effect.gen(function* () {
            failures.push(error.message.split(/\r?\n/)[0] ?? error.message);
            yield* Effect.logWarning("checkpoint retention failed for a sidecar store", {
              repositoryKey,
              error,
            });
          }),
        ),
      );
    }
    return { snapshots, repositories, bytes, failures };
  });

  return SidecarCheckpointRepository.of({
    allocate,
    capture,
    captureWithMetadata,
    has,
    restore,
    prepareRestore,
    diff,
    authoredPaths,
    importLegacy,
    delete: deleteCheckpoints,
    maintain,
    gc,
    retain,
  });
});

export const layer = Layer.effect(SidecarCheckpointRepository, make).pipe(
  Layer.provide(CheckpointRepositoryIdentity.layer),
);
