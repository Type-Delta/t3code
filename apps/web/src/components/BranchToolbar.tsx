import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  CloudIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  HistoryIcon,
  MonitorIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import type { SubagentRunSummary } from "../session-logic";
import { useProject, useThread, useThreadShellsForProjectRefs } from "../state/entities";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useWorktrees, useWorktreesOnce } from "../state/queries";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveDraftWorktreeContext,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveEffectiveEnvMode,
  resolveLockedWorkspaceLabel,
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
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";
import { ComposerSurface } from "./chat/ComposerSurface";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  showGitControls: boolean;
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

interface MobileRunContextSelectorProps {
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  onUsePreviousWorktree: () => void;
}

const MobileRunContextSelector = memo(function MobileRunContextSelector({
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
}: MobileRunContextSelectorProps) {
  const activeEnvironment = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = envModeLocked
    ? resolveLockedWorkspaceLabel(activeWorktreePath)
    : effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isLocked = envLocked || envModeLocked;
  const EnvironmentIcon = activeEnvironment?.isPrimary ? MonitorIcon : CloudIcon;
  const icon = showEnvironmentIndicator ? (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <EnvironmentIcon className="size-3 shrink-0 mx-0!" />
      <WorkspaceIcon className="size-3 shrink-0 mx-0!" />
    </span>
  ) : (
    <WorkspaceIcon className="size-3 shrink-0" />
  );
  const triggerContent = (
    <>
      {icon}
      <span className="min-w-0 truncate">
        {showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel}
      </span>
    </>
  );

  if (isLocked) {
    return (
      <span className="inline-flex h-7 min-w-0 max-w-[48%] flex-1 items-center justify-start gap-1 rounded-md border border-transparent px-[calc(--spacing(2)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 md:hidden">
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className="min-w-0 max-w-[48%] flex-1 justify-start text-muted-foreground/70 hover:text-foreground/80 md:hidden"
      >
        {triggerContent}
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
        {showEnvironmentPicker && availableEnvironments && onEnvironmentChange ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={environmentId}
                onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
              >
                {availableEnvironments.map((env) => {
                  const Icon = env.isPrimary ? MonitorIcon : CloudIcon;
                  return (
                    <MenuRadioItem
                      key={env.environmentId}
                      disabled={envLocked}
                      value={env.environmentId}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-3" />
                        <span className="min-w-0 truncate">{env.label}</span>
                      </span>
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked} value="local">
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <span className="min-w-0 truncate">
                  {resolveCurrentWorkspaceLabel(activeWorktreePath)}
                </span>
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree">
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree">
                <span className="flex min-w-0 items-center gap-1.5">
                  <HistoryIcon className="size-3" />
                  <span className="min-w-0 truncate">{previousWorktreeLabel}</span>
                </span>
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

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

/**
 * Collapse the strip's labels to icons only when the text no longer fits.
 *
 * Hidden labels stay measurable because their inner text keeps its natural
 * width while the outer layout box collapses. This lets every pass recompute
 * the expanded width without remembered values that could go stale or latch
 * the strip compact. A small hysteresis keeps the boundary from flapping.
 */
const COMPACT_EXPAND_HYSTERESIS_PX = 16;
const COMPOSER_CONTEXT_MOTION_DURATION_MS = 180;
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_CONTEXT_CONTROL_SELECTOR = "[data-composer-context-control]";

function useLabelsOverflow(element: HTMLDivElement | null): boolean {
  const [overflows, setOverflows] = useState(false);
  const pendingControlRectsRef = useRef<Map<HTMLElement, DOMRect> | null>(null);
  const controlAnimationsRef = useRef(new Map<HTMLElement, Animation>());
  // A render-synced mirror instead of useEffectEvent: the compiler memoizes
  // the event callback, which left observers reading the first render's null
  // element forever.
  const stateRef = useRef({ element, overflows });
  stateRef.current = { element, overflows };

  const measure = useCallback(() => {
    const { element: current, overflows: compact } = stateRef.current;
    if (!current) return;
    const available = current.clientWidth;
    if (available === 0) return;
    // flex-1 stretches the groups to fill the strip, so their own boxes always
    // measure "full". Sum the laid-out content instead, skipping hidden form
    // artifacts and other out-of-flow nodes.
    const contentWidth = (parent: Element): number => {
      const gap = Number.parseFloat(getComputedStyle(parent).columnGap) || 0;
      let width = 0;
      let counted = 0;
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.offsetWidth <= 1) continue;
        const position = getComputedStyle(child).position;
        if (position === "absolute" || position === "fixed") continue;
        width += child.offsetWidth;
        counted += 1;
      }
      return width + gap * Math.max(0, counted - 1);
    };
    const stripGap = Number.parseFloat(getComputedStyle(current).columnGap) || 0;
    let needed = 0;
    let groups = 0;
    for (const child of current.children) {
      if (!(child instanceof HTMLElement)) continue;
      const width = contentWidth(child);
      if (width <= 1) continue;
      needed += width;
      groups += 1;
    }
    needed += stripGap * Math.max(0, groups - 1);
    for (const label of current.querySelectorAll<HTMLElement>("[data-composer-label]")) {
      // The clipping can happen below the marker (SelectValue truncates
      // internally), where the outer span's scrollWidth matches its clipped
      // box. The text's real width is the largest scrollWidth in the subtree.
      let textWidth = label.scrollWidth;
      for (const inner of label.querySelectorAll<HTMLElement>("*")) {
        textWidth = Math.max(textWidth, inner.scrollWidth);
      }
      if (compact) {
        // Compact: the label is squeezed to zero width but keeps reporting
        // the full width it would need when expanded.
        needed += textWidth;
      } else {
        // Expanded: the label is in flow; only the clipped remainder is
        // missing from the content sum.
        needed += Math.max(0, textWidth - label.clientWidth);
      }
    }
    const nextOverflows = compact
      ? needed > available - COMPACT_EXPAND_HYSTERESIS_PX
      : needed > available;
    if (nextOverflows !== compact) {
      pendingControlRectsRef.current = new Map(
        Array.from(current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_CONTROL_SELECTOR)).map(
          (control) => [control, control.getBoundingClientRect()],
        ),
      );
    }
    setOverflows(nextOverflows);
  }, []);

  useLayoutEffect(() => {
    const previousRects = pendingControlRectsRef.current;
    if (!previousRects) return;
    pendingControlRectsRef.current = null;

    for (const animation of controlAnimationsRef.current.values()) {
      animation.cancel();
    }
    controlAnimationsRef.current.clear();

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const [control, previousRect] of previousRects) {
      if (!control.isConnected) continue;
      const nextRect = control.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      const animation = control.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        {
          duration: COMPOSER_CONTEXT_MOTION_DURATION_MS,
          easing: COMPOSER_CONTEXT_MOTION_EASING,
          fill: "backwards",
        },
      );
      controlAnimationsRef.current.set(control, animation);
      animation.addEventListener(
        "finish",
        () => {
          if (controlAnimationsRef.current.get(control) === animation) {
            controlAnimationsRef.current.delete(control);
          }
        },
        { once: true },
      );
    }
  }, [overflows]);

  useEffect(
    () => () => {
      for (const animation of controlAnimationsRef.current.values()) {
        animation.cancel();
      }
    },
    [],
  );

  // Label widths can change without the strip box moving (font family or
  // size preferences), so re-measure on every render as well as on resize
  // and font loads.
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [element, measure]);

  return overflows;
}

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  showGitControls,
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
  const isMobile = useIsMobile();
  const [stripElement, setStripElement] = useState<HTMLDivElement | null>(null);
  const labelsOverflow = useLabelsOverflow(stripElement);

  if (!hasActiveThread || !activeProject) return null;

  return (
    <ComposerSurface.ContextStrip
      ref={setStripElement}
      className="@container/composer-strip"
      data-compact={labelsOverflow ? "" : undefined}
    >
      {isMobile && showGitControls ? (
        <MobileRunContextSelector
          envLocked={envLocked}
          envModeLocked={envModeLocked}
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          showEnvironmentPicker={showEnvironmentPicker}
          showEnvironmentIndicator={showEnvironmentIndicator}
          onEnvironmentChange={onEnvironmentChange}
          effectiveEnvMode={effectiveEnvMode}
          activeWorktreePath={activeWorktreePath}
          onEnvModeChange={onEnvModeChange}
          previousWorktreeLabel={previousWorktreeLabel}
          onUsePreviousWorktree={onUsePreviousWorktree}
        />
      ) : (
        <div className="flex min-w-10 flex-1 items-center gap-1">
          {showEnvironmentIndicator && availableEnvironments && (
            <>
              <BranchToolbarEnvironmentSelector
                envLocked={envLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments}
                {...(showEnvironmentPicker && onEnvironmentChange ? { onEnvironmentChange } : {})}
              />
              {showGitControls ? (
                <Separator
                  orientation="vertical"
                  className="mx-0.5 h-3.5!"
                  data-composer-context-control
                />
              ) : null}
            </>
          )}
          {showGitControls ? (
            <>
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
            </>
          ) : null}
        </div>
      )}

      <BranchToolbarSubagentSelector runs={subagentRuns} onOpenSubagent={onOpenSubagent} />

      {showGitControls ? (
        <BranchToolbarBranchSelector
          className="min-w-0 flex-1 justify-end md:ml-auto md:flex-initial"
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
      ) : null}
    </ComposerSurface.ContextStrip>
  );
});
