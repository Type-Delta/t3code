import { BotIcon, ChevronDownIcon } from "lucide-react";

import type { SubagentRunSummary } from "../../session-logic";
import { resolveSubagentAggregateStatus } from "../BranchToolbar.logic";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useComposerMenuProps } from "./composerEventScope";
import { composerSubagentLabel } from "./composerSubagentUtils";
import { useComposerMenuState } from "./useComposerMenuState";

interface ComposerSubagentsProps {
  runs: ReadonlyArray<SubagentRunSummary>;
  onOpen: (runIds: ReadonlyArray<string>) => void;
  visible: boolean;
}

const statusLabel = {
  inProgress: "Working",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
} as const satisfies Record<SubagentRunSummary["status"], string>;

const iconClass = {
  inProgress:
    "animate-sidebar-working-text text-sky-600 motion-reduce:animate-none dark:text-sky-400",
  completed: "text-muted-foreground",
  failed: "text-red-600 dark:text-red-400",
  stopped: "text-muted-foreground",
} as const satisfies Record<SubagentRunSummary["status"], string>;

const triggerClass = {
  complete: "text-muted-foreground hover:text-foreground",
  working:
    "animate-sidebar-working-text text-sky-600 motion-reduce:animate-none hover:text-sky-500 dark:text-sky-400 dark:hover:text-sky-300",
  errorWorking:
    "animate-sidebar-working-text text-red-600 motion-reduce:animate-none hover:text-red-500 dark:text-red-400 dark:hover:text-red-300",
  error: "text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300",
} as const;

function runLabel(run: SubagentRunSummary): string {
  if (run.title !== run.model) return run.title;
  return run.prompt.trim().split(/\r?\n/u, 1)[0] || "Subagent";
}

function runMetadata(run: SubagentRunSummary): string {
  const values = [run.model, run.reasoningEffort ? `${run.reasoningEffort} effort` : null].filter(
    (value): value is string => Boolean(value),
  );
  return values.length > 0 ? values.join(" · ") : "Model and effort unavailable";
}

export function ComposerSubagents({ runs, onOpen, visible }: ComposerSubagentsProps) {
  const menuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(!visible);
  if (runs.length === 0) return null;

  const aggregateStatus = resolveSubagentAggregateStatus(runs.map((run) => run.status));
  const aggregateStatusLabel =
    aggregateStatus === "complete"
      ? "completed"
      : aggregateStatus === "working"
        ? "working"
        : aggregateStatus === "errorWorking"
          ? "errors, with work still running"
          : "errors";

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className={`min-w-0 shrink-0 justify-start ${triggerClass[aggregateStatus]}`}
        data-composer-context-control
        aria-label={`${runs.length} ${runs.length === 1 ? "subagent" : "subagents"}, ${aggregateStatusLabel}`}
      >
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
      <MenuPopup align="center" side="top" className="w-80 max-w-[calc(100vw-2rem)]" {...menuProps}>
        <MenuGroup>
          <MenuGroupLabel>Subagents</MenuGroupLabel>
          {runs.map((run) => (
            <MenuItem key={run.id} className="h-auto min-w-0 py-2" onClick={() => onOpen([run.id])}>
              <BotIcon className={`size-3.5 shrink-0 ${iconClass[run.status]}`} aria-hidden />
              <span className="sr-only">{statusLabel[run.status]}</span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate font-medium text-foreground">{runLabel(run)}</span>
                <span className="truncate text-xs text-muted-foreground">{runMetadata(run)}</span>
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
