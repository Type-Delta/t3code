import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RightPanelTabs } from "./RightPanelTabs";

describe("RightPanelTabs", () => {
  it("attributes tabs to their source thread without changing visible titles", () => {
    const markup = renderToStaticMarkup(
      <RightPanelTabs
        mode="inline"
        sourceThread={{ key: "environment-1:thread-1", title: "Implement source attribution" }}
        surfaces={[{ id: "diff", kind: "diff" }]}
        activeSurfaceId="diff"
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        terminalLabelsById={new Map()}
        onActivate={() => {}}
        onCloseSurface={() => {}}
        onCloseOtherSurfaces={() => {}}
        onCloseSurfacesToRight={() => {}}
        onCloseAllSurfaces={() => {}}
        onCopyFilePath={() => {}}
        onAddBrowser={() => {}}
        onAddTerminal={() => {}}
        onAddDiff={() => {}}
        onAddFiles={() => {}}
        browserAvailable
        diffAvailable
        filesAvailable
      >
        <div />
      </RightPanelTabs>,
    );

    expect(markup).toContain('data-source-thread-key="environment-1:thread-1"');
    expect(markup).toContain('aria-label="Diff. Thread: Implement source attribution"');
    expect(markup).toContain("Thread: Implement source attribution");
    expect(markup).toContain('<span class="truncate">Diff</span>');
  });
});
