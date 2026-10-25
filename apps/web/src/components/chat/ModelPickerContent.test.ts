import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { providerModelKey } from "../../modelOrdering";
import { filterModelPickerModels, type ModelPickerItem } from "./ModelPickerContent";

const first = ProviderInstanceId.make("codex_primary");
const second = ProviderInstanceId.make("codex_secondary");
const models: ReadonlyArray<ModelPickerItem> = [
  {
    slug: "fast",
    name: "Fast",
    instanceId: first,
    driverKind: ProviderDriverKind.make("codex"),
    instanceDisplayName: "Primary",
    continuationGroupKey: "one",
  },
  {
    slug: "fast",
    name: "Fast",
    instanceId: second,
    driverKind: ProviderDriverKind.make("codex"),
    instanceDisplayName: "Secondary",
    continuationGroupKey: "two",
  },
  {
    slug: "other",
    name: "Other",
    instanceId: first,
    driverKind: ProviderDriverKind.make("codex"),
    instanceDisplayName: "Primary",
    continuationGroupKey: "one",
  },
];
const base = {
  models,
  favorites: new Set([providerModelKey(second, "fast")]),
  lockedProvider: null,
  instanceOrder: [first, second],
};

describe("model picker group search", () => {
  it("keeps matching names within the selected instance", () => {
    expect(
      filterModelPickerModels({ ...base, selection: first, searchQuery: "fast" }).map(
        (model) => model.instanceId,
      ),
    ).toEqual([first]);
  });
  it("keeps matching names within Favorites", () => {
    expect(
      filterModelPickerModels({ ...base, selection: "favorites", searchQuery: "fast" }).map(
        (model) => model.instanceId,
      ),
    ).toEqual([second]);
  });
  it("searches matching names across instances only in All", () => {
    expect(
      filterModelPickerModels({ ...base, selection: ":all", searchQuery: "fast" }),
    ).toHaveLength(2);
  });
  it("retains continuation restrictions in an All search", () => {
    expect(
      filterModelPickerModels({
        ...base,
        selection: ":all",
        searchQuery: "fast",
        lockedProvider: ProviderDriverKind.make("codex"),
        lockedContinuationGroupKey: "one",
      }).map((model) => model.instanceId),
    ).toEqual([first]);
  });
});
