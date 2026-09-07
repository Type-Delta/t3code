// @effect-diagnostics nodeBuiltinImport:off
import {
  CommandId,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import {
  checkpointCaptureJobIdFor,
  checkpointSnapshotIdFor,
} from "../../checkpointing/CheckpointIds.ts";
import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import { publishCheckpointTimelineEntry } from "../../checkpointing/CheckpointTimelinePublication.ts";
import {
  CheckpointCaptureExecutor,
  CheckpointCaptureObserver,
  CheckpointCaptureQueue,
  makeCheckpointCaptureQueueLayer,
  type CheckpointCaptureExecutionResult,
} from "../../checkpointing/CheckpointCaptureQueue.ts";
import { CheckpointRepositoryIdentityResolver } from "../../checkpointing/CheckpointRepositoryIdentity.ts";
import { WorkspaceMutationCoordinator } from "../../checkpointing/WorkspaceMutationCoordinator.ts";
import { CheckpointCaptureJobRepository } from "../../persistence/Services/CheckpointCaptureJobs.ts";
import { CheckpointTimelineRepository } from "../../persistence/Services/CheckpointTimeline.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const encodeOpaqueJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const BASELINE_BOUNDARY = "pre-turn-baseline";
const TURN_COMPLETION_BOUNDARY = "turn-completed";

const isCaptureVerificationContention = (error: CheckpointStoreError): boolean =>
  error._tag === "VcsProcessExitError" &&
  error.operation === "SidecarCheckpointRepository.capture" &&
  error.detail === "Checkpoint workspace changed during capture verification.";

const jobIdFor = (
  threadId: string,
  timelineGeneration: number,
  turnId: string,
  requestedBoundary: string,
) => checkpointCaptureJobIdFor(threadId, timelineGeneration, turnId, requestedBoundary);

export { checkpointSnapshotIdFor } from "../../checkpointing/CheckpointIds.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

interface PendingProviderMutation {
  readonly ownerKey: string;
  readonly worktreeKey: string;
  readonly fiber: Fiber.Fiber<boolean, never>;
}

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

const resolveCaptureCwd = Effect.fn("resolveCaptureCwd")(function* (
  threadId: ThreadId,
  preferSessionRuntime: boolean,
) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const thread = yield* projectionSnapshotQuery
    .getThreadDetailById(threadId)
    .pipe(Effect.map(Option.getOrUndefined));
  if (!thread) return undefined;
  const project = yield* projectionSnapshotQuery
    .getProjectShellById(thread.projectId)
    .pipe(Effect.map(Option.getOrUndefined));
  const fromThread = resolveThreadWorkspaceCwd({
    thread,
    projects: project ? [project] : [],
  });
  const session = (yield* providerService.listSessions()).find(
    (entry) => entry.threadId === threadId,
  );
  const candidates = preferSessionRuntime ? [session?.cwd, fromThread] : [fromThread, session?.cwd];
  for (const candidate of candidates) {
    if (candidate !== undefined && (yield* checkpointStore.isGitRepository(candidate))) {
      return { cwd: candidate, thread };
    }
  }
  return undefined;
});

const awaitCaptureAbort = (signal: AbortSignal): Effect.Effect<CheckpointCaptureExecutionResult> =>
  Effect.callback((resume) => {
    const onAbort = () =>
      resume(Effect.succeed({ state: "contended", errorCode: "workspace-mutated" }));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

export const makeCaptureExecutor = Effect.gen(function* () {
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const mutationCoordinator = yield* WorkspaceMutationCoordinator;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const resolveCwd = (threadId: ThreadId, preferSessionRuntime: boolean) =>
    resolveCaptureCwd(threadId, preferSessionRuntime).pipe(
      Effect.provideService(CheckpointStore.CheckpointStore, checkpointStore),
      Effect.provideService(ProjectionSnapshotQuery, projectionSnapshotQuery),
      Effect.provideService(ProviderService, providerService),
    );

  const execute: CheckpointCaptureExecutor["Service"]["execute"] = Effect.fn(
    "CheckpointCaptureExecutor.execute",
  )(function* (job, signal) {
    return yield* Effect.gen(function* () {
      const context = yield* resolveCwd(ThreadId.make(job.threadId), true);
      if (!context) {
        return { state: "error", errorCode: "workspace-unavailable" } as const;
      }
      const generationMatches = yield* mutationCoordinator.reconcileCaptureGeneration(
        job.worktreeKey,
        job.requestedGeneration,
      );
      if (!generationMatches || signal.aborted) {
        return { state: "contended", errorCode: "workspace-mutated" } as const;
      }
      const checkpointRef = yield* checkpointStore.allocateCheckpointRef({
        cwd: context.cwd,
        snapshotId: job.snapshotId,
      });
      return yield* Effect.raceFirst(
        checkpointStore.captureCheckpointWithMetadata({ cwd: context.cwd, checkpointRef }).pipe(
          Effect.map((metadata) => ({
            state: "ready" as const,
            commitOid: metadata.commitOid,
            treeOid: metadata.treeOid,
          })),
          Effect.catch((error) =>
            isCaptureVerificationContention(error)
              ? Effect.succeed({
                  state: "contended" as const,
                  errorCode: "workspace-verification-mismatch",
                })
              : Effect.fail(error),
          ),
        ),
        awaitCaptureAbort(signal),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Sidecar checkpoint capture failed", {
          jobId: job.jobId,
          threadId: job.threadId,
          requestedBoundary: job.requestedBoundary,
          durableAttempt: job.attemptCount,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({ state: "error" as const, errorCode: "capture-failed" })),
      ),
    );
  });

  return CheckpointCaptureExecutor.of({ execute });
});

export const CheckpointCaptureExecutorLive = Layer.effect(
  CheckpointCaptureExecutor,
  makeCaptureExecutor,
);

const makeCaptureObserver = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const mutationCoordinator = yield* WorkspaceMutationCoordinator;
  const providerNavigation = providerService.conversationNavigation;
  const timeline = yield* CheckpointTimelineRepository;
  const captureJobs = yield* CheckpointCaptureJobRepository;
  const resolveCwd = (threadId: ThreadId, preferSessionRuntime: boolean) =>
    resolveCaptureCwd(threadId, preferSessionRuntime).pipe(
      Effect.provideService(CheckpointStore.CheckpointStore, checkpointStore),
      Effect.provideService(ProjectionSnapshotQuery, projectionSnapshotQuery),
      Effect.provideService(ProviderService, providerService),
    );

  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const publishTimelineEntry = Effect.fn("CheckpointCaptureObserver.publishTimelineEntry")(
    function* (input: {
      readonly job: import("../../persistence/Services/CheckpointCaptureJobs.ts").CheckpointCaptureJob;
      readonly assistantMessageId: MessageId | null;
    }) {
      yield* publishCheckpointTimelineEntry({
        ...input,
        providerNavigation,
        timeline,
      });
    },
  );

  const publishTimelineEntryObserved = (input: Parameters<typeof publishTimelineEntry>[0]) =>
    publishTimelineEntry(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Checkpoint timeline publication deferred to durable startup repair", {
          jobId: input.job.jobId,
          threadId: input.job.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const repairReadyTimelineEntries = Effect.fn(
    "CheckpointCaptureObserver.repairReadyTimelineEntries",
  )(function* (
    threadId: ThreadId,
    thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    },
  ) {
    const jobs = yield* captureJobs.listReadyWithoutTimelineEntry({ limit: 1_000 });
    for (const readyJob of jobs) {
      if (readyJob.threadId !== threadId) continue;
      const assistantMessageId =
        readyJob.requestedBoundary === BASELINE_BOUNDARY
          ? null
          : (thread.messages
              .toReversed()
              .find((message) => message.role === "assistant" && message.turnId === readyJob.turnId)
              ?.id ?? MessageId.make(`assistant:${readyJob.turnId}`));
      yield* publishTimelineEntryObserved({ job: readyJob, assistantMessageId });
    }
  });

  const publishCompleted = Effect.fn("CheckpointCaptureObserver.onCompleted")(function* (
    job: import("../../persistence/Services/CheckpointCaptureJobs.ts").CheckpointCaptureJob,
    result: CheckpointCaptureExecutionResult,
  ) {
    const threadId = ThreadId.make(job.threadId);
    const turnId = TurnId.make(job.turnId);
    const context = yield* resolveCwd(threadId, true);
    if (!context) return;
    const checkpointRef = yield* checkpointStore.allocateCheckpointRef({
      cwd: context.cwd,
      snapshotId: job.snapshotId,
    });
    yield* repairReadyTimelineEntries(threadId, context.thread);

    if (job.requestedBoundary === BASELINE_BOUNDARY) {
      if (result.state === "ready") {
        yield* receiptBus.publish({
          type: "checkpoint.baseline.captured",
          threadId,
          checkpointTurnCount: job.turnOrdinal,
          checkpointRef,
          createdAt: job.createdAt,
        });
      }
      return;
    }
    if (job.requestedBoundary !== TURN_COMPLETION_BOUNDARY) return;

    let files: Array<{
      readonly path: string;
      readonly kind: "modified";
      readonly additions: number;
      readonly deletions: number;
    }> = [];
    if (result.state === "ready") {
      yield* workspaceEntries.refresh(context.cwd);
      const previousRef = yield* checkpointStore.allocateCheckpointRef({
        cwd: context.cwd,
        snapshotId: checkpointSnapshotIdFor(
          job.threadId,
          job.timelineGeneration,
          Math.max(0, job.turnOrdinal - 1),
        ),
      });
      files = yield* checkpointStore
        .diffCheckpoints({
          cwd: context.cwd,
          fromCheckpointRef: previousRef,
          toCheckpointRef: checkpointRef,
          // Older threads and interrupted baseline jobs may not have the
          // preceding sidecar snapshot. Degrade to the repository HEAD so
          // the changed-file summary still reaches the client instead of
          // silently publishing an empty DiffPanel payload.
          fallbackFromToHead: true,
          ignoreWhitespace: false,
          format: "numstat",
        })
        .pipe(
          Effect.map((diff) =>
            parseTurnDiffFilesFromNumstat(diff).map((file) => ({
              path: file.path,
              kind: "modified" as const,
              additions: file.additions,
              deletions: file.deletions,
            })),
          ),
          Effect.catch((error) =>
            Effect.logWarning("failed to derive sidecar checkpoint file summary", {
              threadId,
              turnId,
              turnCount: job.turnOrdinal,
              detail: error.message,
            }).pipe(Effect.as([])),
          ),
        );
    }

    const status =
      result.state === "ready" ? "ready" : result.state === "error" ? "error" : "missing";
    const assistantMessageId =
      context.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === turnId)?.id ??
      MessageId.make(`assistant:${turnId}`);
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId,
      turnId,
      completedAt: job.createdAt,
      checkpointRef,
      status,
      files,
      assistantMessageId,
      checkpointTurnCount: job.turnOrdinal,
      createdAt: job.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId,
      turnId,
      checkpointTurnCount: job.turnOrdinal,
      checkpointRef,
      status,
      createdAt: job.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId,
      turnId,
      checkpointTurnCount: job.turnOrdinal,
      createdAt: job.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: result.state === "ready" ? "info" : "error",
        kind: result.state === "ready" ? "checkpoint.captured" : "checkpoint.capture.failed",
        summary: result.state === "ready" ? "Checkpoint captured" : "Checkpoint capture failed",
        payload:
          result.state === "ready"
            ? { turnCount: job.turnOrdinal, status }
            : { detail: result.errorCode ?? "capture-failed" },
        turnId,
        createdAt: job.createdAt,
      },
      createdAt: job.createdAt,
    });
  });

  const onCompleted: CheckpointCaptureObserver["Service"]["onCompleted"] = (job, result) =>
    publishCompleted(job, result).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Checkpoint capture publication failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(
        job.requestedBoundary === TURN_COMPLETION_BOUNDARY
          ? mutationCoordinator.releaseProviderMutation(job.threadId)
          : Effect.void,
      ),
    );

  return CheckpointCaptureObserver.of({ onCompleted });
});

export const CheckpointCaptureObserverLive = Layer.effect(
  CheckpointCaptureObserver,
  makeCaptureObserver,
);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const captureQueue = yield* CheckpointCaptureQueue;
  const captureJobs = yield* CheckpointCaptureJobRepository;
  const timeline = yield* CheckpointTimelineRepository;
  const mutationCoordinator = yield* WorkspaceMutationCoordinator;
  const checkpointIdentities = yield* CheckpointRepositoryIdentityResolver;
  const activeProviderMutations = yield* Ref.make(new Map<string, PendingProviderMutation>());
  const startedTurns = new Map<ThreadId, TurnId>();
  const pendingTurnStarts = new Set<ThreadId>();

  const providerMutationKey = (threadId: ThreadId, turnId: TurnId) =>
    `${String(threadId)}\0${String(turnId)}`;

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }
    return cwd;
  });

  const enqueueCheckpointCapture = Effect.fn("enqueueCheckpointCapture")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly providerTurnId: string | null;
    readonly cwd: string;
    readonly turnCount: number;
    readonly kind: "baseline" | "turn";
    readonly requestedBoundary: typeof BASELINE_BOUNDARY | typeof TURN_COMPLETION_BOUNDARY;
    readonly createdAt: string;
  }) {
    const cursorOption = yield* timeline.getCursor({ threadId: input.threadId });
    const timelineGeneration = Option.match(cursorOption, {
      onNone: () => 0,
      onSome: (cursor) => cursor.activeGeneration,
    });
    const logicalTurnId =
      input.kind === "baseline"
        ? TurnId.make(`baseline:${input.threadId}:${input.turnCount}`)
        : input.turnId;
    const identity = yield* checkpointIdentities.resolve(input.cwd);
    const requestedGeneration = yield* mutationCoordinator.getGeneration(identity.worktreeKey);
    const providerMetadata = yield* providerService.conversationNavigation === undefined
      ? Effect.succeed(null)
      : providerService.conversationNavigation.getBinding(input.threadId).pipe(
          Effect.flatMap((binding) =>
            Effect.all({
              providerBindingJson: encodeOpaqueJson(binding),
              providerCursorJson: encodeOpaqueJson({
                schemaVersion: 1,
                provider: binding.provider,
                providerInstanceId: binding.providerInstanceId,
                providerTurnId: input.providerTurnId,
              }),
            }),
          ),
          Effect.orElseSucceed(() => null),
        );
    const snapshotId = checkpointSnapshotIdFor(input.threadId, timelineGeneration, input.turnCount);
    yield* captureJobs.upsertRepository({
      repositoryKey: identity.repositoryKey,
      commonDirFingerprint: identity.repositoryKey,
      objectFormat: identity.objectFormat,
      sidecarRelativePath: `repositories/${identity.repositoryKey}.git`,
      createdAt: input.createdAt,
      lastUsedAt: input.createdAt,
    });
    yield* captureQueue.enqueue({
      snapshot: {
        snapshotId,
        repositoryKey: identity.repositoryKey,
        worktreeKey: identity.worktreeKey,
        kind: input.kind,
        createdAt: input.createdAt,
        expiresAt: null,
      },
      job: {
        jobId: jobIdFor(input.threadId, timelineGeneration, logicalTurnId, input.requestedBoundary),
        snapshotId,
        threadId: input.threadId,
        timelineGeneration,
        turnId: logicalTurnId,
        providerTurnId: input.providerTurnId,
        providerBindingJson: providerMetadata?.providerBindingJson ?? null,
        providerCursorJson: providerMetadata?.providerCursorJson ?? null,
        turnOrdinal: input.turnCount,
        repositoryKey: identity.repositoryKey,
        worktreeKey: identity.worktreeKey,
        requestedBoundary: input.requestedBoundary,
        requestedGeneration,
        createdAt: input.createdAt,
      },
    });
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return false;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return false;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return false;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return false;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return false;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* enqueueCheckpointCapture({
        threadId: thread.id,
        turnId,
        providerTurnId: event.providerRefs?.providerTurnId ?? null,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        kind: "turn",
        requestedBoundary: TURN_COMPLETION_BOUNDARY,
        createdAt: event.createdAt,
      });
      return true;
    },
  );

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* enqueueCheckpointCapture({
      threadId,
      turnId,
      providerTurnId: event.metadata?.providerTurnId ?? null,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      kind: "turn",
      requestedBoundary: TURN_COMPLETION_BOUNDARY,
      createdAt: event.payload.completedAt,
    });
  });

  const beginProviderTurnMutation = Effect.fn("beginProviderTurnMutation")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const key = providerMutationKey(event.threadId, turnId);
    if (yield* mutationCoordinator.bindProviderMutation(event.threadId, String(turnId))) {
      return;
    }
    if ((yield* Ref.get(activeProviderMutations)).has(key)) {
      return;
    }

    const thread = yield* resolveThreadDetail(event.threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const identity = yield* checkpointIdentities.resolve(checkpointCwd);
    // Provider turns dispatched by ProviderCommandReactor already bind their
    // lease above. A runtime event from an external/recovered source registers
    // one in a child fiber. Never wait on the per-worktree gate in this
    // sequential event worker: the restore holding that gate may itself be
    // waiting for a prior turn.completed event queued behind this one.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const fiber = yield* mutationCoordinator
          .prepareRuntimeMutation(key, identity.worktreeKey)
          .pipe(Effect.forkChild);
        yield* Ref.update(activeProviderMutations, (current) => {
          const next = new Map(current);
          next.set(key, { ownerKey: key, worktreeKey: identity.worktreeKey, fiber });
          return next;
        });
      }),
    );
  });

  const releasePendingProviderMutation = Effect.fn("releasePendingProviderMutation")(function* (
    pending: PendingProviderMutation,
  ) {
    yield* Fiber.interrupt(pending.fiber);
    const completed = yield* mutationCoordinator.completeRuntimeMutation(pending.ownerKey);
    if (!completed) yield* mutationCoordinator.preemptCaptures(pending.worktreeKey);
  });

  const completeProviderTurnMutation = Effect.fn("completeProviderTurnMutation")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) return;

    const key = providerMutationKey(event.threadId, turnId);
    const preparedCompleted = yield* mutationCoordinator.completeProviderMutationForCapture(
      event.threadId,
      String(turnId),
    );
    const pending = yield* Ref.modify(activeProviderMutations, (current) => {
      const found = current.get(key);
      if (!found) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(key);
      return [found, next] as const;
    });
    if (pending) {
      yield* releasePendingProviderMutation(pending);
    }
    if (preparedCompleted || pending) {
      return;
    }

    // A completion may be observed after a reactor restart or without the
    // corresponding start event. Invalidate older captures before scheduling
    // the stable post-turn boundary.
    const thread = yield* resolveThreadDetail(event.threadId);
    if (!thread) return;
    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) return;
    const identity = yield* checkpointIdentities.resolve(checkpointCwd);
    yield* mutationCoordinator.preemptCaptures(identity.worktreeKey);
  });

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd ||
        isTemporaryWorktreeBranch(thread.branch)
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.created" | "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    yield* enqueueCheckpointCapture({
      threadId,
      turnId: TurnId.make(
        `baseline:${"messageId" in event.payload ? event.payload.messageId : event.eventId}`,
      ),
      providerTurnId: event.metadata?.providerTurnId ?? null,
      cwd: checkpointCwd,
      turnCount: currentTurnCount,
      kind: "baseline",
      requestedBoundary: BASELINE_BOUNDARY,
      createdAt: event.occurredAt,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (
      event.type === "thread.created" ||
      event.type === "thread.turn-start-requested" ||
      event.type === "thread.message-sent"
    ) {
      if (event.type === "thread.turn-start-requested") {
        pendingTurnStarts.add(event.payload.threadId);
      }
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    // When ProviderRuntimeIngestion creates a placeholder checkpoint (status "missing")
    // from a turn.diff.updated runtime event, capture the real git checkpoint to
    // replace it. ProviderService broadcasts runtime events to each subscriber.
    // This domain-event path also captures checkpoints from turn diff updates.
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      pendingTurnStarts.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pendingTurnStarts.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pendingTurnStarts.delete(event.threadId);
      }
      yield* beginProviderTurnMutation(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveThreadDetail(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);

      yield* completeProviderTurnMutation(event);
      if (event.type === "turn.completed") {
        yield* refreshLocalGitStatusFromTurnCompletion(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pendingTurnStarts.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn;
      }
      if (event.type === "turn.aborted") {
        yield* mutationCoordinator.releaseProviderMutation(event.threadId);
        return;
      }

      const captureEnqueued = yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(
              Effect.catch(() => Effect.void),
              Effect.as(false),
            ),
          ),
        ),
      );
      if (!captureEnqueued) {
        yield* mutationCoordinator.releaseProviderMutation(event.threadId);
      }
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.addFinalizer(() =>
      Ref.getAndSet(activeProviderMutations, new Map()).pipe(
        Effect.flatMap((active) => Effect.forEach(active.values(), releasePendingProviderMutation)),
        Effect.asVoid,
      ),
    );
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.created" &&
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

const CaptureExecutionLive = Layer.mergeAll(
  CheckpointCaptureExecutorLive,
  CheckpointCaptureObserverLive,
);
const CaptureQueueLive = makeCheckpointCaptureQueueLayer({
  workerId: `checkpoint-reactor-${globalThis.process.pid}`,
  concurrency: 2,
}).pipe(Layer.provideMerge(CaptureExecutionLive));
const CaptureRuntimeLive = Layer.mergeAll(CaptureExecutionLive, CaptureQueueLive);

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provide(CaptureRuntimeLive),
);
