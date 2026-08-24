import type { OrchestrationCheckpointNavigationState } from "@t3tools/contracts";

import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export type ComposerTriggerKind = "path" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default" | "undo" | "redo";
export type CheckpointNavigationCommand = "undo" | "redo" | "jump";

export function checkpointNavigationConfirmationMessage(input: {
  command: CheckpointNavigationCommand;
  capability: OrchestrationCheckpointNavigationState["capability"];
  turnCount?: number;
}): string | null {
  if (input.command === "redo") {
    return null;
  }
  if (input.capability !== "branching") {
    const target =
      input.command === "jump"
        ? `checkpoint ${input.turnCount ?? "selected"}`
        : "the previous checkpoint";
    return [
      `Restore workspace files from ${target}?`,
      "Only workspace files will be restored. Chat history will NOT be reverted.",
      "The provider may still remember the later conversation and changes.",
    ].join("\n");
  }
  if (input.command === "jump") {
    return [
      `Revert this thread to checkpoint ${input.turnCount}?`,
      "Newer messages and turn diffs will be hidden until you redo them.",
    ].join("\n");
  }
  return null;
}

export function resolveCheckpointNavigationDisabledReason(input: {
  command: CheckpointNavigationCommand;
  threadCreated: boolean;
  reconnectLabel: string | null;
  busy: boolean;
  locallyNavigating: boolean;
  navigation: OrchestrationCheckpointNavigationState | undefined;
}): string | null {
  if (!input.threadCreated) {
    return "Checkpoint navigation is available after the thread is created.";
  }
  if (input.reconnectLabel !== null) {
    return `Reconnect ${input.reconnectLabel} before using /${input.command}.`;
  }
  if (input.navigation?.isNavigating || input.locallyNavigating) {
    return "Checkpoint navigation is already in progress.";
  }
  if (input.busy) {
    return "Interrupt the current turn before navigating checkpoints.";
  }
  if (!input.navigation) {
    return "Checkpoint navigation availability has not loaded yet.";
  }
  if (input.navigation.latestCheckpointBlockingStatus === "pending") {
    return "The latest checkpoint is still pending.";
  }
  if (input.navigation.latestCheckpointBlockingStatus === "contended") {
    return "The latest checkpoint could not be captured because the workspace changed.";
  }
  if (input.command === "redo" && input.navigation.capability !== "branching") {
    return "This provider cannot preserve conversation branches for redo.";
  }
  if (
    input.command !== "jump" &&
    !(input.command === "undo" ? input.navigation.canUndo : input.navigation.canRedo)
  ) {
    return `No ready checkpoint is available to ${input.command}.`;
  }
  return null;
}
export type ComposerSubmissionIntent = "foreground" | "background";

export function shouldSubmitComposerOnEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
}): boolean {
  return !input.isMobileViewport && !input.shiftKey;
}

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function composerSubmissionIntentForEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
  modifierKey: boolean;
  isDraftThread: boolean;
}): ComposerSubmissionIntent | null {
  if (input.isMobileViewport || input.shiftKey) {
    return null;
  }
  return input.modifierKey && input.isDraftThread ? "background" : "foreground";
}

const isInlineTokenSegment = (
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\t" ||
    char === "\r" ||
    char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER
  );
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return expandedCursor + remaining;
      }
      remaining -= 1;
      expandedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" }
  >,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return collapsedCursor + remaining;
      }
      remaining -= 1;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export const isCollapsedCursorAdjacentToMention = isCollapsedCursorAdjacentToInlineToken;

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model"> | null {
  const match = /^\/(plan|default|undo|redo)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  if (command === "default") return "default";
  if (command === "undo") return "undo";
  return "redo";
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
