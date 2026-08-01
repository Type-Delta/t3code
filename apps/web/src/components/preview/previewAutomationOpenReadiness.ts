import {
  FILL_PREVIEW_VIEWPORT,
  PreviewAutomationOpenInput,
  PreviewNavStatus,
  PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

export const DEFAULT_PREVIEW_AUTOMATION_VIEWPORT = {
  _tag: "freeform",
  width: 1280,
  height: 800,
} as const satisfies PreviewViewportSetting;

export function shouldOpenPreviewMiniPlayer(input: PreviewAutomationOpenInput): boolean {
  return input.open ?? input.show ?? true;
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}

export function previewAutomationOpenNeedsNavigationReadiness(
  input: PreviewAutomationOpenInput,
): input is PreviewAutomationOpenInput & { readonly url: string } {
  return input.url !== undefined;
}

export function previewAutomationNavigationFailure(
  navStatus: PreviewNavStatus | undefined,
): Extract<PreviewNavStatus, { readonly _tag: "LoadFailed" }> | null {
  return navStatus?._tag === "LoadFailed" ? navStatus : null;
}

export function previewAutomationDefaultViewport(
  reusedExistingTab: boolean,
  snapshot: PreviewSessionSnapshot,
): PreviewViewportSetting | null {
  const viewport = snapshot.viewport ?? FILL_PREVIEW_VIEWPORT;
  return !reusedExistingTab && viewport._tag === "fill"
    ? DEFAULT_PREVIEW_AUTOMATION_VIEWPORT
    : null;
}
