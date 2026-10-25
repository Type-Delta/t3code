import "../../index.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

it("expands a JSON failure to its full diagnostics and collapses to its message", async () => {
  const error = '  {"error": {"message":"Turn failed", "code":"unsupported_value"}}\t ';
  await using screen = await render(<ThreadErrorBanner error={error} />);
  await expect.element(screen.getByText("Turn failed", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("unsupported_value");
  await screen.getByRole("button", { name: "Show full error" }).click();
  const diagnostics = screen.getByText(error, { exact: true });
  await expect.element(diagnostics).toBeVisible();
  expect(diagnostics.element().textContent).toBe(error);
  await screen.getByRole("button", { name: "Show less" }).click();
  await expect.element(screen.getByText("Turn failed", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("unsupported_value");
});

it("retries a recoverable failure and disables the action while retrying", async () => {
  const onRetry = vi.fn();
  await using screen = await render(
    <ThreadErrorBanner error="Turn failed." onDismiss={() => {}} onRetry={onRetry} />,
  );
  await expect.element(page.getByRole("button", { name: "Dismiss error" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  expect(onRetry).toHaveBeenCalledOnce();
  await screen.rerender(<ThreadErrorBanner error="Turn failed." onRetry={onRetry} retrying />);
  await expect.element(page.getByRole("button", { name: "Retrying…" })).toBeDisabled();
});
