import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import {
  useEnvironmentsHeldFor,
  useEnvironmentStateHeldFor,
} from "./useEnvironmentDisconnectDelay";

const first = EnvironmentId.make("env-first");
const second = EnvironmentId.make("env-second");

function Probe(props: { environmentId: EnvironmentId | null }) {
  const held = useEnvironmentStateHeldFor(props.environmentId, 1_000);
  return <output>{held ? "held" : "waiting"}</output>;
}

function SetProbe(props: { environmentIds: ReadonlyArray<EnvironmentId> }) {
  const held = useEnvironmentsHeldFor(props.environmentIds, 1_000);
  return <output>{[...held].toSorted().join(",") || "none"}</output>;
}

describe("useEnvironmentsHeldFor", () => {
  it("holds each environment only after its own delay, and from mount when already present", async () => {
    await using screen = await render(<SetProbe environmentIds={[first]} />, {
      // A bare hook probe; nothing here navigates.
      router: false,
    });
    using _timers = fakeTimers();
    await expect.element(screen.getByText("env-first")).toBeInTheDocument();

    await screen.rerender(<SetProbe environmentIds={[]} />);
    await screen.rerender(<SetProbe environmentIds={[first]} />);
    await expect.element(screen.getByText("none")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(600));
    await screen.rerender(<SetProbe environmentIds={[first, second]} />);
    await act(() => vi.advanceTimersByTime(399));
    await expect.element(screen.getByText("none")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(1));
    await expect.element(screen.getByText("env-first")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(600));
    await expect.element(screen.getByText("env-first,env-second")).toBeInTheDocument();
  });
});

describe("useEnvironmentStateHeldFor", () => {
  it("restarts the delay whenever the environment changes", async () => {
    await using screen = await render(<Probe environmentId={first} />, {
      // A bare hook probe; nothing here navigates.
      router: false,
    });
    using _timers = fakeTimers();
    await screen.rerender(<Probe environmentId={second} />);
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(999));
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(1));
    await expect.element(screen.getByText("held")).toBeInTheDocument();

    await screen.rerender(<Probe environmentId={null} />);
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();
    await screen.rerender(<Probe environmentId={second} />);
    await expect.element(screen.getByText("waiting")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByText("held")).toBeInTheDocument();
  });
});
