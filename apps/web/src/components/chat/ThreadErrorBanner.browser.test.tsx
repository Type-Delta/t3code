import "../../index.css";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

it("expands even a short JSON error to its exact diagnostics and collapses back to its message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const error = '  {"error": {"message":"Turn failed", "code":"unsupported_value"}}\t ';

  try {
    await act(async () => root.render(<ThreadErrorBanner error={error} />));

    await expect.element(page.getByText("Turn failed", { exact: true })).toBeVisible();
    expect(container.textContent).not.toContain("unsupported_value");

    await act(async () => page.getByRole("button", { name: "Show full error" }).click());

    const diagnostics = page.getByText(error, { exact: true });
    await expect.element(diagnostics).toBeVisible();
    expect(diagnostics.element().textContent).toBe(error);

    await act(async () => page.getByRole("button", { name: "Show less" }).click());

    await expect.element(page.getByText("Turn failed", { exact: true })).toBeVisible();
    expect(container.textContent).not.toContain("unsupported_value");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("retries a recoverable turn failure and disables the action while retrying", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onRetry = vi.fn();

  try {
    await act(async () =>
      root.render(
        <ThreadErrorBanner error="Turn failed." onDismiss={() => {}} onRetry={onRetry} />,
      ),
    );

    await expect.element(page.getByRole("button", { name: "Dismiss error" })).toBeVisible();
    await act(async () => page.getByRole("button", { name: "Retry" }).click());
    expect(onRetry).toHaveBeenCalledOnce();

    await act(async () =>
      root.render(<ThreadErrorBanner error="Turn failed." onRetry={onRetry} retrying />),
    );
    await expect.element(page.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
