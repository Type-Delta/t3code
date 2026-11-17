import type { RuntimeMode } from "@t3tools/contracts";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

// Modern Codex approval replies have no feedback field, so guidance travels with the turn.
export const CODEX_FULL_ACCESS_CONTEXT = {
  t3_code_full_access: {
    kind: "application",
    value: `In Full access, T3 Code automatically declines command, file-change, and permission approval requests instead of asking a person. A tool result saying "rejected by user" for these requests can be an automatic decline, not withdrawal of the task. Do not ask the user to approve it. Read the rejection and choose a permitted recovery:
- For an unnecessary sandbox escalation, omit sandbox_permissions or use use_default and remove escalation-only options. Use permissions already granted; do not request broader permissions or change policy.
- For Codex's forced-rm check, changing to literal absolute paths alone is insufficient: -f and --force trigger the check too, including combined flags such as -rf or -fr. Inspect the exact targets first. If the authorized cleanup does not need force, use rm -r -- /absolute/directory, rm -- /absolute/file, or rmdir -- /absolute/empty-directory as appropriate. Keep targets narrow and literal; do not delete the current directory or its parents.
- For an explicit policy or access denial, respect the restriction. Do not disguise a rejected operation with reordered flags, another executable, a script, or a different execution channel. If no permitted approach works, report the concrete blocker.
Do not repeat the same rejected request. Always honor an explicit user refusal or cancellation.`,
  },
} satisfies Record<string, V2TurnStartParams__AdditionalContextEntry>;

const T3_CODE_THREAD_TOOL_INSTRUCTIONS = `

## T3 Code threads

When \`t3-code\` exposes thread tools, they create and manage durable, user-visible T3 threads. Use them for work the user should see or continue. Use native subagents for private, short-lived fan-out.
`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.browser ? T3_CODE_THREAD_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly runtimeMode?: RuntimeMode;
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  promptSuggestionInstructions?: string,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...(runtime.runtimeMode === "full-access" ? CODEX_FULL_ACCESS_CONTEXT : {}),
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(promptSuggestionInstructions
      ? {
          t3_code_suggestions: {
            kind: "application" as const,
            value: promptSuggestionInstructions,
          },
        }
      : {}),
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
