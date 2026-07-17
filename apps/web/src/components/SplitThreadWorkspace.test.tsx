import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ChatView", () => ({ default: () => null }));
vi.mock("./DiffWorkerPoolProvider", () => ({ DiffWorkerPoolProvider: () => null }));

import { splitThreadGridColumnClassName } from "./SplitThreadWorkspace";

describe("splitThreadGridColumnClassName", () => {
  it("keeps two through four panes in a single explicit column row", () => {
    const classes = [2, 3, 4].map(splitThreadGridColumnClassName);

    expect(classes).toEqual(["grid-cols-2", "grid-cols-3", "grid-cols-4"]);
    expect(classes.join(" ")).not.toContain("grid-rows");
  });
});
