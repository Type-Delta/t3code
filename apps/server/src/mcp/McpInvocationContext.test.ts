import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ManagementApiKeyId,
  type ManagementApiKeyScope,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
  ThreadToolOperationFailureError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

const managementScopeCases = [
  { operation: "create", scope: "threads:create" },
  { operation: "list", scope: "threads:list" },
  { operation: "list_models", scope: "models:read" },
  { operation: "read", scope: "threads:read" },
  { operation: "send", scope: "threads:message" },
  { operation: "wait", scope: "threads:wait" },
] as const satisfies ReadonlyArray<{
  readonly operation: McpInvocationContext.McpThreadToolOperation;
  readonly scope: ManagementApiKeyScope;
}>;

const makeManagementInvocation = (
  scopes: ReadonlySet<ManagementApiKeyScope>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-scope-test"),
  principal: {
    type: "management-key",
    keyId: ManagementApiKeyId.make("key-scope-test"),
    name: "Scope test key",
    scopes,
    defaultRuntimeMode: "approval-required",
    maximumRuntimeMode: "approval-required",
  },
  issuedAt: 1,
});

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    principal: {
      type: "management-key",
      keyId: ManagementApiKeyId.make("key-1"),
      name: "Read only",
      scopes: new Set(),
      defaultRuntimeMode: "approval-required",
      maximumRuntimeMode: "approval-required",
    },
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: ThreadId.make("mcp-management-key"),
      providerSessionId: "mcp-management-key",
      providerInstanceId: ProviderInstanceId.make("mcp-management-key"),
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});

it.effect("rejects thread tools when the credential only grants preview", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-threads-1"),
    principal: {
      type: "management-key",
      keyId: ManagementApiKeyId.make("key-threads-1"),
      name: "Read only",
      scopes: new Set(["models:read"]),
      defaultRuntimeMode: "approval-required",
      maximumRuntimeMode: "approval-required",
    },
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireThreadMcpCapability("list").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(ThreadToolOperationFailureError);
    expect(error).toMatchObject({
      operation: "list",
      reason: "MCP management key does not grant the threads:list scope.",
    });
  });
});

it.effect.each(managementScopeCases)(
  "enforces the dedicated management scope for $operation",
  ({ operation, scope }) =>
    Effect.gen(function* () {
      const grantedInvocation = makeManagementInvocation(new Set([scope]));
      const granted = yield* McpInvocationContext.requireThreadMcpCapability(operation).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, grantedInvocation),
      );
      expect(granted).toBe(grantedInvocation);

      const deniedInvocation = makeManagementInvocation(new Set());
      const error = yield* McpInvocationContext.requireThreadMcpCapability(operation).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, deniedInvocation),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(ThreadToolOperationFailureError);
      expect(error).toMatchObject({
        operation,
        reason: `MCP management key does not grant the ${scope} scope.`,
      });
    }),
);
