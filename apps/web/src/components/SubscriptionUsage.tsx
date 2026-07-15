import type { ServerProviderUsage, ServerProviderUsageWindow } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const WINDOW_LABELS = { session: "Session", weekly: "Weekly" } as const;
type UsageKind = keyof typeof WINDOW_LABELS;

/**
 * Remaining-quota color: full quota renders in the neutral foreground
 * ("white" in the dark theme), dropping to yellow at ≤30% remaining and
 * red at ≤15% remaining.
 */
function usageColor(remainingPercent: number): string {
  if (remainingPercent <= 15) return "var(--color-red-500)";
  if (remainingPercent <= 30) return "var(--color-yellow-500)";
  return "var(--color-foreground)";
}

const remainingPercent = (window: ServerProviderUsageWindow): number =>
  Math.max(0, Math.min(100, 100 - window.usedPercent));

function usageTooltipText(kind: UsageKind, window: ServerProviderUsageWindow): string {
  const left = `${Math.round(remainingPercent(window))}% left`;
  if (!window.resetsAt) return `${WINDOW_LABELS[kind]}: ${left}`;
  const resets = new Date(window.resetsAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${WINDOW_LABELS[kind]}: ${left} · resets ${resets}`;
}

/**
 * Circular remaining-quota indicator (same geometry as ContextWindowMeter)
 * with a `s`/`w` letter in the middle.
 */
function SubscriptionUsageRing(props: { kind: UsageKind; window: ServerProviderUsageWindow }) {
  const remaining = remainingPercent(props.window);
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (remaining / 100) * circumference;
  const color = usageColor(remaining);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="relative inline-flex size-5 items-center justify-center"
            aria-label={usageTooltipText(props.kind, props.window)}
          >
            <svg
              viewBox="0 0 24 24"
              className="-rotate-90 absolute inset-0 size-full transform-gpu"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
                strokeWidth="3"
              />
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
              />
            </svg>
            <span className="relative mt-[-0.62px] -ml-px text-[10px] font-semibold select-none leading-none text-muted-foreground">
              {props.kind === "session" ? "s" : "w"}
            </span>
          </span>
        }
      />
      <TooltipPopup side="bottom">{usageTooltipText(props.kind, props.window)}</TooltipPopup>
    </Tooltip>
  );
}

/** Session + weekly rings for the title bar. Renders nothing without data. */
export function SubscriptionUsageRings(props: { usage: ServerProviderUsage | null | undefined }) {
  const { usage } = props;
  if (!usage || (usage.session === null && usage.weekly === null)) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {usage.session ? <SubscriptionUsageRing kind="session" window={usage.session} /> : null}
      {usage.weekly ? <SubscriptionUsageRing kind="weekly" window={usage.weekly} /> : null}
    </span>
  );
}

function SubscriptionUsageBar(props: { kind: UsageKind; window: ServerProviderUsageWindow }) {
  const remaining = remainingPercent(props.window);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0">{WINDOW_LABELS[props.kind]}</span>
            <span
              className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(remaining)}
              aria-label={`${WINDOW_LABELS[props.kind]} quota remaining`}
            >
              <span
                className="block h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{
                  width: `${remaining}%`,
                  backgroundColor: usageColor(remaining),
                }}
              />
            </span>
          </span>
        }
      />
      <TooltipPopup side="top">{usageTooltipText(props.kind, props.window)}</TooltipPopup>
    </Tooltip>
  );
}

/** `Session ───── | Weekly ─────` row for the provider settings card. */
export function SubscriptionUsageBars(props: { usage: ServerProviderUsage }) {
  const { usage } = props;
  if (usage.session === null && usage.weekly === null) return null;
  return (
    <div className="flex max-w-72 items-center gap-2 text-xs text-muted-foreground/80">
      {usage.session ? <SubscriptionUsageBar kind="session" window={usage.session} /> : null}
      {usage.session && usage.weekly ? (
        <span aria-hidden className="text-muted-foreground/40">
          |
        </span>
      ) : null}
      {usage.weekly ? <SubscriptionUsageBar kind="weekly" window={usage.weekly} /> : null}
    </div>
  );
}
