import { describe, expect, it } from "vite-plus/test";

import { resolveHostProcessUsername } from "./hostProcess.ts";

const environment = (
  input: {
    readonly USERDOMAIN?: string;
    readonly USERDNSDOMAIN?: string;
    readonly COMPUTERNAME?: string;
  } = {},
): NodeJS.ProcessEnv => input;

describe("resolveHostProcessUsername", () => {
  it("returns the OS username on POSIX hosts", () => {
    expect(
      resolveHostProcessUsername({
        platform: "linux",
        environment: environment(),
        userInfo: () => ({ username: "aila" }),
      }),
    ).toBe("aila");
  });

  it("qualifies Windows domain accounts for OpenSSH", () => {
    expect(
      resolveHostProcessUsername({
        platform: "win32",
        environment: environment({ USERDOMAIN: "CORP", USERDNSDOMAIN: "corp.example.com" }),
        userInfo: () => ({ username: "aila" }),
      }),
    ).toBe("CORP\\aila");
  });

  it("falls back to the simple Windows username without a domain", () => {
    expect(
      resolveHostProcessUsername({
        platform: "win32",
        environment: environment({ USERDOMAIN: "CORP" }),
        userInfo: () => ({ username: "aila" }),
      }),
    ).toBe("aila");
  });

  it("returns an already-qualified Windows principal unchanged", () => {
    expect(
      resolveHostProcessUsername({
        platform: "win32",
        environment: environment({ USERDOMAIN: "CORP", USERDNSDOMAIN: "corp.example.com" }),
        userInfo: () => ({ username: "CORP\\aila" }),
      }),
    ).toBe("CORP\\aila");
  });

  it("omits the username when the OS identity lookup fails", () => {
    expect(
      resolveHostProcessUsername({
        platform: "linux",
        environment: environment(),
        userInfo: () => {
          throw new Error("uid has no passwd entry");
        },
      }),
    ).toBeUndefined();
  });

  it("does not qualify a local account whose domain is the computer name", () => {
    expect(
      resolveHostProcessUsername({
        platform: "win32",
        environment: environment({
          USERDOMAIN: "BLACKAMBER",
          USERDNSDOMAIN: "blackamber.local",
          COMPUTERNAME: "blackamber",
        }),
        userInfo: () => ({ username: "aila" }),
      }),
    ).toBe("aila");
  });

  it("does not qualify a workgroup account", () => {
    expect(
      resolveHostProcessUsername({
        platform: "win32",
        environment: environment({
          USERDOMAIN: "WORKGROUP",
          USERDNSDOMAIN: "workgroup.local",
        }),
        userInfo: () => ({ username: "aila" }),
      }),
    ).toBe("aila");
  });
});
