import { Bot, ChevronDownIcon } from "lucide-react";

import type { SubagentRunSummary } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useComposerMenuProps } from "./composerEventScope";
import { composerSubagentLabel, composerSubagentStatus } from "./composerSubagentUtils";
import { useComposerMenuState } from "./useComposerMenuState";
import { subagentPanelStatusLabel } from "./SubagentPanel";

interface ComposerSubagentsProps {
  runs: ReadonlyArray<SubagentRunSummary>;
  onOpen: (runIds: ReadonlyArray<string>) => void;
  visible: boolean;
}

export function ComposerSubagents({ runs, onOpen, visible }: ComposerSubagentsProps) {
  const menuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(!visible);
  if (runs.length === 0) return null;

  const status = composerSubagentStatus(runs);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className="min-w-0 shrink-0 gap-1 font-normal text-muted-foreground/70 text-xs! hover:text-foreground/80"
        data-composer-context-control
        aria-label={`${runs.length} subagents, ${status}`}
      >
        <Bot
          className={cn(
            "size-3.5 shrink-0",
            status === "working"
              ? "text-foreground"
              : status === "failed"
                ? "text-destructive"
                : "text-success",
          )}
          aria-hidden
        />
        <span
          data-composer-label
          className="relative min-w-0 max-w-[5.5rem] group-data-[compact]/composer-context:max-w-7"
        >
          <span
            data-composer-label-motion
            className="block w-full truncate transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
          >
            {composerSubagentLabel(runs.length)}
          </span>
          <span
            aria-hidden
            className="absolute inset-0 flex items-center whitespace-nowrap opacity-0 group-data-[compact]/composer-context:opacity-100"
          >
            {composerSubagentLabel(runs.length, true)}
          </span>
        </span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="end" side="top" className="w-64" {...menuProps}>
        {runs.map((run) => (
          <MenuItem
            key={run.id}
            onClick={() => onOpen([run.id])}
            aria-label={`Open ${run.title} transcript (${subagentPanelStatusLabel(run.status)})`}
          >
            <Bot
              className={cn(
                "size-4 shrink-0",
                run.status === "inProgress"
                  ? "text-foreground"
                  : run.status === "failed"
                    ? "text-destructive"
                    : run.status === "completed"
                      ? "text-success"
                      : "text-muted-foreground",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{run.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {subagentPanelStatusLabel(run.status)}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
