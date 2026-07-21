import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

export type SplitPaneDropSide = "before" | "after";

export function SplitPaneDropHint(props: {
  position: SplitPaneDropSide;
  className?: string;
  style?: CSSProperties;
}) {
  const { className, position, style } = props;
  const isLeft = position === "before";

  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute z-40 overflow-hidden bg-primary/[0.045] ring-2 ring-inset ring-primary/75",
        className,
      )}
      data-split-pane-drop-hint={isLeft ? "left" : "right"}
      style={style}
    >
      <div
        aria-hidden
        className={cn("absolute inset-y-0 w-1/2 bg-primary/10", isLeft ? "left-0" : "right-0")}
      />
      <div
        aria-hidden
        className="absolute inset-y-0 left-1/2 border-l-2 border-dashed border-primary/70"
      />
      <div
        className={cn(
          "absolute inset-y-0 flex w-1/2 items-center justify-center px-3",
          isLeft ? "left-0" : "right-0",
        )}
      >
        <span className="rounded-md bg-primary px-3 py-1.5 text-center text-xs font-medium text-primary-foreground shadow-sm">
          Drop to place on the {isLeft ? "left" : "right"}
        </span>
      </div>
    </div>
  );
}
