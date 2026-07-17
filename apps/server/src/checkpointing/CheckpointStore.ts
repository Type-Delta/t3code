/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * The live adapter resolves the active VCS driver once per checkpoint operation
 * and delegates to the driver's optional checkpoint capability.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
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
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Check whether cwd is inside a Git worktree. */
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /** Allocate an opaque repository/worktree-bound sidecar locator. */
    readonly allocateCheckpointRef: (
      input: AllocateCheckpointRefInput,
    ) => Effect.Effect<CheckpointRef, CheckpointStoreError>;

    /**
     * Capture a checkpoint commit and store it at the provided checkpoint ref.
     *
     * Uses an isolated temporary Git index and writes a hidden ref.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Capture a sidecar and return verified object/ownership metadata. */
    readonly captureCheckpointWithMetadata: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<CaptureCheckpointMetadata, CheckpointStoreError>;

    /** Check whether a checkpoint ref exists. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Restore workspace and staging state to a checkpoint.
     *
     * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
     */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Compute a patch diff between two checkpoint refs.
     *
     * Can optionally treat a missing "from" ref as `HEAD`.
     */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * Delete the provided checkpoint refs.
     *
     * Best-effort delete: missing refs are tolerated.
     */
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;

  const normalizeSidecarError = <A>(
    cwd: string,
    effect: Effect.Effect<A, VcsError | PlatformError.PlatformError>,
  ): Effect.Effect<A, VcsError> =>
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
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

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
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
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
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    if (SidecarCheckpointRepository.isSidecarCheckpointRef(input.checkpointRef)) {
      return yield* normalizeSidecarError(input.cwd, sidecars.restore(input));
    }
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const fromSidecar = SidecarCheckpointRepository.isSidecarCheckpointRef(input.fromCheckpointRef);
    const toSidecar = SidecarCheckpointRepository.isSidecarCheckpointRef(input.toCheckpointRef);
    if (fromSidecar || toSidecar) {
      return yield* normalizeSidecarError(input.cwd, sidecars.diff(input));
    }
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
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
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    return yield* checkpoints.deleteCheckpointRefs({ ...input, checkpointRefs: legacyRefs });
  });

  return CheckpointStore.of({
    isGitRepository,
    allocateCheckpointRef,
    captureCheckpoint,
    captureCheckpointWithMetadata,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make).pipe(
  Layer.provide(SidecarCheckpointRepository.layer),
);
