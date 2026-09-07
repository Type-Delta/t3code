import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  filterModelPickerModels,
  resolveModelPickerSelectedModel,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
  type ModelPickerItem,
} from "./ModelPickerContent";

function pickerModel(
  instanceId: ProviderInstanceId,
  driverKind: string,
  slug: string,
  name: string,
  continuationGroupKey?: string,
): ModelPickerItem {
  return {
    instanceId,
    driverKind: ProviderDriverKind.make(driverKind),
    slug,
    name,
    instanceDisplayName: driverKind,
    ...(continuationGroupKey ? { continuationGroupKey } : {}),
  };
}

describe("filterModelPickerModels", () => {
  const codex = ProviderInstanceId.make("codex_work");
  const claude = ProviderInstanceId.make("claude_work");
  const models = [
    pickerModel(codex, "codex", "gpt-5", "GPT-5"),
    pickerModel(claude, "claude", "sonnet", "Sonnet"),
  ];
  const baseInput = {
    models,
    searchQuery: "t",
    favorites: new Set<string>(),
    lockedProvider: null,
    instanceOrder: [codex, claude],
  } as const;

  it("keeps search scoped to the selected provider and preserves the query for another selection", () => {
    expect(
      filterModelPickerModels({ ...baseInput, selection: codex }).map((model) => model.slug),
    ).toEqual(["gpt-5"]);
    expect(
      filterModelPickerModels({ ...baseInput, selection: claude }).map((model) => model.slug),
    ).toEqual(["sonnet"]);
  });

  it("searches across providers only when All is selected", () => {
    expect(
      filterModelPickerModels({ ...baseInput, selection: ":all" }).map((model) => model.slug),
    ).toEqual(["gpt-5", "sonnet"]);
  });

  it("limits Favorites search to favorited models", () => {
    expect(
      filterModelPickerModels({
        ...baseInput,
        favorites: new Set([`${claude}:sonnet`]),
        selection: "favorites",
      }).map((model) => model.slug),
    ).toEqual(["sonnet"]);
  });

  it("keeps a provider instance named all distinct from the All group", () => {
    const allInstance = ProviderInstanceId.make("all");
    expect(
      filterModelPickerModels({
        ...baseInput,
        models: [...models, pickerModel(allInstance, "codex", "gpt-work", "GPT Work")],
        selection: allInstance,
      }).map((model) => model.slug),
    ).toEqual(["gpt-work"]);
  });

  it("keeps locked continuation groups scoped even when All is selected", () => {
    const lockedModels = [
      pickerModel(codex, "codex", "gpt-5", "GPT-5", "work"),
      pickerModel(claude, "codex", "sonnet", "Sonnet", "personal"),
    ];
    expect(
      filterModelPickerModels({
        ...baseInput,
        models: lockedModels,
        selection: ":all",
        lockedProvider: ProviderDriverKind.make("codex"),
        lockedContinuationGroupKey: "work",
      }).map((model) => model.slug),
    ).toEqual(["gpt-5"]);
  });
});

function entry(status: ServerProvider["status"], driver = "opencode") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("shouldIncludeModelPickerOption", () => {
  it.each(["ready", "error"] as const)(
    "never offers the internal Antigravity default marker as a model when %s",
    (status) => {
      const providerEntry = entry(status, "antigravity");
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: ANTIGRAVITY_DEFAULT_MODEL,
            name: ANTIGRAVITY_DEFAULT_MODEL,
            isUnavailable: true,
          },
          activeInstanceId: providerEntry.instanceId,
          activeModel: ANTIGRAVITY_DEFAULT_MODEL,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["opencode", "error"],
    ["opencode", "warning"],
    ["antigravity", "error"],
    ["antigravity", "warning"],
  ] as const)(
    "keeps only the active synthetic %s row when the provider status is %s",
    (driver, status) => {
      const providerEntry = entry(status, driver);
      const activeInstanceId = providerEntry.instanceId;
      const activeModel = "missing-model";

      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: activeModel,
            name: activeModel,
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(true);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "stale/model", name: "Stale model" },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: "other/missing",
            name: "Other missing",
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: activeModel, name: activeModel, isUnavailable: true },
          activeInstanceId: ProviderInstanceId.make(`${driver}_personal`),
          activeModel,
        }),
      ).toBe(false);
    },
  );
});

describe("resolveModelPickerSelectedModel", () => {
  it("follows the catalog default for the marker but keeps an explicit native model", () => {
    const driverKind = ProviderDriverKind.make("antigravity");
    const previousOptions = [
      { slug: "gemini-fast", name: "Gemini Fast", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
      { slug: "gemini-pro", name: "Gemini Pro" },
    ];
    const nextOptions = [
      { slug: "gemini-fast", name: "Gemini Fast" },
      { slug: "gemini-pro", name: "Gemini Pro", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
    ];

    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: previousOptions,
      })?.slug,
    ).toBe("gemini-fast");
    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: nextOptions,
      })?.slug,
    ).toBe("gemini-pro");
    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: "gemini-fast",
        options: nextOptions,
      })?.slug,
    ).toBe("gemini-fast");
  });

  it("does not guess the default from the first model in a catalog", () => {
    expect(
      resolveModelPickerSelectedModel({
        driverKind: ProviderDriverKind.make("antigravity"),
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: [{ slug: "gemini-fast", name: "Gemini Fast" }],
      }),
    ).toBeUndefined();
  });
});

describe("shouldOfferModelPickerSetup", () => {
  const availableModel = { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" };

  it("offers setup before an Antigravity account has models", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "antigravity"), [])).toBe(true);
  });

  it("offers setup after sign-out even if a model remains cached", () => {
    const providerEntry = entry("ready", "antigravity");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: { ...providerEntry.snapshot, auth: { status: "unauthenticated" } },
        },
        [availableModel],
      ),
    ).toBe(true);
  });

  it("offers setup when the only model is an unavailable saved selection", () => {
    expect(
      shouldOfferModelPickerSetup(entry("ready", "antigravity"), [
        { ...availableModel, isUnavailable: true },
      ]),
    ).toBe(true);
  });

  it("does not offer setup for a ready account with available models", () => {
    expect(shouldOfferModelPickerSetup(entry("ready", "antigravity"), [availableModel])).toBe(
      false,
    );
  });

  it("does not restore a disabled provider while its status snapshot is stale", () => {
    expect(
      shouldOfferModelPickerSetup({ ...entry("error", "antigravity"), enabled: false }, []),
    ).toBe(false);
  });

  it("keeps providers without integrated setup on their existing path", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "codex"), [])).toBe(false);
  });

  it("uses the environment's setup capability for other drivers", () => {
    const providerEntry = entry("error", "custom_driver");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: {
            ...providerEntry.snapshot,
            setup: { canAuthenticate: true, canInstall: false },
          },
        },
        [],
      ),
    ).toBe(true);
  });
});
