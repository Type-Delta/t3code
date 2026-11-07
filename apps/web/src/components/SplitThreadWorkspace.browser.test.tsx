import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useSplitViewStore } from "~/splitViewStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

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

it("leaves a thread the tag filter hides out of the split", async () => {
  const hidden = { ...threadWithHistory("thread-hidden", 1), tags: ["private"] };
  const shown = threadWithHistory("thread-shown", 1);
  using _environment = installFakeEnvironment([hidden, shown], {
    hideTaggedThreads: true,
    hiddenThreadTags: ["private"],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const shownRef = scopeThreadRef(ENVIRONMENT_ID, shown.id);
  // The split focuses the opened pane, so the route stays on the shown thread.
  useSplitViewStore.getState().openInSplit(scopeThreadRef(ENVIRONMENT_ID, hidden.id), shownRef);
  using _split = { [Symbol.dispose]: () => useSplitViewStore.getState().clearSplit() };

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${shown.id}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using _app = await render(<AppRoot router={router} />, {
    container,
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-shown.")).toBeVisible();
  await expect.element(page.getByText("Answer 0 for thread-hidden.")).not.toBeInTheDocument();
});
