import { act, render as renderClient } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () =>
    ({
      theme: "system",
      followSystem: true,
      themeHalves: null,
      setTheme: vi.fn(),
      setFollowSystem: vi.fn(),
      setThemeHalf: vi.fn(),
      clearThemeHalves: vi.fn(),
    }) as never,
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings!) as never,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));

import { useSettingsRestore } from "./SettingsPanels";

let restore: ReturnType<typeof useSettingsRestore>;

function Probe() {
  const result = useSettingsRestore();
  useEffect(() => {
    restore = result;
  });
  return null;
}

function setup() {
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.confirm.mockResolvedValue(true);
}
const render = () => renderClient(<Probe />);

describe("restoring V2 settings", () => {
  it.each([
    ["persistComposerContextStrip", "Composer context"],
    ["autoResumeLimitedThreads", "Resume after usage limits"],
    ["snoozeLimitedThreads", "Snooze until limits reset"],
  ] as const)("restores %s when it is the only changed setting", async (key, label) => {
    setup();
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: !DEFAULT_UNIFIED_SETTINGS[key] };
    await using _screen = await render();

    expect(restore.changedSettingLabels).toEqual([label]);
    await act(() => restore.restoreDefaults());

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it("does not reset settings after cancellation", async () => {
    setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      autoResumeLimitedThreads: !DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
    };
    state.confirm.mockResolvedValue(false);
    await using _screen = await render();

    await act(() => restore.restoreDefaults());

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });
});
