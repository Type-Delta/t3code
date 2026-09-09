import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  formatDesktopLocalUpdateProgress,
  useDesktopLocalUpdateState,
} from "../../state/desktopLocalUpdate";
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
  const localUpdateState = useDesktopLocalUpdateState();
  const [isStarting, setIsStarting] = useState(false);
  const previousLocalUpdateStatus = useRef(localUpdateState?.status);
  const isUpdateRunning = isStarting || localUpdateState?.status === "running";

  useEffect(() => {
    const previousStatus = previousLocalUpdateStatus.current;
    previousLocalUpdateStatus.current = localUpdateState?.status;
    if (previousStatus === "running" && localUpdateState?.status === "completed") {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Local update completed",
          description: "The installer was opened. Continue with its setup steps.",
        }),
      );
    }
    if (previousStatus === "running" && localUpdateState?.status === "up-to-date") {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Already up to date",
          description: "This installation matches the latest Type-Delta commit.",
        }),
      );
    }
    if (previousStatus === "running" && localUpdateState?.status === "error") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not complete local update",
          description: localUpdateState.message ?? "An unexpected error occurred.",
        }),
      );
    }
  }, [localUpdateState]);

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || isUpdateRunning) return;

    setIsStarting(true);
    try {
      await bridge.startLocalUpdate();
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
  }, [isUpdateRunning]);

  const tooltip = isUpdateRunning
    ? formatDesktopLocalUpdateProgress(localUpdateState)
    : localUpdateState?.status === "up-to-date"
      ? "Up to date. Click to check again"
      : "Check and update Type-Delta";

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={isUpdateRunning || undefined}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2",
                isUpdateRunning
                  ? "cursor-not-allowed text-[var(--sidebar-icon-color)] opacity-60"
                  : "cursor-pointer text-[var(--sidebar-icon-color)] hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
              onClick={() => void handleAction()}
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
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
