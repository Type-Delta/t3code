import {
  type EnvironmentId,
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

export type McpCapability = "preview" | "threads";

/**
 * The credential identity used for one MCP invocation.
 *
 * Provider sessions are intentionally thread-bound and carry the provider
 * identity needed by preview automation. Management keys are environment
 * credentials: they have no calling thread or provider session and are
 * authorized by the narrow management scopes persisted with the key.
 */
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
  readonly principal: McpPrincipal;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export type McpThreadToolOperation = "create" | "list" | "list_models" | "read" | "send" | "wait";

/**
 * Keep this map exhaustive. Every thread MCP operation must make an explicit
 * management authorization decision when a new tool is added.
 */
export const managementScopeByThreadOperation = {
  create: "threads:create",
  list: "threads:list",
  list_models: "models:read",
  read: "threads:read",
  send: "threads:message",
  wait: "threads:wait",
} as const satisfies Record<McpThreadToolOperation, ManagementApiKeyScope>;

export const isProviderSessionPrincipal = (
  principal: McpPrincipal,
): principal is Extract<McpPrincipal, { readonly type: "provider-session" }> =>
  principal.type === "provider-session";

export const isManagementKeyPrincipal = (
  principal: McpPrincipal,
): principal is Extract<McpPrincipal, { readonly type: "management-key" }> =>
  principal.type === "management-key";

export const getProviderSessionPrincipal = (
  invocation: McpInvocationScope,
): Extract<McpPrincipal, { readonly type: "provider-session" }> | undefined =>
  isProviderSessionPrincipal(invocation.principal) ? invocation.principal : undefined;

export const getManagementOrigin = (
  invocation: McpInvocationScope,
): { readonly origin: OrchestrationClientOrigin } | undefined =>
  isManagementKeyPrincipal(invocation.principal)
    ? {
        origin: {
          managementKey: {
            id: invocation.principal.keyId,
            name: invocation.principal.name,
          },
        },
      }
    : undefined;

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  const provider = getProviderSessionPrincipal(invocation);
  if (!provider) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      // Preview is provider-session-only. The preview error contract predates
      // management principals and still requires provider context; the
      // adapter's management rejection is handled before broker invocation.
      threadId: ThreadId.make("mcp-management-key"),
      providerSessionId: "mcp-management-key",
      providerInstanceId: ProviderInstanceId.make("mcp-management-key"),
    });
  }
  return invocation;
});

export const requireThreadMcpCapability = Effect.fn("mcp.requireThreadCapability")(function* (
  operation: McpThreadToolOperation,
) {
  const invocation = yield* McpInvocationContext;
  if (isProviderSessionPrincipal(invocation.principal)) return invocation;
  const scope = managementScopeByThreadOperation[operation];
  if (!invocation.principal.scopes.has(scope)) {
    return yield* new ThreadToolOperationFailureError({
      operation,
      reason: `MCP management key does not grant the ${scope} scope.`,
    });
  }
  return invocation;
});
