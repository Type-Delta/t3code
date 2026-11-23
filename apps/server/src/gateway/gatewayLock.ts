// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const bootEpochSeconds = () => Math.round(Date.now() / 1000 - NodeOS.uptime());
const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "";

/**
 * `acquireServiceSelectionLock` for Windows, where renaming onto an existing folder fails with
 * EPERM or EACCES instead of EEXIST/ENOTEMPTY. Same lock folder, owner names and stale-owner rules.
 */
export async function acquireWindowsGatewayLock(selectionPath: string): Promise<() => void> {
  const lock = selectionPath + ".selection-lock";
  const owner = `${process.pid}.${bootEpochSeconds()}.${NodeCrypto.randomUUID()}`;
  const candidate = `${lock}.${owner}`;
  const deadline = Date.now() + 30_000;
  const removeEmptyLock = () => {
    try {
      NodeFS.rmdirSync(lock);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(error))) throw error;
    }
  };
  NodeFS.mkdirSync(candidate);
  try {
    NodeFS.writeFileSync(NodePath.join(candidate, owner), "");
    while (true) {
      try {
        NodeFS.renameSync(candidate, lock);
        return () => {
          NodeFS.unlinkSync(NodePath.join(lock, owner));
          removeEmptyLock();
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(errorCode(error))) throw error;
      }
      let owners: Array<string>;
      try {
        owners = NodeFS.readdirSync(lock);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (owners.length === 1) {
        const previous = owners[0]!;
        const [pidText, bootText] = previous.split(".");
        const pid = Number(pidText);
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error(`Invalid gateway lock owner at ${lock}.`);
        const ownerBoot = Number(bootText);
        let dead = Number.isSafeInteger(ownerBoot) && Math.abs(ownerBoot - bootEpochSeconds()) > 60;
        if (!dead) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            const code = errorCode(error);
            if (code !== "ESRCH" && code !== "EPERM") throw error;
            dead = code === "ESRCH";
          }
        }
        if (dead) {
          try {
            NodeFS.unlinkSync(NodePath.join(lock, previous));
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        }
      }
      removeEmptyLock();
      if (Date.now() >= deadline)
        throw new Error(
          `The gateway is locked at ${lock}. Retry when the other operation finishes.`,
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    NodeFS.rmSync(candidate, { recursive: true, force: true });
  }
}
