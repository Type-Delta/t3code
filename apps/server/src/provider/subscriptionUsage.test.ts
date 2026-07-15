// @effect-diagnostics globalDate:off - asserts vendor epoch timestamps map to ISO strings.
import { describe, expect, it } from "@effect/vitest";

import { mapClaudeUsageResponse, mapCodexUsageResponse } from "./subscriptionUsage.ts";

describe("mapClaudeUsageResponse", () => {
  it("maps five_hour/seven_day windows", () => {
    const usage = mapClaudeUsageResponse({
      five_hour: { utilization: 42.5, resets_at: "2026-07-14T10:00:00Z" },
      seven_day: { utilization: 80, resets_at: 1783000000 },
    });
    expect(usage.session).toEqual({
      usedPercent: 42.5,
      resetsAt: "2026-07-14T10:00:00.000Z",
    });
    expect(usage.weekly?.usedPercent).toBe(80);
    expect(usage.weekly?.resetsAt).toBe(new Date(1783000000 * 1000).toISOString());
  });

  it("returns null windows for missing/invalid data", () => {
    const usage = mapClaudeUsageResponse({ five_hour: { utilization: "nope" } });
    expect(usage.session).toBeNull();
    expect(usage.weekly).toBeNull();
  });

  it("clamps utilization to 0-100", () => {
    const usage = mapClaudeUsageResponse({ five_hour: { utilization: 130, resets_at: null } });
    expect(usage.session).toEqual({ usedPercent: 100, resetsAt: null });
  });
});

describe("mapCodexUsageResponse", () => {
  it("maps primary/secondary rate-limit windows", () => {
    const usage = mapCodexUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 12, reset_at: "2026-07-14T10:00:00Z" },
        secondary_window: { used_percent: 55.5, reset_at: null },
      },
    });
    expect(usage.session).toEqual({
      usedPercent: 12,
      resetsAt: "2026-07-14T10:00:00.000Z",
    });
    expect(usage.weekly).toEqual({ usedPercent: 55.5, resetsAt: null });
  });

  it("returns null windows when rate_limit is absent", () => {
    const usage = mapCodexUsageResponse({});
    expect(usage.session).toBeNull();
    expect(usage.weekly).toBeNull();
  });
});
