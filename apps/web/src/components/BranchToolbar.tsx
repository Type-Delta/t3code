import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import type { SubagentRunSummary } from "../session-logic";
import { useProject, useThread, useThreadShellsForProjectRefs } from "../state/entities";
import { useWorktrees, useWorktreesOnce } from "../state/queries";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveDraftWorktreeContext,
  resolveEffectiveEnvMode,
  resolveLockedWorktreeDisplay,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  resolveSubagentAggregateStatus,
  resolveWorktreePickerModel,
  type WorktreeRecord,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { BranchToolbarWorktreeSelector } from "./BranchToolbarWorktreeSelector";
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Separator } from "./ui/separator";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  subagentRuns: ReadonlyArray<SubagentRunSummary>;
  onOpenSubagent: (runIds: ReadonlyArray<string>) => void;
}

function subagentMenuLabel(run: SubagentRunSummary): string {
  if (run.title !== run.model) return run.title;
  return run.prompt.trim().split(/\r?\n/u, 1)[0] || "Subagent";
}

function subagentMenuMetadata(run: SubagentRunSummary): string {
  const values = [run.model, run.reasoningEffort ? `${run.reasoningEffort} effort` : null].filter(
    (value): value is string => Boolean(value),
  );
  return values.length > 0 ? values.join(" · ") : "Model and effort unavailable";
}

const SUBAGENT_STATUS_LABEL = {
  inProgress: "Working",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
} as const satisfies Record<SubagentRunSummary["status"], string>;

const SUBAGENT_ICON_CLASS = {
  inProgress:
    "animate-sidebar-working-text text-sky-600 motion-reduce:animate-none dark:text-sky-400",
  completed: "text-muted-foreground",
  failed: "text-red-600 dark:text-red-400",
  stopped: "text-muted-foreground",
} as const satisfies Record<SubagentRunSummary["status"], string>;

const SUBAGENT_TRIGGER_CLASS = {
  complete: "text-muted-foreground hover:text-foreground",
  working:
    "animate-sidebar-working-text text-sky-600 motion-reduce:animate-none hover:text-sky-500 dark:text-sky-400 dark:hover:text-sky-300",
  errorWorking:
    "animate-sidebar-working-text text-red-600 motion-reduce:animate-none hover:text-red-500 dark:text-red-400 dark:hover:text-red-300",
  error: "text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300",
} as const;

const BranchToolbarSubagentSelector = memo(function BranchToolbarSubagentSelector(props: {
  runs: ReadonlyArray<SubagentRunSummary>;
  onOpenSubagent: (runIds: ReadonlyArray<string>) => void;
}) {
  if (props.runs.length === 0) return null;
  const aggregateStatus = resolveSubagentAggregateStatus(props.runs.map((run) => run.status));
  const aggregateStatusLabel =
    aggregateStatus === "complete"
      ? "completed"
      : aggregateStatus === "working"
        ? "working"
        : aggregateStatus === "errorWorking"
          ? "errors, with work still running"
          : "errors";

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className={`shrink-0 justify-start ${SUBAGENT_TRIGGER_CLASS[aggregateStatus]}`}
        aria-label={`${props.runs.length} ${props.runs.length === 1 ? "subagent" : "subagents"}, ${aggregateStatusLabel}`}
      >
        <span className="hidden tabular-nums @[34rem]/composer-strip:inline">
          {props.runs.length} {props.runs.length === 1 ? "Subagent" : "Subagents"}
        </span>
        <span className="tabular-nums @[34rem]/composer-strip:hidden">{props.runs.length} Sub</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="center" side="top" className="w-80 max-w-[calc(100vw-2rem)]">
        <MenuGroup>
          <MenuGroupLabel>Subagents</MenuGroupLabel>
          {props.runs.map((run) => (
            <MenuItem
              key={run.id}
              className="h-auto min-w-0 py-2"
              onClick={() => props.onOpenSubagent([run.id])}
            >
              <BotIcon
                className={`size-3.5 shrink-0 ${SUBAGENT_ICON_CLASS[run.status]}`}
                aria-hidden
              />
              <span className="sr-only">{SUBAGENT_STATUS_LABEL[run.status]}</span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate font-medium text-foreground">
                  {subagentMenuLabel(run)}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {subagentMenuMetadata(run)}
                </span>
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  draftId,
  onEnvModeChange,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  subagentRuns,
  onOpenSubagent,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const canSelectExistingWorktree = draftThread !== null && serverThread === null && !envLocked;
  const projectWorkspaceRoot = activeProject?.workspaceRoot ?? null;
  const worktreeQuery = useWorktrees({
    environmentId,
    cwd: canSelectExistingWorktree ? projectWorkspaceRoot : null,
  });
  const lockedWorktreeQuery = useWorktreesOnce({
    environmentId,
    cwd: serverThread !== null ? projectWorkspaceRoot : null,
  });
  const draftWorktreesRef = useRef<{
    workspaceRoot: string | null;
    worktrees: ReadonlyArray<WorktreeRecord>;
  }>({ workspaceRoot: null, worktrees: [] });
  const initializedPrimaryWorktreeKeysRef = useRef(new Set<string>());
  useEffect(() => {
    if (worktreeQuery.data !== null && projectWorkspaceRoot !== null) {
      draftWorktreesRef.current = {
        workspaceRoot: projectWorkspaceRoot,
        worktrees: worktreeQuery.data.worktrees,
      };
    }
  }, [projectWorkspaceRoot, worktreeQuery.data]);
  const cachedDraftWorktrees =
    draftWorktreesRef.current.workspaceRoot === projectWorkspaceRoot
      ? draftWorktreesRef.current.worktrees
      : [];
  const hasActiveThread = serverThread !== null || draftThread !== null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread: serverThread !== null,
      draftThreadEnvMode: draftThread?.envMode,
    });
  const envModeLocked = envLocked || (serverThread !== null && activeWorktreePath !== null);
  const worktreePickerModel = useMemo(
    () =>
      canSelectExistingWorktree
        ? resolveWorktreePickerModel({
            effectiveEnvMode,
            activeWorktreePath,
            worktrees: worktreeQuery.data?.worktrees ?? [],
          })
        : null,
    [
      activeWorktreePath,
      canSelectExistingWorktree,
      effectiveEnvMode,
      worktreeQuery.data?.worktrees,
    ],
  );
  const lockedWorktreeDisplay = useMemo(
    () =>
      serverThread === null || projectWorkspaceRoot === null
        ? null
        : resolveLockedWorktreeDisplay({
            activeWorktreePath,
            projectWorkspaceRoot,
            branch: serverThread.branch,
            worktrees: lockedWorktreeQuery.data?.worktrees ?? cachedDraftWorktrees,
          }),
    [
      activeWorktreePath,
      cachedDraftWorktrees,
      lockedWorktreeQuery.data?.worktrees,
      projectWorkspaceRoot,
      serverThread,
    ],
  );
  const worktreeControlModel = serverThread === null ? worktreePickerModel : null;
  const onWorktreeChange = useCallback(
    (worktree: NonNullable<typeof worktreePickerModel>["options"][number]) => {
      if (!activeProjectRef || !canSelectExistingWorktree || !projectWorkspaceRoot) return;
      setDraftThreadContext(draftId ?? threadRef, {
        ...resolveDraftWorktreeContext(worktree, projectWorkspaceRoot),
        projectRef: activeProjectRef,
      });
      onComposerFocusRequest?.();
    },
    [
      activeProjectRef,
      canSelectExistingWorktree,
      draftId,
      onComposerFocusRequest,
      projectWorkspaceRoot,
      setDraftThreadContext,
      threadRef,
    ],
  );
  useEffect(() => {
    if (
      !canSelectExistingWorktree ||
      !activeProjectRef ||
      !projectWorkspaceRoot ||
      activeWorktreePath !== null
    ) {
      return;
    }
    const initializationKey = JSON.stringify([draftId ?? threadRef, projectWorkspaceRoot]);
    if (initializedPrimaryWorktreeKeysRef.current.has(initializationKey)) return;
    const primaryWorktree = worktreePickerModel?.options.find((worktree) => worktree.isPrimary);
    if (!primaryWorktree) return;
    initializedPrimaryWorktreeKeysRef.current.add(initializationKey);
    if (draftThread?.branch !== null) return;
    const context = resolveDraftWorktreeContext(primaryWorktree, projectWorkspaceRoot);
    if (
      draftThread?.branch === context.branch &&
      draftThread?.worktreePath === context.worktreePath &&
      draftThread.envMode === context.envMode
    ) {
      return;
    }
    setDraftThreadContext(draftId ?? threadRef, {
      ...context,
      projectRef: activeProjectRef,
    });
  }, [
    activeProjectRef,
    activeWorktreePath,
    canSelectExistingWorktree,
    draftId,
    draftThread?.branch,
    draftThread?.envMode,
    draftThread?.worktreePath,
    projectWorkspaceRoot,
    setDraftThreadContext,
    threadRef,
    worktreePickerModel,
  ]);

  // "Previous worktree" hops a draft into the most recently active worktree
  // of this project — the "keep going where I just was" follow-up flow. Only
  // drafts can hop; started server threads have their workspace pinned.
  const canUsePreviousWorktree = draftThread !== null && serverThread === null && !envModeLocked;
  const projectRefsForWorktreeLookup = useMemo(
    () => (canUsePreviousWorktree && activeProjectRef ? [activeProjectRef] : []),
    [canUsePreviousWorktree, activeProjectRef],
  );
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = useMemo(
    () =>
      canUsePreviousWorktree
        ? resolvePreviousWorktreeSeed({
            threads: projectThreads,
            currentWorktreePath: activeWorktreePath,
          })
        : null,
    [activeWorktreePath, canUsePreviousWorktree, projectThreads],
  );
  const previousWorktreeLabel = previousWorktreeSeed
    ? resolvePreviousWorktreeLabel(previousWorktreeSeed)
    : null;
  const onUsePreviousWorktree = useCallback(() => {
    if (!previousWorktreeSeed || !activeProjectRef) return;
    // Same shape the branch selector writes when picking a branch that
    // already lives in a worktree: point the draft at the existing tree.
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  }, [activeProjectRef, draftId, previousWorktreeSeed, setDraftThreadContext, threadRef]);

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: showEnvironmentPicker,
  });
  if (!hasActiveThread || !activeProject) return null;

  return (
    <div className="chat-composer-context-strip @container/composer-strip -mt-4 mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] items-center gap-2 px-1 pt-5 pb-1">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {showEnvironmentIndicator && availableEnvironments && (
          <>
            <BranchToolbarEnvironmentSelector
              envLocked={envLocked}
              environmentId={environmentId}
              availableEnvironments={availableEnvironments}
              {...(showEnvironmentPicker && onEnvironmentChange ? { onEnvironmentChange } : {})}
            />
            <Separator orientation="vertical" className="mx-0.5 h-3.5!" />
          </>
        )}
        <BranchToolbarEnvModeSelector
          envLocked={envModeLocked}
          effectiveEnvMode={effectiveEnvMode}
          activeWorktreePath={activeWorktreePath}
          onEnvModeChange={onEnvModeChange}
          previousWorktreeLabel={previousWorktreeLabel}
          onUsePreviousWorktree={onUsePreviousWorktree}
        />
        {worktreeControlModel || lockedWorktreeDisplay ? (
          <BranchToolbarWorktreeSelector
            model={worktreeControlModel}
            locked={serverThread !== null}
            lockedDisplay={lockedWorktreeDisplay}
            onWorktreeChange={onWorktreeChange}
          />
        ) : null}
      </div>

      <BranchToolbarSubagentSelector runs={subagentRuns} onOpenSubagent={onOpenSubagent} />

      <BranchToolbarBranchSelector
        className="ml-auto min-w-0 flex-none justify-end"
        environmentId={environmentId}
        threadId={threadId}
        {...(draftId ? { draftId } : {})}
        envLocked={envLocked}
        {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
        {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
        {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
        startFromOrigin={startFromOrigin}
        onStartFromOriginChange={onStartFromOriginChange}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
});
