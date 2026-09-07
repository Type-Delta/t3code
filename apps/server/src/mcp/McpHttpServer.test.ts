import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ManagementApiKeyId,
  type ManagementApiKeyScope,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ManagementApiKeyService from "../auth/ManagementApiKeyService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadCommandDispatcher from "../orchestration/ThreadCommandDispatcher.ts";
import * as ManagementApiKeys from "../persistence/ManagementApiKeys.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ThreadToolkit } from "./toolkits/threads/tools.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  principal: {
    type: "provider-session" as const,
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);
const ThreadRegistrationTestLayer = McpHttpServer.McpToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(
    Layer.succeed(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      {} as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ThreadCommandDispatcher.ThreadCommandDispatcher,
      {} as ThreadCommandDispatcher.ThreadCommandDispatcher["Service"],
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      OrchestrationEngine.OrchestrationEngineService,
      {} as OrchestrationEngine.OrchestrationEngineService["Service"],
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      GitWorkflowService.GitWorkflowService,
      {} as GitWorkflowService.GitWorkflowService["Service"],
    ),
  ),
  Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, invocation)),
);

const managementScopes = [
  "models:read",
  "threads:list",
  "threads:read",
  "threads:create",
  "threads:message",
  "threads:wait",
] satisfies ReadonlyArray<ManagementApiKeyScope>;

const managementPrincipal: ManagementApiKeyService.ManagementApiKeyPrincipal = {
  type: "management-key",
  keyId: ManagementApiKeyId.make("mcp-http-management-key"),
  name: "HTTP management key",
  scopes: new Set(managementScopes),
};

const emptyMcpRegistry = McpSessionRegistry.McpSessionRegistry.of({
  issue: () => Effect.die("MCP issue is not used by this test"),
  resolve: () => Effect.succeed(undefined),
  touch: () => Effect.void,
  revokeProviderSession: () => Effect.void,
  revokeThread: () => Effect.void,
  revokeAll: Effect.void,
});

const testServerEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("MCP descriptor is not used by this test"),
});

const mcpHttpToolkitLayer = McpHttpServer.McpToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpHttpServer.McpTransportLive),
);

const makeMcpHttpTestLayer = (
  managementService: ManagementApiKeyService.ManagementApiKeyService["Service"],
  registry = emptyMcpRegistry,
) =>
  HttpRouter.serve(mcpHttpToolkitLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, testServerEnvironment)),
    Layer.provide(
      Layer.succeed(ManagementApiKeyService.ManagementApiKeyService, managementService),
    ),
    Layer.provide(makeProviderRegistryLayer()),
    Layer.provide(
      Layer.succeed(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        {} as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(
        ThreadCommandDispatcher.ThreadCommandDispatcher,
        {} as ThreadCommandDispatcher.ThreadCommandDispatcher["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(
        OrchestrationEngine.OrchestrationEngineService,
        {} as OrchestrationEngine.OrchestrationEngineService["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(
        GitWorkflowService.GitWorkflowService,
        {} as GitWorkflowService.GitWorkflowService["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(
        PreviewAutomationBroker.PreviewAutomationBroker,
        {} as PreviewAutomationBroker.PreviewAutomationBroker["Service"],
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );

const initializePayload = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "management-key-test", version: "1.0.0" },
  },
});

const mcpRequest = (token: string, body: string, sessionId?: string) => ({
  headers: {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    ...(sessionId === undefined ? {} : { "mcp-protocol-version": "2025-06-18" }),
  },
  body: HttpBody.text(body, "application/json"),
});

const callListModelsPayload = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "list_models", arguments: {} },
});

const makeManagementService = (
  resolveToken: ManagementApiKeyService.ManagementApiKeyService["Service"]["resolveToken"],
) =>
  ManagementApiKeyService.ManagementApiKeyService.of({
    create: () => Effect.die("management key creation is not used by this test"),
    list: () => Effect.succeed([]),
    revoke: () => Effect.succeed(false),
    rotate: () => Effect.succeed(Option.none()),
    resolveToken,
    authenticate: resolveToken,
  });

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect(
  "returns the same generic 401 for missing, malformed, unknown, revoked, and expired bearers",
  () =>
    Effect.gen(function* () {
      const activeToken = "t3mgmt_mcp-http-management-key_active-secret";
      const managementService = makeManagementService((candidate) =>
        Effect.succeed(
          candidate === activeToken ? Option.some(managementPrincipal) : Option.none(),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;
          const candidates = [
            undefined,
            "not-a-bearer",
            "t3mgmt_mcp-http-management-key_unknown-secret",
            "t3mgmt_mcp-http-management-key_revoked-secret",
            "t3mgmt_mcp-http-management-key_expired-secret",
          ] as const;
          const responses = [];
          for (const candidate of candidates) {
            const response = yield* httpClient.post(
              "/mcp",
              candidate === undefined
                ? {
                    headers: { accept: "application/json, text/event-stream" },
                    body: HttpBody.text(initializePayload, "application/json"),
                  }
                : mcpRequest(candidate, initializePayload),
            );
            responses.push({ status: response.status, body: yield* response.text });
          }
          expect(responses).toHaveLength(candidates.length);
          for (const response of responses) {
            expect(response.status).toBe(401);
            expect(response.body).toContain('"error":"invalid_mcp_credential"');
            expect(response.body).toContain("A valid MCP bearer credential is required.");
          }
          expect(new Set(responses.map((response) => response.body)).size).toBe(1);
        }).pipe(Effect.provide(makeMcpHttpTestLayer(managementService))),
      );
    }),
);

it.effect("authenticates a persisted key after rebuilding the service and HTTP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repository = yield* ManagementApiKeys.ManagementApiKeyRepository;
      const firstService = yield* ManagementApiKeyService.make;
      const issued = yield* firstService.create({
        name: "Persisted HTTP integration",
        scopes: managementScopes,
      });
      const rebuiltService = yield* ManagementApiKeyService.make;
      expect(rebuiltService).not.toBe(firstService);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;
          const initialize = yield* httpClient.post(
            "/mcp",
            mcpRequest(issued.secret, initializePayload),
          );
          expect(initialize.status).toBe(200);
          const sessionId = initialize.headers["mcp-session-id"];
          expect(sessionId).toBeDefined();

          const models = yield* httpClient.post(
            "/mcp",
            mcpRequest(issued.secret, callListModelsPayload, sessionId),
          );
          expect(models.status).toBe(200);
          expect(yield* models.text).toContain(environmentId);
        }).pipe(Effect.provide(makeMcpHttpTestLayer(rebuiltService))),
      );
      // Keep the repository alive until the rebuilt transport has finished
      // resolving the token from the in-memory persisted row.
      void repository;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ManagementApiKeys.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          NodeServices.layer,
        ),
      ),
    ),
  ),
);

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("recovers preview status through a healthy host within the tool timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      let staleConnectionId = "";
      const staleEvents = yield* broker.connect({
        clientId: "mcp-stale-client",
        environmentId,
      });
      yield* Stream.runForEach(staleEvents, (event) => {
        if (event.type === "connected") staleConnectionId = event.connectionId;
        return Effect.void;
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.focusHost({
        clientId: "mcp-stale-client",
        environmentId,
        connectionId: staleConnectionId,
        focused: true,
      });

      const healthyEvents = yield* broker.connect({
        clientId: "mcp-healthy-client",
        environmentId,
      });
      yield* Stream.runForEach(healthyEvents, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-healthy-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: {
                available: true,
                visible: true,
                tabId,
                url: "http://example.test/",
                title: "Recovered",
                loading: false,
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusFiber = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* TestClock.adjust(3_000);
      const status = yield* Fiber.join(statusFiber);

      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
        title: "Recovered",
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("registers the thread toolkit alongside preview", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const create = server.tools.find(({ tool }) => tool.name === "create_thread");
    expect(create?.tool.annotations).toMatchObject({
      title: "Create thread",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });

    const read = server.tools.find(({ tool }) => tool.name === "read_thread");
    expect(read?.tool.annotations).toMatchObject({
      title: "Read thread",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });

    const listModels = server.tools.find(({ tool }) => tool.name === "list_models");
    expect(listModels?.tool.annotations).toMatchObject({
      title: "List models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const wait = server.tools.find(({ tool }) => tool.name === "wait_threads");
    expect(wait?.tool.annotations).toMatchObject({
      title: "Wait for threads",
      readOnlyHint: true,
      idempotentHint: false,
    });
  }).pipe(Effect.provide(ThreadRegistrationTestLayer)),
);

it("keeps optional thread defaults optional in generated MCP schemas", () => {
  const listModelsSchema = Tool.getJsonSchema(ThreadToolkit.tools.list_models) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const listSchema = Tool.getJsonSchema(ThreadToolkit.tools.list_threads) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const readSchema = Tool.getJsonSchema(ThreadToolkit.tools.read_thread) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const hasNull = (value: unknown): boolean => {
    if (value === "null") return true;
    if (Array.isArray(value)) return value.some(hasNull);
    return typeof value === "object" && value !== null && Object.values(value).some(hasNull);
  };

  expect(listSchema.required ?? []).not.toContain("limit");
  expect(listModelsSchema.required ?? []).not.toContain("driver");
  expect(readSchema.required ?? []).not.toEqual(
    expect.arrayContaining(["turnLimit", "includeOutputs", "maxOutputCharsPerItem"]),
  );
  for (const schema of [
    listSchema.properties?.limit,
    listModelsSchema.properties?.driver,
    readSchema.properties?.turnLimit,
    readSchema.properties?.includeOutputs,
    readSchema.properties?.maxOutputCharsPerItem,
  ]) {
    expect(hasNull(schema)).toBe(false);
  }
});
