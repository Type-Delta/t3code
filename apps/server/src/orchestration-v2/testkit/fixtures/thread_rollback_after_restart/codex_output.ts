import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertThreadRollbackOutput } from "../thread_rollback/codex_output.ts";

export function assertThreadRollbackAfterRestartOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertThreadRollbackOutput(result, transcript);
  const methods = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    "method" in entry.frame
      ? [String(entry.frame.method)]
      : [],
  );
  const fork = methods.indexOf("thread/fork");
  assert.isAbove(fork, 0, "rollback must fork the preserved native history");
  assert.equal(methods.filter((method) => method === "initialize").length, 2);
  assert.equal(
    methods[fork - 1],
    "initialized",
    "the fresh app-server must initialize before forking the saved native source",
  );
}
