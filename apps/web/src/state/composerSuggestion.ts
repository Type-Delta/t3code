import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  environmentRpcKey,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const composerSuggestion = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:composer:suggestNextPrompt",
  tag: WS_METHODS.composerSuggestion,
  concurrency: { mode: "singleFlight", key: environmentRpcKey },
});
