import { renderToStaticMarkup } from "react-dom/server";
import { ProviderInstanceId, type ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ProviderModelsSection } from "./ProviderModelsSection";

const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "built-in",
    name: "Built In",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "custom",
    name: "Custom",
    isCustom: true,
    capabilities: null,
  },
];

describe("ProviderModelsSection", () => {
  it("allows metadata edits for every visible model but removes only user-added models", () => {
    const html = renderToStaticMarkup(
      <ProviderModelsSection
        instanceId={ProviderInstanceId.make("codex_test")}
        driverKind={null}
        models={models}
        customModels={["custom"]}
        modelOverrides={{}}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onCustomModelsChange={() => undefined}
        onHiddenModelsChange={() => undefined}
        onFavoriteModelsChange={() => undefined}
        onModelOrderChange={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Edit Built In metadata"');
    expect(html).toContain('aria-label="Edit Custom metadata"');
    expect(html).not.toContain('aria-label="Remove built-in"');
    expect(html).toContain('aria-label="Remove custom"');
  });
});
