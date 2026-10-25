import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ProviderDriverKind } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { makeThreadFixture, makeThreadProjectionFixture } from "../../test-fixtures";
import { ComposerCommandMenu } from "./ComposerCommandMenu";
import { useComposerMenuItems } from "./useComposerMenuItems";
import { useTimelineRewind } from "./useTimelineRewind";

vi.mock(import("../../state/entities"), () => ({
  useThreadShells: () => [],
  waitForThreadShell: vi.fn(),
}));
vi.mock(import("../../state/queries"), () => ({
  useDebouncedValue: <T,>(value: T) => value,
  useComposerPathSearch: (target) => ({
    entries: [],
    searchedTarget: { ...target, kind: undefined, imageOnly: undefined },
    searchedQuery: target.query ?? "",
    error: null,
    isPending: false,
    truncated: false,
    refresh: () => {},
  }),
}));
vi.mock(import("../../state/pullRequests"), () => ({
  pullRequestEnvironment: { detail: vi.fn() } as never,
  usePullRequestList: () => ({ data: null, error: null, isPending: false, refresh: () => {} }),
}));
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: () => ({
    data: null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  }),
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock(import("../../state/use-atom-command"), () => ({ useAtomCommand: () => vi.fn() }));
vi.mock(import("../../state/use-atom-query-runner"), () => ({
  useAtomQueryRunner: () => vi.fn(),
}));
vi.mock(import("./ChatOverlayHosts"), () => ({ openRevertConfirm: vi.fn() }));

function OpenCheckpointMenu() {
  const [loaded, setLoaded] = useState(false);
  const thread = makeThreadFixture();
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const key = scopedThreadKey(ref);
  const projection = makeThreadProjectionFixture();
  const { checkpointNavigationDisabledReason } = useTimelineRewind({
    isServerThread: true,
    environmentId: thread.environmentId,
    routeThreadRef: ref,
    routeThreadKey: key,
    currentRouteThreadKeyRef: { current: key },
    serverProjection: loaded
      ? {
          ...projection,
          checkpointNavigation: {
            capability: "branching",
            canUndo: true,
            canRedo: false,
            isNavigating: false,
            latestCheckpointBlockingStatus: null,
            reason: null,
            cursorVersion: 2,
            currentEntryId: "entry-2",
            currentOrdinal: 2,
            forwardTipEntryId: "entry-2",
            forwardTipOrdinal: 2,
          },
        }
      : projection,
    activeThread: thread,
    timelineMessages: [],
    paintOnlyDisplayedTimeline: false,
    phase: "ready",
    isConnecting: false,
    isSendBusy: false,
    isRevertingCheckpoint: false,
    supportsConversationRollback: true,
    activeEnvironmentUnavailable: false,
    activeEnvironmentUnavailableLabel: null,
    promptRef: { current: "/undo" },
    composerRef: { current: null },
    composerDraftTarget: ref,
    setThreadError: vi.fn(),
  });
  const menu = useComposerMenuItems({
    composerTrigger: { kind: "slash-command", query: "undo", rangeStart: 0, rangeEnd: 5 },
    environmentId: thread.environmentId,
    gitCwd: null,
    activeThreadId: thread.id,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    planModeUiEnabled: false,
    compactSlashCommandAvailable: false,
    selectedProvider: ProviderDriverKind.make("codex"),
    selectedProviderSkills: [],
    selectedProviderSlashCommands: [],
    showSkillsInSlashMenu: false,
    checkpointNavigationDisabledReason,
  });
  return (
    <>
      <button onClick={() => setLoaded(true)}>Receive thread snapshot</button>
      <ComposerCommandMenu
        listId="checkpoint-menu"
        items={menu.items}
        resolvedTheme="light"
        isLoading={menu.isLoading}
        triggerKind="slash-command"
        activeItemId="slash:undo"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />
    </>
  );
}

it("enables an open undo menu when checkpoint availability arrives", async () => {
  await using screen = await render(<OpenCheckpointMenu />);
  await expect
    .element(
      screen
        .getByRole("option", { name: /^\/undo/ })
        .getByText("Checkpoint navigation availability has not loaded yet."),
    )
    .toBeVisible();
  await screen.getByRole("button", { name: "Receive thread snapshot" }).click();
  await expect.element(screen.getByText("Restore the previous ready checkpoint")).toBeVisible();
  await expect
    .element(screen.getByRole("option", { name: /^\/undo/ }))
    .not.toHaveAttribute("aria-disabled", "true");
});
