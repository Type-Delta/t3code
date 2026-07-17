import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Distinguishes provider-aware navigation from an isolated workspace restore. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE checkpoint_navigation_operations
    ADD COLUMN mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'files-only'))
  `;
});
