import { type ManagementApiKeyScope as ContractManagementApiKeyScope } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";

export const MANAGEMENT_API_KEY_SCOPES = [
  "models:read",
  "threads:list",
  "threads:read",
  "threads:create",
  "threads:message",
  "threads:wait",
] as const satisfies ReadonlyArray<ContractManagementApiKeyScope>;

export type ManagementApiKeyScope = ContractManagementApiKeyScope;
export type ManagementApiKeyPreset = "read-only" | "thread-orchestration" | "custom";
export type ManagementApiKeyExpiration = "30-days" | "90-days" | "1-year" | "never";

export interface ManagementApiKeyEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Keep the primary machine prominent while making every other machine easy to find. */
export function buildManagementApiKeyEnvironmentOptions<
  T extends ManagementApiKeyEnvironmentOption,
>(environments: ReadonlyArray<T>, primaryEnvironmentId: EnvironmentId | null): ReadonlyArray<T> {
  return environments.toSorted((left, right) => {
    const leftIsPrimary = left.environmentId === primaryEnvironmentId;
    const rightIsPrimary = right.environmentId === primaryEnvironmentId;
    if (leftIsPrimary !== rightIsPrimary) return leftIsPrimary ? -1 : 1;
    return (
      left.label.localeCompare(right.label) ||
      String(left.environmentId).localeCompare(String(right.environmentId))
    );
  });
}

/** Preserve the user's disconnected choice, falling back to primary then the first machine. */
export function resolveSelectedManagementApiKeyEnvironmentId<
  T extends ManagementApiKeyEnvironmentOption,
>(
  environments: ReadonlyArray<T>,
  selectedEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  if (
    primaryEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === primaryEnvironmentId)
  ) {
    return primaryEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export const MANAGEMENT_API_KEY_SCOPE_DETAILS: ReadonlyArray<{
  readonly scope: ManagementApiKeyScope;
  readonly label: string;
  readonly description: string;
}> = [
  {
    scope: "models:read",
    label: "List models",
    description: "Discover models available in this environment.",
  },
  {
    scope: "threads:list",
    label: "List threads",
    description: "See the environment's active threads.",
  },
  {
    scope: "threads:read",
    label: "Read threads",
    description: "Read thread messages and activity.",
  },
  {
    scope: "threads:create",
    label: "Create threads",
    description: "Start a thread in an explicitly selected project.",
  },
  {
    scope: "threads:message",
    label: "Send messages",
    description: "Send messages to existing environment threads.",
  },
  {
    scope: "threads:wait",
    label: "Wait for threads",
    description: "Wait for target threads to finish or need attention.",
  },
];

export const MANAGEMENT_API_KEY_PRESETS: ReadonlyArray<{
  readonly value: ManagementApiKeyPreset;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "read-only",
    label: "Read only",
    description: "List models and inspect threads without changing them.",
  },
  {
    value: "thread-orchestration",
    label: "Thread orchestration",
    description: "Use all six supported thread-management tools.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Choose exactly which thread-management tools this key can use.",
  },
];

export function orderedManagementApiKeyScopes(
  scopes: ReadonlyArray<string>,
): ReadonlyArray<ManagementApiKeyScope> {
  const selected = new Set(scopes);
  return MANAGEMENT_API_KEY_SCOPES.filter((scope) => selected.has(scope));
}

export function scopesForManagementApiKeyPreset(
  preset: ManagementApiKeyPreset,
  customScopes: ReadonlyArray<ManagementApiKeyScope> = [],
): ReadonlyArray<ManagementApiKeyScope> {
  if (preset === "read-only") {
    return ["models:read", "threads:list", "threads:read"];
  }
  if (preset === "thread-orchestration") {
    return MANAGEMENT_API_KEY_SCOPES;
  }
  return orderedManagementApiKeyScopes(customScopes);
}

export function managementApiKeyPresetForScopes(
  scopes: ReadonlyArray<string>,
): ManagementApiKeyPreset {
  const ordered = orderedManagementApiKeyScopes(scopes);
  if (
    ordered.length === 3 &&
    scopesForManagementApiKeyPreset("read-only").every((scope) => ordered.includes(scope))
  ) {
    return "read-only";
  }
  if (
    ordered.length === MANAGEMENT_API_KEY_SCOPES.length &&
    MANAGEMENT_API_KEY_SCOPES.every((scope) => ordered.includes(scope))
  ) {
    return "thread-orchestration";
  }
  return "custom";
}

export function resolveManagementApiKeyExpiration(
  expiration: ManagementApiKeyExpiration,
  now = new Date(),
): string | null {
  if (expiration === "never") return null;
  const expiresAt = new Date(now);
  if (expiration === "30-days") expiresAt.setUTCDate(expiresAt.getUTCDate() + 30);
  if (expiration === "90-days") expiresAt.setUTCDate(expiresAt.getUTCDate() + 90);
  if (expiration === "1-year") expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
  return expiresAt.toISOString();
}

export function managementApiKeyScopeSummary(scopes: ReadonlyArray<string>): string {
  const preset = managementApiKeyPresetForScopes(scopes);
  if (preset === "read-only") return "Read only";
  if (preset === "thread-orchestration") return "Thread orchestration";
  const count = orderedManagementApiKeyScopes(scopes).length;
  return `${count} custom ${count === 1 ? "scope" : "scopes"}`;
}

export function canRotateManagementApiKey(expiresAt: string | null, nowMs = Date.now()): boolean {
  if (expiresAt === null) return true;
  const expiryMs = Date.parse(expiresAt);
  return !Number.isNaN(expiryMs) && expiryMs > nowMs;
}

export type ManagementApiKeyRevealState<T> =
  | (T & {
      readonly operation: "created" | "rotated";
    })
  | null;

export function revealManagementApiKey<T extends object>(
  result: T,
  operation: "created" | "rotated",
): NonNullable<ManagementApiKeyRevealState<T>> {
  return { ...result, operation };
}

export function clearManagementApiKeyReveal(): null {
  return null;
}

export function buildManagementApiKeyJsonExample(endpoint: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        t3: {
          type: "http",
          url: endpoint,
          headers: {
            Authorization: "Bearer ${T3_MANAGEMENT_API_KEY}",
          },
        },
      },
    },
    null,
    2,
  );
}

export function buildManagementApiKeyCodexExample(endpoint: string): string {
  return `[mcp_servers.t3]\nurl = ${JSON.stringify(endpoint)}\nbearer_token_env_var = "T3_MANAGEMENT_API_KEY"`;
}
