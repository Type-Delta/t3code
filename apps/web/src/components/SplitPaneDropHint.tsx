import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

export type SplitPaneDropSide = "before" | "after" | "above" | "below";

export function SplitPaneDropHint(props: {
  position: SplitPaneDropSide;
  className?: string;
  style?: CSSProperties;
}) {
  const { className, position, style } = props;
  const isLeft = position === "before";
  const isAbove = position === "above";
  const isBelow = position === "below";
  const isVertical = isAbove || isBelow;

  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute z-40 overflow-hidden bg-primary/[0.045] ring-2 ring-inset ring-primary/75",
        className,
      )}
      data-split-pane-drop-hint={
        isVertical ? (isAbove ? "above" : "below") : isLeft ? "left" : "right"
      }
      style={style}
    >
      <div
        aria-hidden
        className={cn(
          "absolute bg-primary/10",
          isVertical ? "inset-x-0 h-1/4" : "inset-y-0 w-1/2",
          isAbove ? "top-0" : isBelow ? "bottom-0" : isLeft ? "left-0" : "right-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "absolute border-dashed border-primary/70",
          isAbove
            ? "inset-x-0 top-1/4 border-t-2"
            : isBelow
              ? "inset-x-0 bottom-1/4 border-t-2"
              : "inset-y-0 left-1/2 border-l-2",
        )}
      />
      <div
        className={cn(
          "absolute flex items-center justify-center px-3",
          isVertical ? "inset-x-0 h-1/4" : "inset-y-0 w-1/2",
          isAbove ? "top-0" : isBelow ? "bottom-0" : isLeft ? "left-0" : "right-0",
        )}
      >
        <span className="rounded-md bg-primary px-3 py-1.5 text-center text-xs font-medium text-primary-foreground shadow-sm">
          Drop to place{" "}
          {isAbove ? "above" : isBelow ? "below" : `on the ${isLeft ? "left" : "right"}`}
        </span>
      </div>
    </div>
  );
}
