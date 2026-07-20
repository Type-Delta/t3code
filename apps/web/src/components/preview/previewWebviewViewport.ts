import type { PreviewRenderedViewportSize } from "@t3tools/contracts";

export const PREVIEW_WEBVIEW_VIEWPORT_PROBE_TIMEOUT_MS = 250;

export interface PreviewWebviewViewportReader {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

const decodePreviewViewport = (value: unknown): PreviewRenderedViewportSize | null => {
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { readonly width?: unknown; readonly height?: unknown };
  return typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0
    ? { width, height }
    : null;
};

export async function readPreviewWebviewViewport(
  webview: PreviewWebviewViewportReader,
  timeoutMs = PREVIEW_WEBVIEW_VIEWPORT_PROBE_TIMEOUT_MS,
): Promise<PreviewRenderedViewportSize | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  const measurement = webview
    .executeJavaScript("({ width: window.innerWidth, height: window.innerHeight })")
    .then(decodePreviewViewport);
  return await Promise.race([measurement, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}
