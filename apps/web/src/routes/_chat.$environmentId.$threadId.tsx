import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useState, type DragEvent } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import { SidebarInset } from "~/components/ui/sidebar";
import { SplitThreadWorkspace } from "../components/SplitThreadWorkspace";
import { selectIsSplitViewActive, useSplitViewStore } from "../splitViewStore";
import { endSplitThreadDrag, hasSplitThreadDrag, readSplitThreadDrag } from "../splitViewDrag";
import { useEnvironmentThreadRefs, useThreadDetail, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";

function StandaloneThreadDropWorkspace({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [dropPosition, setDropPosition] = useState<"before" | "after" | null>(null);
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitThreadDrag(event.dataTransfer)) return;
      const draggedRef = readSplitThreadDrag(event.dataTransfer);
      if (!draggedRef || scopedThreadKey(draggedRef) === scopedThreadKey(threadRef)) {
        setDropPosition(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const bounds = event.currentTarget.getBoundingClientRect();
      setDropPosition(event.clientX < bounds.left + bounds.width / 2 ? "before" : "after");
    },
    [threadRef],
  );
  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDropPosition(null);
  }, []);
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitThreadDrag(event.dataTransfer)) return;
      const draggedRef = readSplitThreadDrag(event.dataTransfer);
      event.preventDefault();
      setDropPosition(null);
      if (!draggedRef || scopedThreadKey(draggedRef) === scopedThreadKey(threadRef)) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const insertionIndex = event.clientX < bounds.left + bounds.width / 2 ? 0 : 1;
      useSplitViewStore.getState().placePane(threadRef, draggedRef, insertionIndex);
    },
    [threadRef],
  );

  return (
    <SidebarInset
      className="relative h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh"
      onDragEnd={() => {
        endSplitThreadDrag();
        setDropPosition(null);
      }}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
      />
      {dropPosition ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-lg bg-primary/8 ring-2 ring-primary/70"
        >
          <span className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm">
            {dropPosition === "before"
              ? "Drop to open this thread before the current pane"
              : "Drop to open this thread after the current pane"}
          </span>
        </div>
      ) : null}
    </SidebarInset>
  );
}

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const splitViewActive = useSplitViewStore(selectIsSplitViewActive);
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const threadExists = serverThreadShell !== null || serverThreadDetail !== null;
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  if (splitViewActive) {
    return <SplitThreadWorkspace currentRouteRef={threadRef} />;
  }

  return <StandaloneThreadDropWorkspace threadRef={threadRef} />;
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
