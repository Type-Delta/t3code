import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CheckpointNavigationRepository } from "../persistence/Services/CheckpointNavigation.ts";
import type {
  CheckpointNavigationOperation,
  CheckpointNavigationPhase,
} from "../persistence/Services/CheckpointNavigation.ts";
import { CheckpointRetentionRepository } from "../persistence/Services/CheckpointRetention.ts";
import { CheckpointTimelineRepository } from "../persistence/Services/CheckpointTimeline.ts";
import type {
  ThreadCheckpointCursor,
  ThreadCheckpointEntry,
} from "../persistence/Services/CheckpointTimeline.ts";
import { ProviderUnsupportedError } from "../provider/Errors.ts";
import { ProviderConversationNavigation } from "../provider/Services/ProviderConversationNavigation.ts";
import type {
  ProviderConversationBinding,
  ProviderConversationCursor,
} from "../provider/Services/ProviderConversationNavigation.ts";
import { CheckpointRepositoryIdentityResolver } from "./CheckpointRepositoryIdentity.ts";
import {
  CheckpointNavigationError,
  CheckpointNavigationServiceLive,
  CheckpointNavigationWorkspace,
} from "./CheckpointNavigationService.ts";
import { WorkspaceMutationCoordinatorLive } from "./WorkspaceMutationCoordinator.ts";

export const navigationTestThreadId = ThreadId.make("thread-navigation-test");
const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-local");
export const repositoryKey = "a".repeat(64);
export const worktreeKey = "b".repeat(64);
export const unrelatedWorktreeKey = "e".repeat(64);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

export const testBinding = (value: string): ProviderConversationBinding => ({
  schemaVersion: 1,
  threadId: navigationTestThreadId,
  provider,
  providerInstanceId,
  payload: { value },
});

const bindingValue = (value: ProviderConversationBinding): string =>
  (value.payload as { readonly value: string }).value;

export type NavigationFailurePoint =
  | "capture-rescue"
  | "record-rescue"
  | "prepare-provider"
  | "restore-target"
  | "restore-target-after-mutation"
  | "activate-provider"
  | "move-cursor"
  | "upsert-binding"
  | "schedule-retention"
  | "dispose-provider"
  | "restore-provider"
  | "restore-rescue"
  | "fork-generation"
  | `advance:${CheckpointNavigationPhase}`;

export interface NavigationFixtureOptions {
  readonly currentOrdinal?: number | null;
  readonly entryCount?: number;
  readonly capability?: "branching" | "rollback-only" | "unsupported";
  readonly rescueWorktreeKey?: string;
  readonly targetWorktreeKey?: string;
  readonly failures?: ReadonlyArray<NavigationFailurePoint>;
}

const persistenceFailure = (operation: string) =>
  new PersistenceSqlError({ operation, detail: `Injected ${operation} failure` });
const providerFailure = (operation: string) =>
  new ProviderUnsupportedError({ provider: `injected-${operation}` });
const navigationFailure = (code: string) =>
  new CheckpointNavigationError({ code, detail: `Injected ${code} failure`, operationId: null });

export function makeNavigationFixture(options: NavigationFixtureOptions = {}) {
  const entryCount = options.entryCount ?? 4;
  const initialOrdinal = options.currentOrdinal === undefined ? entryCount : options.currentOrdinal;
  const entries: ThreadCheckpointEntry[] = Array.from({ length: entryCount }, (_, index) => {
    const ordinal = index + 1;
    return {
      entryId: `entry-${ordinal}`,
      threadId: navigationTestThreadId,
      timelineGeneration: 0,
      ordinal,
      turnId: `turn-${ordinal}`,
      providerTurnId: `provider-turn-${ordinal}`,
      snapshotId: `snapshot-${ordinal}`,
      providerBindingJson: encodeJson(testBinding(`binding-${ordinal}`)),
      providerCursorJson: "{}",
      assistantMessageId: `assistant-${ordinal}`,
      completedAt: `2026-07-16T00:00:0${ordinal}.000Z`,
      state: "ready",
      createdAt: `2026-07-16T00:00:0${ordinal}.000Z`,
    };
  });
  let cursor: ThreadCheckpointCursor = {
    threadId: navigationTestThreadId,
    activeGeneration: 0,
    currentEntryId: initialOrdinal === null ? null : `entry-${initialOrdinal}`,
    currentOrdinal: initialOrdinal,
    forwardTipEntryId: `entry-${entryCount}`,
    forwardTipOrdinal: entryCount,
    navigationVersion: 0,
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
  let providerBinding = testBinding(
    initialOrdinal === null ? "baseline" : `binding-${initialOrdinal}`,
  );
  let preparedTarget = providerBinding;
  let workspaceState = "original";
  const operations = new Map<string, CheckpointNavigationOperation>();
  const generations = new Map<
    number,
    { readonly parentGeneration: number | null; readonly forkedFromEntryId: string | null }
  >([[0, { parentGeneration: null, forkedFromEntryId: null }]]);
  const failures = new Set(options.failures ?? []);
  const events: string[] = [];
  const rescueSnapshots: string[] = [];
  const scheduledSnapshots: string[] = [];
  const preparedTurnIds: Array<string | null> = [];

  const hasFailure = (point: NavigationFailurePoint) => failures.has(point);
  const unresolved = (operation: CheckpointNavigationOperation) =>
    !["committed", "compensated", "failed"].includes(operation.phase);

  const timelineLayer = Layer.succeed(CheckpointTimelineRepository, {
    appendEntry: (entry) => Effect.succeed(entry),
    getEntry: ({ entryId }) =>
      Effect.succeed(Option.fromNullishOr(entries.find((entry) => entry.entryId === entryId))),
    listGeneration: ({ generation }) =>
      Effect.succeed(entries.filter((entry) => entry.timelineGeneration === generation)),
    listGenerationLineage: ({ generation }) =>
      Effect.sync(() => {
        const visible: ThreadCheckpointEntry[] = [];
        let currentGeneration: number | null = generation;
        let maxOrdinal: number | null = null;
        while (currentGeneration !== null) {
          visible.push(
            ...entries.filter(
              (entry) =>
                entry.timelineGeneration === currentGeneration &&
                (maxOrdinal === null || entry.ordinal <= maxOrdinal),
            ),
          );
          const metadata = generations.get(currentGeneration);
          if (metadata === undefined || metadata.parentGeneration === null) break;
          const forkEntry = entries.find((entry) => entry.entryId === metadata.forkedFromEntryId);
          if (forkEntry === undefined) break;
          maxOrdinal = forkEntry.ordinal;
          currentGeneration = metadata.parentGeneration;
        }
        return visible.toSorted((left, right) => left.ordinal - right.ordinal);
      }),
    createGeneration: () => Effect.void,
    getGeneration: ({ generation }) =>
      Effect.succeed(
        Option.map(Option.fromNullishOr(generations.get(generation)), (metadata) => ({
          threadId: navigationTestThreadId,
          generation,
          parentGeneration: metadata.parentGeneration,
          forkedFromEntryId: metadata.forkedFromEntryId,
          state:
            generation === cursor.activeGeneration ? ("active" as const) : ("abandoned" as const),
          createdAt: "2026-07-16T00:00:00.000Z",
          abandonedAt: generation === cursor.activeGeneration ? null : "2026-07-16T00:00:00.000Z",
          deleteAfter: null,
        })),
      ),
    initializeCursor: () => Effect.succeed(cursor),
    getCursor: () => Effect.succeed(Option.some(cursor)),
    moveCursor: (input) => {
      events.push(`cursor:move:${input.currentEntryId ?? "baseline"}`);
      if (hasFailure("move-cursor")) return Effect.fail(persistenceFailure("moveCursor"));
      return Effect.sync(() => {
        if (input.expectedNavigationVersion !== cursor.navigationVersion) return false;
        cursor = { ...cursor, ...input, navigationVersion: cursor.navigationVersion + 1 };
        return true;
      });
    },
    forkGeneration: (input) => {
      events.push(`cursor:fork:${input.newGeneration}`);
      if (hasFailure("fork-generation")) {
        return Effect.fail(persistenceFailure("forkGeneration"));
      }
      return Effect.sync(() => {
        if (input.expectedNavigationVersion !== cursor.navigationVersion) return false;
        const parentGeneration = cursor.activeGeneration;
        cursor = {
          ...cursor,
          activeGeneration: input.newGeneration,
          currentEntryId: input.currentEntryId,
          currentOrdinal: input.currentOrdinal,
          forwardTipEntryId: input.currentEntryId,
          forwardTipOrdinal: input.currentOrdinal,
          navigationVersion: cursor.navigationVersion + 1,
          updatedAt: input.createdAt,
        };
        generations.set(input.newGeneration, {
          parentGeneration,
          forkedFromEntryId: input.currentEntryId,
        });
        return true;
      });
    },
    upsertProviderBinding: (_input) => {
      events.push("binding:upsert");
      return hasFailure("upsert-binding")
        ? Effect.fail(persistenceFailure("upsertProviderBinding"))
        : Effect.void;
    },
    getProviderBinding: () => Effect.succeed(Option.none()),
  });

  const operationLayer = Layer.succeed(CheckpointNavigationRepository, {
    recordRescueSnapshot: ({ snapshotId }) => {
      events.push("rescue:record");
      if (hasFailure("record-rescue")) {
        return Effect.fail(persistenceFailure("recordRescueSnapshot"));
      }
      rescueSnapshots.push(snapshotId);
      return Effect.void;
    },
    begin: (operation) =>
      Effect.sync(() => {
        events.push("operation:begin");
        const existing = operations.get(operation.commandId);
        if (existing !== undefined) return existing;
        operations.set(operation.commandId, operation);
        return operation;
      }),
    getByCommandId: ({ commandId }) =>
      Effect.succeed(Option.fromNullishOr(operations.get(commandId))),
    getUnresolvedByThread: ({ threadId }) =>
      Effect.succeed(
        Option.fromNullishOr(
          [...operations.values()].find(
            (operation) => operation.threadId === threadId && unresolved(operation),
          ),
        ),
      ),
    listRecoverable: () =>
      Effect.succeed([...operations.values()].filter((operation) => unresolved(operation))),
    advancePhase: (input) => {
      events.push(`phase:${input.phase}`);
      if (hasFailure(`advance:${input.phase}`)) {
        return Effect.fail(persistenceFailure(`advance:${input.phase}`));
      }
      return Effect.sync(() => {
        const operation = [...operations.values()].find(
          (candidate) => candidate.operationId === input.operationId,
        );
        if (operation === undefined || operation.phase !== input.expectedPhase) return false;
        operations.set(operation.commandId, { ...operation, ...input });
        return true;
      });
    },
  });

  const retentionLayer = Layer.succeed(CheckpointRetentionRepository, {
    applyPolicy: () => Effect.void,
    scheduleSnapshotDeletion: ({ snapshotId }) => {
      events.push("retention:schedule");
      if (hasFailure("schedule-retention")) {
        return Effect.fail(persistenceFailure("scheduleSnapshotDeletion"));
      }
      scheduledSnapshots.push(snapshotId);
      return Effect.void;
    },
    listDeletionCandidates: () => Effect.succeed([]),
    markDeletionStarted: () => Effect.succeed(false),
    markDeleted: () => Effect.void,
    markDeletionFailed: () => Effect.void,
    getSnapshotExecutionContext: () =>
      Effect.succeed({
        cwd: "C:/workspace",
        repositoryKey,
        worktreeKey: options.targetWorktreeKey ?? worktreeKey,
      }),
    listGcExecutionCandidates: () => Effect.succeed([]),
    listRepositoryDeletionCandidates: () => Effect.succeed([]),
    scheduleRepositoryDeletion: () => Effect.void,
    markRepositoryDeletionStarted: () => Effect.succeed(false),
    markRepositoryDeleted: () => Effect.void,
    markRepositoryDeletionFailed: () => Effect.void,
  });

  const workspaceLayer = Layer.succeed(CheckpointNavigationWorkspace, {
    captureRescue: ({ snapshotId }) => {
      events.push("workspace:capture-rescue");
      if (hasFailure("capture-rescue")) {
        return Effect.fail(navigationFailure("capture-rescue"));
      }
      return Effect.succeed({
        snapshotId,
        repositoryKey,
        worktreeKey: options.rescueWorktreeKey ?? worktreeKey,
        objectFormat: "sha1" as const,
        commitOid: "c".repeat(40),
        treeOid: "d".repeat(40),
      });
    },
    restoreSnapshot: ({ snapshotId }) => {
      const rescue = snapshotId.startsWith("nav-rescue-");
      events.push(`workspace:restore-${rescue ? "rescue" : "target"}:${snapshotId}`);
      if (hasFailure(rescue ? "restore-rescue" : "restore-target")) {
        return Effect.fail(navigationFailure(rescue ? "restore-rescue" : "restore-target"));
      }
      if (rescue) {
        workspaceState = "original";
      } else {
        workspaceState = snapshotId;
        if (hasFailure("restore-target-after-mutation")) {
          return Effect.fail(navigationFailure("restore-target-after-mutation"));
        }
      }
      return Effect.void;
    },
  });

  const providerLayer = Layer.succeed(ProviderConversationNavigation, {
    getCapability: () => Effect.succeed(options.capability ?? ("branching" as const)),
    getBinding: () => Effect.succeed(providerBinding),
    prepareCursor: (_threadId, checkpoint) => {
      events.push("provider:prepare");
      preparedTurnIds.push(checkpoint.targetTurnId);
      if (hasFailure("prepare-provider")) {
        return Effect.fail(providerFailure("prepare"));
      }
      preparedTarget = checkpoint.binding;
      return Effect.succeed({
        schemaVersion: 1 as const,
        threadId: navigationTestThreadId,
        provider,
        providerInstanceId,
        payload: { bindingValue: bindingValue(checkpoint.binding) },
      });
    },
    activateCursor: () => {
      events.push("provider:activate");
      if (hasFailure("activate-provider")) {
        return Effect.fail(providerFailure("activate"));
      }
      providerBinding = preparedTarget;
      return Effect.succeed(providerBinding);
    },
    restoreBinding: (_threadId, binding) => {
      events.push(`provider:restore:${bindingValue(binding)}`);
      if (hasFailure("restore-provider")) {
        return Effect.fail(providerFailure("restore"));
      }
      providerBinding = binding;
      return Effect.void;
    },
    disposeCursor: (_cursor: ProviderConversationCursor) => {
      events.push("provider:dispose");
      return hasFailure("dispose-provider") ? Effect.fail(providerFailure("dispose")) : Effect.void;
    },
  });

  const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getCheckpointNavigationContext: () =>
      Effect.succeed(
        Option.some({
          threadId: navigationTestThreadId,
          workspaceCwd: "C:/workspace",
          sessionStatus: "idle" as const,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        }),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"]);
  const identityLayer = Layer.succeed(CheckpointRepositoryIdentityResolver, {
    resolve: () =>
      Effect.succeed({
        repositoryKey,
        worktreeKey,
        commonDir: "C:/workspace/.git",
        worktreeRoot: "C:/workspace",
        objectFormat: "sha1" as const,
      }),
  });
  const dependencies = Layer.mergeAll(
    timelineLayer,
    operationLayer,
    retentionLayer,
    workspaceLayer,
    providerLayer,
    projectionLayer,
    identityLayer,
    WorkspaceMutationCoordinatorLive,
    NodeServices.layer,
  );

  const makeLayer = () => CheckpointNavigationServiceLive.pipe(Layer.provide(dependencies));

  const seedOperation = (
    phase: CheckpointNavigationPhase,
    overrides: Partial<CheckpointNavigationOperation> = {},
  ): CheckpointNavigationOperation => {
    const operationId = overrides.operationId ?? `recover-${phase}`;
    const operation: CheckpointNavigationOperation = {
      operationId,
      commandId: overrides.commandId ?? `command-${phase}`,
      threadId: navigationTestThreadId,
      kind: "undo",
      mode: "full",
      fromEntryId: "entry-4",
      toEntryId: "entry-3",
      rescueSnapshotId: `nav-rescue-${operationId}`,
      oldProviderBindingJson: encodeJson(testBinding("binding-4")),
      targetProviderBindingJson: encodeJson(testBinding("binding-3")),
      preparedProviderCursorJson: encodeJson({
        schemaVersion: 1,
        threadId: navigationTestThreadId,
        provider,
        providerInstanceId,
        payload: { bindingValue: "binding-3" },
      }),
      phase,
      recoveryFromPhase: null,
      failureCode: null,
      compensationFailureCode: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      completedAt: null,
      ...overrides,
    };
    operations.set(operation.commandId, operation);
    return operation;
  };

  return {
    entries,
    events,
    failures,
    operations,
    rescueSnapshots,
    scheduledSnapshots,
    preparedTurnIds,
    makeLayer,
    seedOperation,
    getCursor: () => cursor,
    setCursor: (next: ThreadCheckpointCursor) => {
      cursor = next;
    },
    getProviderBindingValue: () => bindingValue(providerBinding),
    getWorkspaceState: () => workspaceState,
    setProviderBinding: (value: string) => {
      providerBinding = testBinding(value);
    },
  };
}
