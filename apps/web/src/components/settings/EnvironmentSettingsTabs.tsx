import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, LaptopIcon, MonitorIcon, TerminalIcon } from "lucide-react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { providerSettingsTabClassName } from "./providerSettingsTabs";

function environmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "RelayConnectionTarget") return CloudIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

function environmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

export function EnvironmentSettingsTabs({
  environments,
  selectedEnvironmentId,
  onSelect,
  disabled = false,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onSelect: (environmentId: EnvironmentId) => void;
  readonly disabled?: boolean;
}) {
  const onlyPrimaryDevice =
    environments.length === 1 && environments[0]?.entry.target._tag === "PrimaryConnectionTarget";
  if (onlyPrimaryDevice || environments.length === 0) return null;

  return (
    <ScrollArea hideScrollbars scrollFade className="mx-3 h-11 min-w-0 rounded-none sm:mx-4">
      <div
        role="group"
        aria-label="Devices"
        className="flex h-full w-max min-w-full border-b border-border/70 px-1"
      >
        {environments.map((environment) => {
          const Icon = environmentIcon(environment);
          const selected = environment.environmentId === selectedEnvironmentId;
          const detail = environmentDetail(environment);
          const statusText = connectionStatusText(environment.connection);
          return (
            <Tooltip key={environment.environmentId}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={selected}
                    className={cn(providerSettingsTabClassName(selected), "gap-2 text-left")}
                    disabled={disabled}
                    onClick={() => onSelect(environment.environmentId)}
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="max-w-40 truncate">{environment.label}</span>
                    {environment.connection.phase !== "connected" ? (
                      <ConnectionStatusDot
                        dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                        pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                      />
                    ) : null}
                    <span className="sr-only">
                      {detail}, {statusText}
                    </span>
                  </button>
                }
              />
              <TooltipPopup side="top">
                {detail} · {statusText}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </ScrollArea>
  );
}
