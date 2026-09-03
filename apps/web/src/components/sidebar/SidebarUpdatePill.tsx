import { RefreshCwIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarUpdateArchitectureWarning() {
  return null;
}

export function SidebarUpdatePill() {
  return isElectron ? <SidebarUpdateControl /> : null;
}

function SidebarUpdateControl() {
  const [isStarting, setIsStarting] = useState(false);

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || isStarting) return;

    const sourceDirectory = await ensureLocalApi().dialogs.pickFolder();
    if (sourceDirectory === null) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "This fetches and merges the selected local T3 Code checkout, then runs checks and creates an installer. It never pushes changes. Continue?",
    );
    if (!confirmed) return;

    setIsStarting(true);
    try {
      await bridge.startLocalUpdate(sourceDirectory);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Local update completed",
          description: "The installer was opened. Continue with its setup steps.",
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start local update",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    } finally {
      setIsStarting(false);
    }
  }, [isStarting]);

  const tooltip = isStarting ? "Starting local update…" : "Update local T3 Code";

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={isStarting || undefined}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2",
                isStarting
                  ? "cursor-not-allowed text-[var(--sidebar-icon-color)] opacity-60"
                  : "cursor-pointer text-[var(--sidebar-icon-color)] hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
              onClick={() => void handleAction()}
            >
              <RefreshCwIcon
                aria-hidden="true"
                className={cn("size-4", isStarting && "animate-spin")}
              />
            </button>
          }
        />
        <TooltipPopup align="center" side="top">
          {tooltip}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
