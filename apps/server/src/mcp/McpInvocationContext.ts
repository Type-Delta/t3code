import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  type ManagementApiKeyId,
  type ManagementApiKeyScope,
  type OrchestrationClientOrigin,
  ThreadToolOperationFailureError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
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

/** A provider session T3 Code launched for one thread. */
export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

/** An agent T3 Code did not launch, signed in through MCP OAuth. */
export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  /** Read only, or the most the threads it starts or changes may run with. */
  readonly access: AuthMcpClientAccess;
}

/**
 * The runtime mode a client caller's writes are capped at. A read-only client
 * never reaches a write (`McpToolAccess` refuses it first), so it maps to the
 * lowest mode rather than to nothing.
 */
export const clientRuntimeModeCeiling = (client: McpClientCaller | undefined): RuntimeMode =>
  client === undefined || client.access === "read-only" ? "approval-required" : client.access;

/**
 * Who is calling and what they may do. Tool parameters choose the target
 * (thread, project); the caller sets the limits. A thread caller's omitted
 * target falls back to its own thread; a client caller has no own thread, so
 * tools that act as the caller (delegate_task, preview, worktree handoff)
 * need `thread`.
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
  readonly principal?: McpPrincipal;
  readonly capabilities?: ReadonlySet<McpCapability> | undefined;
  readonly issuedAt: number;
  /** Namespaces idempotency keys so two callers reusing a clientRequestId cannot collide. */
  readonly requestNamespace?: string | undefined;
  readonly thread?: McpThreadCaller | undefined;
  readonly client?: McpClientCaller | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly providerSessionId?: string | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly mcpToolScope?: "global" | "project" | undefined;
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
export const managementMcpToolScope = (name: string): ManagementApiKeyScope | undefined =>
  managementToolScopes[name];
export const isManagementMcpToolAllowed = (name: string) =>
  managementMcpToolScope(name) !== undefined;
export const isManagementKeyPrincipal = (
  p: McpPrincipal | undefined,
): p is Extract<McpPrincipal, { type: "management-key" }> => p?.type === "management-key";
export const isProviderSessionPrincipal = (
  p: McpPrincipal | undefined,
): p is Extract<McpPrincipal, { type: "provider-session" }> => p?.type === "provider-session";
export const managementKeyCanUseTool = (invocation: McpInvocationScope, name: string) =>
  isManagementKeyPrincipal(invocation.principal) &&
  invocation.principal.scopes.has(
    managementMcpToolScope(name) ?? ("__denied__" as ManagementApiKeyScope),
  );
export const getInvocationThreadId = (invocation: McpInvocationScope) =>
  invocation.thread?.threadId ??
  (isProviderSessionPrincipal(invocation.principal) ? invocation.principal.threadId : undefined);
export const getInvocationProviderSessionId = (invocation: McpInvocationScope) =>
  invocation.thread?.providerSessionId ??
  (isProviderSessionPrincipal(invocation.principal)
    ? invocation.principal.providerSessionId
    : undefined);
export const getInvocationProviderInstanceId = (invocation: McpInvocationScope) =>
  invocation.thread?.providerInstanceId ??
  (isProviderSessionPrincipal(invocation.principal)
    ? invocation.principal.providerInstanceId
    : undefined);
export const requireThreadMcpOperation = Effect.fn("mcp.requireThreadOperation")(function* (
  operation: McpThreadToolOperation,
) {
  const invocation = yield* McpInvocationContext;
  if (!isManagementKeyPrincipal(invocation.principal)) return invocation;
  const scope = managementScopeByThreadOperation[operation];
  if (!invocation.principal.scopes.has(scope))
    return yield* new ThreadToolOperationFailureError({
      operation,
      reason: `MCP management key does not grant the ${scope} scope.`,
    });
  return invocation;
});

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities?.has(capability) === true,
      // The conditional type narrows what the literal argument decided at runtime.
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

/**
 * Preview tabs and device sessions belong to the calling thread, so their
 * capabilities are only ever granted to thread callers. A scope that carries
 * one without a thread is refused the same way as a missing capability.
 */
export const requireThreadMcpCapability = <const C extends "preview" | "device">(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities?.has(capability) === true && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.`,
  });

/** A scope with a thread caller, for tools whose whole surface acts as the caller. */
export type McpThreadInvocationScope = Omit<McpInvocationScope, "thread"> & {
  readonly thread: McpThreadCaller;
};

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
