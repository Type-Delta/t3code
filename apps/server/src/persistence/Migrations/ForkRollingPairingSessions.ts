import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  if (columns.some((column) => column.name === "rolling")) return;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN rolling INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    UPDATE auth_sessions SET rolling = 2
    WHERE subject = 'one-time-token'
      AND method IN ('browser-session-cookie', 'bearer-access-token')
      AND client_device_type <> 'bot'
      AND revoked_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND abs((julianday(expires_at) - julianday(issued_at)) - 30) < 0.000001
  `;
});
