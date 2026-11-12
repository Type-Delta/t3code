import type { PromptSuggestionPreference, RunId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";

/** A predicted next prompt and the run that produced it. */
export interface PromptSuggestionCandidate {
  readonly runId: RunId;
  readonly text: string;
}

/**
 * The suggestion an agent tagged at the end of the thread's last message, if that message is a
 * settled assistant reply. The structure drops assistant text but keeps its suggestion, so this
 * survives reloads and servers without native suggestions.
 */
export function findTaggedPromptSuggestion(
  rows: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): PromptSuggestionCandidate | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index]!.item;
    if (item.type === "user_message") return null;
    if (item.type !== "assistant_message") continue;
    const text = item.suggestion?.trim();
    return !item.streaming && item.runId !== null && text ? { runId: item.runId, text } : null;
  }
  return null;
}

/** What a human-sent turn asks the agent for; the server applies it from that turn on. */
export function promptSuggestionPreference(
  settings: Pick<
    ClientSettings,
    "enablePromptSuggestion" | "claudeNativePromptSuggestions" | "promptSuggestionInstructions"
  >,
): PromptSuggestionPreference {
  return {
    enabled: settings.enablePromptSuggestion,
    claudeNative: settings.claudeNativePromptSuggestions,
    ...(settings.promptSuggestionInstructions.length > 0
      ? { instructions: settings.promptSuggestionInstructions }
      : {}),
  };
}
