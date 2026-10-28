import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  type ManagementApiKeyId,
  type ManagementApiKeyScope,
  ThreadToolOperationFailureError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** A delegated child task; its parent owns the work it hands back. */
  readonly subagent?: boolean;
}

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  /**
   * Another T3 Code environment's peer link. What it starts here carries its
   * session as `linkOrigin`, and it changes only that work (`linkOrigin.ts`).
   */
  readonly linked?: boolean | undefined;
  /**
   * Narrower modes the client asked for on this request (`T3-Mode-Limit`):
   * another environment passing on the limits of the agent it calls for.
   */
  readonly narrowedTo?: ClientModes | undefined;
}

/**
 * `T3-Mode-Limit: <runtimeMode>/<interactionMode>` lets an OAuth client cap
 * a request below what it was approved with: another environment passes on
 * the limits of the agent it calls for. It can only narrow (see
 * `clientModeCeiling`), so a client gains nothing by sending a broad one.
 */
export const MODE_LIMIT_HEADER = "t3-mode-limit";

export interface ClientModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

/**
 * The modes a client caller's writes are capped at: what it was approved
 * with, narrowed by what it asked for on this request. A read-only client
 * never reaches a write (`McpToolAccess` refuses it first), so it maps to the
 * lowest runtime mode rather than to nothing.
 */
export const clientModeCeiling = (client: McpClientCaller | undefined): ClientModes => {
  const approved: ClientModes = {
    runtimeMode:
      client === undefined || client.access === "read-only" ? "approval-required" : client.access,
    interactionMode: "default",
  };
  const asked = client?.narrowedTo;
  if (asked === undefined) return approved;
  return {
    runtimeMode:
      runtimeModeRank[asked.runtimeMode] < runtimeModeRank[approved.runtimeMode]
        ? asked.runtimeMode
        : approved.runtimeMode,
    interactionMode:
      interactionModeRank[asked.interactionMode] < interactionModeRank[approved.interactionMode]
        ? asked.interactionMode
        : approved.interactionMode,
  };
};

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

/**
 * A thread caller's omitted target falls back to its own thread; a client
 * caller has no own thread, so tools that act as the caller (delegate_task,
 * preview, worktree handoff) need `thread`.
 */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly principal?: McpPrincipal;
  readonly capabilities?: ReadonlySet<McpCapability> | undefined;
  readonly issuedAt: number;

  readonly requestNamespace: string;
  readonly thread?: McpThreadCaller | undefined;
  readonly client?: McpClientCaller | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly providerSessionId?: string | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly linkedEnvironments?: boolean;
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
  t3_thread_wait: "threads:wait",
  t3_thread_send: "threads:message",
  t3_thread_interrupt: "threads:message",
  t3_thread_update: "threads:message",
  t3_thread_organize: "threads:message",
  t3_thread_configure: "threads:message",
  t3_thread_transfer: "threads:message",
  write_pull_request_guides: "pullRequests:review",
  read_pull_request_guide: "pullRequests:review",
};
export const managementToolRequiredScope = (
  name: string,
  args?: unknown,
): ManagementApiKeyScope | undefined => {
  if (
    name === "t3_thread_configure" &&
    typeof args === "object" &&
    args !== null &&
    !("modelSelection" in args)
  )
    return "threads:read";
  if (
    name === "t3_thread_transfer" &&
    typeof args === "object" &&
    args !== null &&
    "action" in args &&
    args.action === "status"
  )
    return "threads:read";
  return managementToolScopes[name];
};
export const isManagementMcpToolAllowed = (name: string) =>
  managementToolRequiredScope(name) !== undefined;
const managementToolCapabilities: Readonly<Record<string, McpCapability>> = {
  write_pull_request_guides: "pull-requests",
  read_pull_request_guide: "pull-requests",
};
export const managementMcpToolCapability = (name: string): McpCapability | undefined =>
  managementToolCapabilities[name];
export const isManagementKeyPrincipal = (
  p: McpPrincipal | undefined,
): p is Extract<McpPrincipal, { type: "management-key" }> => p?.type === "management-key";
export const isProviderSessionPrincipal = (
  p: McpPrincipal | undefined,
): p is Extract<McpPrincipal, { type: "provider-session" }> => p?.type === "provider-session";
export const managementKeyCanUseTool = (
  invocation: McpInvocationScope,
  name: string,
  args?: unknown,
) =>
  isManagementKeyPrincipal(invocation.principal) &&
  invocation.principal.scopes.has(
    managementToolRequiredScope(name, args) ?? ("__denied__" as ManagementApiKeyScope),
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

/**
 * `McpSchema.EnabledWhen` for tools a delegated child must not see or call.
 * EnabledWhen only receives the MCP client profile, so read the T3 caller from the request fiber.
 */
export const hiddenFromSubagents = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.thread?.subagent !== true;
};

/** `McpSchema.EnabledWhen` for tools that only serve links, hidden while the beta is off. */
export const hiddenWhileLinksOff = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.linkedEnvironments !== false;
};

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
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

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

export type McpThreadInvocationScope = Omit<McpInvocationScope, "thread"> & {
  readonly thread: McpThreadCaller;
};

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
