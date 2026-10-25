import { render as renderClient, stubGlobal } from "../../test/render";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  retrying: false,
  subagent: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor"; awaited?: boolean }>,
  delegatedChild: null as "running" | "approval" | null,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.retrying
        ? "waiting"
        : state.sessionError || state.turnError || state.limited
          ? "failed"
          : "running",
    lastError: state.sessionError ? "Provider overloaded" : null,
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

let stableParent: ReturnType<typeof mockThreadShell> | null = null;
function mockThreads() {
  if (state.delegatedChild === null) return [mockThreadShell()];
  stableParent ??= mockThreadShell();
  const child = {
    ...mockThreadShell(),
    id: "child-1",
    title: "Review the login form",
    creationSource: "mcp",
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: "thread-1",
      relationshipToParent: "subagent",
    },
    pendingRuntimeRequest:
      state.delegatedChild === "approval"
        ? { id: "request-2", kind: "command", createdAt: SHELL_NOW }
        : null,
  };
  return [stableParent, child];
}

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: mockThreads() }),
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => state.active) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp })) as never,
  getClientSettings: (() => ({ notificationMode: state.mode })) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add as never, close: state.close },
  };
});

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

async function setup() {
  const stack = new AsyncDisposableStack();
  stack.defer(() => {
    vi.restoreAllMocks();
  });
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    retrying: false,
    subagent: false,
    background: [],
    delegatedChild: null,
  });
  stableParent = null;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => state.visible as DocumentVisibilityState,
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused);
  stack.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  const screen = stack.use(await renderClient(null));
  const rerender = () => screen.rerender(<ThreadNotificationCoordinator />);
  return {
    render: rerender,
    complete: async () => {
      state.completedAt = "2026-09-13T10:00:00.000Z";
      await rerender();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("thread notifications", () => {
  it.each([true, false])(
    "waits for retry success before alerting with focus=%s",
    async (focused) => {
      await using screen = await setup();
      const { render, complete } = screen;
      state.focused = focused;
      state.mode = "notifications-and-sound";
      await render();
      state.retrying = true;
      state.sessionError = true;
      await render();
      await render();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();

      state.retrying = false;
      state.sessionError = false;
      await complete();
      await render();
      expect(state.sound).toHaveBeenCalledTimes(1);
      expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
      if (focused) {
        expect(state.add).toHaveBeenCalledTimes(1);
        expect(state.add).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Thread completed" }),
        );
        expect(state.notification).not.toHaveBeenCalled();
      } else {
        expect(state.notification).toHaveBeenCalledTimes(1);
        expect(state.notification).toHaveBeenCalledWith("Thread completed", expect.any(Object));
        expect(state.add).not.toHaveBeenCalled();
      }
    },
  );

  it("alerts once when automatic retries stop at the provider failure", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.mode = "notifications-and-sound";
    await render();
    state.retrying = true;
    state.sessionError = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();

    state.retrying = false;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ title: "Thread failed" }));
    expect(state.sound).toHaveBeenCalledTimes(1);
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
  });

  it.each([true, false])("keeps subagents silent with focus=%s", async (focused) => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.subagent = true;
    state.focused = focused;
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    state.input = true;
    await render();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("alerts on the parent when its delegated subagent asks for approval", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.mode = "notifications-and-sound";
    state.delegatedChild = "running";
    await render();
    state.delegatedChild = "approval";
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Approval needed", description: "Fix the login form" }),
    );
  });

  it("alerts once with system alerts off and opens the completed thread", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await using screen = await setup();
      const { render, complete } = screen;
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed"],
    ["approval", "Approval needed"],
    ["sessionError", "Thread failed"],
    ["turnError", "Thread failed"],
    ["limited", "Usage limit reached"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.mode = "notifications-and-sound";
    await render();
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await render();
    state.focused = false;
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: expect.any(String),
      silent: true,
    });
  });

  it("alerts when only a dev server is left running, not while an awaited monitor runs", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    await render();
    state.background = [{ taskId: "watch", kind: "monitor", awaited: true }];
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    state.background = [{ taskId: "dev", kind: "command" }];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread completed" }),
    );
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Thread completed", {
      body: "Fix the login form",
      tag: expect.any(String),
      silent: true,
    });
  });

  it("reveals the desktop window and opens the thread when a system alert is clicked", async () => {
    await using screen = await setup();
    const { render, complete } = screen;
    const revealWindow = vi.fn(() => Promise.resolve());
    vi.stubGlobal("desktopBridge", { revealWindow });
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    const notification: EventTarget = state.notification.mock.results[0]?.value;
    notification.dispatchEvent(new Event("click"));
    expect(revealWindow).toHaveBeenCalledTimes(1);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
  });
});
