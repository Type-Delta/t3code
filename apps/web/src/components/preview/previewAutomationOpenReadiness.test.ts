import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  previewAutomationNavigationFailure,
  previewAutomationOpenNeedsNavigationReadiness,
  previewAutomationOpenNeedsOverlay,
} from "./previewAutomationOpenReadiness";

const snapshot = (navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab-1",
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-26T00:00:00.000Z",
});

describe("preview automation open readiness", () => {
  it("does not wait for a desktop overlay when opening an empty tab", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(false);
  });

  it("waits when an empty tab is immediately given a URL", () => {
    const input = { url: "https://example.com" } as PreviewAutomationOpenInput;
    expect(previewAutomationOpenNeedsOverlay(input, snapshot({ _tag: "Idle" }))).toBe(true);
    expect(previewAutomationOpenNeedsNavigationReadiness(input)).toBe(true);
  });

  it("waits for existing tabs that already have rendered content", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Success",
          url: "https://example.com/",
          title: "Example",
        }),
      ),
    ).toBe(true);
  });

  it("recognizes a committed navigation failure", () => {
    const failure = {
      _tag: "LoadFailed" as const,
      url: "https://example.invalid/",
      title: "example.invalid",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    };

    expect(previewAutomationNavigationFailure(failure)).toEqual(failure);
    expect(
      previewAutomationNavigationFailure({
        _tag: "Success",
        url: "https://example.com/",
        title: "Example",
      }),
    ).toBeNull();
  });
});
