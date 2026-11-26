import {
  type EnvironmentId,
  isDelegatedAppThread,
  type OrchestrationV2Run,
  type RunId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { Thread } from "../../types";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import type { PromptSuggestionCandidate } from "../../promptSuggestion.logic";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { announcedRun } from "@t3tools/client-runtime/state/thread-activity-announcement";

// Dismissed suggestions, keyed by environment and run, shared by every mounted composer and kept
// across remounts. Run ids derive from thread ids, which can repeat across environments.
let dismissedKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readDismissed = () => dismissedKeys;
const dismissKey = (environmentId: EnvironmentId, runId: RunId) => `${environmentId}\u0000${runId}`;

/**
 * The suggestion while the run that produced it is the thread's latest completed run. A message
 * promoted to Steer leaves its queued run cancelled before it started, still the latest run, so
 * the comparison skips to the last run that ran. Detail can lag the shell, so it skips only once
 * the runs include that cancelled run.
 */
export function offeredPromptSuggestion<Suggestion extends { readonly runId: RunId }>(
  suggestion: Suggestion | null | undefined,
  latestRun: Thread["latestRun"] | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
): Suggestion | null {
  const run = announcedRun(latestRun ?? null, runs);
  const skippedUnseenRun =
    latestRun != null &&
    run?.runId !== latestRun.runId &&
    !runs.some(
      (candidate) =>
        candidate.id === latestRun.runId &&
        candidate.status === "cancelled" &&
        candidate.startedAt === null,
    );
  return suggestion &&
    !skippedUnseenRun &&
    run?.runId === suggestion.runId &&
    run.status === "completed"
    ? suggestion
    : null;
}

/**
 * The suggestion to insert when Tab or the hint accepts it. The hint unmounts a render after
 * typing starts, so a late accept must not prepend the suggestion to a draft that has text.
 */
export function promptSuggestionToAccept(suggestion: string | null, draft: string): string | null {
  return draft.length === 0 ? suggestion : null;
}

/**
 * The agent's predicted next prompt while the run that produced it is the thread's latest
 * completed run and Escape has not dismissed it. Claude's native prediction arrives over an
 * unpersisted subscription; the reply's tagged suggestion is the durable fallback, so older
 * servers, Codex, and reloads still offer one. Threads another agent drives never show one.
 */
export function usePromptSuggestion(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: Thread | undefined;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly tagged: PromptSuggestionCandidate | null;
  /** The thread runs on Claude, the only provider with native suggestions. */
  readonly claudeThread: boolean;
}): { readonly suggestion: string | null; readonly dismiss: () => void } {
  const { environmentId, thread, runs } = input;
  const settings = useClientSettings((clientSettings) => ({
    enabled: clientSettings.enablePromptSuggestion,
    claudeNative: clientSettings.claudeNativePromptSuggestions,
  }));
  const nativeSupported =
    useServerConfigs().get(environmentId)?.environment.capabilities.promptSuggestions === true;
  // Suggestions target keyboard and mouse setups, so skip devices with no mouse or trackpad at all.
  const hasFinePointer = useMediaQuery("(any-pointer: fine)");
  const enabled =
    settings.enabled &&
    hasFinePointer &&
    thread !== undefined &&
    !isDelegatedAppThread({
      lineage: thread.lineage,
      delegatedFrom: thread.delegatedFrom ?? undefined,
    });
  const native = enabled && settings.claudeNative && input.claudeThread && nativeSupported;
  const { data } = useEnvironmentQuery(
    // A local draft has no run, and so no suggestion, until its first send.
    native && thread?.latestRun
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed);
  const offered = enabled
    ? (offeredPromptSuggestion(native ? data : null, thread?.latestRun, runs) ??
      offeredPromptSuggestion(input.tagged, thread?.latestRun, runs))
    : null;
  return {
    suggestion:
      offered && !dismissed.has(dismissKey(environmentId, offered.runId)) ? offered.text : null,
    dismiss: () => {
      if (offered === null) return;
      dismissedKeys = new Set(dismissedKeys).add(dismissKey(environmentId, offered.runId));
      for (const listener of listeners) listener();
    },
  };
}
