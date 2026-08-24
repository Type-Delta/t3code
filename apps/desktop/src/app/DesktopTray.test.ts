import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  activateFromTray,
  formatRunningThreadCount,
  formatRunningThreadCountStatus,
  summarizeRunningThreadCounts,
} from "./DesktopTray.ts";

describe("summarizeRunningThreadCounts", () => {
  it("sums backend counts and marks retained counts stale", () => {
    expect(
      summarizeRunningThreadCounts([
        { status: "fresh", count: 2 },
        { status: "stale", count: 3 },
        { status: "stopped" },
      ]),
    ).toEqual({ count: 5, freshness: "stale" });
  });

  it("marks the total unavailable when a backend has never returned a count", () => {
    expect(
      summarizeRunningThreadCounts([{ status: "fresh", count: 2 }, { status: "unavailable" }]),
    ).toEqual({ count: 2, freshness: "unavailable" });
  });
});

describe("formatRunningThreadCount", () => {
  it.each([
    [0, "0 threads running"],
    [1, "1 thread running"],
    [2, "2 threads running"],
  ])("uses the correct grammar for %s", (count, expected) => {
    expect(formatRunningThreadCount(count)).toBe(expected);
  });

  it("marks stale and unavailable counts without claiming they are live", () => {
    expect(formatRunningThreadCountStatus(2, "stale")).toBe("2 threads running (last known)");
    expect(formatRunningThreadCountStatus(0, "unavailable")).toBe(
      "Running thread count unavailable",
    );
  });
});

describe("activateFromTray", () => {
  effectIt.effect("opens while running and ignores activation once quit starts", () => {
    let activations = 0;
    return Effect.gen(function* () {
      const quitting = yield* Ref.make(false);
      const activate = Effect.sync(() => {
        activations += 1;
      });
      yield* activateFromTray(quitting, activate);
      yield* Ref.set(quitting, true);
      yield* activateFromTray(quitting, activate);
      expect(activations).toBe(1);
    });
  });
});
