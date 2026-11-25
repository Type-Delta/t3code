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
import type { GatewayPlatform } from "./platform/GatewayPlatform.ts";

const MAX_PENDING_FILE_BYTES = 4096;
// A user can fill their own folder; never read more than this many markers from one per request.
export const MAX_PENDING_FILES_PER_USER = 64;
// The `<uuid>.json` name `t3 gateway pair` links in; its `.pending-*` staging files are skipped.
export const PENDING_FILE_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;
const decodePendingPairing = Schema.decodeUnknownExit(Schema.fromJsonString(GatewayPendingPairing));

const errorCode = (error: unknown): unknown => Object(error).code;

/**
 * A marker's owner and contents, read through an open handle so the owner is that of the file
 * parsed. Undefined when it is gone or not a regular file. Windows has no O_NOFOLLOW, so the path
 * must still name the opened file afterwards: a link swapped in after the listing is never read.
 */
export const readOwnedFile = async (filePath: string) => {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      filePath,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    const entry = await NodeFSP.lstat(filePath, { bigint: true }).catch(() => undefined);
    if (!info.isFile() || !entry?.isFile() || entry.ino !== info.ino || entry.dev !== info.dev) {
      return undefined;
    }
    // The owner can grow the file after fstat, so the read itself is bounded too.
    const buffer = Buffer.alloc(MAX_PENDING_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PENDING_FILE_BYTES) return undefined;
    return { uid: Number(info.uid), text: buffer.toString("utf8", 0, bytesRead) };
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

// The live markers in `<pairingDir>/<user>` attributed to `uid`, undefined when none, or "unknown"
// when the folder could not be read to the end.
const userPending = async (
  folder: string,
  uid: number | string,
  nowMs: number,
  attribution: GatewayPlatform["markerAttribution"],
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
      } catch {
        return "unknown";
      }
      if (file === undefined || (attribution === "file-owner" && file.uid !== uid)) continue;
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
 * registered account unless `attribution` trusts the folder. "unknown" when any folder could not
 * be read to the end.
 */
export const readPendingUsers = async (
  pairingDir: string,
  users: GatewayConfig["users"],
  nowMs: number,
  attribution: GatewayPlatform["markerAttribution"],
): Promise<Map<string, PendingUser> | "unknown"> => {
  const results = await Promise.all(
    Object.entries(users).map(
      async ([user, { uid }]) =>
        [
          user,
          await userPending(NodePath.join(pairingDir, user), uid, nowMs, attribution),
        ] as const,
    ),
  );
  const pending = new Map<string, PendingUser>();
  for (const [user, entry] of results) {
    if (entry === "unknown") return "unknown";
    if (entry !== undefined) pending.set(user, entry);
  }
  return pending;
};
