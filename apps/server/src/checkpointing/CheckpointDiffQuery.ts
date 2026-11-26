import {
  type CheckpointScopeId,
  CHECKPOINT_DIFF_TRUNCATED_MARKER,
  type CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
  type ThreadTurnRepositoryDiff,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import {
  checkpointRefForScopeOrdinal,
  nestedScopePaths,
  sidecarSnapshotIdForScopeOrdinal,
} from "../orchestration-v2/CheckpointService.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointServiceError,
  type CheckpointStoreError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "./Diffs.ts";

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;
const REPOSITORY_DIFF_CONCURRENCY = 6;

function batchFilePaths(files: ReadonlyArray<TurnDiffFileSummary>) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    const size = paths.reduce((total, path) => total + path.length + 16, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isOrdinaryDiffFailure = (error: CheckpointStoreError) =>
  error._tag !== "CheckpointObjectsUnavailableError" &&
  error._tag !== "CheckpointSnapshotUnavailableError";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
  repositories?: ReadonlyArray<ThreadTurnRepositoryDiff>,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
    ...(repositories === undefined ? {} : { repositories }),
  };
}

type ContextCheckpoint = ProjectionCheckpointContext["checkpoints"][number];

/**
 * A repository's checkpoints for a turn range. Only turns that changed it are recorded, each with
 * the baseline before it, so the range runs from its first record to its last one inside the
 * range. None when no turn in the range changed it.
 */
function repositoryDiffRange(
  checkpoints: ReadonlyArray<ContextCheckpoint>,
  range: { readonly fromTurnCount: number; readonly toTurnCount: number },
): { readonly from: ContextCheckpoint; readonly to: ContextCheckpoint } | undefined {
  const ready = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.status === "ready" &&
        checkpoint.ordinalWithinScope >= range.fromTurnCount &&
        checkpoint.ordinalWithinScope <= range.toTurnCount,
    )
    .toSorted((left, right) => left.ordinalWithinScope - right.ordinalWithinScope);
  const from = ready[0];
  const to = ready.at(-1);
  return from === undefined || to === undefined || from === to ? undefined : { from, to };
}

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const digest = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  interface Comparison {
    readonly cwd: string;
    readonly fromCheckpointRef: CheckpointRef;
    readonly toCheckpointRef: CheckpointRef;
    readonly fallbackFromToHead: boolean;
    readonly ignoreWhitespace: boolean;
    readonly excludePaths?: ReadonlyArray<string>;
  }

  // What a pull or rebase brought in is not the turn's work. Null keeps every changed file.
  const retainedFilePaths = Effect.fn("CheckpointDiffQuery.retainedFilePaths")(function* (
    comparison: Comparison,
  ) {
    const authoredPaths = yield* checkpointStore
      .listAuthoredPaths(comparison)
      .pipe(Effect.orElseSucceed(() => null));
    const files =
      authoredPaths === null
        ? []
        : yield* checkpointStore
            .diffCheckpoints({ ...comparison, format: "numstat", allowNetwork: false })
            .pipe(
              Effect.map(parseTurnDiffFilesFromNumstat),
              Effect.catchIf(isOrdinaryDiffFailure, () => Effect.succeed([])),
            );
    const retainedFiles = files.filter((file) => !isGitImport(file, authoredPaths));
    return retainedFiles.length === files.length ? null : retainedFiles;
  });

  // Selects retained paths before generating a patch, so imported bulk cannot exhaust the limit.
  const patchBetween = Effect.fn("CheckpointDiffQuery.patchBetween")(function* (
    comparison: Comparison,
    maxBytes: number,
  ) {
    const retainedFiles = yield* retainedFilePaths(comparison);
    const pathBatches = retainedFiles === null ? [undefined] : batchFilePaths(retainedFiles);
    let diff = "";
    let remainingBytes = maxBytes;
    for (const filePaths of pathBatches) {
      const patch = yield* checkpointStore
        .diffCheckpoints({
          ...comparison,
          ...(filePaths === undefined ? {} : { filePaths }),
          // One extra byte distinguishes an exact fit from a truncated patch.
          maxOutputBytes: remainingBytes + 1,
        })
        .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
      const patchBytes = Buffer.byteLength(patch);
      diff += patch;
      if (patchBytes > remainingBytes) {
        // Reserve marker space only on overflow, which may trim an earlier batch.
        // Streaming decode drops an incomplete final UTF-8 character at the byte boundary.
        diff =
          new TextDecoder().decode(
            Buffer.from(diff).subarray(
              0,
              Math.max(0, maxBytes - Buffer.byteLength(CHECKPOINT_DIFF_TRUNCATED_MARKER)),
            ),
            { stream: true },
          ) + CHECKPOINT_DIFF_TRUNCATED_MARKER;
        break;
      }
      remainingBytes -= patchBytes;
    }
    return diff;
  });

  // Most tracked repositories are untouched in a turn. A numstat finds the few that changed
  // before any patch is built, and those patches then share what the thread's own patch left.
  const repositoryDiffs = Effect.fn("CheckpointDiffQuery.repositoryDiffs")(function* (input: {
    readonly projection: ProjectionCheckpointContext;
    readonly threadCwd: string;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
    readonly ignoreWhitespace: boolean;
    readonly nested: ReadonlyMap<string, ReadonlyArray<string>>;
    readonly maxBytes: number;
  }) {
    const rolledBack = input.projection.runs.filter((run) => run.status === "rolled_back");
    const excludedRuns = new Set(rolledBack.map((run) => run.id));
    const excludedBaselines = new Set(rolledBack.map((run) => run.ordinal - 1));
    const changed = yield* Effect.forEach(
      input.projection.checkpointScopes.filter((scope) => typeof scope.repositoryPath === "string"),
      (scope) => {
        const range = repositoryDiffRange(
          input.projection.checkpoints.filter(
            (checkpoint) =>
              checkpoint.scopeId === scope.id &&
              (checkpoint.runId === null
                ? !excludedBaselines.has(checkpoint.ordinalWithinScope)
                : !excludedRuns.has(checkpoint.runId)),
          ),
          input,
        );
        if (range === undefined) return Effect.succeed([]);
        const excludePaths = input.nested.get(scope.id);
        const comparison: Comparison = {
          cwd: scope.cwd,
          fromCheckpointRef: range.from.ref,
          toCheckpointRef: range.to.ref,
          fallbackFromToHead: false,
          ignoreWhitespace: input.ignoreWhitespace,
          ...(excludePaths === undefined ? {} : { excludePaths }),
        };
        return checkpointStore
          .diffCheckpoints({ ...comparison, format: "numstat", allowNetwork: false })
          .pipe(
            Effect.map((numstat) => (numstat === "" ? [] : [{ scope, comparison }])),
            Effect.catchIf(isOrdinaryDiffFailure, (cause) =>
              Effect.logWarning("checkpoint repository diff unavailable", {
                scopeId: scope.id,
                cause: String(cause),
              }).pipe(Effect.as([])),
            ),
          );
      },
      { concurrency: REPOSITORY_DIFF_CONCURRENCY },
    );
    const repositories: Array<ThreadTurnRepositoryDiff> = [];
    let remainingBytes = input.maxBytes;
    for (const { scope, comparison } of changed.flat()) {
      if (remainingBytes < Buffer.byteLength(CHECKPOINT_DIFF_TRUNCATED_MARKER)) break;
      const diff = yield* patchBetween(comparison, remainingBytes).pipe(
        Effect.catchIf(isOrdinaryDiffFailure, (cause) =>
          Effect.logWarning("checkpoint repository diff unavailable", {
            scopeId: scope.id,
            cause: String(cause),
          }).pipe(Effect.as("")),
        ),
      );
      if (diff === "") continue;
      remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(diff));
      repositories.push({
        name: scope.label ?? path.basename(scope.cwd),
        repositoryPath: scope.repositoryPath ?? scope.cwd,
        relativePath: path.relative(input.threadCwd, scope.cwd).split(path.sep).join("/"),
        diff,
      });
    }
    return repositories;
  });

  // The thread-start boundary: its sidecar snapshot, else the in-repo ref an
  // older thread recorded. A missing ref is left to the HEAD fallback.
  const threadBaselineRef = Effect.fn("CheckpointDiffQuery.threadBaselineRef")(function* (scope: {
    readonly id: CheckpointScopeId;
    readonly cwd: string;
  }) {
    const boundary = { scopeId: scope.id, ordinalWithinScope: 0 };
    const sidecarRef = yield* sidecarSnapshotIdForScopeOrdinal(boundary).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.flatMap((snapshotId) =>
        checkpointStore.allocateCheckpointRef({ cwd: scope.cwd, snapshotId }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (
      sidecarRef !== null &&
      (yield* checkpointStore
        .hasCheckpointRef({ cwd: scope.cwd, checkpointRef: sidecarRef })
        .pipe(Effect.orElseSucceed(() => false)))
    ) {
      return sidecarRef;
    }
    return yield* checkpointRefForScopeOrdinal(boundary).pipe(
      Effect.provideService(Digest.Digest, digest),
    );
  });

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
        Effect.mapError(
          () =>
            new CheckpointThreadNotFoundError({
              operation,
              threadId: input.threadId,
            }),
        ),
        Effect.withSpan("checkpoint.turnDiff.lookupContext"),
      );
      const completedRunIds = new Set(
        projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
      );
      const hasRepositories = projection.checkpointScopes.some(
        (scope) => typeof scope.repositoryPath === "string",
      );
      // A thread folder that is not a Git repository records missing checkpoints; its turns still
      // exist, for the repositories inside it and as an empty patch while none of them changed.
      const turnCheckpoints = projection.checkpoints.filter(
        (checkpoint) =>
          (checkpoint.status === "ready" || checkpoint.status === "missing") &&
          checkpoint.appRunOrdinal !== null &&
          checkpoint.runId !== null &&
          completedRunIds.has(checkpoint.runId),
      );
      const readyCheckpoints = turnCheckpoints.filter(
        (checkpoint) => checkpoint.status === "ready",
      );
      const maxTurnCount = turnCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const toCheckpoint = turnCheckpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
      );
      if (toCheckpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const toScope = projection.checkpointScopes.find(
        (scope) => scope.id === toCheckpoint.scopeId,
      );
      if (toScope === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      const nested = hasRepositories
        ? yield* nestedScopePaths([
            toScope,
            // A folder that became a repository after the range still belongs to the thread's patch.
            ...projection.checkpointScopes.filter(
              (scope) =>
                typeof scope.repositoryPath === "string" &&
                projection.checkpoints.some(
                  (checkpoint) =>
                    checkpoint.scopeId === scope.id &&
                    checkpoint.ordinalWithinScope <= input.toTurnCount,
                ),
            ),
          ]).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          )
        : undefined;
      const withRepositories = Effect.fnUntraced(function* (diff: string) {
        const repositories =
          nested === undefined
            ? undefined
            : yield* repositoryDiffs({
                projection,
                threadCwd: toScope.cwd,
                fromTurnCount: input.fromTurnCount,
                toTurnCount: input.toTurnCount,
                ignoreWhitespace,
                nested,
                maxBytes: Math.max(0, CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(diff)),
              });
        const turnDiff = buildTurnDiffResult(input, diff, repositories);
        if (!isTurnDiffResult(turnDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return turnDiff;
      });
      if (toCheckpoint.status === "missing") return yield* withRepositories("");

      // Capture compares against the preceding scope ordinal, even when that
      // checkpoint belongs to a stopped run or has no run.
      const parentCheckpoint =
        input.fromTurnCount === input.toTurnCount - 1
          ? projection.checkpoints.find(
              (checkpoint) =>
                checkpoint.status === "ready" &&
                checkpoint.scopeId === toCheckpoint.scopeId &&
                checkpoint.ordinalWithinScope === toCheckpoint.ordinalWithinScope - 1,
            )
          : undefined;

      const firstScope =
        input.fromTurnCount === 0
          ? projection.checkpointScopes.find((scope) => scope.kind === "root_run")
          : undefined;
      const recordedBaseline = projection.checkpoints.find(
        (checkpoint) =>
          checkpoint.scopeId === firstScope?.id &&
          checkpoint.ordinalWithinScope === 0 &&
          checkpoint.status === "ready",
      );
      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? firstScope === undefined
            ? undefined
            : (recordedBaseline?.ref ?? (yield* threadBaselineRef(firstScope)))
          : (
              parentCheckpoint ??
              readyCheckpoints.find(
                (checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount,
              )
            )?.ref;
      if (fromCheckpointRef === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const excludePaths = nested?.get(toScope.id);
      const diff = yield* patchBetween(
        {
          cwd: toScope.cwd,
          fromCheckpointRef,
          toCheckpointRef: toCheckpoint.ref,
          fallbackFromToHead: input.fromTurnCount === 0 && recordedBaseline === undefined,
          ignoreWhitespace,
          ...(excludePaths === undefined ? {} : { excludePaths }),
        },
        CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      );
      return yield* withRepositories(diff);
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
