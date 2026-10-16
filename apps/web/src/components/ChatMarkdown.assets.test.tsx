import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  asset: { _tag: "Success", url: "https://host.test/api/assets/image.png" } as
    | { readonly _tag: "Success"; readonly url: string }
    | { readonly _tag: "Failure" },
  refresh: vi.fn(),
}));
const mint = vi.hoisted(() => vi.fn());
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useFileMetadata", () => ({ useFileMetadata: () => undefined }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("./media/MediaActions", () => ({
  MediaActions: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mint }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: () => state.asset,
  useAssetUrlRefresh: () => state.refresh,
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, { ChatMarkdownAssetImage } from "./ChatMarkdown";

it("retries a host image after an initial cached asset failure", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.asset = { _tag: "Failure" };
  state.refresh.mockReset().mockResolvedValue("https://host.test/api/assets/image.png");
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ChatMarkdownAssetImage
          environmentId={EnvironmentId.make("media-environment")}
          resource={{
            _tag: "media-file",
            threadId: ThreadId.make("media-thread"),
            path: "/tmp/image.png",
          }}
          alt="image"
        />,
      );
    });
    await act(async () => {
      renderer!.update(
        <ChatMarkdownAssetImage
          environmentId={EnvironmentId.make("media-environment")}
          resource={{
            _tag: "media-file",
            threadId: ThreadId.make("media-thread"),
            path: "/tmp/image.png",
          }}
          alt="image"
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => renderer?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    state.asset = { _tag: "Success", url: "https://host.test/api/assets/image.png" };
  }
});

it("opens host media through server authorization before the client grant loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const threadRef = {
    environmentId: EnvironmentId.make("media-environment"),
    threadId: ThreadId.make("media-thread"),
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          cwd="/repo"
          threadRef={threadRef}
          text="[Open image](/tmp/image.png)"
          onImageExpand={onImageExpand}
        />,
      );
    });
    await act(async () => {
      const link = renderer!.root
        .findAllByType("a")
        .find((node) => node.props.href === "/tmp/image.png");
      expect(link).toBeDefined();
      link!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    );
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
