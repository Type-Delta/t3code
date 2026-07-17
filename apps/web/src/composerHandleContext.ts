import { createContext, use, useLayoutEffect, useMemo, useRef } from "react";
import type { ChatComposerHandle } from "./components/chat/ChatComposer";

export type ComposerHandleRef = React.RefObject<ChatComposerHandle | null>;

export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null);

export function useComposerHandleContext(): ComposerHandleRef | null {
  return use(ComposerHandleContext);
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
  const localRef = useRef<ChatComposerHandle | null>(null);
  const shouldPublish = options.scoped && options.active;
  const publishRef = useRef(shouldPublish);
  publishRef.current = shouldPublish;

  const forwardingRef = useMemo<ComposerHandleRef>(() => {
    const ref = {} as ComposerHandleRef;
    Object.defineProperty(ref, "current", {
      get: () => localRef.current,
      set: (handle: ChatComposerHandle | null) => {
        localRef.current = handle;
        if (publishRef.current && globalRef) {
          globalRef.current = handle;
        }
      },
    });
    return ref;
  }, [globalRef]);

  useLayoutEffect(() => {
    if (!shouldPublish || !globalRef) {
      return;
    }
    globalRef.current = localRef.current;
    return () => {
      if (globalRef.current === localRef.current) {
        globalRef.current = null;
      }
    };
  }, [globalRef, shouldPublish]);

  return options.scoped ? forwardingRef : (globalRef ?? localRef);
}
