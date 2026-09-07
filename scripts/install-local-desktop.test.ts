import { describe, expect, it } from "vite-plus/test";

import { resolveInstallerLaunch, resolveLocalInstallerTarget } from "./install-local-desktop.ts";

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

describe("resolveInstallerLaunch", () => {
  it("opens the Windows installer through cmd so it outlives this script", () => {
    expect(resolveInstallerLaunch("win32", "C:Usersa b\releaseT3-Code.exe")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "C:Usersa b\releaseT3-Code.exe"],
    });
  });

  it("uses the native opener elsewhere", () => {
    expect(resolveInstallerLaunch("darwin", "/tmp/a b/T3-Code.dmg")).toEqual({
      command: "open",
      args: ["/tmp/a b/T3-Code.dmg"],
    });
    expect(resolveInstallerLaunch("linux", "/tmp/a b/T3-Code.AppImage")).toEqual({
      command: "xdg-open",
      args: ["/tmp/a b/T3-Code.AppImage"],
    });
  });
});
