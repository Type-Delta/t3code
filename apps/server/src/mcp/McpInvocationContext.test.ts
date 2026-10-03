import { expect, it } from "@effect/vitest";
import { EnvironmentId, ManagementApiKeyId } from "@t3tools/contracts";

import * as McpInvocationContext from "./McpInvocationContext.ts";

const invocation = (
  scopes: ReadonlyArray<
    | "models:read"
    | "threads:list"
    | "threads:read"
    | "threads:create"
    | "threads:message"
    | "threads:wait"
  >,
) =>
  ({
    environmentId: EnvironmentId.make("mcp-invocation-context-test"),
    principal: {
      type: "management-key" as const,
      keyId: ManagementApiKeyId.make("mcp-invocation-context-key"),
      name: "MCP invocation context",
      scopes: new Set(scopes),
    },
    issuedAt: 1,
  }) satisfies McpInvocationContext.McpInvocationScope;

it("maps only the reviewed management tools to scopes", () => {
  expect(McpInvocationContext.managementMcpToolScope("orchestrator_capabilities")).toBe(
    "models:read",
  );
  expect(McpInvocationContext.managementMcpToolScope("t3_thread_list")).toBe("threads:list");
  expect(McpInvocationContext.managementMcpToolScope("t3_project_update")).toBe("threads:create");
  expect(McpInvocationContext.managementMcpToolScope("create_threads")).toBeUndefined();
  expect(McpInvocationContext.managementMcpToolScope("preview_snapshot")).toBeUndefined();
});

it("requires the mapped scope for management-key discovery and invocation", () => {
  const readOnly = invocation(["threads:read"]);
  expect(McpInvocationContext.managementKeyCanUseTool(readOnly, "t3_thread_read")).toBe(true);
  expect(McpInvocationContext.managementKeyCanUseTool(readOnly, "t3_thread_send")).toBe(false);
  expect(McpInvocationContext.managementKeyCanUseTool(readOnly, "preview_snapshot")).toBe(false);
  expect(McpInvocationContext.isManagementMcpToolAllowed("t3_thread_read")).toBe(true);
  expect(McpInvocationContext.isManagementMcpToolAllowed("create_threads")).toBe(false);
});
