import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { DEFAULT_COMPOSER_PLACEHOLDER } from "~/composerPlaceholder";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  PROJECT_ID,
  type FakeThread,
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

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("opens the thread actions menu for an older settled thread the shell leaves out", async () => {
  const thread = { ...threadWithHistory("older-settled", 1), olderSettled: true as const };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("older-settled: question 0")).toBeVisible();

  await page.getByRole("button", { name: `Thread actions for ${thread.title}` }).click();
  // Without a bound the poll runs to the test deadline and reports a bare timeout.
  await expect
    .element(page.getByRole("menuitem", { name: "Rename thread" }), { timeout: 5_000 })
    .toBeVisible();
});

it("retains each thread's diff selection when returning from another thread or Settings", async () => {
  const a = threadWithHistory("diff-selection-a", 1);
  const b = threadWithHistory("diff-selection-b", 1);
  using _environment = installFakeEnvironment([a, b]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  useRightPanelStore.getState().open(aRef, "diff");
  useRightPanelStore.getState().open(bRef, "diff");
  useDiffPanelStore.getState().selectBranchBaseRef(bRef, "origin/release");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  await act(() => useDiffPanelStore.getState().selectGitScope(aRef, "unstaged"));

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: b.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, bRef)).toEqual({
    kind: "branch",
    baseRef: "origin/release",
  });
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef)).toEqual({
    kind: "unstaged",
  });

  await act(() => useDiffPanelStore.getState().selectTurn(aRef, a.runs[0]!.id));
  await act(() => router.navigate({ to: "/settings/general" }));
  await expect
    .element(page.getByRole("heading", { name: "Time format", exact: true }))
    .toBeVisible();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef),
  ).toMatchObject({
    kind: "turn",
    turnId: a.runs[0]!.id,
  });
});

function withTaggedSuggestion(thread: FakeThread, suggestion: string): FakeThread {
  return {
    ...thread,
    items: thread.items.map((item) =>
      item.type === "assistant_message" ? { ...item, suggestion } : item,
    ),
  };
}

async function openThreadWithSuggestions(thread: FakeThread) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    enablePromptSuggestion: true,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  return render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
}

// Locators skip the editor's placeholder overlay, so read the text it shows directly.
const placeholderText = () => document.querySelector(".text-placeholder")?.textContent ?? null;

it("offers the settled reply's suggestion until Escape, hiding it only while typing", async () => {
  const thread = withTaggedSuggestion(threadWithHistory("suggestion-tagged", 1), "Run the tests");
  using _environment = installFakeEnvironment([thread]);
  await using _app = await openThreadWithSuggestions(thread);
  const editor = page.getByTestId("composer-editor");
  const offered = "Run the tests⇥ Tab";
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  await vi.waitFor(() => expect(placeholderText()).toBe(offered));

  await userEvent.click(editor);
  await userEvent.keyboard("x");
  await vi.waitFor(() => expect(placeholderText()).toBeNull());
  await userEvent.keyboard("{Backspace}");
  await vi.waitFor(() => expect(placeholderText()).toBe(offered));

  await userEvent.keyboard("{Tab}");
  await expect.element(editor).toHaveTextContent("Run the tests");
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}{Backspace}");
  await vi.waitFor(() => expect(placeholderText()).toBe(offered));

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(placeholderText()).toBe(DEFAULT_COMPOSER_PLACEHOLDER));
  await userEvent.keyboard("x{Backspace}");
  await vi.waitFor(() => expect(placeholderText()).toBe(DEFAULT_COMPOSER_PLACEHOLDER));
});

it("prefers Claude's native suggestion for the latest run over the tagged one", async () => {
  const base = threadWithHistory("suggestion-native", 1, {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-4-6",
  });
  const thread = withTaggedSuggestion(base, "Tagged suggestion");
  using _environment = installFakeEnvironment([thread], {
    providers: [CLAUDE_PROVIDER, CODEX_PROVIDER],
    promptSuggestion: { runId: base.runs.at(-1)!.id, text: "Native suggestion" },
  });
  await using _app = await openThreadWithSuggestions(thread);
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  await vi.waitFor(() => expect(placeholderText()).toBe("Native suggestion⇥ Tab"));
});

it("never offers a suggestion in a thread another agent drives", async () => {
  const parent = threadWithHistory("suggestion-parent", 1);
  const child = {
    ...withTaggedSuggestion(threadWithHistory("suggestion-child", 1), "Child suggestion"),
    subagentOf: parent.id,
  };
  using _environment = installFakeEnvironment([parent, child]);
  await using _app = await openThreadWithSuggestions(child);
  await expect.element(page.getByText(`Answer 0 for ${child.id}.`)).toBeVisible();
  await vi.waitFor(() => expect(placeholderText()).toBe(DEFAULT_COMPOSER_PLACEHOLDER));
});
