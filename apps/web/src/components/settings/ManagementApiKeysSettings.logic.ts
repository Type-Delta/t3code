import {
  MANAGEMENT_API_KEY_RUNTIME_MODE_ORDER,
  type ManagementApiKeyRuntimeMode,
  type ManagementApiKeyScope as ContractManagementApiKeyScope,
} from "@t3tools/contracts";

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

export const MANAGEMENT_API_KEY_RUNTIME_MODES: ReadonlyArray<{
  readonly value: Exclude<ManagementApiKeyRuntimeMode, "auto">;
  readonly label: string;
  readonly description: string;
  readonly rank: number;
}> = [
  {
    value: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
    rank: 0,
  },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    rank: 1,
  },
];

const MANAGEMENT_API_KEY_RUNTIME_MODE_RANK = MANAGEMENT_API_KEY_RUNTIME_MODE_ORDER;

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

export function managementApiKeyRuntimeModeRank(mode: string): number {
  return mode in MANAGEMENT_API_KEY_RUNTIME_MODE_RANK
    ? MANAGEMENT_API_KEY_RUNTIME_MODE_RANK[mode as ManagementApiKeyRuntimeMode]
    : Number.POSITIVE_INFINITY;
}

export function isManagementApiKeyRuntimeModeWithinCeiling(
  defaultRuntimeMode: string,
  maximumRuntimeMode: string,
): boolean {
  return (
    managementApiKeyRuntimeModeRank(defaultRuntimeMode) <=
    managementApiKeyRuntimeModeRank(maximumRuntimeMode)
  );
}

export function clampManagementApiKeyDefaultRuntimeMode(
  defaultRuntimeMode: Exclude<ManagementApiKeyRuntimeMode, "auto">,
  maximumRuntimeMode: Exclude<ManagementApiKeyRuntimeMode, "auto">,
): Exclude<ManagementApiKeyRuntimeMode, "auto"> {
  return isManagementApiKeyRuntimeModeWithinCeiling(defaultRuntimeMode, maximumRuntimeMode)
    ? defaultRuntimeMode
    : maximumRuntimeMode;
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

export function managementApiKeyRuntimeModeLabel(mode: string): string {
  if (mode === "auto") return "Auto";
  return (
    MANAGEMENT_API_KEY_RUNTIME_MODES.find((candidate) => candidate.value === mode)?.label ?? mode
  );
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
