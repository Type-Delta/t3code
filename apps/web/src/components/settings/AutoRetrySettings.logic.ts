import { randomUUID } from "~/lib/utils";

export type AutoRetryPredicateKind = "error_message" | "backend" | "model";
export type AutoRetryCondition =
  | { readonly kind: AutoRetryPredicateKind; readonly value: string }
  | { readonly kind: "and" | "or"; readonly children: readonly AutoRetryCondition[] }
  | { readonly kind: "not"; readonly child: AutoRetryCondition };
export interface AutoRetryTrigger {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly message: string;
  readonly condition: AutoRetryCondition;
}
export interface AutoRetrySettings {
  readonly enabled: boolean;
  readonly triggers: readonly AutoRetryTrigger[];
}

export const AUTO_RETRY_PREDICATE_LABELS = {
  error_message: "Error message contains",
  backend: "Backend is",
  model: "Model contains",
} satisfies Record<AutoRetryPredicateKind, string>;
export const DEFAULT_AUTO_RETRY_MESSAGE = "Please continue.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPredicateKind = (value: unknown): value is AutoRetryPredicateKind =>
  value === "error_message" || value === "backend" || value === "model";

export const predicate = (kind: AutoRetryPredicateKind = "error_message"): AutoRetryCondition => ({
  kind,
  value: "",
});

/** Drops malformed condition nodes from older or newer servers instead of crashing the editor. */
export function normalizeAutoRetryCondition(value: unknown): AutoRetryCondition | null {
  if (!isRecord(value)) return null;
  if (isPredicateKind(value.kind))
    return { kind: value.kind, value: typeof value.value === "string" ? value.value : "" };
  if (value.kind === "not") {
    const child = normalizeAutoRetryCondition(value.child);
    return child ? { kind: "not", child } : null;
  }
  if (value.kind === "and" || value.kind === "or") {
    const children = Array.isArray(value.children)
      ? value.children.flatMap((child) => normalizeAutoRetryCondition(child) ?? [])
      : [];
    return children.length > 0 ? { kind: value.kind, children } : null;
  }
  return null;
}

export function normalizeAutoRetrySettings(value: unknown): AutoRetrySettings {
  if (!isRecord(value)) return { enabled: false, triggers: [] };
  const triggers = Array.isArray(value.triggers)
    ? value.triggers.flatMap((trigger, index): AutoRetryTrigger[] => {
        if (!isRecord(trigger)) return [];
        return [
          {
            id:
              typeof trigger.id === "string" && trigger.id.length > 0
                ? trigger.id
                : "legacy-" + index,
            name: typeof trigger.name === "string" ? trigger.name : "",
            enabled: trigger.enabled !== false,
            message: typeof trigger.message === "string" ? trigger.message : "",
            condition: normalizeAutoRetryCondition(trigger.condition) ?? predicate(),
          },
        ];
      })
    : [];
  return { enabled: value.enabled === true, triggers };
}

export function createAutoRetryTrigger(index: number): AutoRetryTrigger {
  return {
    id: randomUUID(),
    name: "Retry trigger " + index,
    enabled: true,
    message: DEFAULT_AUTO_RETRY_MESSAGE,
    condition: predicate(),
  };
}

export type ConditionPath = readonly number[];

export function readCondition(
  root: AutoRetryCondition,
  path: ConditionPath,
): AutoRetryCondition | undefined {
  let node: AutoRetryCondition | undefined = root;
  for (const index of path) {
    if (!node) return undefined;
    node = node.kind === "not" ? node.child : "children" in node ? node.children[index] : undefined;
  }
  return node;
}

/** Replaces one node; returning null removes it from its parent group. */
export function updateCondition(
  root: AutoRetryCondition,
  path: ConditionPath,
  update: (node: AutoRetryCondition) => AutoRetryCondition | null,
): AutoRetryCondition {
  const visit = (node: AutoRetryCondition, depth: number): AutoRetryCondition | null => {
    if (depth === path.length) return update(node);
    const index = path[depth]!;
    if (node.kind === "not") {
      return { kind: "not", child: visit(node.child, depth + 1) ?? predicate() };
    }
    if (!("children" in node)) return node;
    const target = node.children[index];
    if (!target) return node;
    const next = visit(target, depth + 1);
    const children = node.children.flatMap((child, childIndex) =>
      childIndex === index ? (next ? [next] : []) : [child],
    );
    return children.length > 0 ? { ...node, children } : predicate();
  };
  return visit(root, 0) ?? predicate();
}

export function conditionIsComplete(node: AutoRetryCondition): boolean {
  if (node.kind === "not") return conditionIsComplete(node.child);
  if ("children" in node)
    return node.children.length > 0 && node.children.every(conditionIsComplete);
  return node.value.trim().length > 0;
}

export function describeCondition(node: AutoRetryCondition): string {
  if (node.kind === "not") return "not (" + describeCondition(node.child) + ")";
  if ("children" in node) return node.children.map(describeCondition).join(" " + node.kind + " ");
  return AUTO_RETRY_PREDICATE_LABELS[node.kind].toLowerCase() + ' "' + node.value + '"';
}
