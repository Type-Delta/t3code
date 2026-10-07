import { useLayoutEffect, type PointerEvent as ReactPointerEvent } from "react";
import { type SensorProps } from "@dnd-kit/core";
import { getOwnerDocument, getWindow } from "@dnd-kit/utilities";

// Search unmounts the drag context while its owning Sidebar remains mounted.
export function SidebarDragLifecycle({ onUnmount }: { onUnmount: () => void }) {
  useLayoutEffect(() => onUnmount, [onUnmount]);
  return null;
}

type Options = {
  distance: number;
  onAttach: (sensor: SidebarPointerSensor) => void;
  onFinish: (started: boolean) => void;
  /** Return true when the move is handled by an external drag destination. */
  onMove?: (point: { x: number; y: number }) => boolean;
  /** Report coordinates to split-view drop targets while the pointer is moving. */
  onSplitMove?: (active: string, point: { x: number; y: number }) => void;
  /** Return true when a split-view target consumed the release. */
  onRelease?: (active: string, point: { x: number; y: number }) => boolean;
  onCancelDrag?: () => void;
  /** Return true when the release was consumed elsewhere, so the sort is cancelled. */
  onDrop?: (point: { x: number; y: number }) => boolean;
};

/** A sidebar gesture ends on release, cancellation, or loss of its window.
 * Own the listeners so unmounting the list can cancel the sensor too. */
export class SidebarPointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) =>
        nativeEvent.isPrimary && nativeEvent.button === 0,
    },
  ];
  autoScrollEnabled = true;
  private phase: "pending" | "dragging" | "finished" = "pending";
  private readonly pointer: PointerEvent;
  private readonly document: Document;
  private readonly window: Window;
  private readonly captureTarget: Element | null;

  constructor(private readonly props: SensorProps<Options>) {
    this.pointer = props.event as PointerEvent;
    this.document = getOwnerDocument(this.pointer.target);
    this.window = getWindow(this.pointer.target);
    const target = this.pointer.target;
    this.captureTarget =
      target !== null && typeof (target as Element).setPointerCapture === "function"
        ? (target as Element)
        : null;
    this.captureTarget?.setPointerCapture(this.pointer.pointerId);
    this.document.addEventListener("pointermove", this.move, { passive: false, capture: true });
    this.document.addEventListener("pointerup", this.end, { capture: true });
    this.document.addEventListener("pointercancel", this.pointerCancel, { capture: true });
    // Pointer capture normally keeps these events on the initiating element,
    // including when the pointer leaves the sidebar. Keep a window fallback
    // for browsers and embedded documents that do not honor capture.
    this.window.addEventListener("pointerup", this.end, { capture: true });
    this.window.addEventListener("pointercancel", this.pointerCancel, { capture: true });
    this.document.addEventListener("keydown", this.keydown, { capture: true });
    this.document.addEventListener("visibilitychange", this.visibilityChange);
    this.window.addEventListener("blur", this.cancel);
    this.window.addEventListener("pagehide", this.cancel);
    this.window.addEventListener("resize", this.cancel);
    this.document.addEventListener("dragstart", this.preventDefault);
    this.document.addEventListener("contextmenu", this.preventDefault);
    props.options.onAttach(this);
    props.onPending(props.active, { distance: props.options.distance }, this.coordinates());
  }

  private coordinates = () => ({ x: this.pointer.clientX, y: this.pointer.clientY });
  private preventDefault = (event: Event) => event.preventDefault();
  private clearClickSuppression = () => {
    this.document.removeEventListener("click", this.suppressClick, { capture: true });
    this.document.removeEventListener("pointerdown", this.clearClickSuppression, { capture: true });
  };
  private suppressClick = (event: Event) => {
    event.stopPropagation();
    this.clearClickSuppression();
  };
  private clearSelection = () => this.document.getSelection()?.removeAllRanges();

  private move = (event: PointerEvent) => {
    if (this.phase === "finished" || event.pointerId !== this.pointer.pointerId) return;
    // A release outside the window can be missed. Never activate or continue
    // a drag when the initiating button is no longer held.
    if ((event.buttons & 1) === 0) return this.cancel();
    const coordinates = { x: event.clientX, y: event.clientY };
    if (this.phase === "pending") {
      const offset = {
        x: event.clientX - this.pointer.clientX,
        y: event.clientY - this.pointer.clientY,
      };
      if (Math.hypot(offset.x, offset.y) <= this.props.options.distance) {
        this.props.onPending(
          this.props.active,
          { distance: this.props.options.distance },
          this.coordinates(),
          offset,
        );
        return;
      }
      this.phase = "dragging";
      this.document.addEventListener("click", this.suppressClick, { capture: true });
      this.document.addEventListener("selectionchange", this.clearSelection);
      this.clearSelection();
      this.props.onStart(this.coordinates());
      if (this.phase === "dragging") {
        this.props.options.onSplitMove?.(String(this.props.active), coordinates);
      }
      return;
    }
    if (this.phase === "dragging") {
      if (event.cancelable) event.preventDefault();
      // External destinations use this callback to suspend sidebar sorting,
      // but dnd-kit's move must still run so DragOverlay follows the pointer.
      this.props.options.onMove?.(coordinates);
      this.props.options.onSplitMove?.(String(this.props.active), coordinates);
      this.props.onMove(coordinates);
    }
  };

  private end = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer.pointerId) return;
    const point = { x: event.clientX, y: event.clientY };
    const contextDrop =
      this.phase === "dragging" &&
      this.props.options.onDrop?.({ x: event.clientX, y: event.clientY }) === true;
    const splitDrop =
      !contextDrop &&
      this.phase === "dragging" &&
      this.props.options.onRelease?.(String(this.props.active), point) === true;
    this.finish(contextDrop || splitDrop);
  };
  private pointerCancel = (event: PointerEvent) => {
    if (event.pointerId === this.pointer.pointerId) this.cancel();
  };
  private keydown = (event: KeyboardEvent) => {
    if (event.code === "Escape") this.cancel();
  };
  private visibilityChange = () => {
    if (this.document.hidden) this.cancel();
  };
  cancel = () => this.finish(true);

  private finish(cancelled: boolean) {
    if (this.phase === "finished") return;
    const aborted = this.phase === "pending";
    this.phase = "finished";
    if (cancelled) this.props.options.onCancelDrag?.();
    this.document.removeEventListener("pointermove", this.move, { capture: true });
    this.document.removeEventListener("pointerup", this.end, { capture: true });
    this.document.removeEventListener("pointercancel", this.pointerCancel, { capture: true });
    this.window.removeEventListener("pointerup", this.end, { capture: true });
    this.window.removeEventListener("pointercancel", this.pointerCancel, { capture: true });
    this.document.removeEventListener("keydown", this.keydown, { capture: true });
    this.document.removeEventListener("visibilitychange", this.visibilityChange);
    this.window.removeEventListener("blur", this.cancel);
    this.window.removeEventListener("pagehide", this.cancel);
    this.window.removeEventListener("resize", this.cancel);
    this.document.removeEventListener("dragstart", this.preventDefault);
    this.document.removeEventListener("contextmenu", this.preventDefault);
    this.document.removeEventListener("selectionchange", this.clearSelection);
    if (
      this.captureTarget &&
      typeof this.captureTarget.hasPointerCapture === "function" &&
      this.captureTarget.hasPointerCapture(this.pointer.pointerId)
    ) {
      this.captureTarget.releasePointerCapture(this.pointer.pointerId);
    }
    // Cancellation can precede release by an arbitrary amount of time. Consume
    // that release click, or let a fresh pointerdown end suppression if release
    // happened outside the document. Ordinary clicks never install this guard.
    if (!aborted) {
      this.document.addEventListener("pointerdown", this.clearClickSuppression, { capture: true });
    }
    try {
      // Release the sidebar preview before dnd-kit clears its transforms.
      // Its public end/cancel event can be omitted before its first layout.
      this.props.options.onFinish(!aborted);
    } finally {
      if (aborted) this.props.onAbort(this.props.active);
      if (cancelled) this.props.onCancel();
      else this.props.onEnd();
    }
  }
}
