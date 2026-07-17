import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { autoAnimate } from "@formkit/auto-animate";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "~/threadRoutes";

import {
  selectActiveSplitPane,
  selectIsSplitViewActive,
  selectSplitPaneRefs,
  useSplitViewStore,
} from "../splitViewStore";
import { useThread, useThreadRefs } from "../state/entities";
import ChatView from "./ChatView";
import { threadHasStarted } from "./ChatView.logic";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { SidebarInset } from "./ui/sidebar";

interface SplitThreadWorkspaceProps {
  /** The thread represented by the browser URL before split-mode reconciliation. */
  currentRouteRef: ScopedThreadRef | null;
}

interface DraftPane {
  draftId: DraftId;
  threadRef: ScopedThreadRef;
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
  onActivate: () => void;
  headerSlot: HTMLElement | null;
  rightPanelSlot: HTMLElement | null;
}) {
  const { active, draftPane, headerSlot, onActivate, rightPanelSlot, threadRef } = props;
  const navigate = useNavigate();
  const serverThread = useThread(threadRef);
  const serverThreadStarted = threadHasStarted(serverThread);

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

  if (!serverThread && !draftPane) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 overflow-hidden bg-background",
        active && "relative z-10 outline outline-1 -outline-offset-1 outline-primary/60",
      )}
      data-split-thread-pane
      data-split-thread-pane-active={active}
    >
      {draftPane && !serverThreadStarted ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="draft"
          draftId={draftPane.draftId}
          paneMode={{ isActive: active, onActivate, headerSlot, rightPanelSlot }}
        />
      ) : (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          paneMode={{ isActive: active, onActivate, headerSlot, rightPanelSlot }}
        />
      )}
    </div>
  );
}

/**
 * Hosts all split panes while keeping the app-level chrome owned by only the
 * focused pane. The URL remains a normal single-thread URL for that pane.
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
    const fallback = useSplitViewStore.getState().reconcilePanes(availablePaneRefs);
    if (fallback) {
      navigateToPane(fallback);
    }
  }, [availablePaneRefs, navigateToPane]);

  const activePaneKey = activePane ? scopedThreadKey(activePane) : null;
  const currentRouteKey = currentRouteRef ? scopedThreadKey(currentRouteRef) : null;
  useEffect(() => {
    // A normal navigation outside the displayed panes exits split mode instead
    // of being redirected back to the previously focused pane.
    if (
      currentRouteKey &&
      !paneRefs.some((paneRef) => scopedThreadKey(paneRef) === currentRouteKey)
    ) {
      useSplitViewStore.getState().clearSplit();
      return;
    }

    // Re-read after reconciliation: this effect runs immediately after the
    // reconciliation effect above and must not navigate to a just-removed pane.
    const currentActivePane = selectActiveSplitPane(useSplitViewStore.getState());
    if (!currentActivePane || currentRouteKey === scopedThreadKey(currentActivePane)) {
      return;
    }
    navigateToPane(currentActivePane);
  }, [activePane, activePaneKey, currentRouteKey, navigateToPane, paneRefs]);

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
            >
              {paneRefs.map((threadRef) => {
                const threadKey = scopedThreadKey(threadRef);
                return (
                  <SplitThreadPane
                    key={threadKey}
                    threadRef={threadRef}
                    draftPane={draftPaneByThreadKey.get(threadKey)}
                    active={threadKey === activePaneKey}
                    onActivate={() => activatePane(threadRef)}
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
