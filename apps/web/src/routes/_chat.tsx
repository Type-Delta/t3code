import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Navigate, Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { selectSplitPaneRefs, useSplitViewStore } from "../splitViewStore";
import { resolveVisibleSplitPanes, SplitThreadWorkspace } from "../components/SplitThreadWorkspace";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { GlobalVoiceInputIndicator } from "../components/chat/GlobalVoiceInputIndicator";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useShownThreadRouteTarget } from "../hooks/useShownThreadRouteTarget";
import { useHiddenThreadKeys } from "../state/entities";

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const { shownTarget, modalOpen } = useShownThreadRouteTarget();
  const splitPaneRefs = useSplitViewStore(selectSplitPaneRefs);
  const splitViewActive = splitPaneRefs.length > 0;
  const hiddenKeys = useHiddenThreadKeys();
  const draftSession = useComposerDraftStore((store) =>
    shownTarget?.kind === "draft" ? store.getDraftSession(shownTarget.draftId) : null,
  );
  const promotedDraftRef = useComposerDraftStore((store) =>
    shownTarget?.kind === "draft" ? store.getPromotedDraftRedirect(shownTarget.draftId) : null,
  );
  const currentRouteRef =
    shownTarget?.kind === "server"
      ? shownTarget.threadRef
      : draftSession
        ? scopeThreadRef(draftSession.environmentId, draftSession.threadId)
        : promotedDraftRef;
  const visibleSplitPaneRefs =
    splitViewActive && currentRouteRef
      ? resolveVisibleSplitPanes({ paneRefs: splitPaneRefs, hiddenKeys, routeRef: currentRouteRef })
      : null;
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {visibleSplitPaneRefs && currentRouteRef ? (
        <SplitThreadWorkspace
          currentRouteRef={currentRouteRef}
          paneRefs={visibleSplitPaneRefs}
          background={modalOpen}
        />
      ) : shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {splitViewActive && promotedDraftRef && !modalOpen ? (
        <Navigate
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(promotedDraftRef)}
          replace
        />
      ) : null}
      {modalOpen ? <Outlet /> : null}
      <GlobalVoiceInputIndicator hidden={modalOpen} />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
