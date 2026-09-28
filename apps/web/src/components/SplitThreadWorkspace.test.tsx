import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ChatView", () => ({ default: () => null }));
vi.mock("./DiffWorkerPoolProvider", () => ({ DiffWorkerPoolProvider: () => null }));

import {
  resolveSplitPaneDropPosition,
  resolveSplitRightPanelOwner,
  splitThreadGridClassName,
  splitThreadPaneGridClassName,
} from "./SplitThreadWorkspace";
import { resolveSplitPaneSlots } from "../splitViewStore";

describe("splitThreadGridClassName", () => {
  const refs = (count: number) =>
    Array.from({ length: count }, (_unused, index) =>
      scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(`thread-${index + 1}`)),
    );

  it("uses one row until a column is stacked", () => {
    expect(splitThreadGridClassName(resolveSplitPaneSlots(refs(3)))).toBe(
      "grid-cols-3 grid-rows-1",
    );
  });

  it("keeps five columns and opens a second row once panes overflow", () => {
    expect(splitThreadGridClassName(resolveSplitPaneSlots(refs(7)))).toBe(
      "grid-cols-5 grid-rows-2",
    );
  });

  it("gives a column both cells until something is stacked under it", () => {
    const paneRefs = refs(6);
    const slots = resolveSplitPaneSlots(paneRefs);

    expect(slots.map(splitThreadPaneGridClassName)).toEqual([
      "col-start-1 row-start-1",
      "col-start-2 row-start-1 row-span-2",
      "col-start-3 row-start-1 row-span-2",
      "col-start-4 row-start-1 row-span-2",
      "col-start-5 row-start-1 row-span-2",
      "col-start-1 row-start-2",
    ]);
  });

  it("stacks a flagged pane under the column it follows", () => {
    const paneRefs = refs(4);
    const slots = resolveSplitPaneSlots(paneRefs, [scopedThreadKey(paneRefs[2]!)]);

    expect(slots.map(splitThreadPaneGridClassName)).toEqual([
      "col-start-1 row-start-1 row-span-2",
      "col-start-2 row-start-1",
      "col-start-2 row-start-2",
      "col-start-3 row-start-1 row-span-2",
    ]);
  });
});

describe("resolveSplitPaneDropPosition with a stackable column", () => {
  const element = {
    getBoundingClientRect: () =>
      ({ left: 100, width: 240, top: 0, height: 300 }) as ReturnType<
        HTMLElement["getBoundingClientRect"]
      >,
  };

  it("splits the column when the pointer sits in the lower third", () => {
    expect(resolveSplitPaneDropPosition({ clientX: 180, clientY: 260 }, element, true)).toBe(
      "below",
    );
  });

  it("keeps left and right placement for a column that is already stacked", () => {
    expect(resolveSplitPaneDropPosition({ clientX: 180, clientY: 260 }, element, false)).toBe(
      "before",
    );
  });
});

describe("splitThreadWorkspace drop placement", () => {
  it("uses the pane midpoint to describe before and after drop locations", () => {
    const element = {
      getBoundingClientRect: () =>
        ({ left: 100, width: 240, top: 0, height: 300 }) as ReturnType<
          HTMLElement["getBoundingClientRect"]
        >,
    };

    expect(resolveSplitPaneDropPosition({ clientX: 180, clientY: 10 }, element)).toBe("before");
    expect(resolveSplitPaneDropPosition({ clientX: 260, clientY: 10 }, element)).toBe("after");
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
