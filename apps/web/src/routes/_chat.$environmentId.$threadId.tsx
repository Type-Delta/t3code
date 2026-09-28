import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { prepareSplitViewThreadNavigation } from "../splitViewNavigation";
import { useSplitViewStore } from "../splitViewStore";

// The view lives in the `_chat` layout (see ThreadRouteView) so a draft's
// promotion onto this route keeps the same ChatView mounted.
export function reconcileSplitViewThreadRoute(
  params: { environmentId: string; threadId: string },
  preload: boolean,
): void {
  if (preload) return;
  const threadRef = scopeThreadRef(
    EnvironmentId.make(params.environmentId),
    ThreadId.make(params.threadId),
  );
  const pendingThreadKey = useSplitViewStore.getState().pendingNavigationThreadKey;
  if (pendingThreadKey && pendingThreadKey !== scopedThreadKey(threadRef)) return;
  prepareSplitViewThreadNavigation(threadRef);
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  beforeLoad: ({ params, preload }) => reconcileSplitViewThreadRoute(params, preload),
  component: () => null,
});
