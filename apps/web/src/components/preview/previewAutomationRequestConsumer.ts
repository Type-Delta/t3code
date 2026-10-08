import type {
  PreviewAutomationHost,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  PreviewAutomationOperationError,
  type PreviewAutomationOperationContext,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

type AutomationStreamResult<E> = AsyncResult.AsyncResult<PreviewAutomationStreamEvent, E>;

export function serializePreviewAutomationError(
  error: unknown,
  context: PreviewAutomationOperationContext,
): NonNullable<PreviewAutomationResponse["error"]> {
  return serializePreviewAutomationHostError(
    PreviewAutomationOperationError.fromCause({ ...context, cause: error }),
  );
}

export function createPreviewAutomationRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AutomationStreamResult<E>>;
  readonly clientId: PreviewAutomationHost["clientId"];
  readonly connectionAtom: Atom.Writable<PreviewAutomationStreamEvent["connectionId"] | null>;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly requestHandlerAtom: Atom.Atom<{
    readonly handle: (request: PreviewAutomationRequest) => Promise<unknown>;
  }>;
  readonly respond: (response: PreviewAutomationResponse) => Promise<unknown>;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    get.mount(options.connectionAtom);
    get.mount(options.requestHandlerAtom);
    let disposed = false;
    let activeConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let connectionExplicitlyAnnounced = false;
    let supportsRequestAcknowledgement = false;
    let reportedConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let requestsVersion = 0;

    const consume = (result: AutomationStreamResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") {
        activeConnectionId = event.connectionId;
        connectionExplicitlyAnnounced = true;
        supportsRequestAcknowledgement = event.supportsRequestAcknowledgement === true;
      } else if (activeConnectionId === null) {
        activeConnectionId = event.connectionId;
      } else if (activeConnectionId !== event.connectionId) {
        if (connectionExplicitlyAnnounced) return;
        activeConnectionId = event.connectionId;
      }
      if (reportedConnectionId !== event.connectionId) {
        reportedConnectionId = event.connectionId;
        get.set(options.connectionAtom, event.connectionId);
      }
      if (event.type === "connected") {
        return;
      }
      const request = event.request;
      const acknowledge = event.supportsRequestAcknowledgement ?? supportsRequestAcknowledgement;
      const handle = get.once(options.requestHandlerAtom).handle;
      const respond = (
        response: Pick<PreviewAutomationResponse, "ok" | "result" | "error" | "phase">,
      ) =>
        options.respond({
          clientId: options.clientId,
          connectionId: event.connectionId,
          requestId: request.requestId,
          ...response,
        });
      const run = async () => {
        if (acknowledge) await respond({ phase: "started", ok: true });
        if (disposed || activeConnectionId !== event.connectionId) return;
        let response: Pick<PreviewAutomationResponse, "ok" | "result" | "error">;
        try {
          const value = await handle(request);
          response = { ok: true, ...(value === undefined ? {} : { result: value }) };
        } catch (error) {
          response = {
            ok: false,
            error: serializePreviewAutomationError(error, {
              requestId: request.requestId,
              operation: request.operation,
              environmentId: options.environmentId,
              threadId: request.threadId,
              tabId: request.tabId ?? null,
            }),
          };
        }
        await respond(response);
      };
      void run().catch(() => {
        // Transport reconnect owns response failures. Do not start page work
        // when the broker could not receive its acknowledgement.
      });
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initialRequest = get.once(options.requestsAtom);
    if (AsyncResult.isSuccess(initialRequest)) {
      activeConnectionId = initialRequest.value.connectionId;
      connectionExplicitlyAnnounced = initialRequest.value.type === "connected";
      if (initialRequest.value.type === "connected") {
        supportsRequestAcknowledgement =
          initialRequest.value.supportsRequestAcknowledgement === true;
        reportedConnectionId = initialRequest.value.connectionId;
        get.set(options.connectionAtom, initialRequest.value.connectionId);
      }
    }
    get.subscribe(options.requestsAtom, (result) => {
      requestsVersion += 1;
      consume(result);
    });
    queueMicrotask(() => {
      const initialConnectionWasSkipped =
        AsyncResult.isSuccess(initialRequest) &&
        initialRequest.value.connectionId === activeConnectionId &&
        initialRequest.value.connectionId !== reportedConnectionId;
      if (!disposed && (requestsVersion === 0 || initialConnectionWasSkipped)) {
        consume(initialRequest);
      }
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
