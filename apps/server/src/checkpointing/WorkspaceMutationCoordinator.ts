import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface WorkspaceCaptureTicket {
  readonly ticketId: number;
  readonly worktreeKey: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface WorkspaceMutationTicket {
  readonly ticketId: number;
  readonly worktreeKey: string;
}

interface ActiveCapture {
  readonly worktreeKey: string;
  readonly controller: AbortController;
}

interface ProviderMutation {
  readonly ticket: WorkspaceMutationTicket;
  readonly ownerTurnId: string | null;
  readonly handoffInProgress: boolean;
}

interface State {
  readonly nextTicketId: number;
  /**
   * Logical generation offsets established by this process. An absent offset
   * means no local observation or mutation has established the generation
   * origin yet, which lets a reclaimed durable job safely rebase it.
   */
  readonly generationOffsets: ReadonlyMap<string, number>;
  readonly generations: ReadonlyMap<string, number>;
  readonly mutationDepths: ReadonlyMap<string, number>;
  readonly captures: ReadonlyMap<number, ActiveCapture>;
  readonly mutations: ReadonlyMap<number, string>;
}

export interface WorkspaceMutationCoordinatorShape {
  readonly getGeneration: (worktreeKey: string) => Effect.Effect<number>;
  /**
   * Validates a durable capture generation, adopting it as the logical origin
   * only when this process has not observed or mutated the worktree yet.
   */
  readonly reconcileCaptureGeneration: (
    worktreeKey: string,
    requestedGeneration: number,
  ) => Effect.Effect<boolean>;
  readonly beginCapture: (worktreeKey: string) => Effect.Effect<WorkspaceCaptureTicket>;
  /** Removes the capture and reports whether no mutation overlapped it. */
  readonly completeCapture: (ticket: WorkspaceCaptureTicket) => Effect.Effect<boolean>;
  /** Starts a mutation, increments generation, and preempts active captures. */
  readonly beginMutation: (worktreeKey: string) => Effect.Effect<WorkspaceMutationTicket>;
  /** Ends a mutation and increments generation again to bound its full interval. */
  readonly completeMutation: (ticket: WorkspaceMutationTicket) => Effect.Effect<void>;
  /** A one-shot mutation signal for operations whose duration is not observable. */
  readonly preemptCaptures: (worktreeKey: string) => Effect.Effect<number>;
  /**
   * Acquires and retains the worktree mutation lease before a provider turn is
   * dispatched. Returns false rather than reusing an existing thread lease.
   */
  readonly prepareProviderMutation: (
    threadId: string,
    worktreeKey: string,
  ) => Effect.Effect<boolean>;
  /** Binds a prepared lease to the exact provider turn that owns it. */
  readonly bindProviderMutation: (threadId: string, turnId: string) => Effect.Effect<boolean>;
  /** Reports whether the exact provider turn currently owns the thread lease. */
  readonly isProviderMutationOwnedBy: (threadId: string, turnId: string) => Effect.Effect<boolean>;
  /** Reserves an exact provider turn lease while a steering request is in flight. */
  readonly beginProviderMutationHandoff: (
    threadId: string,
    turnId: string,
  ) => Effect.Effect<boolean>;
  /** Completes a reserved steering handoff, or keeps the old owner on failure. */
  readonly finishProviderMutationHandoff: (
    threadId: string,
    fromTurnId: string,
    toTurnId: string | null,
  ) => Effect.Effect<boolean>;
  /** Releases only the lease owned by the matching provider turn. */
  readonly completeProviderMutation: (threadId: string, turnId: string) => Effect.Effect<boolean>;
  /** Ends the workspace mutation but keeps the next provider turn behind a capture barrier. */
  readonly completeProviderMutationForCapture: (
    threadId: string,
    turnId: string,
  ) => Effect.Effect<boolean>;
  /** Releases a capture barrier after the post-turn checkpoint has finalized. */
  readonly releaseProviderMutation: (threadId: string) => Effect.Effect<void>;
  /** Releases an unbound/prepared lease when dispatch fails or shuts down. */
  readonly cancelProviderMutation: (threadId: string) => Effect.Effect<boolean>;
  /** Waits until the current provider lease has fully released its mutation ticket. */
  readonly awaitProviderMutationRelease: (threadId: string) => Effect.Effect<void>;
  /** Reports that mutation ended and only post-turn checkpoint finalization remains. */
  readonly isProviderCapturePending: (threadId: string) => Effect.Effect<boolean>;
  /**
   * Registers a runtime-only mutation without exposing an acquired ticket
   * before it is observable by completion handling.
   */
  readonly prepareRuntimeMutation: (
    ownerKey: string,
    worktreeKey: string,
  ) => Effect.Effect<boolean>;
  readonly completeRuntimeMutation: (ownerKey: string) => Effect.Effect<boolean>;
  readonly withMutation: <A, E, R>(
    worktreeKey: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class WorkspaceMutationCoordinator extends Context.Service<
  WorkspaceMutationCoordinator,
  WorkspaceMutationCoordinatorShape
>()("t3/checkpointing/WorkspaceMutationCoordinator") {}

const copyMap = <K, V>(map: ReadonlyMap<K, V>) => new Map(map);

const make = Effect.gen(function* () {
  const state = yield* Ref.make<State>({
    nextTicketId: 1,
    generationOffsets: new Map(),
    generations: new Map(),
    mutationDepths: new Map(),
    captures: new Map(),
    mutations: new Map(),
  });
  const lock = yield* Semaphore.make(1);
  const mutationGates = new Map<string, Semaphore.Semaphore>();
  const mutationIdleSignals = new Map<string, Deferred.Deferred<void>>();
  const captureIdleSignals = new Map<string, Deferred.Deferred<void>>();
  const providerMutations = new Map<string, ProviderMutation>();
  const providerTerminalTurns = new Map<string, Set<string>>();
  const providerReleaseSignals = new Map<string, Deferred.Deferred<void>>();
  const runtimeMutations = new Map<string, WorkspaceMutationTicket>();

  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const getMutationGate = (worktreeKey: string) =>
    locked(
      Effect.sync(() => {
        const existing = mutationGates.get(worktreeKey);
        if (existing) return existing;
        const created = Semaphore.makeUnsafe(1);
        mutationGates.set(worktreeKey, created);
        return created;
      }),
    );

  const getGeneration: WorkspaceMutationCoordinatorShape["getGeneration"] = (worktreeKey) =>
    locked(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const rawGeneration = current.generations.get(worktreeKey) ?? 0;
        const existingOffset = current.generationOffsets.get(worktreeKey);
        if (existingOffset !== undefined) return rawGeneration + existingOffset;
        const generationOffsets = copyMap(current.generationOffsets);
        generationOffsets.set(worktreeKey, 0);
        yield* Ref.set(state, { ...current, generationOffsets });
        return rawGeneration;
      }),
    );

  const reconcileCaptureGeneration: WorkspaceMutationCoordinatorShape["reconcileCaptureGeneration"] =
    (worktreeKey, requestedGeneration) =>
      locked(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const rawGeneration = current.generations.get(worktreeKey) ?? 0;
          const existingOffset = current.generationOffsets.get(worktreeKey);
          if (existingOffset !== undefined) {
            return rawGeneration + existingOffset === requestedGeneration;
          }
          const generationOffsets = copyMap(current.generationOffsets);
          generationOffsets.set(worktreeKey, requestedGeneration - rawGeneration);
          yield* Ref.set(state, { ...current, generationOffsets });
          return true;
        }),
      );

  const beginCapture: WorkspaceMutationCoordinatorShape["beginCapture"] = (worktreeKey) =>
    Effect.gen(function* () {
      const gate = yield* getMutationGate(worktreeKey);
      while (true) {
        const attempt = yield* gate.withPermits(1)(
          locked(
            Effect.gen(function* () {
              const current = yield* Ref.get(state);
              if ((current.mutationDepths.get(worktreeKey) ?? 0) > 0) {
                return {
                  ticket: undefined,
                  mutationIdle: mutationIdleSignals.get(worktreeKey),
                } as const;
              }
              const ticketId = current.nextTicketId;
              const controller = new AbortController();
              const captures = copyMap(current.captures);
              captures.set(ticketId, { worktreeKey, controller });
              const generation = current.generations.get(worktreeKey) ?? 0;
              if (!captureIdleSignals.has(worktreeKey)) {
                captureIdleSignals.set(worktreeKey, yield* Deferred.make<void>());
              }
              yield* Ref.set(state, {
                ...current,
                nextTicketId: ticketId + 1,
                captures,
              });
              return {
                ticket: { ticketId, worktreeKey, generation, signal: controller.signal },
                mutationIdle: undefined,
              } as const;
            }),
          ),
        );
        if (attempt.ticket) return attempt.ticket;
        if (attempt.mutationIdle) yield* Deferred.await(attempt.mutationIdle);
        else yield* Effect.yieldNow;
      }
    });

  const completeCapture: WorkspaceMutationCoordinatorShape["completeCapture"] = (ticket) =>
    Effect.gen(function* () {
      const captureIdle = yield* locked(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const active = current.captures.get(ticket.ticketId);
          const captures = copyMap(current.captures);
          captures.delete(ticket.ticketId);
          yield* Ref.set(state, { ...current, captures });
          const stable =
            active !== undefined &&
            active.worktreeKey === ticket.worktreeKey &&
            !active.controller.signal.aborted &&
            (current.generations.get(ticket.worktreeKey) ?? 0) === ticket.generation &&
            (current.mutationDepths.get(ticket.worktreeKey) ?? 0) === 0;
          if (
            [...captures.values()].some((capture) => capture.worktreeKey === ticket.worktreeKey)
          ) {
            return { stable, signal: undefined };
          }
          const signal = captureIdleSignals.get(ticket.worktreeKey);
          captureIdleSignals.delete(ticket.worktreeKey);
          return { stable, signal };
        }),
      );
      if (captureIdle.signal) yield* Deferred.succeed(captureIdle.signal, undefined);
      return captureIdle.stable;
    });

  const preempt = (worktreeKey: string, mutationDelta: number) =>
    locked(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const generationOffsets = copyMap(current.generationOffsets);
        if (!generationOffsets.has(worktreeKey)) generationOffsets.set(worktreeKey, 0);
        const generations = copyMap(current.generations);
        const nextGeneration = (generations.get(worktreeKey) ?? 0) + 1;
        generations.set(worktreeKey, nextGeneration);
        const mutationDepths = copyMap(current.mutationDepths);
        if (mutationDelta !== 0) {
          const nextDepth = Math.max(0, (mutationDepths.get(worktreeKey) ?? 0) + mutationDelta);
          if (nextDepth === 0) mutationDepths.delete(worktreeKey);
          else mutationDepths.set(worktreeKey, nextDepth);
        }
        for (const capture of current.captures.values()) {
          if (capture.worktreeKey === worktreeKey && !capture.controller.signal.aborted) {
            capture.controller.abort("workspace-mutated");
          }
        }
        yield* Ref.set(state, { ...current, generationOffsets, generations, mutationDepths });
        return nextGeneration + (generationOffsets.get(worktreeKey) ?? 0);
      }),
    );

  const beginMutationUncoordinated = (worktreeKey: string) =>
    locked(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const ticketId = current.nextTicketId;
        const generationOffsets = copyMap(current.generationOffsets);
        if (!generationOffsets.has(worktreeKey)) generationOffsets.set(worktreeKey, 0);
        const generations = copyMap(current.generations);
        generations.set(worktreeKey, (generations.get(worktreeKey) ?? 0) + 1);
        const mutationDepths = copyMap(current.mutationDepths);
        const currentDepth = mutationDepths.get(worktreeKey) ?? 0;
        mutationDepths.set(worktreeKey, currentDepth + 1);
        if (currentDepth === 0) {
          mutationIdleSignals.set(worktreeKey, yield* Deferred.make<void>());
        }
        const mutations = copyMap(current.mutations);
        mutations.set(ticketId, worktreeKey);
        for (const capture of current.captures.values()) {
          if (capture.worktreeKey === worktreeKey && !capture.controller.signal.aborted) {
            capture.controller.abort("workspace-mutation-started");
          }
        }
        yield* Ref.set(state, {
          ...current,
          nextTicketId: ticketId + 1,
          generationOffsets,
          generations,
          mutationDepths,
          mutations,
        });
        return { ticketId, worktreeKey };
      }),
    );

  const beginMutation: WorkspaceMutationCoordinatorShape["beginMutation"] = (worktreeKey) =>
    Effect.flatMap(getMutationGate(worktreeKey), (gate) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const captureIdle = yield* locked(Effect.sync(() => captureIdleSignals.get(worktreeKey)));
          if (captureIdle) yield* Deferred.await(captureIdle);
          return yield* beginMutationUncoordinated(worktreeKey);
        }),
      ),
    );

  const completeMutation: WorkspaceMutationCoordinatorShape["completeMutation"] = (ticket) =>
    Effect.gen(function* () {
      const idleSignal = yield* locked(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.mutations.get(ticket.ticketId) !== ticket.worktreeKey) return undefined;
          const generations = copyMap(current.generations);
          generations.set(ticket.worktreeKey, (generations.get(ticket.worktreeKey) ?? 0) + 1);
          const mutationDepths = copyMap(current.mutationDepths);
          const nextDepth = Math.max(0, (mutationDepths.get(ticket.worktreeKey) ?? 0) - 1);
          if (nextDepth === 0) mutationDepths.delete(ticket.worktreeKey);
          else mutationDepths.set(ticket.worktreeKey, nextDepth);
          const mutations = copyMap(current.mutations);
          mutations.delete(ticket.ticketId);
          for (const capture of current.captures.values()) {
            if (capture.worktreeKey === ticket.worktreeKey && !capture.controller.signal.aborted) {
              capture.controller.abort("workspace-mutation-completed");
            }
          }
          yield* Ref.set(state, { ...current, generations, mutationDepths, mutations });
          if (nextDepth !== 0) return undefined;
          const signal = mutationIdleSignals.get(ticket.worktreeKey);
          mutationIdleSignals.delete(ticket.worktreeKey);
          return signal;
        }),
      );
      if (idleSignal) yield* Deferred.succeed(idleSignal, undefined);
    });

  const preemptCaptures: WorkspaceMutationCoordinatorShape["preemptCaptures"] = (worktreeKey) =>
    preempt(worktreeKey, 0);

  const releaseProviderMutation: WorkspaceMutationCoordinatorShape["releaseProviderMutation"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const releaseSignal = yield* locked(
        Effect.sync(() => {
          const found = providerReleaseSignals.get(threadId);
          providerReleaseSignals.delete(threadId);
          return found;
        }),
      );
      if (releaseSignal) yield* Deferred.succeed(releaseSignal, undefined);
    });

  const completeProviderTicket = (
    threadId: string,
    ticket: WorkspaceMutationTicket,
    release: boolean,
  ): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        yield* completeMutation(ticket);
        if (release) yield* releaseProviderMutation(threadId);
      }),
    );

  const prepareProviderMutation: WorkspaceMutationCoordinatorShape["prepareProviderMutation"] = (
    threadId,
    worktreeKey,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const available = yield* locked(
          Effect.sync(
            () => !providerMutations.has(threadId) && !providerReleaseSignals.has(threadId),
          ),
        );
        if (!available) return false;
        const ticket = yield* restore(beginMutation(worktreeKey));
        const installed = yield* locked(
          Effect.sync(() => {
            if (providerMutations.has(threadId) || providerReleaseSignals.has(threadId)) {
              return false;
            }
            providerMutations.set(threadId, {
              ticket,
              ownerTurnId: null,
              handoffInProgress: false,
            });
            providerTerminalTurns.delete(threadId);
            providerReleaseSignals.set(threadId, Deferred.makeUnsafe<void>());
            return true;
          }),
        );
        if (!installed) yield* completeMutation(ticket);
        return installed;
      }),
    );

  const bindProviderMutation: WorkspaceMutationCoordinatorShape["bindProviderMutation"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const result = yield* locked(
        Effect.sync(() => {
          const found = providerMutations.get(threadId);
          if (!found) return { bound: false, ticket: undefined } as const;
          if (found.ownerTurnId !== null && found.ownerTurnId !== turnId) {
            return { bound: false, ticket: undefined } as const;
          }

          const terminalTurns = providerTerminalTurns.get(threadId);
          if (terminalTurns?.has(turnId)) {
            providerMutations.delete(threadId);
            providerTerminalTurns.delete(threadId);
            return { bound: true, ticket: found.ticket } as const;
          }

          if (found.ownerTurnId === null) {
            providerMutations.set(threadId, { ...found, ownerTurnId: turnId });
          }
          return { bound: true, ticket: undefined } as const;
        }),
      );
      if (result.ticket) yield* completeProviderTicket(threadId, result.ticket, true);
      return result.bound;
    });

  const isProviderMutationOwnedBy: WorkspaceMutationCoordinatorShape["isProviderMutationOwnedBy"] =
    (threadId, turnId) =>
      locked(Effect.sync(() => providerMutations.get(threadId)?.ownerTurnId === turnId));

  const rememberProviderTerminalTurn = (threadId: string, turnId: string) => {
    const terminalTurns = providerTerminalTurns.get(threadId) ?? new Set<string>();
    terminalTurns.add(turnId);
    while (terminalTurns.size > 8) {
      const oldest = terminalTurns.values().next().value;
      if (oldest === undefined) break;
      terminalTurns.delete(oldest);
    }
    providerTerminalTurns.set(threadId, terminalTurns);
  };

  const beginProviderMutationHandoff: WorkspaceMutationCoordinatorShape["beginProviderMutationHandoff"] =
    (threadId, turnId) =>
      locked(
        Effect.sync(() => {
          const found = providerMutations.get(threadId);
          if (!found || found.ownerTurnId !== turnId || found.handoffInProgress) return false;
          providerMutations.set(threadId, { ...found, handoffInProgress: true });
          return true;
        }),
      );

  const finishProviderMutationHandoff: WorkspaceMutationCoordinatorShape["finishProviderMutationHandoff"] =
    (threadId, fromTurnId, toTurnId) =>
      Effect.gen(function* () {
        const result = yield* locked(
          Effect.sync(() => {
            const found = providerMutations.get(threadId);
            if (!found || found.ownerTurnId !== fromTurnId || found.handoffInProgress !== true) {
              return { finished: false, ticket: undefined } as const;
            }

            const nextTurnId = toTurnId ?? fromTurnId;
            const terminalTurns = providerTerminalTurns.get(threadId);
            if (terminalTurns?.has(nextTurnId)) {
              providerMutations.delete(threadId);
              providerTerminalTurns.delete(threadId);
              return { finished: true, ticket: found.ticket } as const;
            }

            providerMutations.set(threadId, {
              ...found,
              ownerTurnId: nextTurnId,
              handoffInProgress: false,
            });
            return { finished: true, ticket: undefined } as const;
          }),
        );
        if (result.ticket) yield* completeProviderTicket(threadId, result.ticket, true);
        return result.finished;
      });

  const completeProviderMutationWithRelease = (
    threadId: string,
    turnId: string,
    release: boolean,
  ) =>
    Effect.gen(function* () {
      const result = yield* locked(
        Effect.sync(() => {
          const found = providerMutations.get(threadId);
          if (!found) return { handled: false, ticket: undefined } as const;
          if (found.ownerTurnId === null) {
            rememberProviderTerminalTurn(threadId, turnId);
            return { handled: true, ticket: undefined } as const;
          }
          if (found.ownerTurnId !== turnId) {
            rememberProviderTerminalTurn(threadId, turnId);
            return { handled: false, ticket: undefined } as const;
          }
          if (found.handoffInProgress) {
            rememberProviderTerminalTurn(threadId, turnId);
            return { handled: true, ticket: undefined } as const;
          }
          providerMutations.delete(threadId);
          providerTerminalTurns.delete(threadId);
          return { handled: true, ticket: found.ticket } as const;
        }),
      );
      if (result.ticket) yield* completeProviderTicket(threadId, result.ticket, release);
      return result.handled;
    });

  const completeProviderMutation: WorkspaceMutationCoordinatorShape["completeProviderMutation"] = (
    threadId,
    turnId,
  ) => completeProviderMutationWithRelease(threadId, turnId, true);

  const completeProviderMutationForCapture: WorkspaceMutationCoordinatorShape["completeProviderMutationForCapture"] =
    (threadId, turnId) => completeProviderMutationWithRelease(threadId, turnId, false);

  const cancelProviderMutation: WorkspaceMutationCoordinatorShape["cancelProviderMutation"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const ticket = yield* locked(
        Effect.sync(() => {
          const found = providerMutations.get(threadId);
          providerMutations.delete(threadId);
          providerTerminalTurns.delete(threadId);
          return found?.ticket;
        }),
      );
      if (!ticket) return false;
      yield* completeProviderTicket(threadId, ticket, true);
      return true;
    });

  const awaitProviderMutationRelease: WorkspaceMutationCoordinatorShape["awaitProviderMutationRelease"] =
    (threadId) =>
      Effect.gen(function* () {
        const releaseSignal = yield* locked(
          Effect.sync(() => providerReleaseSignals.get(threadId)),
        );
        if (releaseSignal) yield* Deferred.await(releaseSignal);
      });

  const isProviderCapturePending: WorkspaceMutationCoordinatorShape["isProviderCapturePending"] = (
    threadId,
  ) =>
    locked(
      Effect.sync(() => !providerMutations.has(threadId) && providerReleaseSignals.has(threadId)),
    );

  const prepareRuntimeMutation: WorkspaceMutationCoordinatorShape["prepareRuntimeMutation"] = (
    ownerKey,
    worktreeKey,
  ) =>
    Effect.gen(function* () {
      const available = yield* locked(Effect.sync(() => !runtimeMutations.has(ownerKey)));
      if (!available) return false;
      const gate = yield* getMutationGate(worktreeKey);
      return yield* gate.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const ticket = yield* beginMutationUncoordinated(worktreeKey);
            const installed = yield* locked(
              Effect.sync(() => {
                if (runtimeMutations.has(ownerKey)) return false;
                runtimeMutations.set(ownerKey, ticket);
                return true;
              }),
            );
            if (!installed) yield* completeMutation(ticket);
            return installed;
          }),
        ),
      );
    });

  const completeRuntimeMutation: WorkspaceMutationCoordinatorShape["completeRuntimeMutation"] = (
    ownerKey,
  ) =>
    Effect.gen(function* () {
      const ticket = yield* locked(
        Effect.sync(() => {
          const found = runtimeMutations.get(ownerKey);
          if (found) runtimeMutations.delete(ownerKey);
          return found;
        }),
      );
      if (!ticket) return false;
      yield* completeMutation(ticket);
      return true;
    });

  const withMutation: WorkspaceMutationCoordinatorShape["withMutation"] = (worktreeKey, effect) =>
    Effect.flatMap(getMutationGate(worktreeKey), (gate) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const idleSignal = yield* locked(
            Effect.gen(function* () {
              const current = yield* Ref.get(state);
              return (current.mutationDepths.get(worktreeKey) ?? 0) === 0
                ? undefined
                : mutationIdleSignals.get(worktreeKey);
            }),
          );
          if (idleSignal) yield* Deferred.await(idleSignal);
          return yield* Effect.acquireUseRelease(
            beginMutationUncoordinated(worktreeKey),
            () => effect,
            completeMutation,
          );
        }),
      ),
    );

  return WorkspaceMutationCoordinator.of({
    getGeneration,
    reconcileCaptureGeneration,
    beginCapture,
    completeCapture,
    beginMutation,
    completeMutation,
    preemptCaptures,
    prepareProviderMutation,
    bindProviderMutation,
    isProviderMutationOwnedBy,
    beginProviderMutationHandoff,
    finishProviderMutationHandoff,
    completeProviderMutation,
    completeProviderMutationForCapture,
    releaseProviderMutation,
    cancelProviderMutation,
    awaitProviderMutationRelease,
    isProviderCapturePending,
    prepareRuntimeMutation,
    completeRuntimeMutation,
    withMutation,
  });
});

export const WorkspaceMutationCoordinatorLive = Layer.effect(WorkspaceMutationCoordinator, make);
