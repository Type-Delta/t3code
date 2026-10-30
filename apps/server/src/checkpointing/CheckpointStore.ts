import {
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type CheckpointRef,
  type VcsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface AllocateCheckpointRefInput {
  readonly cwd: string;
  readonly snapshotId: string;
}

export interface CaptureCheckpointMetadata {
  readonly commitOid: string;
  readonly treeOid: string;
  readonly repositoryKey: string;
  readonly worktreeKey: string;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** False never downloads evicted file versions; see `SidecarDiffInput.allowNetwork`. */
  readonly allowNetwork?: boolean;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /** Allocate an opaque repository/worktree-bound sidecar locator. */
    readonly allocateCheckpointRef: (
      input: AllocateCheckpointRefInput,
    ) => Effect.Effect<CheckpointRef, CheckpointStoreError>;

    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Capture a sidecar and return verified object/ownership metadata. */
    readonly captureCheckpointWithMetadata: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<CaptureCheckpointMetadata, CheckpointStoreError>;

    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Downloads what a restore would read, so it can fail before anything else
     * changes, and keeps it local until the scope closes.
     */
    readonly prepareRestoreCheckpoint: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<void, CheckpointStoreError, Scope.Scope>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /** Null means HEAD is unchanged or unrecorded; all changed paths then belong to the turn. */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;

  const normalizeSidecarError = <A, E extends CheckpointStoreError, R>(
    cwd: string,
    effect: Effect.Effect<A, E | PlatformError.PlatformError, R>,
  ): Effect.Effect<A, E | VcsError, R> =>
    effect.pipe(
      Effect.mapError((error) =>
        error._tag === "PlatformError"
          ? new VcsProcessExitError({
              operation: "CheckpointStore.sidecar",
              command: "git",
              cwd,
              exitCode: 1,
              detail: "Sidecar checkpoint filesystem operation failed.",
            })
          : error,
      ),
    );

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  // Detection answers a non-Git workspace with stats alone, so a turn in a
  // plain folder spawns no git process.
  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  const allocateCheckpointRef: CheckpointStore["Service"]["allocateCheckpointRef"] = Effect.fn(
    "CheckpointStore.allocateCheckpointRef",
  )(function* (input) {
    return yield* normalizeSidecarError(input.cwd, sidecars.allocate(input));
  });

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    if (SidecarCheckpointRepository.isSidecarCheckpointRef(input.checkpointRef)) {
      return yield* normalizeSidecarError(input.cwd, sidecars.capture(input));
    }
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const captureCheckpointWithMetadata: CheckpointStore["Service"]["captureCheckpointWithMetadata"] =
    Effect.fn("captureCheckpointWithMetadata")(function* (input) {
      if (!SidecarCheckpointRepository.isSidecarCheckpointRef(input.checkpointRef)) {
        return yield* new VcsUnsupportedOperationError({
          operation: "CheckpointStore.captureCheckpointWithMetadata",
          kind: "git",
          detail: "Capture metadata is available only for sidecar checkpoints.",
        });
      }
      return yield* normalizeSidecarError(input.cwd, sidecars.captureWithMetadata(input));
    });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    if (SidecarCheckpointRepository.isSidecarCheckpointRef(input.checkpointRef)) {
      return yield* normalizeSidecarError(input.cwd, sidecars.has(input));
    }
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    if (SidecarCheckpointRepository.isSidecarCheckpointRef(input.checkpointRef)) {
      return yield* normalizeSidecarError(input.cwd, sidecars.restore(input));
    }
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const prepareRestoreCheckpoint: CheckpointStore["Service"]["prepareRestoreCheckpoint"] =
    Effect.fn("prepareRestoreCheckpoint")(function* (input) {
      if (!SidecarCheckpointRepository.isSidecarCheckpointRef(input.checkpointRef)) return;
      return yield* normalizeSidecarError(input.cwd, sidecars.prepareRestore(input));
    });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const fromSidecar = SidecarCheckpointRepository.isSidecarCheckpointRef(input.fromCheckpointRef);
    const toSidecar = SidecarCheckpointRepository.isSidecarCheckpointRef(input.toCheckpointRef);
    if (fromSidecar || toSidecar) {
      return yield* normalizeSidecarError(input.cwd, sidecars.diff(input));
    }
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    if (
      SidecarCheckpointRepository.isSidecarCheckpointRef(input.fromCheckpointRef) ||
      SidecarCheckpointRepository.isSidecarCheckpointRef(input.toCheckpointRef)
    ) {
      return yield* normalizeSidecarError(input.cwd, sidecars.authoredPaths(input));
    }
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.listAuthoredPaths(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const sidecarRefs = input.checkpointRefs.filter((checkpointRef) =>
      SidecarCheckpointRepository.isSidecarCheckpointRef(checkpointRef),
    );
    const legacyRefs = input.checkpointRefs.filter(
      (checkpointRef) => !SidecarCheckpointRepository.isSidecarCheckpointRef(checkpointRef),
    );
    if (sidecarRefs.length > 0) {
      yield* normalizeSidecarError(
        input.cwd,
        sidecars.delete({ cwd: input.cwd, checkpointRefs: sidecarRefs }),
      );
    }
    if (legacyRefs.length === 0) return;
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.deleteCheckpointRefs({ ...input, checkpointRefs: legacyRefs });
  });

  return CheckpointStore.of({
    isGitRepository,
    allocateCheckpointRef,
    captureCheckpoint,
    captureCheckpointWithMetadata,
    hasCheckpointRef,
    restoreCheckpoint,
    prepareRestoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

// Exposes its sidecar so storage cleanup shares the same repository locks.
export const layer = Layer.effect(CheckpointStore, make).pipe(
  Layer.provideMerge(SidecarCheckpointRepository.layer),
);
