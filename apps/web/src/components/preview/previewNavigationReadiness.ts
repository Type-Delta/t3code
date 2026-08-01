import {
  type PreviewAutomationNavigateInput,
  type PreviewAutomationRequest,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { isCurrentPreviewRuntimeTab } from "~/browser/previewRuntimeTabId";
import { readThreadPreviewState } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";
import {
  PreviewAutomationNavigationFailedError,
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationTargetUnavailableError,
} from "./previewAutomationErrors";
import { previewAutomationNavigationFailure } from "./previewAutomationOpenReadiness";

export function assertPreviewRuntimeCurrent(
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  request: Pick<PreviewAutomationRequest, "operation" | "requestId">,
) {
  const state = readThreadPreviewState(threadRef);
  if (
    state.sessions[tabId] &&
    isCurrentPreviewRuntimeTab(threadRef, state.serverEpoch, tabId, runtimeTabId)
  ) {
    return state;
  }
  throw new PreviewAutomationTargetUnavailableError({
    requestId: request.requestId,
    operation: request.operation,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    tabId,
    bridgeAvailable: Boolean(previewBridge),
  });
}

export async function waitForNavigationReadiness(
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  readiness: PreviewAutomationNavigateInput["readiness"],
  timeoutMs: number,
): Promise<void> {
  const targetReadiness = readiness ?? "load";
  if (!previewBridge) return;
  assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, { operation, requestId });
  if (targetReadiness === "none") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, {
      operation,
      requestId,
    });
    const snapshot =
      state.sessions[tabId] ?? (state.snapshot?.tabId === tabId ? state.snapshot : undefined);
    const failure = previewAutomationNavigationFailure(snapshot?.navStatus);
    if (failure) {
      throw new PreviewAutomationNavigationFailedError({
        requestId,
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        tabId,
        url: failure.url,
        code: failure.code,
        description: failure.description,
      });
    }
    if (targetReadiness === "domContentLoaded") {
      const readyState = await previewBridge.automation.evaluate(runtimeTabId, {
        expression: "document.readyState",
      });
      if (readyState === "interactive" || readyState === "complete") return;
    } else {
      const status = await previewBridge.automation.status(runtimeTabId);
      if (status.available && !status.loading) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationNavigationTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    tabId,
    readiness: targetReadiness,
    timeoutMs,
  });
}
