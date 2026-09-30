import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: {
      evaluate: mocks.evaluate,
      status: vi.fn(),
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";
import { waitForNavigationReadiness } from "./previewNavigationReadiness";

describe("waitForNavigationReadiness", () => {
  it("does not accept the previous document while a new main resource is pending", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout });
    try {
      const threadRef = {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      };
      const tabId = "tab_1";
      mocks.readThreadPreviewState.mockReturnValue({
        serverEpoch: "epoch-1",
        sessions: { [tabId]: { tabId } },
      });
      let timeOrigin = 100;
      mocks.evaluate.mockImplementation(async (_tabId, { expression }) =>
        NodeVM.runInNewContext(expression, {
          performance: { timeOrigin },
          document: { readyState: "complete" },
        }),
      );
      let settled = false;
      const ready = waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        previewRuntimeTabId(threadRef, "epoch-1", tabId),
        "navigate",
        "domContentLoaded",
        1000,
        100,
      ).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      timeOrigin = 200;
      await vi.advanceTimersByTimeAsync(50);
      await ready;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("rejects a replaced runtime target even when readiness polling is disabled", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const staleRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-2",
      sessions: {
        [tabId]: { tabId },
      },
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        staleRuntimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });
});
