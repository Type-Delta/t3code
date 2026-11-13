import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "./ForkRollingPairingSessions.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("rolling pairing migration", (it) => {
  it.effect("marks only active default-lifetime pairing candidates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE auth_sessions (session_id TEXT, subject TEXT, method TEXT, client_device_type TEXT, issued_at TEXT, expires_at TEXT, revoked_at TEXT)`;
      yield* sql`INSERT INTO auth_sessions VALUES
      ('pair', 'one-time-token', 'bearer-access-token', 'mobile', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+20 days'), NULL),
      ('expired', 'one-time-token', 'bearer-access-token', 'mobile', strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), NULL),
      ('revoked', 'one-time-token', 'browser-session-cookie', 'desktop', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+20 days'), 'revoked'),
      ('bot', 'one-time-token', 'bearer-access-token', 'bot', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+20 days'), NULL),
      ('fixed', 'one-time-token', 'bearer-access-token', 'mobile', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'), NULL),
      ('mcp', 'mcp-client', 'bearer-access-token', 'mobile', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+20 days'), NULL)`;
      yield* migration;
      const rows = yield* sql<{
        session_id: string;
        rolling: number;
      }>`SELECT session_id, rolling FROM auth_sessions ORDER BY session_id`;
      assert.deepEqual(
        rows.map((row) => [row.session_id, row.rolling]),
        [
          ["bot", 0],
          ["expired", 0],
          ["fixed", 0],
          ["mcp", 0],
          ["pair", 2],
          ["revoked", 0],
        ],
      );
      yield* migration;
      assert.deepEqual(yield* sql`SELECT rolling FROM auth_sessions WHERE session_id = 'pair'`, [
        { rolling: 2 },
      ]);
    }),
  );
});
