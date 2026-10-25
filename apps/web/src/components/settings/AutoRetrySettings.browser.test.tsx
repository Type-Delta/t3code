import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { type ReactNode } from "react";
import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { AutoRetrySettings as AutoRetryValue } from "./AutoRetrySettings.logic";

const state = vi.hoisted(() => ({
  autoRetry: undefined as unknown,
  updateSettings: vi.fn<(patch: { autoRetry?: AutoRetryValue }) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector: (settings: unknown) => unknown) =>
    selector({ ...DEFAULT_UNIFIED_SETTINGS, autoRetry: state.autoRetry })) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, control, children }) => (
    <div>
      <h3>{title}</h3>
      {control}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { AutoRetrySettings } from "./AutoRetrySettings";

const saved = () => state.autoRetry as AutoRetryValue;
async function setup() {
  state.autoRetry = {
    enabled: true,
    triggers: [{ id: "old", name: "Old", condition: { kind: "future" } }],
  };
  const screen = await render(<AutoRetrySettings />);
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.autoRetry = patch.autoRetry;
    void screen.rerender(<AutoRetrySettings />);
  });
  return screen;
}

describe("AutoRetrySettings", () => {
  it("edits triggers and nested conditions", async () => {
    await using screen = await setup();
    await expect
      .element(page.getByRole("textbox", { name: "Error message substring" }))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Add trigger" }));
    expect(saved().triggers).toHaveLength(2);

    const message = page.getByRole("textbox", { name: "Error message substring" }).nth(1);
    await userEvent.fill(message, "overloaded");
    await userEvent.tab();
    expect(saved().triggers[1]?.condition).toEqual({ kind: "error_message", value: "overloaded" });

    await userEvent.click(page.getByRole("combobox", { name: "Condition type at level 1" }).nth(1));
    await userEvent.click(page.getByRole("option", { name: "Any of" }));
    expect(saved().triggers[1]?.condition).toEqual({
      kind: "or",
      children: [{ kind: "error_message", value: "overloaded" }],
    });

    await userEvent.click(page.getByRole("button", { name: "Add condition" }));
    await userEvent.click(page.getByRole("combobox", { name: "Condition type at level 2" }).nth(1));
    await userEvent.click(page.getByRole("option", { name: "Model contains" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Model substring" }), "gpt");
    await userEvent.tab();

    await userEvent.click(page.getByRole("switch", { name: "Enable Retry trigger 2" }));
    expect(saved().triggers[1]).toMatchObject({
      enabled: false,
      condition: {
        kind: "or",
        children: [
          { kind: "error_message", value: "overloaded" },
          { kind: "model", value: "gpt" },
        ],
      },
    });

    await userEvent.click(page.getByRole("button", { name: "Remove Old" }));
    expect(saved().triggers.map((trigger) => trigger.name)).toEqual(["Retry trigger 2"]);
  });
});
