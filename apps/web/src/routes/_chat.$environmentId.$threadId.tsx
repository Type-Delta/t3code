import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useState, type DragEvent } from "react";

import ChatView from "../components/ChatView";
import { SplitPaneDropHint, type SplitPaneDropSide } from "../components/SplitPaneDropHint";
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
  const [dropHint, setDropHint] = useState<{
    position: SplitPaneDropSide;
    bounds: { left: number; top: number; width: number; height: number };
  } | null>(null);
  const resolveDropHint = useCallback((event: DragEvent<HTMLDivElement>) => {
    const threadArea = event.currentTarget.querySelector<HTMLElement>(
      "[data-chat-column-maximized-away]",
    );
    if (!threadArea) return null;
    const bounds = threadArea.getBoundingClientRect();
    const pointerInsideThreadArea =
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom;
    if (!pointerInsideThreadArea || bounds.width <= 0 || bounds.height <= 0) return null;

    const workspaceBounds = event.currentTarget.getBoundingClientRect();
    return {
      position: event.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
      bounds: {
        left: bounds.left - workspaceBounds.left,
        top: bounds.top - workspaceBounds.top,
        width: bounds.width,
        height: bounds.height,
      },
    } satisfies NonNullable<typeof dropHint>;
  }, []);
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitThreadDrag(event.dataTransfer)) return;
      const draggedRef = readSplitThreadDrag(event.dataTransfer);
      if (!draggedRef || scopedThreadKey(draggedRef) === scopedThreadKey(threadRef)) {
        setDropHint(null);
        return;
      }
      const nextDropHint = resolveDropHint(event);
      if (!nextDropHint) {
        setDropHint(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropHint(nextDropHint);
    },
    [resolveDropHint, threadRef],
  );
  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDropHint(null);
  }, []);
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitThreadDrag(event.dataTransfer)) return;
      const draggedRef = readSplitThreadDrag(event.dataTransfer);
      const nextDropHint = resolveDropHint(event);
      setDropHint(null);
      if (!nextDropHint) return;
      event.preventDefault();
      if (!draggedRef || scopedThreadKey(draggedRef) === scopedThreadKey(threadRef)) return;
      const insertionIndex = nextDropHint.position === "before" ? 0 : 1;
      useSplitViewStore.getState().placePane(threadRef, draggedRef, insertionIndex);
    },
    [resolveDropHint, threadRef],
  );

  return (
    <SidebarInset
      className="relative h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh"
      onDragEnd={() => {
        endSplitThreadDrag();
        setDropHint(null);
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
      {dropHint ? (
        <SplitPaneDropHint
          position={dropHint.position}
          style={{
            left: dropHint.bounds.left,
            top: dropHint.bounds.top,
            width: dropHint.bounds.width,
            height: dropHint.bounds.height,
          }}
        />
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
