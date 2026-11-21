// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  GATEWAY_PENDING_MAX_MS,
  GatewayPendingPairing,
  type GatewayConfig,
} from "./GatewayConfig.ts";

const MAX_PENDING_FILE_BYTES = 4096;
// A user can fill their own folder; never read more than this many markers from one per request.
export const MAX_PENDING_FILES_PER_USER = 64;
// The `<uuid>.json` name `t3 gateway pair` links in; its `.pending-*` staging files are skipped.
export const PENDING_FILE_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;
const decodePendingPairing = Schema.decodeUnknownExit(Schema.fromJsonString(GatewayPendingPairing));

// O_NOFOLLOW plus fstat on the open handle: the owner we read is the file we parse.
const readOwnedFile = async (filePath: string) => {
  const handle = await NodeFSP.open(
    filePath,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    // The owner can grow the file after fstat, so the read itself is bounded too.
    const buffer = Buffer.alloc(MAX_PENDING_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PENDING_FILE_BYTES) return undefined;
    return { uid: info.uid, text: buffer.toString("utf8", 0, bytesRead) };
  } finally {
    await handle.close();
  }
};

// The marker when it is live and within the maximum life.
const liveMarker = (text: string, nowMs: number) => {
  const decoded = decodePendingPairing(text);
  return Exit.isSuccess(decoded) &&
    decoded.value.expiresAt > nowMs &&
    decoded.value.expiresAt <= nowMs + GATEWAY_PENDING_MAX_MS
    ? decoded.value
    : undefined;
};

/** A user's live markers: the latest expiry, and each marker's expiry by its token hash. */
export interface PendingUser {
  readonly expiresAt: number;
  readonly tokens: ReadonlyMap<string, number>;
}

const errorCode = (error: unknown): unknown => Object(error).code;

// The live markers in `<pairingDir>/<user>` owned by `uid`, undefined when none, or "unknown"
// when the folder could not be read to the end.
const userPending = async (
  folder: string,
  uid: number,
  nowMs: number,
): Promise<PendingUser | undefined | "unknown"> => {
  let dir: NodeFS.Dir;
  try {
    dir = await NodeFSP.opendir(folder);
  } catch (error) {
    // Users enrolled before per-user folders existed have none: nobody is pairing there.
    return errorCode(error) === "ENOENT" ? undefined : "unknown";
  }
  let examined = 0;
  const tokens = new Map<string, number>();
  // The iterator closes `dir` when the loop ends, returns or throws.
  try {
    for await (const entry of dir) {
      if (!entry.isFile() || !PENDING_FILE_NAME.test(entry.name)) continue;
      if (++examined > MAX_PENDING_FILES_PER_USER) return "unknown";
      let file: Awaited<ReturnType<typeof readOwnedFile>>;
      try {
        file = await readOwnedFile(NodePath.join(folder, entry.name));
      } catch (error) {
        // Removed since the listing, or swapped for a symlink: not a marker.
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") continue;
        return "unknown";
      }
      if (file === undefined || file.uid !== uid) continue;
      const marker = liveMarker(file.text, nowMs);
      if (marker !== undefined)
        tokens.set(
          marker.tokenSha256,
          Math.max(marker.expiresAt, tokens.get(marker.tokenSha256) ?? 0),
        );
    }
  } catch {
    return "unknown";
  }
  return tokens.size === 0 ? undefined : { expiresAt: Math.max(...tokens.values()), tokens };
};

/**
 * Enrolled users with a live marker in their own `<pairingDir>/<user>` folder, owned by their
 * registered uid. "unknown" when any folder could not be read to the end.
 */
export const readPendingUsers = async (
  pairingDir: string,
  users: GatewayConfig["users"],
  nowMs: number,
): Promise<Map<string, PendingUser> | "unknown"> => {
  const results = await Promise.all(
    Object.entries(users).map(
      async ([user, { uid }]) =>
        [user, await userPending(NodePath.join(pairingDir, user), uid, nowMs)] as const,
    ),
  );
  const pending = new Map<string, PendingUser>();
  for (const [user, entry] of results) {
    if (entry === "unknown") return "unknown";
    if (entry !== undefined) pending.set(user, entry);
  }
  return pending;
};
