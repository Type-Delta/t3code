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

export type McpCapability = "preview" | "device" | "pull-requests" | "threads";

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
  /** Present for fork management-key authorization; provider sessions use the native identity. */
  readonly principal?: McpPrincipal;
  /** Legacy callers may provide these directly; principals are preferred. */
  readonly threadId?: ThreadId;
  readonly providerSessionId?: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly capabilities?: ReadonlySet<McpCapability>;
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

const managementFallbackThreadId = ThreadId.make("mcp-management-key");
const managementFallbackProviderInstanceId = ProviderInstanceId.make("mcp-management-key");

/** Resolve legacy direct fields and the newer provider principal to one context. */
export const getInvocationThreadId = (invocation: McpInvocationScope): ThreadId =>
  invocation.threadId ??
  getProviderSessionPrincipal(invocation)?.threadId ??
  managementFallbackThreadId;

export const getInvocationProviderSessionId = (invocation: McpInvocationScope): string =>
  invocation.providerSessionId ??
  getProviderSessionPrincipal(invocation)?.providerSessionId ??
  "mcp-management-key";

export const getInvocationProviderInstanceId = (
  invocation: McpInvocationScope,
): ProviderInstanceId =>
  invocation.providerInstanceId ??
  getProviderSessionPrincipal(invocation)?.providerInstanceId ??
  managementFallbackProviderInstanceId;

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
    threadId: getInvocationThreadId(invocation),
    providerSessionId: getInvocationProviderSessionId(invocation),
    providerInstanceId: getInvocationProviderInstanceId(invocation),
  };
  if (capability === "preview")
    return new PreviewAutomationUnavailableError({ ...fields, capability });
  return new McpCapabilityUnavailableError({ ...fields, capability });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  Effect.flatMap(McpInvocationContext, (invocation) =>
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
