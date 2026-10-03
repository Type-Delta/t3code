import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Preview from "../../../preview/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  // The preview capability already reflects the calling project's access setting.
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  return { scope, manager: yield* Preview.PreviewManager };
});
export const PreviewControlsHandlersLive = PreviewControlsToolkit.toLayer({
  t3_preview_list: (input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const threadId = McpInvocationContext.getInvocationThreadId(scope);
      if (threadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Preview controls require an owning provider thread.",
        });
      const result = yield* manager.list({ threadId });
      const start = input.cursor ?? 0;
      const end = start + (input.limit ?? 20);
      return {
        ...result,
        sessions: result.sessions.slice(start, end),
        nextCursor: end < result.sessions.length ? end : null,
      };
    }),
  t3_preview_close: (input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const threadId = McpInvocationContext.getInvocationThreadId(scope);
      if (threadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Preview controls require an owning provider thread.",
        });
      yield* manager.close({ threadId, tabId: input.tabId }).pipe(Effect.mapError(unavailable));
      return {};
    }),
});
