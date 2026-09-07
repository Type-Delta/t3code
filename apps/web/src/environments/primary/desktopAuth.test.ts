import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { __resetDesktopPrimaryAuthForTests, readDesktopPrimaryBearerToken } from "./desktopAuth";

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("reuses the main-process bearer token across renderer requests", async () => {
    const getLocalEnvironmentBearerToken = vi
      .fn<(environmentId?: string) => Promise<string>>()
      .mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    const first = readDesktopPrimaryBearerToken();
    const second = readDesktopPrimaryBearerToken();
    await expect(first).resolves.toBe("desktop-bearer-token");
    await expect(second).resolves.toBe("desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledWith();
  });

  it("observes a refreshed main-process token on the next request", async () => {
    const getLocalEnvironmentBearerToken = vi
      .fn<(environmentId?: string) => Promise<string>>()
      .mockResolvedValueOnce("first-desktop-bearer-token")
      .mockResolvedValueOnce("second-desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("first-desktop-bearer-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("second-desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});
