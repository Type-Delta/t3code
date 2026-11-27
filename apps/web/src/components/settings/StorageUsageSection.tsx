import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { RefreshCwIcon } from "lucide-react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SettingsSection } from "./settingsLayout";
import {
  STORAGE_USAGE_CATEGORIES,
  storageUsageParts,
  storageUsageSegments,
  storageUsageSummary,
} from "./StorageUsageSection.logic";

/** Measured on mount and on Refresh only, since walking worktrees can take seconds. */
export function StorageUsageSection({
  environments,
}: {
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}) {
  const gt = useGT();
  if (environments.length === 0) return null;
  return (
    <SettingsSection id="storage-usage" title={gt("Storage usage")}>
      {environments.map((environment) => (
        <EnvironmentStorageUsage
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environments.length > 1 ? environment.label : null}
        />
      ))}
    </SettingsSection>
  );
}

function EnvironmentStorageUsage({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const query = useEnvironmentQuery(serverEnvironment.storageUsage({ environmentId, input: {} }));
  const usage = query.data;
  const title =
    usage !== null
      ? label === null
        ? gt("T3 Code is using {size}", { size: formatBytes(usage.totalBytes) })
        : gt("T3 Code is using {size} on {label}", { size: formatBytes(usage.totalBytes), label })
      : query.error !== null
        ? label === null
          ? gt("Couldn't measure storage")
          : gt("Couldn't measure storage on {label}", { label })
        : label === null
          ? gt("Measuring storage…")
          : gt("Measuring storage on {label}…", { label });
  const segments = usage === null ? [] : storageUsageSegments(usage);
  const freePercent = 100 - segments.reduce((sum, segment) => sum + segment.percent, 0);

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4" aria-busy={query.isPending}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-h-6 min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {usage?.diskFreeBytes != null ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {usage.diskTotalBytes === null ? (
                <T>
                  <Var>{formatBytes(usage.diskFreeBytes)}</Var> free on disk
                </T>
              ) : (
                <T>
                  <Var>{formatBytes(usage.diskFreeBytes)}</Var> free of{" "}
                  <Var>{formatBytes(usage.diskTotalBytes)}</Var>
                </T>
              )}
            </span>
          ) : null}
        </div>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={gt("Measure storage again")}
          disabled={query.isPending}
          onClick={query.refresh}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>
      <div
        role="img"
        aria-label={usage === null ? title : storageUsageSummary(usage, messages)}
        className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-foreground/8"
      >
        {segments.map((segment) => (
          <div
            key={segment.id}
            className={cn("basis-0", STORAGE_USAGE_CATEGORIES[segment.id].swatchClassName)}
            style={{ flexGrow: segment.percent }}
          />
        ))}
        {freePercent > 0 ? <div className="basis-0" style={{ flexGrow: freePercent }} /> : null}
      </div>
      {usage !== null ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
          {storageUsageParts(usage).map((category) => {
            const meta = STORAGE_USAGE_CATEGORIES[category.id];
            return (
              <li key={category.id}>
                <Popover>
                  <PopoverTrigger
                    openOnHover
                    render={
                      <button
                        type="button"
                        className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      />
                    }
                  >
                    <span
                      aria-hidden
                      className={cn("size-2 shrink-0 rounded-full", meta.swatchClassName)}
                    />
                    {messages(meta.label)}
                  </PopoverTrigger>
                  <PopoverPopup tooltipStyle side="bottom" aria-label={messages(meta.label)}>
                    <p className="font-medium tabular-nums">
                      {messages(meta.label)} · {formatBytes(category.bytes)}
                    </p>
                    <p className="text-muted-foreground">{messages(meta.hint)}</p>
                  </PopoverPopup>
                </Popover>
              </li>
            );
          })}
        </ul>
      ) : null}
      {query.error !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted-foreground">{query.error}</p>
          <Button variant="outline" size="xs" disabled={query.isPending} onClick={query.refresh}>
            <T>Retry</T>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
