import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./064_PullRequestFilesViewed.ts";
import OrchestrationV2 from "./055_OrchestrationV2.ts";
import RemoveRedundantProjectionIndexes from "./056_RemoveRedundantProjectionIndexes.ts";
import AutoSettleDisabledAt from "./066_ProjectionThreadsAutoSettleDisabledAt.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const v2 = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_events'
  `;

  // Fork databases already use IDs through 66. Upstream and preview databases
  // keep their own ledger and reach this schema through the new, non-colliding ID.
  if (v2.length === 0) yield* OrchestrationV2;
  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "suggestion")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN suggestion TEXT`;
  }
  yield* PullRequestFilesViewed;
  yield* AutoSettleDisabledAt;
  yield* RemoveRedundantProjectionIndexes;
});
