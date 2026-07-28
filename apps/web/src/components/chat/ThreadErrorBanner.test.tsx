import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("renders a retry action for recoverable turn failures", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Turn failed." onDismiss={() => {}} onRetry={() => {}} />,
    );

    expect(markup).toContain(">Retry</button>");
    expect(markup).toContain('aria-label="Dismiss error"');
  });

  it("disables the retry action while retrying", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Turn failed." onRetry={() => {}} retrying />,
    );

    expect(markup).toContain("Retrying…");
    expect(markup).toContain("disabled");
  });
});
