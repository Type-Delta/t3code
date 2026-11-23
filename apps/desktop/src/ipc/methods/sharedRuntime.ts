import { DesktopSharedRuntimeStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopGateway from "../../backend/DesktopGateway.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

// Fork-only (gateway self-service): join or leave shared T3 Code from Settings.

export const getSharedRuntimeState = makeIpcMethod({
  channel: IpcChannels.GET_SHARED_RUNTIME_STATE_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopSharedRuntimeStateSchema),
  handler: Effect.fn("desktop.ipc.sharedRuntime.getState")(function* () {
    const gateway = yield* DesktopGateway.DesktopGateway;
    const status = yield* gateway.status;
    if (Option.isNone(status)) return null;
    const { enrolled, selfService, joinNeedsPassword, runtimeVersion } = status.value;
    return {
      attached: yield* Ref.get(gateway.attached),
      enrolled,
      selfService,
      joinNeedsPassword,
      runtimeVersion,
    };
  }),
});

export const joinSharedRuntime = makeIpcMethod({
  channel: IpcChannels.JOIN_SHARED_RUNTIME_CHANNEL,
  payload: Schema.UndefinedOr(Schema.String),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sharedRuntime.join")(function* (password) {
    const gateway = yield* DesktopGateway.DesktopGateway;
    const primary = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
    // The shared backend needs this T3 home, which the app's own backend holds while it runs.
    const wasRunning = (yield* primary.snapshot).desiredRunning;
    if (wasRunning)
      yield* primary.stop({ timeout: DesktopBackendManager.BACKEND_QUIT_STOP_TIMEOUT });
    yield* gateway
      .join(password)
      .pipe(Effect.tapError(() => (wasRunning ? primary.start : Effect.void)));
    yield* (yield* DesktopLifecycle.DesktopLifecycle).relaunch("joined shared T3 Code");
  }),
});

export const leaveSharedRuntime = makeIpcMethod({
  channel: IpcChannels.LEAVE_SHARED_RUNTIME_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sharedRuntime.leave")(function* () {
    yield* (yield* DesktopGateway.DesktopGateway).leave;
    yield* (yield* DesktopLifecycle.DesktopLifecycle).relaunch("left shared T3 Code");
  }),
});
