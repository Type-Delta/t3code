import type {
  PreviewAutomationOpenInput,
  PreviewNavStatus,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";

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
