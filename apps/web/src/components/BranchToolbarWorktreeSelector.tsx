import { FolderGitIcon, FolderIcon } from "lucide-react";
import { memo } from "react";

import type {
  WorktreeDisplay,
  WorktreePickerModel,
  WorktreePickerOption,
} from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { cn } from "../lib/utils";

interface BranchToolbarWorktreeSelectorProps {
  className?: string;
  model: WorktreePickerModel | null;
  locked: boolean;
  lockedDisplay: WorktreeDisplay | null;
  onWorktreeChange: (worktree: WorktreePickerOption) => void;
}

export const BranchToolbarWorktreeSelector = memo(function BranchToolbarWorktreeSelector({
  className,
  model,
  locked,
  lockedDisplay,
  onWorktreeChange,
}: BranchToolbarWorktreeSelectorProps) {
  const selectedWorktree = model?.options.find((worktree) => worktree.path === model.value);

  if (locked) {
    const display = lockedDisplay ?? selectedWorktree;
    if (!display) return null;
    return (
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs",
          className,
        )}
      >
        {display.isPrimary ? (
          <FolderIcon className="size-3 shrink-0" />
        ) : (
          <FolderGitIcon className="size-3 shrink-0" />
        )}
        <span className="truncate">{display.label}</span>
      </span>
    );
  }

  if (!model) return null;

  return (
    <Select
      modal={false}
      value={model.value}
      onValueChange={(value: string | null) => {
        const worktree = model.options.find((option) => option.path === value);
        if (worktree) onWorktreeChange(worktree);
      }}
      items={model.options.map((worktree) => ({ value: worktree.path, label: worktree.label }))}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className={cn("min-w-0 font-medium", className)}
        aria-label="Worktree"
      >
        {selectedWorktree?.isPrimary ? (
          <FolderIcon className="size-3 shrink-0" />
        ) : (
          <FolderGitIcon className="size-3 shrink-0" />
        )}
        <SelectValue>{selectedWorktree?.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Worktree</SelectGroupLabel>
          {model.options.map((worktree) => (
            <SelectItem key={worktree.path} value={worktree.path}>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {worktree.isPrimary ? (
                  <FolderIcon className="size-3 shrink-0" />
                ) : (
                  <FolderGitIcon className="size-3 shrink-0" />
                )}
                <span className="truncate">{worktree.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
