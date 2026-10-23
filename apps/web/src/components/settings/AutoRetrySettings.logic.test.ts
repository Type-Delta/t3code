import { describe, expect, it } from "vite-plus/test";

import {
  conditionIsComplete,
  normalizeAutoRetrySettings,
  updateCondition,
  type AutoRetryCondition,
} from "./AutoRetrySettings.logic";

describe("normalizeAutoRetrySettings", () => {
  it("defaults missing settings to off", () => {
    expect(normalizeAutoRetrySettings(undefined)).toEqual({ enabled: false, triggers: [] });
  });

  it("keeps valid recursive conditions and drops unknown nodes", () => {
    const settings = normalizeAutoRetrySettings({
      enabled: true,
      triggers: [
        {
          id: "t1",
          name: "Overloaded",
          enabled: false,
          message: "Try again",
          condition: {
            kind: "and",
            children: [
              { kind: "error_message", value: "overloaded" },
              { kind: "future", value: "x" },
              { kind: "not", child: { kind: "backend", value: "codex" } },
            ],
          },
        },
        { name: "Legacy", condition: { kind: "unknown" } },
        "bad",
      ],
    });

    expect(settings.triggers).toEqual([
      {
        id: "t1",
        name: "Overloaded",
        enabled: false,
        message: "Try again",
        condition: {
          kind: "and",
          children: [
            { kind: "error_message", value: "overloaded" },
            { kind: "not", child: { kind: "backend", value: "codex" } },
          ],
        },
      },
      {
        id: "legacy-1",
        name: "Legacy",
        enabled: true,
        message: "",
        condition: { kind: "error_message", value: "" },
      },
    ]);
  });
});

describe("updateCondition", () => {
  const root: AutoRetryCondition = {
    kind: "or",
    children: [
      { kind: "model", value: "gpt" },
      { kind: "not", child: { kind: "error_message", value: "quota" } },
    ],
  };

  it("updates nested nodes through not", () => {
    expect(
      updateCondition(root, [1, 0], () => ({ kind: "error_message", value: "limit" })),
    ).toEqual({
      kind: "or",
      children: [
        { kind: "model", value: "gpt" },
        { kind: "not", child: { kind: "error_message", value: "limit" } },
      ],
    });
  });

  it("removes group children and falls back to an empty predicate", () => {
    const one = updateCondition(root, [0], () => null);
    expect(updateCondition(one, [0], () => null)).toEqual({ kind: "error_message", value: "" });
  });

  it("requires every predicate value", () => {
    expect(conditionIsComplete(root)).toBe(true);
    expect(
      conditionIsComplete(updateCondition(root, [0], () => ({ kind: "model", value: " " }))),
    ).toBe(false);
  });
});
