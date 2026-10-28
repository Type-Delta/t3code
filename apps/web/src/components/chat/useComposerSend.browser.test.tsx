import { DEFAULT_UNIFIED_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import type { ChatComposerHandle } from "./ChatComposer";
import { useComposerSend } from "./useComposerSend";

const calls = vi.hoisted(() => ({
  provider: vi.fn(async (_input: unknown) => AsyncResult.success(undefined)),
}));
vi.mock(import("../../state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() => calls.provider) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettingsHydrated: () => true,
  useEnvironmentSettings: ((
    _id: unknown,
    select: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown,
  ) => select({ ...DEFAULT_UNIFIED_SETTINGS, planModeEnabled: false })) as never,
}));
vi.mock(import("../../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: () => vi.fn(),
}));

type Input = Parameters<typeof useComposerSend>[0];
function inputFor(prompt: string, navigate: Input["onCheckpointNavigation"]): Input {
  const thread = makeThreadFixture();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const routeThreadKey = scopedThreadKey(threadRef);
  const promptRef = { current: prompt };
  // The sender only reads these methods. The real composer inserts a trailing space
  // after a slash-menu selection before the next Enter submits it.
  const composer = {
    getSendContext: () => ({
      answeringPendingUserInput: false,
      prompt: promptRef.current,
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
      selectedPromptEffort: null,
      selectedModelOptionsForDispatch: null,
      selectedModelSelection: thread.modelSelection,
      multipleModelSelections: null,
      providerAvailable: true,
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedModel: thread.modelSelection.model,
      selectedProviderModels: [],
      interactionMode: "default" as const,
      interactionModeEnabled: false,
      shownPendingApprovalIds: [],
    }),
    validateProviderInput: () => true,
    resetCursorState: vi.fn(),
  } as Partial<ChatComposerHandle> as ChatComposerHandle;
  return {
    onCheckpointNavigation: navigate,
    environmentId: thread.environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef: { current: routeThreadKey },
    draftId: null,
    draftThread: null,
    activeThread: thread,
    activeThreadKey: routeThreadKey,
    activeThreadBranch: null,
    activeProject: {
      id: thread.projectId,
      environmentId: thread.environmentId,
      title: "Project",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    },
    activeProjectDefaultModelSelection: null,
    activeProposedPlan: null,
    activeMessageCount: 2,
    isServerThread: true,
    isLocalDraftThread: false,
    isGitRepo: true,
    phase: "ready",
    runtimeMode: "full-access",
    sendEnvMode: "local",
    startFromOrigin: false,
    localCheckoutBranchMismatch: null,
    logicalProjectEnvironments: [],
    providerInstanceEntries: [],
    composerRef: { current: composer },
    composerDraftTarget: threadRef,
    promptRef,
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    feedbackUploadsInFlightRef: { current: new Set() },
    queuedRunEdit: { isEditing: false } as Input["queuedRunEdit"],
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    activeEnvironmentUnavailable: false,
    isSendBusy: false,
    sendQueuesBehindSetup: false,
    isDraftHeroState: false,
    panelAnimationsActive: false,
    panelAnimationDurationMs: 0,
    keepFullHistory: false,
    resumeCompactionTokens: null,
    showPlanFollowUpPrompt: false,
    usageLimitsKey: null,
    usageLimitsOffered: false,
    openUsageLimits: vi.fn(),
    clearUsageLimitsFor: vi.fn(),
    needsLoadBalancing: false,
    loadBalancing: { pending: false } as Input["loadBalancing"],
    readPendingEnvironmentChange: () => null,
    pendingApprovals: [],
    respondingRequestIds: [],
    activePendingProgress: null,
    onAdvanceActivePendingUserInput: vi.fn(),
    onRespondToApproval: vi.fn(),
    beginLocalDispatch: vi.fn(),
    resetLocalDispatch: vi.fn(),
    beginWorktreeSetup: vi.fn(),
    captureDraftHeroComposerRect: vi.fn(),
    setDockedDraftHeroThreadKey: vi.fn(),
    setSetupQueueSendThreadKey: vi.fn(),
    setOptimisticUserMessages: vi.fn(),
    optimisticBlobPreviews: { track: vi.fn(), release: vi.fn() },
    setFeedbackSubmissionsByThreadKey: vi.fn(),
    setThreadError: vi.fn(),
    setKeepFullHistory: vi.fn(),
    anchorNewTurn: vi.fn(),
    acknowledgeActiveThreadWoke: vi.fn(),
    handleInteractionModeChange: vi.fn(),
    handleNewThreadInActiveProject: vi.fn(),
    persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
  };
}
function Sender({ input, finished }: { input: Input; finished: () => void }) {
  const { onSend } = useComposerSend(input);
  return (
    <button
      onClick={async () => {
        await onSend();
        finished();
      }}
    >
      Send
    </button>
  );
}

it.each(["undo", "redo"] as const)(
  "submits /%s locally when plan controls are unavailable",
  async (command) => {
    calls.provider.mockClear();
    const navigation = vi.fn(async () => {});
    const finished = vi.fn();
    const input = inputFor(`/${command} `, navigation);
    await using screen = await render(<Sender input={input} finished={finished} />);
    await screen.getByRole("button", { name: "Send", exact: true }).click();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(calls.provider).not.toHaveBeenCalled();
    expect(navigation).toHaveBeenCalledExactlyOnceWith(command);
    expect(input.promptRef.current).toBe("");
  },
);

it("keeps prompts that merely start with /undo on the provider send path", async () => {
  calls.provider.mockClear();
  const navigation = vi.fn(async () => {});
  const finished = vi.fn();
  const input = inputFor("/undo this change in a new way", navigation);
  await using screen = await render(<Sender input={input} finished={finished} />);
  await screen.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
  expect(navigation).not.toHaveBeenCalled();
  expect(calls.provider).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      input: expect.objectContaining({
        message: expect.objectContaining({ text: "/undo this change in a new way" }),
      }),
    }),
  );
});
