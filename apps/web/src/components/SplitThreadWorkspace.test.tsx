import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ChatView", () => ({ default: () => null }));
vi.mock("./DiffWorkerPoolProvider", () => ({ DiffWorkerPoolProvider: () => null }));

import {
  resolveSplitPaneDropPosition,
  resolveSplitRightPanelOwner,
  splitThreadGridColumnClassName,
} from "./SplitThreadWorkspace";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveSplitPaneSlots } from "../splitViewStore";

function paneRefs(count: number) {
  return Array.from({ length: count }, (_, index) =>
    scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(`thread-${index}`)),
  );
}

describe("splitThreadGridColumnClassName", () => {
  it("keeps the workspace on five deterministic columns", () => {
    expect([2, 5, 6, 10].map((count) => splitThreadGridColumnClassName(count))).toEqual([
      "grid-cols-2",
      "grid-cols-5",
      "grid-cols-5",
      "grid-cols-5",
    ]);
  });

  it("lays out two and five panes in one row", () => {
    for (const count of [2, 5]) {
      const slots = resolveSplitPaneSlots(paneRefs(count), []);
      expect(slots).toHaveLength(count);
      expect(slots.every((slot) => slot.row === 0)).toBe(true);
      expect(new Set(slots.map((slot) => slot.column)).size).toBe(count);
    }
  });

  it("uses a second row for six and ten panes", () => {
    for (const count of [6, 10]) {
      const slots = resolveSplitPaneSlots(paneRefs(count), []);
      expect(slots).toHaveLength(count);
      expect(slots.some((slot) => slot.row === 1)).toBe(true);
      expect(slots.every((slot) => slot.column >= 0 && slot.column < 5)).toBe(true);
    }
  });

  it("keeps an explicitly stacked pair in one column", () => {
    const refs = paneRefs(2);
    const slots = resolveSplitPaneSlots(refs, ["env:thread-1"]);

    expect(slots.map(({ column, row, spansBothRows }) => ({ column, row, spansBothRows }))).toEqual(
      [
        { column: 0, row: 0, spansBothRows: false },
        { column: 0, row: 1, spansBothRows: false },
      ],
    );
    expect(splitThreadGridColumnClassName(refs.length, slots)).toBe("grid-cols-1");
  });

  it("uses the pane midpoint to describe before and after drop locations", () => {
    const element = {
      getBoundingClientRect: () =>
        ({ left: 100, top: 100, width: 240, height: 200 }) as ReturnType<
          HTMLElement["getBoundingClientRect"]
        >,
    };

    expect(resolveSplitPaneDropPosition({ clientX: 180, clientY: 120 }, element)).toBe("before");
    expect(resolveSplitPaneDropPosition({ clientX: 260, clientY: 120 }, element)).toBe("after");
    expect(
      resolveSplitPaneDropPosition({ clientX: 260, clientY: 280 }, element, {
        canStackVertically: true,
      }),
    ).toBe("below");
  });

  it("offers top and bottom drops in the outer quarters of a one-row pane", () => {
    const element = {
      getBoundingClientRect: () =>
        ({ left: 100, top: 100, width: 240, height: 200 }) as ReturnType<
          HTMLElement["getBoundingClientRect"]
        >,
    };

    expect(
      resolveSplitPaneDropPosition({ clientX: 180, clientY: 120 }, element, {
        canStackVertically: true,
      }),
    ).toBe("above");
    expect(
      resolveSplitPaneDropPosition({ clientX: 180, clientY: 280 }, element, {
        canStackVertically: true,
      }),
    ).toBe("below");
    expect(
      resolveSplitPaneDropPosition({ clientX: 180, clientY: 200 }, element, {
        canStackVertically: true,
      }),
    ).toBe("before");
    expect(
      resolveSplitPaneDropPosition({ clientX: 180, clientY: 200 }, element, {
        canStackVertically: true,
        canInsertColumn: false,
      }),
    ).toBeNull();
    expect(
      resolveSplitPaneDropPosition({ clientX: 180, clientY: 120 }, element, {
        canStackVertically: true,
        canInsertColumn: false,
      }),
    ).toBe("above");
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
