import type {
  ServerProviderSubscriptionUsageWindow,
  ServerProviderUsage,
} from "@t3tools/contracts";

import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
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
  return "var(--color-muted-foreground)";
}

const remainingPercent = (window: ServerProviderSubscriptionUsageWindow): number =>
  Math.max(0, Math.min(100, 100 - window.usedPercent));

function usageTooltipText(kind: UsageKind, window: ServerProviderSubscriptionUsageWindow): string {
  const left = `${Math.round(remainingPercent(window))}% left`;
  const resetTime = usageResetTime(window);
  if (!resetTime) return `${WINDOW_LABELS[kind]}: ${left}`;
  return `${WINDOW_LABELS[kind]}: ${left} · resets ${resetTime}`;
}

function usageResetTime(window: ServerProviderSubscriptionUsageWindow): string | null {
  if (!window.resetsAt) return null;
  return new Date(window.resetsAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Circular remaining-quota indicator (same geometry as ContextWindowMeter)
 * with a `s`/`w` letter in the middle.
 */
function SubscriptionUsageRing(props: {
  kind: UsageKind;
  window: ServerProviderSubscriptionUsageWindow;
}) {
  const remaining = remainingPercent(props.window);
  const radius = 19;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (remaining / 100) * circumference;
  const color = usageColor(remaining);
  const resetTime = usageResetTime(props.window);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            aria-label={usageTooltipText(props.kind, props.window)}
          >
            <span className="relative inline-flex size-5.5 aspect-square items-center justify-center">
              <svg
                viewBox="0 0 48 48"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="24"
                  cy="24"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
                  strokeWidth="6"
                />
                <circle
                  cx="24"
                  cy="24"
                  r={radius}
                  fill="none"
                  stroke={color}
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">
              {WINDOW_LABELS[props.kind]} usage
            </div>
            <div className="text-[11px] tabular-nums text-muted-foreground/70">
              {Math.round(remaining)}% left
            </div>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(remaining)}
            aria-label={`${WINDOW_LABELS[props.kind]} quota remaining`}
          >
            <div
              className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
              style={{ width: `${remaining}%`, backgroundColor: color }}
            />
          </div>
          {resetTime ? (
            <div className="text-[11px] leading-4 text-muted-foreground/60">Resets {resetTime}</div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Session + weekly rings for the title bar. Renders nothing without data. */
export function SubscriptionUsageRings(props: { usage: ServerProviderUsage | null | undefined }) {
  const { usage } = props;
  if (!usage || (usage.session === null && usage.weekly === null)) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {usage.session ? <SubscriptionUsageRing kind="session" window={usage.session} /> : null}
      {usage.weekly ? <SubscriptionUsageRing kind="weekly" window={usage.weekly} /> : null}
    </span>
  );
}

function SubscriptionUsageBar(props: {
  kind: UsageKind;
  window: ServerProviderSubscriptionUsageWindow;
}) {
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
