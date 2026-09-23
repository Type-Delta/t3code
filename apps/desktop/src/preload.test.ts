import type { DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke },
  webFrame: {},
  webUtils: {},
}));

describe("desktop preload", () => {
  it("forwards the selected environment when requesting its bearer token", async () => {
    await import("./preload.ts");
    const bridge = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === "desktopBridge",
    )?.[1] as DesktopBridge | undefined;
    expect(bridge).toBeDefined();

    await bridge!.getLocalEnvironmentBearerToken("wsl:Ubuntu");

    expect(electron.invoke).toHaveBeenCalledWith(
      IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL,
      "wsl:Ubuntu",
    );
  });
});
