import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationMcp from "./OrchestratorMcpService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadId = McpInvocationContext.getInvocationThreadId(scope);
  if (threadId === undefined || scope.capabilities?.has("orchestration") !== true) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const caller = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return { scope, threads, caller };
});

function assertLiveCaller({
  caller,
  scope,
}: {
  caller: OrchestrationV2ThreadShell;
  scope: McpInvocationContext.McpInvocationScope;
}) {
  const providerInstanceId = McpInvocationContext.getInvocationProviderInstanceId(scope);
  return caller.archivedAt !== null ||
    caller.activeRunId === null ||
    providerInstanceId === undefined ||
    caller.providerInstanceId !== providerInstanceId
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      )
    : Effect.void;
}
export const readMutationCaller = Effect.fn("mcp.readMutationCaller")(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  return context;
});

/** Resolve the credential's project before looking up a caller-supplied thread. */
export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const { scope, threads, caller } = yield* readCaller();
  const isGlobal = scope.mcpToolScope === "global";
  const requestedThreadId = threadId ?? caller.id;
  const mapProjectionError = (error: unknown) => {
    const tag =
      typeof error === "object" && error !== null && "_tag" in error
        ? (error as { readonly _tag?: unknown })._tag
        : undefined;
    return tag === "ThreadManagementThreadNotFoundError"
      ? new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: "The thread was not found in the calling project.",
        })
      : unavailable();
  };
  const projection = isGlobal
    ? yield* threads
        .getThreadRecords(requestedThreadId, fields, {
          turnItemTypes: ["user_input_request"],
        })
        .pipe(Effect.mapError(mapProjectionError))
    : yield* threads
        .getProjectThreadRecords(
          { projectId: caller.projectId, threadId: requestedThreadId },
          fields,
          { turnItemTypes: ["user_input_request"] },
        )
        .pipe(Effect.mapError(mapProjectionError));
  return { scope, threads, caller, projection };
});

/** Resolve an explicitly scoped tool target for provider sessions or management keys. */
export const readAuthorizedToolThread = Effect.fn("mcp.readAuthorizedToolThread")(function* <
  K extends ProjectionRecordField = never,
>(toolName: string, threadId: ThreadId | undefined, fields: ReadonlyArray<K> = []) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!McpInvocationContext.isManagementKeyPrincipal(scope.principal))
    return yield* readThread(threadId, fields);
  if (!McpInvocationContext.managementKeyCanUseTool(scope, toolName)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This management key cannot use the requested thread tool.",
    });
  }
  if (threadId === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "A management key must provide threadId for this tool.",
    });
  }

  const threads = yield* ThreadManagement.ThreadManagementService;
  const projection = yield* threads
    .getThreadRecords(threadId, fields, { turnItemTypes: ["user_input_request"] })
    .pipe(Effect.mapError(() => unavailable()));
  return { scope, threads, projection, caller: undefined };
});

export const readWritableThread = Effect.fn("mcp.readWritableThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readThread(threadId, fields);
  yield* assertLiveCaller(context);
  yield* OrchestrationMcp.resolveRuntimeMode(
    context.caller.runtimeMode,
    context.projection.thread.runtimeMode,
  );
  yield* OrchestrationMcp.resolveInteractionMode(
    context.caller.interactionMode,
    context.projection.thread.interactionMode,
  );
  return context;
});

/** Management keys have no active provider run; the scoped key permission authorizes mutations. */
export const readAuthorizedWritableToolThread = Effect.fn("mcp.readAuthorizedWritableToolThread")(
  function* <K extends ProjectionRecordField = never>(
    toolName: string,
    threadId: ThreadId | undefined,
    fields: ReadonlyArray<K> = [],
  ) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return McpInvocationContext.isManagementKeyPrincipal(scope.principal)
      ? yield* readAuthorizedToolThread(toolName, threadId, fields)
      : yield* readWritableThread(threadId, fields);
  },
);

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
});
