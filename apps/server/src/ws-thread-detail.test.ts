import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationEvent } from "@t3tools/contracts";

import { isThreadDetailEvent } from "./ws.ts";

describe("isThreadDetailEvent", () => {
  it("delivers checkpoint navigation lifecycle events to thread subscribers", () => {
    const types = [
      "thread.checkpoint-navigation-requested",
      "thread.checkpoint-navigation-completed",
      "thread.checkpoint-navigation-failed",
      "thread.checkpoint-forward-history-abandoned",
    ] as const;

    for (const type of types) {
      expect(isThreadDetailEvent({ type } as OrchestrationEvent)).toBe(true);
    }
  });
});
