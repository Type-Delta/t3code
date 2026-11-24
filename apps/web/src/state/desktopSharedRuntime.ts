import type { DesktopSharedRuntimeState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

// Fork-only (gateway self-service): read once per page; join and leave relaunch the app.
export const desktopSharedRuntimeAtom = Atom.make(
  Effect.promise(
    (): Promise<DesktopSharedRuntimeState | null> =>
      window.desktopBridge?.getSharedRuntimeState().catch(() => null) ?? Promise.resolve(null),
  ),
).pipe(Atom.keepAlive, Atom.withLabel("desktop:shared-runtime:load"));

/** Electron prefixes rejected IPC calls with the channel and the error's tag. */
export function sharedRuntimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return (
    message.replace(/^Error invoking remote method '[^']+':\s*(?:\w+Error:\s*)?/u, "").trim() ||
    "Shared T3 Code did not answer."
  );
}
