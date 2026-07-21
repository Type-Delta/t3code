import { useNavigate } from "@tanstack/react-router";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { autoAnimate } from "@formkit/auto-animate";
import { GripVerticalIcon, PanelLeftCloseIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "~/threadRoutes";

import {
  beginSplitThreadDrag,
  endSplitThreadDrag,
  hasSplitThreadDrag,
  readSplitThreadDrag,
} from "../splitViewDrag";
import {
  findSplitViewGroupForThread,
  MAX_SPLIT_VIEW_PANES,
  selectActiveSplitPane,
  selectIsSplitViewActive,
  selectSplitPaneRefs,
  useSplitViewStore,
} from "../splitViewStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useProject, useThread, useThreadRefs } from "../state/entities";
import ChatView from "./ChatView";
import { threadHasStarted } from "./ChatView.logic";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { SplitPaneDropHint } from "./SplitPaneDropHint";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface SplitThreadWorkspaceProps {
  /** The thread represented by the browser URL before split-mode reconciliation. */
  currentRouteRef: ScopedThreadRef | null;
}

interface DraftPane {
  draftId: DraftId;
  projectId: ReturnType<
    typeof useComposerDraftStore.getState
  >["draftThreadsByThreadKey"][string]["projectId"];
  threadRef: ScopedThreadRef;
}

export type SplitPaneDropPosition = "before" | "after";

interface SplitPaneDropTarget {
  paneKey: string;
  position: SplitPaneDropPosition;
}

const SPLIT_PANE_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

export function splitThreadGridColumnClassName(paneCount: number): string {
  switch (paneCount) {
    case 4:
      return "grid-cols-4";
    case 3:
      return "grid-cols-3";
    default:
      return "grid-cols-2";
  }
}

export function resolveSplitPaneDropPosition(
  event: Pick<DragEvent<HTMLElement>, "clientX">,
  element: Pick<HTMLElement, "getBoundingClientRect">,
): SplitPaneDropPosition {
  const bounds = element.getBoundingClientRect();
  return event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
}

export function resolveSplitRightPanelOwner(input: {
  paneKeys: readonly string[];
  activePaneKey: string | null;
  currentOwnerKey: string | null;
  openPanelKeys: ReadonlySet<string>;
}): string | null {
  const paneHasOpenPanel = (paneKey: string | null): paneKey is string =>
    paneKey !== null && input.paneKeys.includes(paneKey) && input.openPanelKeys.has(paneKey);
  if (paneHasOpenPanel(input.activePaneKey)) return input.activePaneKey;
  if (paneHasOpenPanel(input.currentOwnerKey)) return input.currentOwnerKey;
  return input.paneKeys.find((paneKey) => input.openPanelKeys.has(paneKey)) ?? null;
}

function routeToPane(
  navigate: ReturnType<typeof useNavigate>,
  threadRef: ScopedThreadRef,
  draftPane: DraftPane | undefined,
): void {
  if (draftPane) {
    void navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(draftPane.draftId),
      replace: true,
    });
    return;
  }

  void navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(threadRef),
    replace: true,
  });
}

function SplitThreadPane(props: {
  threadRef: ScopedThreadRef;
  draftPane: DraftPane | undefined;
  active: boolean;
  isRightPanelOwner: boolean;
  paneIndex: number;
  dropTarget: SplitPaneDropTarget | null;
  canPlaceThread: (threadRef: ScopedThreadRef | null) => boolean;
  onActivate: () => void;
  onDetach: () => void;
  onDropTargetChange: (target: SplitPaneDropTarget | null) => void;
  onPlaceThread: (threadRef: ScopedThreadRef, insertionIndex: number) => void;
  headerSlot: HTMLElement | null;
  rightPanelSlot: HTMLElement | null;
}) {
  const {
    active,
    canPlaceThread,
    draftPane,
    dropTarget,
    headerSlot,
    isRightPanelOwner,
    onActivate,
    onDetach,
    onDropTargetChange,
    onPlaceThread,
    paneIndex,
    rightPanelSlot,
    threadRef,
  } = props;
  const navigate = useNavigate();
  const serverThread = useThread(threadRef);
  const projectRef = useMemo(() => {
    const projectId = serverThread?.projectId ?? draftPane?.projectId;
    return projectId ? scopeProjectRef(threadRef.environmentId, projectId) : null;
  }, [draftPane?.projectId, serverThread?.projectId, threadRef.environmentId]);
  const project = useProject(projectRef);
  const serverThreadStarted = threadHasStarted(serverThread);
  const threadKey = scopedThreadKey(threadRef);
  const isDropTarget = dropTarget?.paneKey === threadKey;

  useEffect(() => {
    if (!draftPane || !serverThreadStarted) {
      return;
    }

    finalizePromotedDraftThreadByRef(threadRef);
    if (active) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        replace: true,
      });
    }
  }, [active, draftPane, navigate, serverThreadStarted, threadRef]);

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      beginSplitThreadDrag(event.dataTransfer, threadRef);
    },
    [threadRef],
  );
  const handleDragEnd = useCallback(() => {
    endSplitThreadDrag();
    onDropTargetChange(null);
  }, [onDropTargetChange]);
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitThreadDrag(event.dataTransfer)) return;
      const draggedRef = readSplitThreadDrag(event.dataTransfer);
      if (!canPlaceThread(draggedRef)) {
        onDropTargetChange(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      onDropTargetChange({
        paneKey: threadKey,
        position: resolveSplitPaneDropPosition(event, event.currentTarget),
      });
    },
    [canPlaceThread, onDropTargetChange, threadKey],
  );
  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
      onDropTargetChange(null);
    },
    [onDropTargetChange],
  );
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitThreadDrag(event.dataTransfer)) return;
      const draggedRef = readSplitThreadDrag(event.dataTransfer);
      event.preventDefault();
      event.stopPropagation();
      onDropTargetChange(null);
      if (!draggedRef || !canPlaceThread(draggedRef)) return;
      const position = resolveSplitPaneDropPosition(event, event.currentTarget);
      onPlaceThread(draggedRef, paneIndex + (position === "before" ? 0 : 1));
    },
    [canPlaceThread, onDropTargetChange, onPlaceThread, paneIndex],
  );

  if (!serverThread && !draftPane) {
    return null;
  }

  const threadTitle = serverThread?.title ?? "New thread";
  const projectName = project?.title ?? "Project unavailable";
  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        active && "z-10",
      )}
      data-split-thread-pane
      data-split-thread-pane-active={active}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div
        className="flex h-12 shrink-0 cursor-grab items-center gap-2 border-b border-border/70 bg-card/60 px-2.5 active:cursor-grabbing"
        draggable
        onClick={onActivate}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
      >
        <GripVerticalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/55" />
        <span className="min-w-0 flex-1 text-left leading-tight">
          <span className="block truncate text-xs font-medium text-foreground">{threadTitle}</span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/75">
            {projectName}
          </span>
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Detach ${threadTitle} from split view`}
                className="shrink-0"
                draggable={false}
                size="icon-xs"
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation();
                  onDetach();
                }}
                onDragStart={(event) => event.preventDefault()}
              />
            }
          >
            <PanelLeftCloseIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Detach from split view</TooltipPopup>
        </Tooltip>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        {draftPane && !serverThreadStarted ? (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="draft"
            draftId={draftPane.draftId}
            paneMode={{
              isActive: active,
              isRightPanelOwner,
              onActivate,
              headerSlot,
              rightPanelSlot,
            }}
          />
        ) : (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            paneMode={{
              isActive: active,
              isRightPanelOwner,
              onActivate,
              headerSlot,
              rightPanelSlot,
            }}
          />
        )}
      </div>
      {isDropTarget ? (
        <SplitPaneDropHint className="inset-0" position={dropTarget.position} />
      ) : null}
    </div>
  );
}

/**
 * Hosts all split panes while keeping the app-level right chrome owned by only
 * the focused pane. The URL remains a normal single-thread URL for that pane.
 */
export function SplitThreadWorkspace({ currentRouteRef }: SplitThreadWorkspaceProps) {
  const navigate = useNavigate();
  const paneRefs = useSplitViewStore(selectSplitPaneRefs);
  const activePane = useSplitViewStore(selectActiveSplitPane);
  const splitActive = useSplitViewStore(selectIsSplitViewActive);
  const serverThreadRefs = useThreadRefs();
  const draftThreadsById = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [rightPanelSlot, setRightPanelSlot] = useState<HTMLDivElement | null>(null);
  const rightPanelStateByThreadKey = useRightPanelStore((state) => state.byThreadKey);
  const [rightPanelOwnerThreadKey, setRightPanelOwnerThreadKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<SplitPaneDropTarget | null>(null);
  const paneGridAnimationRef = useRef<{
    node: HTMLElement;
    controller: ReturnType<typeof autoAnimate>;
  } | null>(null);
  const attachPaneGridAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (paneGridAnimationRef.current?.node === node) {
      return;
    }
    paneGridAnimationRef.current?.controller.destroy?.();
    paneGridAnimationRef.current = node
      ? { node, controller: autoAnimate(node, SPLIT_PANE_ANIMATION_OPTIONS) }
      : null;
  }, []);

  const draftPaneByThreadKey = useMemo(() => {
    const entries = new Map<string, DraftPane>();
    for (const [rawDraftId, draft] of Object.entries(draftThreadsById)) {
      const threadRef = scopeThreadRef(draft.environmentId, draft.threadId);
      entries.set(scopedThreadKey(threadRef), {
        draftId: DraftId.make(rawDraftId),
        projectId: draft.projectId,
        threadRef,
      });
    }
    return entries;
  }, [draftThreadsById]);

  const availablePaneRefs = useMemo(() => {
    const available = new Map<string, ScopedThreadRef>();
    for (const threadRef of serverThreadRefs) {
      available.set(scopedThreadKey(threadRef), threadRef);
    }
    for (const draftPane of draftPaneByThreadKey.values()) {
      available.set(scopedThreadKey(draftPane.threadRef), draftPane.threadRef);
    }
    return [...available.values()];
  }, [draftPaneByThreadKey, serverThreadRefs]);

  const navigateToPane = useCallback(
    (threadRef: ScopedThreadRef) => {
      routeToPane(navigate, threadRef, draftPaneByThreadKey.get(scopedThreadKey(threadRef)));
    },
    [draftPaneByThreadKey, navigate],
  );

  useEffect(() => {
    // Persisted layouts are restored before thread bootstrap completes. Waiting
    // for at least one known thread prevents that short loading interval from
    // erasing a valid saved layout.
    if (availablePaneRefs.length === 0) return;
    const fallback = useSplitViewStore.getState().reconcilePanes(availablePaneRefs);
    if (fallback) {
      navigateToPane(fallback);
    }
  }, [availablePaneRefs, navigateToPane]);

  const activePaneKey = activePane ? scopedThreadKey(activePane) : null;
  useEffect(() => {
    const paneKeys = paneRefs.map(scopedThreadKey);
    const openPanelKeys = new Set(
      paneRefs.flatMap((paneRef) => {
        const paneKey = scopedThreadKey(paneRef);
        return rightPanelStateByThreadKey[paneKey]?.isOpen ? [paneKey] : [];
      }),
    );
    setRightPanelOwnerThreadKey((currentOwnerKey) =>
      resolveSplitRightPanelOwner({
        paneKeys,
        activePaneKey,
        currentOwnerKey,
        openPanelKeys,
      }),
    );
  }, [activePaneKey, paneRefs, rightPanelStateByThreadKey]);
  const currentRouteKey = currentRouteRef ? scopedThreadKey(currentRouteRef) : null;
  useEffect(() => {
    const state = useSplitViewStore.getState();
    const currentActivePane = selectActiveSplitPane(state);
    const pendingThreadKey = state.pendingNavigationThreadKey;

    // Store actions intentionally precede URL updates. During a group switch,
    // keep the requested group active until the router reaches its focused pane.
    if (pendingThreadKey) {
      if (currentRouteKey === pendingThreadKey && currentRouteRef) {
        state.confirmNavigation(currentRouteRef);
      } else if (currentActivePane && scopedThreadKey(currentActivePane) === pendingThreadKey) {
        navigateToPane(currentActivePane);
        return;
      }
    }

    if (
      currentRouteKey &&
      !paneRefs.some((paneRef) => scopedThreadKey(paneRef) === currentRouteKey)
    ) {
      const routeGroup = findSplitViewGroupForThread(state, currentRouteKey);
      if (routeGroup && currentRouteRef) {
        state.resumeSplit(currentRouteRef);
      } else {
        // A normal navigation outside every saved group exits split mode while
        // preserving all layouts for a later return.
        state.exitSplit();
      }
      return;
    }

    // Re-read after reconciliation: this effect runs immediately after the
    // reconciliation effect above and must not navigate to a just-removed pane.
    if (!currentActivePane || currentRouteKey === scopedThreadKey(currentActivePane)) {
      return;
    }
    navigateToPane(currentActivePane);
  }, [activePane, activePaneKey, currentRouteKey, currentRouteRef, navigateToPane, paneRefs]);

  const activatePane = useCallback(
    (threadRef: ScopedThreadRef) => {
      const threadKey = scopedThreadKey(threadRef);
      if (
        useSplitViewStore.getState().activeThreadKey === threadKey &&
        currentRouteKey === threadKey
      ) {
        return;
      }
      useSplitViewStore.getState().activatePane(threadRef);
      navigateToPane(threadRef);
    },
    [currentRouteKey, navigateToPane],
  );

  const canPlaceThread = useCallback(
    (threadRef: ScopedThreadRef | null) => {
      if (!threadRef) return paneRefs.length < MAX_SPLIT_VIEW_PANES;
      return (
        paneRefs.some((paneRef) => scopedThreadKey(paneRef) === scopedThreadKey(threadRef)) ||
        paneRefs.length < MAX_SPLIT_VIEW_PANES
      );
    },
    [paneRefs],
  );
  const placeThread = useCallback(
    (threadRef: ScopedThreadRef, insertionIndex: number) => {
      const state = useSplitViewStore.getState();
      const activePaneRefs = selectSplitPaneRefs(state);
      const isExistingPane = activePaneRefs.some(
        (paneRef) => scopedThreadKey(paneRef) === scopedThreadKey(threadRef),
      );
      if (isExistingPane) {
        state.movePane(threadRef, insertionIndex);
        return;
      }
      const anchor = currentRouteRef ?? activePaneRefs[0];
      if (!anchor) return;
      state.placePane(anchor, threadRef, insertionIndex);
    },
    [currentRouteRef],
  );
  const detachPane = useCallback(
    (threadRef: ScopedThreadRef) => {
      const state = useSplitViewStore.getState();
      const wasActive = state.activeThreadKey === scopedThreadKey(threadRef);
      const fallback = state.detachPane(threadRef);
      if (fallback) {
        navigateToPane(fallback);
      } else if (wasActive) {
        const nextActivePane = selectActiveSplitPane(useSplitViewStore.getState());
        if (nextActivePane) navigateToPane(nextActivePane);
      }
    },
    [navigateToPane],
  );
  const handleGridDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitThreadDrag(event.dataTransfer)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-split-thread-pane]")) return;
      const draggedRef = readSplitThreadDrag(event.dataTransfer);
      if (!canPlaceThread(draggedRef)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(null);
    },
    [canPlaceThread],
  );
  const handleGridDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitThreadDrag(event.dataTransfer)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-split-thread-pane]")) return;
      const draggedRef = readSplitThreadDrag(event.dataTransfer);
      event.preventDefault();
      setDropTarget(null);
      if (!draggedRef || !canPlaceThread(draggedRef)) return;
      placeThread(draggedRef, paneRefs.length);
    },
    [canPlaceThread, paneRefs.length, placeThread],
  );

  // The route switches back to its standalone ChatView as soon as the store
  // falls below two panes during reconciliation.
  if (!splitActive) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <DiffWorkerPoolProvider>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div
              ref={setHeaderSlot}
              className="relative z-20 min-w-0 shrink-0"
              data-split-workspace-header
            />
            <div
              ref={attachPaneGridAutoAnimateRef}
              className={cn(
                "grid min-h-0 min-w-0 flex-1 gap-px overflow-hidden bg-border",
                splitThreadGridColumnClassName(paneRefs.length),
              )}
              data-split-thread-grid
              onDragEnd={() => {
                endSplitThreadDrag();
                setDropTarget(null);
              }}
              onDragOver={handleGridDragOver}
              onDrop={handleGridDrop}
            >
              {paneRefs.map((threadRef, paneIndex) => {
                const threadKey = scopedThreadKey(threadRef);
                return (
                  <SplitThreadPane
                    key={threadKey}
                    threadRef={threadRef}
                    draftPane={draftPaneByThreadKey.get(threadKey)}
                    active={threadKey === activePaneKey}
                    isRightPanelOwner={threadKey === rightPanelOwnerThreadKey}
                    paneIndex={paneIndex}
                    dropTarget={dropTarget}
                    canPlaceThread={canPlaceThread}
                    onActivate={() => activatePane(threadRef)}
                    onDetach={() => detachPane(threadRef)}
                    onDropTargetChange={setDropTarget}
                    onPlaceThread={placeThread}
                    headerSlot={headerSlot}
                    rightPanelSlot={rightPanelSlot}
                  />
                );
              })}
            </div>
          </div>
          <div
            ref={setRightPanelSlot}
            className="relative flex min-h-0 min-w-0 shrink-0"
            data-split-workspace-right-panel
          />
        </div>
      </DiffWorkerPoolProvider>
    </SidebarInset>
  );
}
