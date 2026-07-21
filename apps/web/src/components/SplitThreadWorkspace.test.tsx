import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ChatView", () => ({ default: () => null }));
vi.mock("./DiffWorkerPoolProvider", () => ({ DiffWorkerPoolProvider: () => null }));

import {
  resolveSplitPaneDropPosition,
  resolveSplitRightPanelOwner,
  splitThreadGridColumnClassName,
} from "./SplitThreadWorkspace";

describe("splitThreadGridColumnClassName", () => {
  it("keeps two through four panes in a single explicit column row", () => {
    const classes = [2, 3, 4].map(splitThreadGridColumnClassName);

    expect(classes).toEqual(["grid-cols-2", "grid-cols-3", "grid-cols-4"]);
    expect(classes.join(" ")).not.toContain("grid-rows");
  });

  it("uses the pane midpoint to describe before and after drop locations", () => {
    const element = {
      getBoundingClientRect: () =>
        ({ left: 100, width: 240 }) as ReturnType<HTMLElement["getBoundingClientRect"]>,
    };

    expect(resolveSplitPaneDropPosition({ clientX: 180 }, element)).toBe("before");
    expect(resolveSplitPaneDropPosition({ clientX: 260 }, element)).toBe("after");
  });

  it("keeps an open right panel visible when a pane without one becomes active", () => {
    expect(
      resolveSplitRightPanelOwner({
        paneKeys: ["thread-a", "thread-b"],
        activePaneKey: "thread-b",
        currentOwnerKey: "thread-a",
        openPanelKeys: new Set(["thread-a"]),
      }),
    ).toBe("thread-a");
  });

  it("hands the right panel to the active pane when that pane has one open", () => {
    expect(
      resolveSplitRightPanelOwner({
        paneKeys: ["thread-a", "thread-b"],
        activePaneKey: "thread-b",
        currentOwnerKey: "thread-a",
        openPanelKeys: new Set(["thread-a", "thread-b"]),
      }),
    ).toBe("thread-b");
  });
});
