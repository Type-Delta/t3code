import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("keeps the title when dragging a search result from a collapsed folder", async () => {
  await page.viewport(1400, 900);
  const [first, second] = [threadWithHistory("visible", 1), threadWithHistory("search-target", 1)];
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const folder = page.getByRole("button", { name: /^render/ });
  await expect.element(folder).toHaveAttribute("aria-expanded", "true");
  // Folder expansion is persisted UI state, so later tests must not inherit the collapse.
  using _expanded = {
    [Symbol.dispose]: () => useUiStateStore.setState({ projectExpandedById: {} }),
  };
  await userEvent.click(folder);
  await expect.element(page.getByText(second.title, { exact: true })).not.toBeInTheDocument();
  await userEvent.fill(page.getByRole("combobox", { name: "Search threads" }), "search-target");
  const result = page.getByRole("option", { name: /Thread search-target/ });
  await expect.element(result).toBeVisible();
  const bounds = result.element().getBoundingClientRect();
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  await act(() => {
    result.element().dispatchEvent(pointer("pointerdown", bounds.x + 10, bounds.y + 10));
    // The first move past the threshold only activates the drag; the next one moves it.
    document.dispatchEvent(pointer("pointermove", -90, 100));
    document.dispatchEvent(pointer("pointermove", -100, 100));
  });
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
});

it("reorders a project folder's threads by dragging in Manual order", async () => {
  await page.viewport(1400, 900);
  const threads = ["folder-a", "folder-b", "folder-c"].map((name) => threadWithHistory(name, 1));
  using _environment = installFakeEnvironment(threads, { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    sidebarThreadOrderingMode: "manual",
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const title = (name: string) => page.getByText(`Thread ${name}`, { exact: true }).first();
  await expect.element(title("folder-c")).toBeVisible();
  // Real mouse steps: the first move past the threshold starts the drag, later ones sort.
  await userEvent.dragAndDrop(title("folder-c"), title("folder-a"), {
    targetPosition: { x: 4, y: 1 },
    steps: 12,
  });

  await vi.waitFor(() =>
    expect(
      dispatchedCommands().filter((command) => command.type === "thread.active.reorder"),
    ).toContainEqual(expect.objectContaining({ threadId: "folder-c" })),
  );
});
