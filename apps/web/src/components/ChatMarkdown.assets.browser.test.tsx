import { RegistryContext } from "@effect/atom-react";
import { type AssetCreateUrlResult, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { type ReactNode } from "react";
import { act, render as renderClient } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn<() => Promise<AssetCreateUrlResult>>());
const scopes = vi.hoisted(() => ({ filesystemRead: false }));
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// Keep the real query runner and registry: refreshes during waiting requests are skipped.
vi.mock(import("../state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const family = Atom.family((_key: string) =>
    Atom.make(Effect.tryPromise(() => mint())).pipe(Atom.keepAlive),
  );
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target) => family(JSON.stringify(target)),
    },
  };
});
vi.mock(import("../state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => scopes.filesystemRead,
  useEnvironmentScope: () => false,
  readPreparedConnection: (() => ({ httpBaseUrl: "https://host.test" })) as never,
  usePreparedConnection: (() => ({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  })) as never,
}));

import ChatMarkdown from "./ChatMarkdown";
import { ChatMarkdownAssetImage } from "./chat/ChatMarkdownMedia";

const imageUrl = (version: string) =>
  `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>#${version}`;
const assetResult = (version: string): AssetCreateUrlResult => ({
  relativeUrl: imageUrl(version),
  expiresAt: 1,
});

function setup() {
  mint.mockReset().mockResolvedValue(assetResult("updated"));
  scopes.filesystemRead = false;
  return {
    [Symbol.dispose]() {
      scopes.filesystemRead = false;
    },
  };
}
async function createTestRoot() {
  const registry = AtomRegistry.make();
  const screen = await renderClient(null);
  return {
    container: screen.container,
    render: (children: ReactNode) =>
      screen.rerender(
        <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>,
      ),
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
      registry.dispose();
    },
  };
}

it("opens host media through server authorization before the client grant loads", async () => {
  using _state = setup();
  mint.mockResolvedValue({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
  const onImageExpand = vi.fn();
  await using screen = await createTestRoot();
  const { container, render } = screen;
  await render(
    <ChatMarkdown
      cwd="/repo"
      threadRef={{
        environmentId: EnvironmentId.make("media-environment"),
        threadId: ThreadId.make("media-thread"),
      }}
      text="[Open image](/tmp/image.png)"
      onImageExpand={onImageExpand}
    />,
  );
  const link = container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  await vi.waitFor(() =>
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    ),
  );
});

const threadRef = {
  environmentId: EnvironmentId.make("media-environment"),
  threadId: ThreadId.make("media-thread"),
};

function markdown(workspaceMutationId?: string | null) {
  return (
    <ChatMarkdown
      cwd="/repo"
      imageBaseDir="/repo"
      threadRef={threadRef}
      text="![Diagram](diagram.svg)"
      workspaceMutationId={workspaceMutationId}
    />
  );
}

function renderedImage(container: HTMLElement) {
  return container.querySelector<HTMLImageElement>('img[alt="Diagram"]')?.getAttribute("src");
}

it("ordinary chat keeps its embedded asset URL across renders and reopening", async () => {
  using _state = setup();
  await using screen = await createTestRoot();
  const { container, render } = screen;
  await render(markdown());
  expect(renderedImage(container)).toBe(imageUrl("updated"));
  mint.mockResolvedValue(assetResult("changed"));

  await render(markdown());
  await render(null);
  await render(markdown());

  expect(renderedImage(container)).toBe(imageUrl("updated"));
  expect(mint).toHaveBeenCalledTimes(1);
});

it.each(["URL", "failure"] as const)(
  "reopening a file preview with no workspace mutation replaces its cached %s",
  async (cached) => {
    using _state = setup();
    if (cached === "failure") mint.mockRejectedValueOnce(new Error("Image missing"));
    else mint.mockResolvedValueOnce(assetResult("stale"));
    await using screen = await createTestRoot();
    const { container, render } = screen;
    await render(markdown(null));
    expect(renderedImage(container)).toBe(cached === "URL" ? imageUrl("stale") : undefined);
    await render(null);

    mint.mockResolvedValue(assetResult("updated"));
    await render(markdown(null));

    expect(renderedImage(container)).toBe(imageUrl("updated"));
    expect(mint).toHaveBeenCalledTimes(2);
  },
);

it.each(["initial", "refresh"] as const)(
  "shows the latest workspace edit after a pending %s asset request settles",
  async (request) => {
    using _state = setup();
    let resolvePending!: (value: AssetCreateUrlResult) => void;
    const pending = new Promise<AssetCreateUrlResult>((resolve) => {
      resolvePending = resolve;
    });
    await using screen = await createTestRoot();
    const { container, render } = screen;
    if (request === "refresh") {
      await render(markdown("m0"));
      expect(renderedImage(container)).toBe(imageUrl("updated"));
    }

    mint.mockReturnValueOnce(pending).mockResolvedValue(assetResult("latest"));
    await render(markdown("m1"));
    const callsBeforeEdits = mint.mock.calls.length;
    await render(markdown("m2"));
    await render(markdown("m3"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits);

    await act(async () => {
      resolvePending(assetResult("before-edits"));
      await pending;
    });

    expect(renderedImage(container)).toBe(imageUrl("latest"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
    await render(markdown("m3"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
  },
);

it("retries a host image after its first asset request fails", async () => {
  using _state = setup();
  scopes.filesystemRead = true;
  mint.mockRejectedValueOnce(new Error("Image missing"));
  const resource = {
    _tag: "media-file" as const,
    threadId: threadRef.threadId,
    path: "/tmp/image.svg",
  };
  await using screen = await createTestRoot();
  const { container, render } = screen;
  const image = () => (
    <ChatMarkdownAssetImage
      environmentId={threadRef.environmentId}
      resource={{ ...resource }}
      alt="Streamed"
    />
  );
  await render(image());
  // Streaming re-renders recreate the resource literal without restarting the retry.
  await render(image());

  await vi.waitFor(
    () =>
      expect(
        container.querySelector<HTMLImageElement>('img[alt="Streamed"]')?.getAttribute("src"),
      ).toBe(imageUrl("updated")),
    { timeout: 3_000 },
  );
  expect(mint).toHaveBeenCalledTimes(2);
});
