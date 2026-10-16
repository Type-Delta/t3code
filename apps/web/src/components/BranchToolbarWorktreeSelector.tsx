import { FolderGitIcon, FolderIcon } from "lucide-react";
import { memo } from "react";

import type {
  WorktreeDisplay,
  WorktreePickerModel,
  WorktreePickerOption,
} from "./BranchToolbar.logic";
import { ComposerSelectControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ComposerContextLabel } from "./ComposerContextLabel";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

interface BranchToolbarWorktreeSelectorProps {
  model: WorktreePickerModel | null;
  locked: boolean;
  lockedDisplay: WorktreeDisplay | null;
  onWorktreeChange: (worktree: WorktreePickerOption) => void;
}

function WorktreeIcon({ isPrimary }: { isPrimary: boolean | undefined }) {
  return isPrimary ? <FolderIcon className="size-3" /> : <FolderGitIcon className="size-3" />;
}

/**
 * Pins a Current checkout draft to an existing Git worktree. Once the thread
 * exists, the choice is shown as an immutable label.
 */
export const BranchToolbarWorktreeSelector = memo(function BranchToolbarWorktreeSelector({
  model,
  locked,
  lockedDisplay,
  onWorktreeChange,
}: BranchToolbarWorktreeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const selectedWorktree = model?.options.find((worktree) => worktree.path === model.value);

  if (locked) {
    const display = lockedDisplay ?? selectedWorktree;
    if (!display) return null;
    return (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        aria-label={`Worktree: ${display.label}`}
        data-composer-context-control
      >
        <WorktreeIcon isPrimary={display.isPrimary} />
        <ComposerContextLabel>{display.label}</ComposerContextLabel>
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
      <ComposerSelectControl
        size="xs"
        className="min-w-0 shrink"
        aria-label="Worktree"
        data-composer-context-control
      >
        <WorktreeIcon isPrimary={selectedWorktree?.isPrimary} />
        <ComposerContextLabel>
          <SelectValue />
        </ComposerContextLabel>
      </ComposerSelectControl>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Worktree</SelectGroupLabel>
          {model.options.map((worktree) => (
            <SelectItem key={worktree.path} value={worktree.path}>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <WorktreeIcon isPrimary={worktree.isPrimary} />
                <span className="truncate">{worktree.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
