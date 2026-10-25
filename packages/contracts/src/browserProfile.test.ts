import * as Schema from "effect/Schema";
import { BrowserProfileId } from "./browserProfile.ts";
import { describe, expect, it } from "@effect/vitest";

import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
} from "./browserProfile.ts";

const work: BrowserProfile = { id: "profile-work", name: "Work", kind: "persistent" };
const isBrowserProfileId = Schema.is(BrowserProfileId);

describe("resolveBrowserProfiles", () => {
  it("drops stored entries that collide with a built-in id", () => {
    const resolved = resolveBrowserProfiles([
      { id: DEFAULT_BROWSER_PROFILE_ID, name: "Hijacked", kind: "persistent" },
      { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Not incognito", kind: "persistent" },
      work,
    ]);

    expect(resolved).toEqual([...BUILT_IN_BROWSER_PROFILES, work]);
  });
});

describe("resolveBrowserProfiles normalization", () => {
  it("reports a custom incognito profile as persistent", () => {
    const resolved = resolveBrowserProfiles([
      { id: "throwaway", name: "Throwaway", kind: "incognito" },
    ]);

    expect(resolved.find((profile) => profile.id === "throwaway")).toEqual({
      id: "throwaway",
      name: "Throwaway",
      kind: "persistent",
    });
  });

  it("still lets the built-in incognito profile stay ephemeral", () => {
    const incognito = resolveBrowserProfiles([]).find(
      (profile) => profile.id === INCOGNITO_BROWSER_PROFILE_ID,
    );

    expect(incognito?.kind).toBe("incognito");
  });
});

describe("BrowserProfileId", () => {
  it("rejects control characters", () => {
    expect(isBrowserProfileId("profile-a\u0000b")).toBe(false);
    expect(isBrowserProfileId("profile-a")).toBe(true);
  });
});
