import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";

import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
    <ScrollArea hideScrollbars scrollFade className="mx-3 h-11 min-w-0 flex-1 rounded-none sm:mx-4">
      <ToggleGroup
        aria-label="Devices"
        variant="segmented"
        className="my-2"
        value={selectedEnvironmentId ? [selectedEnvironmentId] : []}
        disabled={disabled}
        onValueChange={(next) => {
          const environment = environments.find((entry) => entry.environmentId === next[0]);
          if (environment) onSelect(environment.environmentId);
        }}
      >
        {environments.map((environment) => {
          const detail = environmentDetail(environment);
          const statusText = connectionStatusTitle(environment.connection);
          return (
            <Tooltip key={environment.environmentId}>
              <TooltipTrigger
                render={
                  <Toggle value={environment.environmentId} className="gap-2 text-left">
                    <EnvironmentMachineIcon
                      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                      className="size-3.5 shrink-0"
                      aria-hidden
                    />
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
                  </Toggle>
                }
              />
              <TooltipPopup side="top">
                {detail} · {statusText}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </ScrollArea>
  );
}
