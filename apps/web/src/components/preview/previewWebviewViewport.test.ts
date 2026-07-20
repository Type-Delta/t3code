import { describe, expect, it, vi } from "vite-plus/test";

import { readPreviewWebviewViewport } from "./previewWebviewViewport";

describe("readPreviewWebviewViewport", () => {
  it("returns a measured viewport", async () => {
    const viewport = await readPreviewWebviewViewport({
      executeJavaScript: vi.fn(async () => ({ width: 1024, height: 768 })),
    });

    expect(viewport).toEqual({ width: 1024, height: 768 });
  });

  it("returns null when guest execution stalls during navigation", async () => {
    vi.useFakeTimers();
    try {
      const viewport = readPreviewWebviewViewport(
        { executeJavaScript: vi.fn(() => new Promise(() => undefined)) },
        250,
      );

      await vi.advanceTimersByTimeAsync(250);
      await expect(viewport).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid viewport dimensions", async () => {
    const viewport = await readPreviewWebviewViewport({
      executeJavaScript: vi.fn(async () => ({ width: 0, height: "768" })),
    });

    expect(viewport).toBeNull();
  });
});
