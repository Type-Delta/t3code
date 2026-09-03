import { memo } from "react";
import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { MAX_QUEUED_PROMPTS, type QueuedPrompt } from "../../promptQueueStore";

interface PromptQueueListProps {
  queue: ReadonlyArray<QueuedPrompt>;
  onRemove: (id: string) => void;
  className?: string;
}

/**
 * Compact list of prompts waiting to run after the current turn. Each entry
 * fires as its own fresh turn once the thread goes idle; removing one drops it
 * before it runs. Renders nothing when the queue is empty.
 */
export const PromptQueueList = memo(function PromptQueueList({
  queue,
  onRemove,
  className,
}: PromptQueueListProps) {
  if (queue.length === 0) {
    return null;
  }
  return (
    <div
      className={cn("flex flex-col gap-1 px-2 pb-1.5 pt-0.5", className)}
      data-testid="prompt-queue-list"
    >
      <div className="flex items-center justify-between px-0.5 text-[11px] font-medium text-muted-foreground">
        <span>Queued to run next</span>
        <span className="tabular-nums">
          {queue.length}/{MAX_QUEUED_PROMPTS}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {queue.map((entry, index) => (
          <li
            key={entry.id}
            className="group flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs"
          >
            <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate">{entry.text}</span>
            <button
              type="button"
              onClick={() => onRemove(entry.id)}
              aria-label="Remove queued prompt"
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-70 transition-colors hover:bg-background hover:text-foreground group-hover:opacity-100"
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});
