// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";

export interface CheckpointDiagnosticsSummary {
  readonly sidecarLocation: string;
  readonly repositoryCount: number;
  readonly totalSizeBytes: number;
  readonly queue: {
    readonly pending: number;
    readonly running: number;
    readonly oldestAgeMs: number | null;
  };
  readonly recoverableFailures: {
    readonly capture: number;
    readonly navigation: number;
    readonly deletion: number;
    readonly migration: number;
  };
}

export class CheckpointDiagnosticsError extends Schema.TaggedErrorClass<CheckpointDiagnosticsError>()(
  "CheckpointDiagnosticsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class CheckpointDiagnostics extends Context.Service<
  CheckpointDiagnostics,
  {
    readonly summarize: () => Effect.Effect<
      CheckpointDiagnosticsSummary,
      CheckpointDiagnosticsError
    >;
  }
>()("t3/checkpointing/CheckpointDiagnostics") {}

const directorySize = async (root: string): Promise<number> => {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await NodeFSP.readdir(current, { withFileTypes: true });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw cause;
    }
    for (const entry of entries) {
      const absolute = NodePath.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else {
        const info = await NodeFSP.lstat(absolute);
        total += info.size;
      }
    }
  }
  return total;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;

  const summarize: CheckpointDiagnostics["Service"]["summarize"] = () =>
    Effect.gen(function* () {
      const [repositoryRows, queueRows, oldestRows, failureRows, totalSizeBytes, now] =
        yield* Effect.all([
          sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count" FROM checkpoint_repositories WHERE deleted_at IS NULL
          `,
          sql<{ readonly state: string; readonly count: number }>`
            SELECT state, COUNT(*) AS "count"
            FROM checkpoint_capture_jobs
            WHERE state IN ('pending', 'running')
            GROUP BY state
          `,
          sql<{ readonly createdAt: string | null }>`
            SELECT MIN(created_at) AS "createdAt"
            FROM checkpoint_capture_jobs
            WHERE state IN ('pending', 'running')
          `,
          sql<{
            readonly capture: number;
            readonly navigation: number;
            readonly deletion: number;
            readonly migration: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM checkpoint_capture_jobs WHERE state = 'error') AS "capture",
              (SELECT COUNT(*) FROM checkpoint_navigation_operations
               WHERE phase = 'needs-recovery') AS "navigation",
              ((SELECT COUNT(*) FROM checkpoint_snapshots
                WHERE deletion_error_code IS NOT NULL AND deleted_at IS NULL) +
               (SELECT COUNT(*) FROM checkpoint_repositories
                WHERE deletion_error_code IS NOT NULL AND deleted_at IS NULL)) AS "deletion",
              (SELECT COUNT(*) FROM checkpoint_legacy_migrations WHERE state = 'error') AS "migration"
          `,
          Effect.tryPromise({
            try: () => directorySize(config.checkpointsDir),
            catch: (cause) => new CheckpointDiagnosticsError({ operation: "directorySize", cause }),
          }),
          Clock.currentTimeMillis,
        ]);
      const queue = new Map(queueRows.map((row) => [row.state, Number(row.count)]));
      const oldest = oldestRows[0]?.createdAt;
      return {
        sidecarLocation: config.checkpointsDir,
        repositoryCount: Number(repositoryRows[0]?.count ?? 0),
        totalSizeBytes,
        queue: {
          pending: queue.get("pending") ?? 0,
          running: queue.get("running") ?? 0,
          oldestAgeMs: oldest ? Math.max(0, now - Date.parse(oldest)) : null,
        },
        recoverableFailures: failureRows[0] ?? {
          capture: 0,
          navigation: 0,
          deletion: 0,
          migration: 0,
        },
      };
    }).pipe(
      Effect.mapError((cause) => new CheckpointDiagnosticsError({ operation: "summarize", cause })),
    );

  return CheckpointDiagnostics.of({ summarize });
});

export const layer = Layer.effect(CheckpointDiagnostics, make);
