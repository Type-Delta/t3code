// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { GatewayConfig } from "./GatewayConfig.ts";

const decodeGatewayConfig = Schema.decodeUnknownExit(Schema.fromJsonString(GatewayConfig));

const readGatewayConfig = async (path: string): Promise<GatewayConfig> => {
  const text = await NodeFSP.readFile(path, "utf8");
  const decoded = decodeGatewayConfig(text);
  if (Exit.isFailure(decoded)) {
    throw new Error(`Invalid gateway config ${path}: ${String(decoded.cause)}`);
  }
  return decoded.value;
};

/**
 * Rereads the config when its inode, size, mtime, or mode changes.
 * A broken edit keeps the last good config and reports through `onError`.
 */
export const makeGatewayConfigSource = async (path: string, onError: (error: unknown) => void) => {
  const stamp = async () => {
    const info = await NodeFSP.stat(path, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.mode}`;
  };
  let current = { stamp: await stamp().catch(() => ""), config: await readGatewayConfig(path) };
  const reload = async () => {
    const next = await stamp().catch(() => current.stamp);
    if (next === current.stamp) return current.config;
    try {
      current = { stamp: next, config: await readGatewayConfig(path) };
    } catch (error) {
      current = { ...current, stamp: next };
      onError(error);
    }
    return current.config;
  };
  let running: Promise<GatewayConfig> | undefined;
  let queued: Promise<GatewayConfig> | undefined;
  const start = () => {
    running = reload().finally(() => {
      running = undefined;
    });
    return running;
  };
  return {
    initial: current.config,
    // Answers from a reload that began after the call, so an edit made just before is never missed;
    // calls made while one is waiting share it.
    get: (): Promise<GatewayConfig> => {
      if (running === undefined) return start();
      queued ??= running.then(() => {
        queued = undefined;
        return start();
      });
      return queued;
    },
  };
};
