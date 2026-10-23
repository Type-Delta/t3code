import type { AutoRetryConditionNode, AutoRetrySettings } from "@t3tools/contracts";

export interface AutoRetryMatchContext {
  readonly errorMessage: string;
  readonly backend: string;
  readonly model: string;
}

function includesInsensitive(haystack: string, needle: string): boolean {
  const value = needle.trim();
  return value.length > 0 && haystack.toLocaleLowerCase().includes(value.toLocaleLowerCase());
}

export function matchesAutoRetryCondition(
  condition: AutoRetryConditionNode,
  context: AutoRetryMatchContext,
): boolean {
  if (condition.kind === "error_message")
    return includesInsensitive(context.errorMessage, condition.value);
  if (condition.kind === "backend")
    return context.backend.toLocaleLowerCase() === condition.value.trim().toLocaleLowerCase();
  if (condition.kind === "model") return includesInsensitive(context.model, condition.value);
  if (condition.kind === "not") return !matchesAutoRetryCondition(condition.child, context);
  if (condition.kind === "and" && "children" in condition) {
    return (
      condition.children.length > 0 &&
      condition.children.every((child) => matchesAutoRetryCondition(child, context))
    );
  }
  if (condition.kind === "or" && "children" in condition) {
    return (
      condition.children.length > 0 &&
      condition.children.some((child) => matchesAutoRetryCondition(child, context))
    );
  }
  return false;
}

export function matchingAutoRetryTrigger(
  settings: AutoRetrySettings,
  context: AutoRetryMatchContext,
) {
  if (!settings.enabled) return null;
  return (
    settings.triggers.find(
      (trigger) =>
        trigger.enabled &&
        trigger.message.trim().length > 0 &&
        matchesAutoRetryCondition(trigger.condition, context),
    ) ?? null
  );
}

export const AUTO_RETRY_FAILURE_WINDOW_MS = 60_000;
export const AUTO_RETRY_MAX_FAILURES_IN_WINDOW = 3;
export const AUTO_RETRY_DISABLE_MS = 10 * 60_000;

export interface AutoRetryFailureGuardState {
  readonly failuresAt: ReadonlyArray<number>;
  readonly disabledUntil: number | null;
}

export function recordAutoRetryFailure(
  state: AutoRetryFailureGuardState,
  now: number,
): AutoRetryFailureGuardState {
  if (state.disabledUntil !== null && state.disabledUntil > now) return state;
  const failuresAt = [
    ...state.failuresAt.filter((timestamp) => now - timestamp < AUTO_RETRY_FAILURE_WINDOW_MS),
    now,
  ];
  return failuresAt.length >= AUTO_RETRY_MAX_FAILURES_IN_WINDOW
    ? { failuresAt, disabledUntil: now + AUTO_RETRY_DISABLE_MS }
    : { failuresAt, disabledUntil: null };
}
