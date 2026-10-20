import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type RefObject, useEffect, useEffectEvent } from "react";

/**
 * Dragging a sidebar thread past the list edge turns the sort gesture into a context drop.
 * The composer form marks itself as the target; the sidebar hit-tests the pointer against it
 * and hands over the dragged thread refs through a DOM event, so neither side imports the
 * other. Target highlighting lives here rather than in Sidebar state.
 */

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  const handleDrop = useEffectEvent(onDrop);
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new environment or target ends the previous listener, so isActive reports false to drops still in flight for it.
    environmentId,
    targetKey,
    targetRef,
  ]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";

let overTarget: HTMLElement | null = null;

function findDropTarget(point: { x: number; y: number }): HTMLElement | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
  );
}

/** Tracks the highlighted drop target while the pointer is outside the list. */
export function moveThreadContextDrag(
  point: { x: number; y: number },
  options: { trackDropTarget?: boolean } = {},
) {
  const target = options.trackDropTarget === false ? null : findDropTarget(point);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  const target = findDropTarget(point);
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}
