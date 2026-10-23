import { assert, it } from "@effect/vitest";
import {
  matchingAutoRetryTrigger,
  matchesAutoRetryCondition,
  recordAutoRetryFailure,
  type AutoRetryFailureGuardState,
} from "./AutoRetry.ts";

const context = { errorMessage: "Temporary network timeout", backend: "codex", model: "gpt-5" };

it("matches predicates and nested boolean expressions", () => {
  assert.isTrue(matchesAutoRetryCondition({ kind: "error_message", value: "NETWORK" }, context));
  assert.isTrue(
    matchesAutoRetryCondition(
      {
        kind: "and",
        children: [
          { kind: "backend", value: "codex" },
          { kind: "not", child: { kind: "model", value: "opus" } },
        ],
      },
      context,
    ),
  );
});

it("selects the first enabled matching trigger", () => {
  const trigger = matchingAutoRetryTrigger(
    {
      enabled: true,
      triggers: [
        {
          id: "off",
          name: "off",
          enabled: false,
          message: "no",
          condition: { kind: "error_message", value: "timeout" },
        },
        {
          id: "hit",
          name: "hit",
          enabled: true,
          message: "Continue",
          condition: { kind: "error_message", value: "timeout" },
        },
      ],
    },
    context,
  );
  assert.equal(trigger?.id, "hit");
});

it("pauses after repeated failures in the guard window", () => {
  let state: AutoRetryFailureGuardState = { failuresAt: [], disabledUntil: null };
  state = recordAutoRetryFailure(state, 1_000);
  state = recordAutoRetryFailure(state, 2_000);
  state = recordAutoRetryFailure(state, 3_000);
  assert.equal(state.disabledUntil, 603_000);
});
