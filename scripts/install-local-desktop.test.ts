import { describe, expect, it } from "vite-plus/test";

import { resolveLocalInstallerTarget } from "./install-local-desktop.ts";

describe("resolveLocalInstallerTarget", () => {
  it("maps each supported host to its dist script and artifact", () => {
    expect(resolveLocalInstallerTarget("win32", "x64", "0.0.37")).toEqual({
      script: "dist:desktop:win:x64",
      artifact: "T3-Code-0.0.37-x64.exe",
    });
    expect(resolveLocalInstallerTarget("darwin", "arm64", "0.0.37")).toEqual({
      script: "dist:desktop:dmg:arm64",
      artifact: "T3-Code-0.0.37-arm64.dmg",
    });
    expect(resolveLocalInstallerTarget("linux", "x64", "0.0.37")).toEqual({
      script: "dist:desktop:linux",
      artifact: "T3-Code-0.0.37-x64.AppImage",
    });
  });

  it("reports hosts with no packaged installer", () => {
    expect(resolveLocalInstallerTarget("linux", "arm64", "0.0.37")).toBeNull();
    expect(resolveLocalInstallerTarget("freebsd", "x64", "0.0.37")).toBeNull();
  });
});
