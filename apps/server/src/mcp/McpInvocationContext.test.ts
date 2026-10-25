import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ManagementApiKeyId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "pull-requests",
      threadId: invocation.thread?.threadId,
    });

    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});

it.effect("refuses thread-owned capabilities to a caller signed in from outside a thread", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
    capabilities: new Set(["preview", "orchestration"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({ capability: "preview", environmentId: "environment-1" });
    expect(error.threadId).toBeUndefined();
  });
});

it.effect(
  "shares project authorization across provider scopes without changing management keys",
  () =>
    Effect.gen(function* () {
      const ownProject = ProjectId.make("project-own");
      const foreignProject = ProjectId.make("project-foreign");
      const caller = { projectId: ownProject };
      const provider = (mcpToolScope: "project" | "global") =>
        ({
          environmentId: EnvironmentId.make("environment-1"),
          principal: {
            type: "provider-session" as const,
            threadId: ThreadId.make("thread-1"),
            providerSessionId: "provider-session-1",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          thread: {
            threadId: ThreadId.make("thread-1"),
            providerSessionId: "provider-session-1",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          mcpToolScope,
          issuedAt: 1,
        }) satisfies McpInvocationContext.McpInvocationScope;
      const management = {
        environmentId: EnvironmentId.make("environment-1"),
        principal: {
          type: "management-key" as const,
          keyId: ManagementApiKeyId.make("key-1"),
          name: "test",
          scopes: new Set(),
        },
        issuedAt: 1,
      } satisfies McpInvocationContext.McpInvocationScope;

      const denied = yield* McpInvocationContext.assertProjectAllowed(
        provider("project"),
        caller,
        foreignProject,
      ).pipe(Effect.flip);
      expect(denied.code).toBe("invalid_request");
      yield* McpInvocationContext.assertProjectAllowed(provider("project"), caller, ownProject);
      // A scoped caller whose own project is unknown can address no project.
      const unknownCaller = yield* McpInvocationContext.assertProjectAllowed(
        provider("project"),
        undefined,
        ownProject,
      ).pipe(Effect.flip);
      expect(unknownCaller.code).toBe("invalid_request");
      yield* McpInvocationContext.assertProjectAllowed(provider("global"), caller, foreignProject);
      yield* McpInvocationContext.assertProjectAllowed(management, caller, foreignProject);
    }),
);
