import type { SensorProps } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeTimers } from "../../test/render";
import { SidebarPointerSensor } from "./Sidebar.pointer";

const sensors: SidebarPointerSensor[] = [];

function pointer(type: string, values: PointerEventInit = {}) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    buttons: 1,
    ...values,
  });
}

function gesture(
  extraOptions: Partial<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]> = {},
) {
  const callbacks = {
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
    onPending: vi.fn(),
  };
  const onFinish = vi.fn();
  const onPointerMove = vi.fn();
  const onRelease = vi.fn();
  const onCancelDrag = vi.fn();
  // The sensor never reads dnd-kit's layout context or active node.
  const props = {
    active: "thread",
    event: pointer("pointerdown"),
    options: {
      distance: 6,
      onAttach: vi.fn(),
      onFinish,
      onSplitMove: onPointerMove,
      onRelease,
      onCancelDrag,
      ...extraOptions,
    },
    ...callbacks,
  } as unknown as SensorProps<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]>;
  const sensor = new SidebarPointerSensor(props);
  sensors.push(sensor);
  return { sensor, onFinish, onPointerMove, onRelease, onCancelDrag, ...callbacks };
}

function setup() {
  const stack = new DisposableStack();
  stack.use(fakeTimers());
  stack.defer(() => {
    for (const sensor of sensors.splice(0)) sensor.cancel();
    // Cancelled sensors keep suppressing clicks on the shared document until the next press.
    document.dispatchEvent(pointer("pointerdown"));
    vi.runAllTimers();
  });
  return stack;
}

describe("sidebar pointer lifecycle", () => {
  it("starts the same drag from any primary-button row target", () => {
    const activate = SidebarPointerSensor.activators[0]!.handler;
    expect(activate({ nativeEvent: { isPrimary: true, button: 0 } } as never)).toBe(true);
    expect(activate({ nativeEvent: { isPrimary: true, button: 1 } } as never)).toBe(false);
    expect(activate({ nativeEvent: { isPrimary: false, button: 0 } } as never)).toBe(false);
  });

  it("drops context when a zero-button move precedes pointerup", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));

    // Native desktop releases can report the released button on the final move.
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 100, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 94, y: 32 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });

  // regression: #17373 a zero-button release outside a drop target must cancel, not reorder
  it("cancels a missed sidebar release without committing a reorder", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 30, clientY: 40 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 30, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 40 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("reports split movement and consumes a split release exactly once", () => {
    using _environment = setup();
    const release = vi.fn(() => true);
    const drag = gesture({ onRelease: release });
    document.dispatchEvent(pointer("pointermove", { clientX: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 120, clientY: 40 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 125, clientY: 43 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 130, clientY: 44 }));
    expect(drag.onPointerMove).toHaveBeenLastCalledWith("thread", { x: 120, y: 40 });
    expect(release).toHaveBeenCalledExactlyOnceWith("thread", { x: 125, y: 43 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
  });
  it("keeps the overlay following the pointer over an external target", () => {
    using _environment = setup();
    const drag = gesture({ onMove: () => true });
    document.dispatchEvent(pointer("pointermove", { clientX: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 120, clientY: 40 }));
    expect(drag.onMove).toHaveBeenLastCalledWith({ x: 120, y: 40 });
    expect(drag.onPointerMove).toHaveBeenLastCalledWith("thread", { x: 120, y: 40 });
  });
});
