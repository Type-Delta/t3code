import type { StorageUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MIN_SEGMENT_PERCENT,
  storageUsageSegments,
  storageUsageSummary,
} from "./StorageUsageSection.logic";

const usage = (
  bytes: Partial<Record<StorageUsage["categories"][number]["id"], number>>,
  disk: { total: number; free: number } | null = null,
) => {
  const categories = (
    ["database", "worktrees", "checkpoints", "logs", "attachments", "other"] as const
  ).map((id) => ({ id, bytes: bytes[id] ?? 0 }));
  return {
    totalBytes: categories.reduce((total, category) => total + category.bytes, 0),
    categories,
    diskFreeBytes: disk?.free ?? null,
    diskTotalBytes: disk?.total ?? null,
  } satisfies StorageUsage;
};

describe("storageUsageSegments", () => {
  it("scales to the disk, adds the rest of its used space, and leaves free space empty", () => {
    expect(
      storageUsageSegments(usage({ database: 100, worktrees: 200 }, { total: 1000, free: 400 })),
    ).toEqual([
      { id: "database", percent: 10 },
      { id: "worktrees", percent: 20 },
      { id: "elsewhere", percent: 30 },
    ]);
  });

  it("fills the bar with T3 Code's categories when the disk size is unknown", () => {
    expect(storageUsageSegments(usage({ database: 300, worktrees: 100 }))).toEqual([
      { id: "database", percent: 75 },
      { id: "worktrees", percent: 25 },
    ]);
  });

  it("gives tiny parts a minimum width and keeps the total within the bar", () => {
    const onDisk = storageUsageSegments(usage({ logs: 1 }, { total: 1_000_000, free: 999_999 }));
    expect(onDisk).toEqual([{ id: "logs", percent: MIN_SEGMENT_PERCENT }]);
    const full = storageUsageSegments(usage({ worktrees: 1_000_000, logs: 1 }));
    expect(full.reduce((sum, segment) => sum + segment.percent, 0)).toBeCloseTo(100);
    expect(full[1]?.percent).toBeGreaterThan(1);
  });

  it("renders no segments when nothing is stored", () => {
    expect(storageUsageSegments(usage({}))).toEqual([]);
  });
});

describe("storageUsageSummary", () => {
  it("names each non-empty category and free space for screen readers", () => {
    expect(
      storageUsageSummary(usage({ database: 2048, checkpoints: 512 }, { total: 8192, free: 4096 })),
    ).toBe("T3 Code uses 2.50 KB: Database 2.00 KB, Git snapshots 512 B. 4.00 KB free on disk");
  });
});
