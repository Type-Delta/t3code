import {
  StorageUsageError,
  type StorageUsage as StorageUsageResult,
  type StorageUsageCategoryId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- statfs and inode-aware walking require Node filesystem APIs.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The filesystem walker uses native path semantics.
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { scratchFolderRoot } from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";

const ids = ["database", "worktrees", "checkpoints", "logs", "attachments", "other"] as const;

export class StorageUsage extends Context.Service<
  StorageUsage,
  { readonly measure: () => Effect.Effect<StorageUsageResult, StorageUsageError> }
>()("t3/persistence/StorageUsage") {}

// Split an ancestor into siblings so a nested managed worktrees directory is counted only once.
async function excludeDirectory(
  target: string,
  excluded: string,
  windows: boolean,
): Promise<string[]> {
  const relative = NodePath.relative(
    windows ? target.toLowerCase() : target,
    windows ? excluded.toLowerCase() : excluded,
  );
  if (relative === "") return [];
  if (
    relative.startsWith(`..${NodePath.sep}`) ||
    relative === ".." ||
    NodePath.isAbsolute(relative)
  ) {
    return [target];
  }
  const [next] = relative.split(NodePath.sep);
  if (!next) return [target];
  try {
    const entries = await NodeFSP.readdir(target);
    const siblings = entries
      .filter((entry) => (windows ? entry.toLowerCase() : entry) !== next)
      .map((entry) => NodePath.join(target, entry));
    return [
      ...siblings,
      ...(await excludeDirectory(NodePath.join(target, next), excluded, windows)),
    ];
  } catch {
    return [];
  }
}

async function walkBytes(paths: readonly string[]): Promise<number> {
  const seen = new Set<string>();
  const walk = async (target: string): Promise<number> => {
    try {
      const info = await NodeFSP.lstat(target);
      if (info.isSymbolicLink()) return 0;
      const key = `${info.dev}:${info.ino}`;
      if (seen.has(key)) return 0;
      seen.add(key);
      if (!info.isDirectory()) return info.size;
      const children = await NodeFSP.readdir(target);
      let total = 0;
      for (const child of children) total += await walk(NodePath.join(target, child));
      return total;
    } catch {
      return 0;
    }
  };
  let total = 0;
  for (const target of paths) total += await walk(target);
  return total;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;

  const runMeasurement = Effect.fn("StorageUsage.measure")(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ worktreesDirectory: "" })),
    );
    const worktrees =
      resolveWorktreesDirectory(current.worktreesDirectory, config.worktreesDir, path, home) ??
      config.worktreesDir;
    const canonical = (target: string) =>
      NodeFSP.realpath(target).catch(() => path.resolve(target));
    const windows = platform === "win32";
    const key = (target: string) => (windows ? target.toLowerCase() : target);
    const contains = (parent: string, child: string) => {
      const relative = path.relative(key(parent), key(child));
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      );
    };
    const [stateDir, cacheDir, scratchDir, ...roots] = yield* Effect.promise(() =>
      Promise.all([
        canonical(config.stateDir),
        canonical(config.providerStatusCacheDir),
        canonical(scratchFolderRoot(config.baseDir, path)),
        canonical(worktrees),
        canonical(config.worktreesDir),
      ]),
    );
    const worktreeRoots = roots.filter(
      (root, index) =>
        !roots.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            contains(other, root) &&
            (key(other) !== key(root) || otherIndex < index),
        ),
    );
    const excludeAll = async (targets: string[], excluded: readonly string[]) => {
      for (const item of excluded) {
        targets = (
          await Promise.all(targets.map((target) => excludeDirectory(target, item, windows)))
        ).flat();
      }
      return targets;
    };
    const entries = yield* Effect.promise(() =>
      NodeFSP.readdir(stateDir, { withFileTypes: true }).catch(() => []),
    );
    const paths: Record<StorageUsageCategoryId, string[]> = {
      database: [],
      worktrees: yield* Effect.promise(() =>
        excludeAll(worktreeRoots, [stateDir, cacheDir, scratchDir]),
      ),
      checkpoints: [],
      logs: [],
      attachments: [],
      other: [cacheDir, scratchDir],
    };
    for (const entry of entries) {
      const id =
        entry.isFile() && /\.sqlite(?:-wal|-shm|-journal)?$/.test(entry.name)
          ? "database"
          : entry.name === "checkpoints" || entry.name === "logs" || entry.name === "attachments"
            ? entry.name
            : "other";
      const selected = yield* Effect.promise(() =>
        excludeAll(
          [path.join(stateDir, entry.name)],
          [...worktreeRoots.filter((root) => !contains(root, stateDir)), cacheDir, scratchDir],
        ),
      );
      paths[id].push(...selected);
    }
    const categories = yield* Effect.forEach(
      ids,
      (id) =>
        Effect.gen(function* () {
          const existing = yield* Effect.promise(async () => {
            const results = await Promise.all(
              paths[id].map(async (target) => {
                try {
                  await NodeFSP.lstat(target);
                  return target;
                } catch {
                  return null;
                }
              }),
            );
            return results.filter((target): target is string => target !== null);
          });
          if (existing.length === 0) return { id, bytes: 0 };
          if (platform === "win32")
            return { id, bytes: yield* Effect.promise(() => walkBytes(existing)) };
          const output = yield* runner
            .run({ command: "du", args: ["-skc", ...existing], timeout: "10 minutes" })
            .pipe(Effect.mapError((cause) => new StorageUsageError({ reason: cause.message })));
          const match = /^(\d+)\s+total\s*$/.exec(output.stdout.trimEnd().split("\n").at(-1) ?? "");
          if (output.timedOut || output.stdoutTruncated || match === null) {
            return yield* new StorageUsageError({ reason: "du printed no valid total." });
          }
          const bytes = Number(match[1]) * 1024;
          return { id, bytes };
        }),
      { concurrency: "unbounded" },
    );
    const disk = yield* Effect.promise(() => NodeFSP.statfs(config.baseDir).catch(() => null));
    return {
      categories,
      totalBytes: categories.reduce((sum, category) => sum + category.bytes, 0),
      diskFreeBytes: disk === null ? null : disk.bavail * disk.bsize,
      diskTotalBytes: disk === null ? null : disk.blocks * disk.bsize,
    };
  });
  let inFlight: Deferred.Deferred<StorageUsageResult, StorageUsageError> | undefined;
  const measure = Effect.fn("StorageUsage.sharedMeasure")(function* () {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<StorageUsageResult, StorageUsageError>();
        const shared = yield* Effect.sync(() => {
          if (inFlight) return inFlight;
          inFlight = candidate;
          return candidate;
        });
        if (shared === candidate) {
          yield* runMeasurement().pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.sync(() => {
                inFlight = undefined;
              }).pipe(Effect.andThen(Deferred.done(candidate, exit))),
            ),
            Effect.forkDetach,
          );
        }
        return yield* restore(Deferred.await(shared));
      }),
    );
  });
  return StorageUsage.of({ measure });
});

export const layer = Layer.effect(StorageUsage, make);
