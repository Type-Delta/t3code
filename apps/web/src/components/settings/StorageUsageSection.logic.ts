import type { StorageUsage, StorageUsageCategoryId } from "@t3tools/contracts";

import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { formatBytes } from "../../lib/formatBytes";

/** Share of the bar, in percent, that a tiny non-zero part still gets so it stays visible. */
export const MIN_SEGMENT_PERCENT = 1.5;

type StoragePartId = StorageUsageCategoryId | "elsewhere";

export const STORAGE_USAGE_CATEGORIES: Record<
  StoragePartId,
  { readonly label: string; readonly hint: string; readonly swatchClassName: string }
> = {
  database: {
    label: msg("Database"),
    hint: msg("Threads, messages, and history"),
    swatchClassName: "bg-blue-500",
  },
  worktrees: {
    label: msg("Worktrees"),
    hint: msg("Checkouts T3 Code created"),
    swatchClassName: "bg-violet-500",
  },
  checkpoints: {
    label: msg("Git snapshots"),
    hint: msg("Turn checkpoints for diffs and undo"),
    swatchClassName: "bg-amber-500",
  },
  logs: {
    label: msg("Logs"),
    hint: msg("Server, provider, and terminal logs"),
    swatchClassName: "bg-teal-500",
  },
  attachments: {
    label: msg("Attachments"),
    hint: msg("Images and files you attached"),
    swatchClassName: "bg-rose-500",
  },
  other: {
    label: msg("Other"),
    hint: msg("Caches, browser captures, and settings"),
    swatchClassName: "bg-lime-500",
  },
  elsewhere: {
    label: msg("Everything else"),
    hint: msg("System files and other apps on this disk"),
    swatchClassName: "bg-zinc-400 dark:bg-zinc-500",
  },
};

/** T3 Code's categories, then the disk's other used space when the disk size is known. */
export function storageUsageParts(usage: StorageUsage) {
  const parts: Array<{ id: StoragePartId; bytes: number }> = [...usage.categories];
  if (usage.diskTotalBytes !== null && usage.diskFreeBytes !== null) {
    const elsewhere = usage.diskTotalBytes - usage.diskFreeBytes - usage.totalBytes;
    if (elsewhere > 0) parts.push({ id: "elsewhere", bytes: elsewhere });
  }
  return parts;
}

/** Bar segments as percent of the disk (or of T3 Code's total if the disk size is unknown); the rest is free. */
export function storageUsageSegments(usage: StorageUsage) {
  const capacity = usage.diskTotalBytes ?? usage.totalBytes;
  if (capacity <= 0) return [];
  const filled = storageUsageParts(usage).filter((part) => part.bytes > 0);
  const percents = filled.map((part) =>
    Math.max(MIN_SEGMENT_PERCENT, (part.bytes / capacity) * 100),
  );
  const scale = Math.min(1, 100 / percents.reduce((sum, percent) => sum + percent, 0));
  return filled.map((part, index) => ({ id: part.id, percent: (percents[index] ?? 0) * scale }));
}

export function storageUsageSummary(usage: StorageUsage, resolve: MessageResolver = m): string {
  const total = formatBytes(usage.totalBytes);
  const parts = usage.categories
    .filter((category) => category.bytes > 0)
    .map(
      (category) =>
        `${resolve(STORAGE_USAGE_CATEGORIES[category.id].label)} ${formatBytes(category.bytes)}`,
    )
    .join(", ");
  if (usage.diskFreeBytes === null) {
    return parts
      ? resolve(msg("T3 Code uses {total}: {parts}", { total, parts }))
      : resolve(msg("T3 Code uses {total}", { total }));
  }
  const free = formatBytes(usage.diskFreeBytes);
  return parts
    ? resolve(msg("T3 Code uses {total}: {parts}. {free} free on disk", { total, parts, free }))
    : resolve(msg("T3 Code uses {total}. {free} free on disk", { total, free }));
}
