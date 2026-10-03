import {
  type EnvironmentId,
  McpCapabilityUnavailableError,
  type ManagementApiKeyId,
  type ManagementApiKeyScope,
  type OrchestrationClientOrigin,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
  ThreadToolOperationFailureError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

/** The credential identity carried by one MCP invocation. */
export type McpPrincipal =
  | {
      readonly type: "provider-session";
      readonly threadId: ThreadId;
      readonly providerSessionId: string;
      readonly providerInstanceId: ProviderInstanceId;
    }
  | {
      readonly type: "management-key";
      readonly keyId: ManagementApiKeyId;
      readonly name: string;
      readonly scopes: ReadonlySet<ManagementApiKeyScope>;
    };

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  /** Management keys have no owning provider thread or provider run. */
  readonly principal?: McpPrincipal;
  /** Legacy provider callers may provide these directly; principals are preferred. */
  readonly threadId?: ThreadId;
  readonly providerSessionId?: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly capabilities?: ReadonlySet<McpCapability>;
  /** Project-local callers are restricted to their project unless set to global. */
  readonly mcpToolScope?: "global" | "project";
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export type McpThreadToolOperation = "create" | "list" | "list_models" | "read" | "send" | "wait";

export const managementScopeByThreadOperation = {
  create: "threads:create",
  list: "threads:list",
  list_models: "models:read",
  read: "threads:read",
  send: "threads:message",
  wait: "threads:wait",
} as const satisfies Record<McpThreadToolOperation, ManagementApiKeyScope>;

const managementToolScopes: Readonly<Record<string, ManagementApiKeyScope>> = {
  orchestrator_capabilities: "models:read",
  t3_project_list: "threads:list",
  t3_project_read: "threads:read",
  t3_project_create: "threads:create",
  t3_project_update: "threads:create",
  t3_project_delete: "threads:create",
  t3_project_clone: "threads:create",
  t3_thread_launch: "threads:create",
  t3_thread_list: "threads:list",
  t3_thread_search: "threads:list",
  t3_thread_read: "threads:read",
  t3_thread_transfers: "threads:read",
  t3_thread_configuration: "threads:read",
  t3_thread_wait: "threads:wait",
  t3_thread_send: "threads:message",
  t3_thread_interrupt: "threads:message",
  t3_thread_update: "threads:message",
  t3_thread_organize: "threads:message",
  t3_thread_configure: "threads:message",
  t3_thread_fork: "threads:message",
  t3_thread_merge_back: "threads:message",
};

export const managementMcpToolScope = (toolName: string): ManagementApiKeyScope | undefined => {
  if (
    toolName !== "orchestrator_capabilities" &&
    !toolName.startsWith("t3_thread_") &&
    !toolName.startsWith("t3_project_")
  )
    return undefined;
  // Unknown tools fail closed until their management-key scope is reviewed.
  return managementToolScopes[toolName];
};

export const isManagementMcpToolAllowed = (toolName: string): boolean =>
  managementMcpToolScope(toolName) !== undefined;

export const managementKeyCanUseTool = (
  invocation: McpInvocationScope,
  toolName: string,
): boolean => {
  if (!isManagementKeyPrincipal(invocation.principal)) return false;
  const requiredScope = managementMcpToolScope(toolName);
  return requiredScope !== undefined && invocation.principal.scopes.has(requiredScope);
};

export const isProviderSessionPrincipal = (
  principal: McpPrincipal | undefined,
): principal is Extract<McpPrincipal, { readonly type: "provider-session" }> =>
  principal?.type === "provider-session";

export const isManagementKeyPrincipal = (
  principal: McpPrincipal | undefined,
): principal is Extract<McpPrincipal, { readonly type: "management-key" }> =>
  principal?.type === "management-key";

export const getProviderSessionPrincipal = (
  invocation: McpInvocationScope,
): Extract<McpPrincipal, { readonly type: "provider-session" }> | undefined =>
  invocation.principal && isProviderSessionPrincipal(invocation.principal)
    ? invocation.principal
    : undefined;

/** Resolve provider identity without inventing one for management-key callers. */
export const getInvocationThreadId = (invocation: McpInvocationScope): ThreadId | undefined =>
  invocation.threadId ?? getProviderSessionPrincipal(invocation)?.threadId;

export const getInvocationProviderSessionId = (
  invocation: McpInvocationScope,
): string | undefined =>
  invocation.providerSessionId ?? getProviderSessionPrincipal(invocation)?.providerSessionId;

export const getInvocationProviderInstanceId = (
  invocation: McpInvocationScope,
): ProviderInstanceId | undefined =>
  invocation.providerInstanceId ?? getProviderSessionPrincipal(invocation)?.providerInstanceId;

/** Stable credential identity for request keys and command ids. */
export const getInvocationCredentialId = (invocation: McpInvocationScope): string | undefined =>
  getInvocationProviderSessionId(invocation) ??
  (isManagementKeyPrincipal(invocation.principal)
    ? `management-key:${invocation.principal.keyId}`
    : undefined);

export const getManagementOrigin = (
  invocation: McpInvocationScope,
): { readonly origin: OrchestrationClientOrigin } | undefined =>
  invocation.principal && isManagementKeyPrincipal(invocation.principal)
    ? {
        origin: {
          managementKey: {
            id: invocation.principal.keyId,
            name: invocation.principal.name,
          },
        },
      }
    : undefined;

/** The error a missing capability surfaces as; preview keeps its broker-specific error. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    capability,
    environmentId: invocation.environmentId,
    ...(getInvocationThreadId(invocation) === undefined
      ? {}
      : { threadId: getInvocationThreadId(invocation)! }),
    ...(getInvocationProviderSessionId(invocation) === undefined
      ? {}
      : { providerSessionId: getInvocationProviderSessionId(invocation)! }),
    ...(getInvocationProviderInstanceId(invocation) === undefined
      ? {}
      : { providerInstanceId: getInvocationProviderInstanceId(invocation)! }),
  };
  if (capability === "preview")
    return new PreviewAutomationUnavailableError({ ...fields, capability });
  return new McpCapabilityUnavailableError({ ...fields, capability });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  Effect.flatMap(McpInvocationContext, (invocation) =>
    !isManagementKeyPrincipal(invocation.principal) &&
    invocation.capabilities?.has(capability) === true
      ? Effect.succeed(invocation)
      : Effect.fail(missingCapability(invocation, capability) as McpCapabilityError<C>),
  ).pipe(Effect.withSpan("mcp.requireCapability"));

export const requireThreadMcpCapability = Effect.fn("mcp.requireThreadCapability")(function* (
  operation: McpThreadToolOperation,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.principal || isProviderSessionPrincipal(invocation.principal)) return invocation;
  const scope = managementScopeByThreadOperation[operation];
  if (!invocation.principal.scopes.has(scope)) {
    return yield* new ThreadToolOperationFailureError({
      operation,
      reason: `MCP management key does not grant the ${scope} scope.`,
    });
  }
  return invocation;
});
