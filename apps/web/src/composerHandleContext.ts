import { createContext, use, useLayoutEffect, useState } from "react";
import type { ChatComposerHandle } from "./components/chat/ChatComposer";

export type ComposerHandleRef = React.RefObject<ChatComposerHandle | null>;

export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null);

export function useComposerHandleContext(): ComposerHandleRef | null {
  return use(ComposerHandleContext);
}

/**
 * A composer ref that mirrors each handle ChatComposer assigns into a publish
 * target (the app-wide handle) while one is set.
 */
function createForwardingComposerHandle() {
  let handle: ChatComposerHandle | null = null;
  let target: ComposerHandleRef | null = null;
  const ref: ComposerHandleRef = {
    get current() {
      return handle;
    },
    set current(next) {
      handle = next;
      if (target) target.current = next;
    },
  };
  return {
    ref,
    setTarget: (next: ComposerHandleRef | null) => {
      target = next;
    },
  };
}

/**
 * Gives a split-pane composer its own ref while publishing that ref through the
 * app-wide command-palette handle only while the pane is active. The forwarding
 * ref keeps the published handle fresh when ChatComposer recreates it.
 */
export function useActiveComposerHandle(options: {
  scoped: boolean;
  active: boolean;
}): ComposerHandleRef {
  const globalRef = useComposerHandleContext();
  const [forwarding] = useState(createForwardingComposerHandle);
  const shouldPublish = options.scoped && options.active;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish the active composer to the shared imperative handle.
  useLayoutEffect(() => {
    if (!shouldPublish || !globalRef) {
      return;
    }
    forwarding.setTarget(globalRef);
    globalRef.current = forwarding.ref.current;
    return () => {
      forwarding.setTarget(null);
      if (globalRef.current === forwarding.ref.current) {
        globalRef.current = null;
      }
    };
  }, [forwarding, globalRef, shouldPublish]);

  return options.scoped ? forwarding.ref : (globalRef ?? forwarding.ref);
}
