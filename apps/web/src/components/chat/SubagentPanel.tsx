import {
  MessageId,
  type EnvironmentId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import type { LegendListRef } from "@legendapp/list/react";
import { Bot } from "lucide-react";
import { useMemo, useRef } from "react";

import {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  type SubagentPanelRunSummary,
} from "../../session-logic";
import type { ChatMessage, TurnDiffSummary } from "../../types";
import { cn } from "~/lib/utils";

import { MessagesTimeline } from "./MessagesTimeline";

interface SubagentPanelProps {
  run: SubagentPanelRunSummary;
  messages: ReadonlyArray<OrchestrationMessage>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  environmentId: EnvironmentId;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  onOpenSubagent: (runIds: ReadonlyArray<string>) => void;
}

const EMPTY_TURN_DIFF_SUMMARIES = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();
const doNothing = () => {};

export function subagentPanelStatusLabel(status: SubagentPanelRunSummary["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "inProgress":
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "stopped":
      return "Stopped";
  }
}

export function subagentPanelIsWorking(status: SubagentPanelRunSummary["status"]): boolean {
  return status === "inProgress" || status === "running";
}

export function SubagentPanel(props: SubagentPanelProps) {
  const listRef = useRef<LegendListRef>(null);
  const timelineEntries = useMemo(() => {
    const messages = props.messages.filter(
      (message): message is ChatMessage => message.subagentId === props.run.id,
    );
    const activities = props.activities.filter((activity) => {
      if (activity.subagentId === props.run.id) return true;
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      return payload?.agentId === props.run.id;
    });
    const prompt: ChatMessage | null = props.run.prompt
      ? {
          id: MessageId.make(`subagent-prompt:${props.run.id}`),
          role: "user",
          text: props.run.prompt,
          turnId: null,
          streaming: false,
          createdAt: props.run.createdAt,
          updatedAt: props.run.createdAt,
        }
      : null;
    return deriveTimelineEntries(
      prompt ? [prompt, ...messages] : messages,
      [],
      deriveWorkLogEntries(activities, { includeAgentInternal: true }),
    );
  }, [props.activities, props.messages, props.run]);

  const isWorking = subagentPanelIsWorking(props.run.status);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
        <Bot className="size-3.5" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-foreground/85">{props.run.title}</span>
        <span
          className={cn(
            "size-1.5 rounded-full",
            props.run.status === "completed"
              ? "bg-success"
              : props.run.status === "failed"
                ? "bg-destructive"
                : "bg-muted-foreground/50",
          )}
          aria-hidden
        />
        <span>{subagentPanelStatusLabel(props.run.status)}</span>
      </div>
      <MessagesTimeline
        isWorking={isWorking}
        activeTurnInProgress={isWorking}
        activeTurnStartedAt={props.run.createdAt}
        listRef={listRef}
        timelineEntries={timelineEntries}
        latestTurn={null}
        runningTurnId={null}
        turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFF_SUMMARIES}
        routeThreadKey={props.routeThreadKey}
        onOpenTurnDiff={doNothing}
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        onRevertUserMessage={doNothing}
        isRevertingCheckpoint={false}
        onImageExpand={doNothing}
        activeThreadEnvironmentId={props.environmentId}
        markdownCwd={props.markdownCwd}
        resolvedTheme={props.resolvedTheme}
        timestampFormat={props.timestampFormat}
        workspaceRoot={props.workspaceRoot}
        anchorMessageId={null}
        onAnchorReady={doNothing}
        contentInsetEndAdjustment={0}
        liveFollowEnabled={isWorking}
        onIsAtEndChange={doNothing}
        onManualNavigation={doNothing}
        onOpenSubagent={props.onOpenSubagent}
        emptyState={{ machineName: "Subagent" }}
        hideEmptyPlaceholder
      />
    </div>
  );
}
