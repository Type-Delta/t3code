import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

export type MigrationHistoryKind =
  | "empty"
  | "common"
  | "fork"
  | "fork-v2"
  | "upstream-v1"
  | "upstream-v2"
  | "preview-v2";

export interface MigrationHistory {
  readonly kind: MigrationHistoryKind;
  readonly latestMigrationId: number;
}

type MigrationRow = { readonly migration_id: number; readonly name: string };

const commonMigrationNames = new Map<number, string>([
  [1, "OrchestrationEvents"],
  [2, "OrchestrationCommandReceipts"],
  [3, "CheckpointDiffBlobs"],
  [4, "ProviderSessionRuntime"],
  [5, "Projections"],
  [6, "ProjectionThreadSessionRuntimeModeColumns"],
  [7, "ProjectionThreadMessageAttachments"],
  [8, "ProjectionThreadActivitySequence"],
  [9, "ProviderSessionRuntimeMode"],
  [10, "ProjectionThreadsRuntimeMode"],
  [11, "OrchestrationThreadCreatedRuntimeMode"],
  [12, "ProjectionThreadsInteractionMode"],
  [13, "ProjectionThreadProposedPlans"],
  [14, "ProjectionThreadProposedPlanImplementation"],
  [15, "ProjectionTurnsSourceProposedPlan"],
  [16, "CanonicalizeModelSelections"],
  [17, "ProjectionThreadsArchivedAt"],
  [18, "ProjectionThreadsArchivedAtIndex"],
  [19, "ProjectionSnapshotLookupIndexes"],
  [20, "AuthAccessManagement"],
  [21, "AuthSessionClientMetadata"],
  [22, "AuthSessionLastConnectedAt"],
  [23, "ProjectionThreadShellSummary"],
  [24, "BackfillProjectionThreadShellSummary"],
  [25, "CleanupInvalidProjectionPendingApprovals"],
  [26, "CanonicalizeModelSelectionOptions"],
  [27, "ProviderSessionRuntimeInstanceId"],
  [28, "ProjectionThreadSessionInstanceId"],
  [29, "ProjectionThreadDetailOrderingIndexes"],
  [30, "ProjectionThreadShellArchiveIndexes"],
  [31, "AuthAuthorizationScopes"],
  [32, "AuthPairingProofKeyThumbprint"],
  [33, "ProjectionThreadsSettled"],
  [34, "ProjectionThreadsSnoozed"],
  [35, "ProjectionThreadTitleRegeneration"],
]);

const forkMigrationNames = new Map<number, string>([
  [36, "CheckpointDurableState"],
  [37, "CheckpointLegacyMigration"],
  [38, "CheckpointCaptureProviderMetadata"],
  [39, "ReconcileCheckpointAndTitleHistory"],
  [40, "ProjectionSubagentIds"],
  [41, "ProjectionThreadsPinned"],
  [42, "ProjectionTurnsKeysetIndex"],
  [43, "ProjectionThreadsPinOrderKey"],
  [44, "ProjectionProjectsDefaultThreadEnvMode"],
  [45, "ProjectionProjectFaviconPath"],
  [46, "ReconcileUpstream41History"],
  [47, "AuthSessionClientConnection"],
  [48, "ProjectionThreadLinkedPullRequest"],
  [49, "ProjectionThreadsUnsettledAt"],
  [50, "ManagementApiKeys"],
  [51, "AutoResumeJobs"],
  [52, "RemoveManagementApiKeyRuntimeModes"],
  [53, "ReconcileUpstream47History"],
  [54, "ClearAutomaticProjectModelDefaults"],
  [55, "ProjectionProjectsAutoPull"],
  [56, "RepairAutomaticSettlementTimestamps"],
  [57, "ProjectionProjectIcon"],
  [58, "ProjectionThreadBranchPullRequest"],
  [59, "ProjectionThreadsActiveOrderKey"],
  [60, "ProjectionThreadPullRequests"],
  [61, "ProjectionThreadMessageContext"],
  [62, "ProjectionThreadMessageSuggestions"],
  [63, "ProjectionThreadTitleState"],
  [64, "PullRequestFilesViewed"],
  [65, "ReconcileBranchPullRequestHistory"],
  [66, "ProjectionThreadsAutoSettleDisabledAt"],
]);

// Older fork deployments placed checkpoint migrations before the upstream
// settled/snoozed projections. Their later ledger names still identify the
// same schema lineage and must be allowed through the V2 cutover.
const legacyForkMigrationNames = new Map<number, string>([
  ...commonMigrationNames,
  [33, "CheckpointDurableState"],
  [34, "CheckpointLegacyMigration"],
  [35, "CheckpointCaptureProviderMetadata"],
  [36, "CheckpointNavigationMode"],
  [37, "ProjectionThreadsSettled"],
  [38, "ProjectionThreadsSnoozed"],
  [39, "ReconcileCheckpointAndTitleHistory"],
  [40, "ProjectionSubagentIds"],
  [41, "ProjectionThreadsPinned"],
  [42, "ProjectionTurnsKeysetIndex"],
  [43, "ProjectionThreadsPinOrderKey"],
  [44, "ProjectionProjectsDefaultThreadEnvMode"],
  [45, "ProjectionProjectFaviconPath"],
  [46, "ReconcileUpstream41History"],
  [47, "AuthSessionClientConnection"],
  [48, "ProjectionThreadLinkedPullRequest"],
  [49, "ProjectionThreadsUnsettledAt"],
  [50, "ManagementApiKeys"],
  [51, "AutoResumeJobs"],
  [52, "RemoveManagementApiKeyRuntimeModes"],
  [53, "ReconcileUpstream47History"],
  [54, "ClearAutomaticProjectModelDefaults"],
  [55, "ProjectionProjectsAutoPull"],
  [56, "RepairAutomaticSettlementTimestamps"],
  [57, "ProjectionProjectIcon"],
  [58, "ProjectionThreadBranchPullRequest"],
  [59, "ProjectionThreadsActiveOrderKey"],
  [60, "ProjectionThreadPullRequests"],
  [61, "ProjectionThreadMessageContext"],
  [62, "ProjectionThreadMessageSuggestions"],
  [63, "ProjectionThreadTitleState"],
  [64, "PullRequestFilesViewed"],
  [65, "ReconcileBranchPullRequestHistory"],
  [66, "ProjectionThreadsAutoSettleDisabledAt"],
]);

const upstreamMigrationNames = new Map<number, string>([
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionTurnsKeysetIndex"],
  [38, "ProjectionThreadsPinOrderKey"],
  [39, "ProjectionProjectsDefaultThreadEnvMode"],
  [40, "ProjectionProjectFaviconPath"],
  [41, "AuthSessionClientConnection"],
  [42, "ProjectionThreadLinkedPullRequest"],
  [43, "ProjectionThreadsUnsettledAt"],
  [44, "ClearAutomaticProjectModelDefaults"],
  [45, "ProjectionProjectsAutoPull"],
  [46, "RepairAutomaticSettlementTimestamps"],
  [47, "ProjectionProjectIcon"],
  [48, "ProjectionThreadBranchPullRequest"],
  [49, "ProjectionThreadsActiveOrderKey"],
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
]);

const coreCutoverMigration = { id: 67, name: "CoreV2Cutover" } as const;

const requiredV2Tables = [
  "orchestration_v2_events",
  "orchestration_v2_command_receipts",
  "orchestration_v2_projection_threads",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_provider_sessions",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_checkpoint_scopes",
  "orchestration_v2_projection_checkpoints",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_context_transfers",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_metadata",
  "orchestration_v2_projection_provider_session_bindings",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_v2_legacy_imports",
  "scheduled_tasks",
];

const migrationError = (message: string) =>
  new Migrator.MigrationError({ kind: "BadState", message });

const migrationErrorFromCause = (cause: unknown) =>
  migrationError(cause instanceof Error ? cause.message : String(cause));

const allUserTables = Effect.fn("migrationHistory.userTables")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  return new Set(rows.map((row) => row.name));
});

const exactPrefix = (history: ReadonlyArray<MigrationRow>, expected: ReadonlyMap<number, string>) =>
  history.every(
    (row, index) => row.migration_id === index + 1 && expected.get(row.migration_id) === row.name,
  );

// Some fork deployments recorded a site-local migration at slot 41 while
// applying the same schema change as the fork's ProjectionThreadsPinned step.
// Preserve that lineage marker instead of rejecting an otherwise exact fork
// history during the V2 cutover.
const exactForkPrefix = (
  history: ReadonlyArray<MigrationRow>,
  expected: ReadonlyMap<number, string>,
) =>
  history.every(
    (row, index) =>
      row.migration_id === index + 1 &&
      (row.migration_id === 41 && row.name === "ThreadSummaryTimeline"
        ? true
        : expected.get(row.migration_id) === row.name),
  );

const combinedNames = (...maps: ReadonlyArray<ReadonlyMap<number, string>>) =>
  new Map(maps.flatMap((map) => [...map.entries()]));

const withCoreCutover = (history: ReadonlyArray<MigrationRow>, prefixLength: number) =>
  history.length === prefixLength + 1 &&
  history[prefixLength]?.migration_id === coreCutoverMigration.id &&
  history[prefixLength]?.name === coreCutoverMigration.name;

/** Classifies ledger lineage before the numeric migrator can mistake fork IDs for upstream IDs. */
export const inspectMigrationHistory = Effect.fn("inspectMigrationHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* allUserTables().pipe(Effect.mapError(migrationErrorFromCause));
  if (!tables.has("effect_sql_migrations")) {
    if (tables.size > 0) {
      return yield* migrationError(
        "Database has application tables but no effect_sql_migrations ledger; refusing to guess its schema lineage.",
      );
    }
    return { kind: "empty", latestMigrationId: 0 };
  }

  const history = yield* sql<MigrationRow>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `.pipe(Effect.mapError(migrationErrorFromCause));
  if (history.length === 0) {
    if (tables.size > 1) {
      return yield* migrationError(
        "Database has application tables but an empty effect_sql_migrations ledger; refusing to guess its schema lineage.",
      );
    }
    return { kind: "empty", latestMigrationId: 0 };
  }

  const latestMigrationId = history.at(-1)!.migration_id;
  if (tables.has("orchestration_v2_events")) {
    const missingV2Tables = requiredV2Tables.filter((name) => !tables.has(name));
    if (missingV2Tables.length > 0) {
      return yield* migrationError(
        `V2 event log exists but its schema is incomplete (missing ${missingV2Tables.join(", ")}); no migrations were changed.`,
      );
    }
  }

  if (history.length <= 35 && exactPrefix(history, commonMigrationNames)) {
    return { kind: "common", latestMigrationId };
  }

  const forkNames = combinedNames(commonMigrationNames, forkMigrationNames);
  if (history.length <= 66 && exactForkPrefix(history, forkNames)) {
    if (tables.has("orchestration_v2_events")) {
      return yield* migrationError(
        "Fork migration history through 66 unexpectedly contains V2 tables; refusing to treat the V2 schema as fork V1.",
      );
    }
    return { kind: "fork", latestMigrationId };
  }
  if (history.length <= 66 && exactPrefix(history, legacyForkMigrationNames)) {
    if (tables.has("orchestration_v2_events")) {
      return yield* migrationError(
        "Legacy fork migration history unexpectedly contains V2 tables; refusing to treat the V2 schema as fork V1.",
      );
    }
    return { kind: "fork", latestMigrationId };
  }
  if (
    history.length === 67 &&
    exactForkPrefix(history.slice(0, 66), forkNames) &&
    withCoreCutover(history, 66) &&
    tables.has("orchestration_v2_events")
  ) {
    return { kind: "fork-v2", latestMigrationId };
  }
  if (
    history.length === 67 &&
    exactPrefix(history.slice(0, 66), legacyForkMigrationNames) &&
    withCoreCutover(history, 66) &&
    tables.has("orchestration_v2_events")
  ) {
    return { kind: "fork-v2", latestMigrationId };
  }

  const upstreamNames = combinedNames(commonMigrationNames, upstreamMigrationNames);
  const hasCutoverRow = withCoreCutover(history, history.length - 1);
  const upstreamPrefixLength = hasCutoverRow ? history.length - 1 : history.length;
  const hasValidUpstreamPrefix =
    upstreamPrefixLength >= 36 &&
    upstreamPrefixLength <= 56 &&
    exactPrefix(history.slice(0, upstreamPrefixLength), upstreamNames);
  const hasCutover = withCoreCutover(history, upstreamPrefixLength);

  if (hasValidUpstreamPrefix && (history.length === upstreamPrefixLength || hasCutover)) {
    if (upstreamPrefixLength <= 54) {
      if (tables.has("orchestration_v2_events") && !hasCutover) {
        return yield* migrationError(
          "Upstream V1 ledger contains V2 tables without a V2 migration marker; refusing to guess whether that schema is complete.",
        );
      }
      if (hasCutover && !tables.has("orchestration_v2_events")) {
        return yield* migrationError("Core V2 cutover marker is present without the V2 schema.");
      }
      return { kind: "upstream-v1", latestMigrationId };
    }
    if (!tables.has("orchestration_v2_events")) {
      return yield* migrationError(
        "Upstream V2 migration history is missing its V2 schema marker.",
      );
    }
    return { kind: "upstream-v2", latestMigrationId };
  }

  const previewBase = history.length >= 52 && exactPrefix(history.slice(0, 52), upstreamNames);
  const preview53 =
    previewBase &&
    history[52]?.migration_id === 53 &&
    history[52]?.name === "OrchestrationV2" &&
    (history.length === 53 || withCoreCutover(history, 53));
  const preview54 =
    previewBase &&
    history[52]?.migration_id === 53 &&
    history[52]?.name === "PullRequestFilesViewed" &&
    history[53]?.migration_id === 54 &&
    history[53]?.name === "OrchestrationV2" &&
    (history.length === 54 ||
      (history[54]?.migration_id === 55 &&
        history[54]?.name === "RemoveRedundantProjectionIndexes" &&
        (history.length === 55 || withCoreCutover(history, 55))));
  if ((preview53 || preview54) && tables.has("orchestration_v2_events")) {
    return { kind: "preview-v2", latestMigrationId };
  }

  return yield* migrationError(
    `Unsupported migration history through ${latestMigrationId}; expected a fork history through 66, upstream V1/V2, or a supported V2 preview at 53/54. The recorded ledger was left untouched.`,
  );
});
