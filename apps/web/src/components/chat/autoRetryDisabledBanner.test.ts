import { describe, expect, it } from "@effect/vitest";

import { readAutoRetryDisabledMetadata } from "./autoRetryDisabledBanner";

describe("readAutoRetryDisabledMetadata", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  it("reads a future pause and trims its optional reason", () => {
    expect(
      readAutoRetryDisabledMetadata(
        {
          autoRetryDisabledUntil: "2026-01-01T00:15:00.000Z",
          autoRetryDisabledReason: "  usage limit  ",
        },
        now,
      ),
    ).toEqual({
      until: "2026-01-01T00:15:00.000Z",
      reason: "usage limit",
    });
  });

  it("also reads metadata that remains on the source shell", () => {
    expect(
      readAutoRetryDisabledMetadata(
        {
          source: {
            autoRetryDisabledUntil: new Date(now + 60_000),
            autoRetryDisabledReason: "limit",
          },
        },
        now,
      ),
    ).toEqual({ until: "2026-01-01T00:01:00.000Z", reason: "limit" });
  });

  const staleShells: ReadonlyArray<unknown> = [
    null,
    undefined,
    {},
    { autoRetryDisabledUntil: null },
    { autoRetryDisabledUntil: "2025-12-31T23:59:59.000Z" },
    { autoRetryDisabledUntil: "not a date" },
  ];
  it.each(staleShells)("ignores metadata without a future expiry: %j", (shell: unknown) => {
    expect(readAutoRetryDisabledMetadata(shell, now)).toBeNull();
  });
});
