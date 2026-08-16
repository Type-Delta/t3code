import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

const status = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:server:zrok-share-status",
  tag: WS_METHODS.serverGetZrokShareStatus,
  staleTimeMs: 5_000,
  refreshIntervalMs: 5_000,
});

export const zrokShare = {
  status,
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:server:start-zrok-share",
    tag: WS_METHODS.serverStartZrokShare,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    onSettled: (target, registry) =>
      Effect.sync(() =>
        registry.refresh(status({ environmentId: target.environmentId, input: {} })),
      ),
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:server:stop-zrok-share",
    tag: WS_METHODS.serverStopZrokShare,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    onSettled: (target, registry) =>
      Effect.sync(() =>
        registry.refresh(status({ environmentId: target.environmentId, input: {} })),
      ),
  }),
};
