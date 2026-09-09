import { useAtomValue } from "@effect/atom-react";
import type { DesktopBridge, DesktopLocalUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Atom } from "effect/unstable/reactivity";

type DesktopLocalUpdateBridge = Pick<DesktopBridge, "getLocalUpdateState" | "onLocalUpdateState">;

const LOCAL_UPDATE_STEP_LABELS = {
  idle: "Starting",
  "resolve-source": "Resolving source",
  "inspect-checkout": "Inspecting checkout",
  stash: "Stashing local changes",
  fetch: "Fetching changes",
  merge: "Merging changes",
  check: "Checking code",
  typecheck: "Checking types",
  build: "Building installer",
  "open-installer": "Opening installer",
  restore: "Restoring local changes",
  "up-to-date": "Already up to date",
  completed: "Completed",
} as const;

export function formatDesktopLocalUpdateProgress(state: DesktopLocalUpdateState | null): string {
  if (!state) return "Starting";
  return `${state.progressPercent}% — ${LOCAL_UPDATE_STEP_LABELS[state.step]}`;
}

function getDesktopLocalUpdateBridge(): DesktopLocalUpdateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

function createDesktopLocalUpdateStateAtom(getBridge: () => DesktopLocalUpdateBridge | undefined) {
  const updates = Stream.callback<DesktopLocalUpdateState | null>((queue) =>
    Effect.gen(function* () {
      const bridge = getBridge();
      if (!bridge) {
        Queue.offerUnsafe(queue, null);
        return yield* Effect.never;
      }

      let receivedUpdate = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onLocalUpdateState((state) => {
            receivedUpdate = true;
            Queue.offerUnsafe(queue, state);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );

      const initialState = yield* Effect.promise(() => bridge.getLocalUpdateState()).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (!receivedUpdate) {
        Queue.offerUnsafe(queue, initialState);
      }

      return yield* Effect.never;
    }),
  );

  return Atom.make(updates, { initialValue: null }).pipe(
    Atom.keepAlive,
    Atom.withLabel("desktop:local-update-state"),
  );
}

const desktopLocalUpdateStateAtom = createDesktopLocalUpdateStateAtom(getDesktopLocalUpdateBridge);

export function useDesktopLocalUpdateState(): DesktopLocalUpdateState | null {
  return AsyncResult.getOrElse(useAtomValue(desktopLocalUpdateStateAtom), () => null);
}
