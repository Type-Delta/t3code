import { deadlineAfter } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useDeadlinePassed } from "./useDeadline";

export const DISCONNECT_DELAY_MS = 20_000;

export function useEnvironmentDisconnectDelay(unavailableEnvironmentId: EnvironmentId | null) {
  return useEnvironmentStateHeldFor(unavailableEnvironmentId, DISCONNECT_DELAY_MS);
}

/**
 * Whether `environmentId` has stayed the same non-null value for `delayMs`. Every change starts a
 * new delay, so leaving and returning to an id restarts it.
 */
export function useEnvironmentStateHeldFor(environmentId: EnvironmentId | null, delayMs: number) {
  const [held, setHeld] = useState(() => ({
    environmentId,
    deadline: deadlineAfter(delayMs),
  }));
  if (held.environmentId !== environmentId) {
    setHeld({ environmentId, deadline: deadlineAfter(delayMs) });
  }
  const elapsed = useDeadlinePassed(held.environmentId === null ? null : held.deadline);
  return environmentId !== null && held.environmentId === environmentId && elapsed;
}

/**
 * The ids in `environmentIds` that have stayed in it for `delayMs`. An id that leaves and returns
 * starts a new delay. Ids present at mount count as held, so a remount does not restart them.
 */
export function useEnvironmentsHeldFor(
  environmentIds: ReadonlyArray<EnvironmentId>,
  delayMs: number,
): ReadonlySet<EnvironmentId> {
  // Each id maps to its deadline; 0 marks one already held.
  const [holds, setHolds] = useState<ReadonlyMap<EnvironmentId, number>>(
    () => new Map(environmentIds.map((environmentId) => [environmentId, 0])),
  );
  const synced =
    environmentIds.length === holds.size && environmentIds.every((id) => holds.has(id))
      ? holds
      : new Map(environmentIds.map((id) => [id, holds.get(id) ?? deadlineAfter(delayMs)]));
  let next = Infinity;
  for (const deadline of synced.values()) if (deadline > 0) next = Math.min(next, deadline);
  const passed = useDeadlinePassed(next === Infinity ? null : next);
  const nextHolds = passed
    ? new Map([...synced].map(([id, deadline]) => [id, deadline <= next ? 0 : deadline]))
    : synced;
  if (nextHolds !== holds) setHolds(nextHolds);
  return new Set([...nextHolds].filter(([, deadline]) => deadline === 0).map(([id]) => id));
}
