import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { CheckpointNavigationPhase } from "../persistence/Services/CheckpointNavigation.ts";
import { CheckpointNavigationService } from "./CheckpointNavigationService.ts";
import {
  makeNavigationFixture,
  navigationTestThreadId as threadId,
  unrelatedWorktreeKey,
  type NavigationFailurePoint,
} from "./CheckpointNavigationService.test-fixture.ts";

const runWith = <A, E>(
  fixture: ReturnType<typeof makeNavigationFixture>,
  effect: Effect.Effect<A, E, CheckpointNavigationService>,
) => effect.pipe(Effect.provide(fixture.makeLayer()));

it.effect("returns deterministic baseline, tip, and already-current no-ops", () =>
  Effect.gen(function* () {
    const baseline = makeNavigationFixture({ currentOrdinal: 1 });
    const baselineResult = yield* runWith(
      baseline,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        return yield* service.navigate({ commandId: "baseline", threadId, kind: "undo" });
      }),
    );
    assert.deepStrictEqual(baselineResult, {
      status: "noop",
      operationId: "baseline",
      kind: "undo",
      reason: "baseline",
      targetEntryId: "entry-1",
      cursorVersion: 0,
    });
    assert.deepStrictEqual(baseline.events, []);

    const tip = makeNavigationFixture();
    const tipResult = yield* runWith(
      tip,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        return yield* service.navigate({ commandId: "tip", threadId, kind: "redo" });
      }),
    );
    assert.deepStrictEqual(tipResult, {
      status: "noop",
      operationId: "tip",
      kind: "redo",
      reason: "tip",
      targetEntryId: "entry-4",
      cursorVersion: 0,
    });
    assert.deepStrictEqual(tip.events, []);

    const current = makeNavigationFixture({ currentOrdinal: 2 });
    const currentResult = yield* runWith(
      current,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        return yield* service.navigate({
          commandId: "current",
          threadId,
          kind: "jump",
          targetTurnCount: 2,
        });
      }),
    );
    assert.deepStrictEqual(currentResult, {
      status: "noop",
      operationId: "current",
      kind: "jump",
      reason: "already-current",
      targetEntryId: "entry-2",
      cursorVersion: 0,
    });
    assert.deepStrictEqual(current.events, []);
  }),
);

it.effect("supports repeated undo and redo without losing the forward tip", () => {
  const fixture = makeNavigationFixture();
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      yield* service.navigate({ commandId: "undo-1", threadId, kind: "undo" });
      yield* service.navigate({ commandId: "undo-2", threadId, kind: "undo" });
      assert.equal(fixture.getCursor().currentOrdinal, 2);
      assert.equal(fixture.getCursor().forwardTipOrdinal, 4);
      yield* service.navigate({ commandId: "redo-1", threadId, kind: "redo" });
      yield* service.navigate({ commandId: "redo-2", threadId, kind: "redo" });
      assert.equal(fixture.getCursor().currentOrdinal, 4);
      assert.equal(fixture.getCursor().navigationVersion, 4);
      assert.deepStrictEqual(
        fixture.events.filter((event) => event.startsWith("workspace:restore-target")),
        [
          "workspace:restore-target:snapshot-3",
          "workspace:restore-target:snapshot-2",
          "workspace:restore-target:snapshot-3",
          "workspace:restore-target:snapshot-4",
        ],
      );
    }),
  );
});

it.effect("continues redo one step at a time after a backward jump", () => {
  const fixture = makeNavigationFixture();
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      yield* service.navigate({
        commandId: "jump-2",
        threadId,
        kind: "jump",
        targetTurnCount: 2,
      });
      const redo = yield* service.navigate({
        commandId: "redo-after-jump",
        threadId,
        kind: "redo",
      });
      assert.equal(redo.status, "completed");
      if (redo.status === "completed") assert.equal(redo.targetEntryId, "entry-3");
      assert.equal(fixture.getCursor().currentOrdinal, 3);
      assert.equal(fixture.getCursor().forwardTipOrdinal, 4);
    }),
  );
});

it.effect(
  "branches at the checkpoint native provider turn id, never the assistant message id",
  () => {
    const fixture = makeNavigationFixture();
    fixture.entries[2] = {
      ...fixture.entries[2]!,
      providerTurnId: "native-provider-turn",
      assistantMessageId: "t3-assistant-message",
    };
    return runWith(
      fixture,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        yield* service.navigate({ commandId: "native-turn", threadId, kind: "undo" });
        assert.deepStrictEqual(fixture.preparedTurnIds, ["native-provider-turn"]);
      }),
    );
  },
);

it.effect("undoes to the generation baseline with a null native provider turn id", () => {
  const fixture = makeNavigationFixture({ currentOrdinal: 1 });
  fixture.entries.unshift({
    ...fixture.entries[0]!,
    entryId: "entry-0",
    ordinal: 0,
    turnId: "baseline-turn",
    providerTurnId: null,
    snapshotId: "snapshot-0",
    assistantMessageId: null,
  });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const result = yield* service.navigate({
        commandId: "undo-to-baseline",
        threadId,
        kind: "undo",
      });
      assert.equal(result.status, "completed");
      if (result.status === "completed") assert.equal(result.targetEntryId, "entry-0");
      assert.deepStrictEqual(fixture.preparedTurnIds, [null]);
      assert.equal(fixture.getCursor().currentOrdinal, 0);
      assert.equal(fixture.getWorkspaceState(), "snapshot-0");
    }),
  );
});

it.effect("rejects a branching target without a native provider turn id before mutation", () => {
  const fixture = makeNavigationFixture();
  fixture.entries[2] = { ...fixture.entries[2]!, providerTurnId: null };
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const error = yield* service
        .navigate({ commandId: "missing-native-turn", threadId, kind: "undo" })
        .pipe(Effect.flip);
      assert.equal(error.code, "provider-turn-id-unavailable");
      assert.deepStrictEqual(fixture.events, []);
      assert.equal(fixture.operations.size, 0);
    }),
  );
});

it.effect("requires explicit confirmation before a non-branching files-only undo", () => {
  const fixture = makeNavigationFixture({ capability: "rollback-only" });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const error = yield* service
        .navigate({ commandId: "unconfirmed-files-only", threadId, kind: "undo" })
        .pipe(Effect.flip);
      assert.equal(error.code, "files-only-confirmation-required");
      assert.deepStrictEqual(fixture.events, []);
      assert.equal(fixture.getWorkspaceState(), "original");
    }),
  );
});

it.effect(
  "restores files for a confirmed non-branching undo without mutating conversation state",
  () => {
    const fixture = makeNavigationFixture({ capability: "rollback-only" });
    fixture.entries[2] = { ...fixture.entries[2]!, providerTurnId: null };
    return runWith(
      fixture,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        const result = yield* service.navigate({
          commandId: "confirmed-files-only",
          threadId,
          kind: "undo",
          filesOnlyConfirmed: true,
        });
        assert.equal(result.status, "files-restored");
        if (result.status === "files-restored") {
          assert.equal(result.targetEntryId, "entry-3");
          assert.equal(result.cursorVersion, 0);
        }
        assert.equal(fixture.getWorkspaceState(), "snapshot-3");
        assert.equal(fixture.getCursor().currentOrdinal, 4);
        assert.equal(fixture.getCursor().navigationVersion, 0);
        assert.equal(fixture.getProviderBindingValue(), "binding-4");
        assert.isFalse(fixture.events.some((event) => event.startsWith("provider:")));
        assert.isFalse(fixture.events.some((event) => event.startsWith("cursor:")));
        assert.isFalse(fixture.events.includes("binding:upsert"));
        assert.equal(fixture.operations.size, 1);
        const operation = fixture.operations.get("confirmed-files-only");
        assert.equal(operation?.mode, "files-only");
        assert.equal(operation?.phase, "committed");
        assert.equal(fixture.rescueSnapshots.length, 1);
        assert.deepStrictEqual(fixture.scheduledSnapshots, fixture.rescueSnapshots);
      }),
    );
  },
);

it.effect(
  "honors explicit files-only intent even when the live provider capability is branching",
  () => {
    const fixture = makeNavigationFixture();
    fixture.entries[2] = { ...fixture.entries[2]!, providerTurnId: null };
    return runWith(
      fixture,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        const result = yield* service.navigate({
          commandId: "branching-files-only",
          threadId,
          kind: "undo",
          filesOnlyConfirmed: true,
        });

        assert.equal(result.status, "files-restored");
        assert.equal(fixture.getWorkspaceState(), "snapshot-3");
        assert.equal(fixture.getCursor().currentOrdinal, 4);
        assert.equal(fixture.getCursor().navigationVersion, 0);
        assert.equal(fixture.getProviderBindingValue(), "binding-4");
        assert.isFalse(fixture.events.some((event) => event.startsWith("provider:")));
        assert.isFalse(fixture.events.some((event) => event.startsWith("cursor:")));
        assert.isFalse(fixture.events.includes("binding:upsert"));
        assert.equal(fixture.operations.get("branching-files-only")?.mode, "files-only");
      }),
    );
  },
);

it.effect("supports a confirmed files-only jump for an unsupported provider", () => {
  const fixture = makeNavigationFixture({ capability: "unsupported" });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const result = yield* service.navigate({
        commandId: "confirmed-files-only-jump",
        threadId,
        kind: "jump",
        targetTurnCount: 1,
        filesOnlyConfirmed: true,
      });
      assert.equal(result.status, "files-restored");
      assert.equal(fixture.getWorkspaceState(), "snapshot-1");
      assert.equal(fixture.getCursor().currentOrdinal, 4);
      assert.equal(fixture.getProviderBindingValue(), "binding-4");
    }),
  );
});

it.effect("keeps redo unavailable for non-branching providers after confirmation", () => {
  const fixture = makeNavigationFixture({ capability: "rollback-only", currentOrdinal: 2 });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const error = yield* service
        .navigate({
          commandId: "files-only-redo",
          threadId,
          kind: "redo",
          filesOnlyConfirmed: true,
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "redo-requires-branching");
      assert.deepStrictEqual(fixture.events, []);
    }),
  );
});

it.effect("compensates a failed files-only restore from its rescue snapshot", () => {
  const fixture = makeNavigationFixture({
    capability: "rollback-only",
    failures: ["restore-target-after-mutation"],
  });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      yield* service
        .navigate({
          commandId: "files-only-restore-failure",
          threadId,
          kind: "undo",
          filesOnlyConfirmed: true,
        })
        .pipe(Effect.flip);
      assert.equal(fixture.getWorkspaceState(), "original");
      assert.equal(fixture.getCursor().currentOrdinal, 4);
      assert.equal(fixture.getProviderBindingValue(), "binding-4");
      assert.equal(fixture.operations.get("files-only-restore-failure")?.phase, "compensated");
      assert.deepStrictEqual(
        fixture.events.filter((event) => event.startsWith("workspace:restore")),
        [
          "workspace:restore-target:snapshot-3",
          fixture.events.find((event) => event.startsWith("workspace:restore-rescue")),
        ],
      );
    }),
  );
});

it.effect("rejects a files-only restore whose snapshot belongs to another worktree", () => {
  const fixture = makeNavigationFixture({
    capability: "unsupported",
    targetWorktreeKey: unrelatedWorktreeKey,
  });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const error = yield* service
        .navigate({
          commandId: "files-only-identity-mismatch",
          threadId,
          kind: "undo",
          filesOnlyConfirmed: true,
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "worktree-identity-mismatch");
      assert.deepStrictEqual(fixture.events, ["operation:begin", "phase:compensated"]);
    }),
  );
});

it.effect("returns a committed command idempotently without replaying mutation", () => {
  const fixture = makeNavigationFixture();
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const first = yield* service.navigate({ commandId: "same-command", threadId, kind: "undo" });
      const eventCount = fixture.events.length;
      const second = yield* service.navigate({ commandId: "same-command", threadId, kind: "undo" });
      assert.equal(first.status, "completed");
      assert.equal(second.status, "completed");
      assert.equal(fixture.events.length, eventCount);
      assert.equal(fixture.operations.size, 1);
    }),
  );
});

it.effect("returns a committed files-only command idempotently without replaying mutation", () => {
  const fixture = makeNavigationFixture({ capability: "rollback-only" });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const input = {
        commandId: "same-files-only-command",
        threadId,
        kind: "undo" as const,
        filesOnlyConfirmed: true,
      };
      const first = yield* service.navigate(input);
      const eventCount = fixture.events.length;
      const second = yield* service.navigate(input);
      assert.equal(first.status, "files-restored");
      assert.equal(second.status, "files-restored");
      assert.equal(fixture.events.length, eventCount);
      assert.equal(fixture.operations.size, 1);
      assert.equal(fixture.operations.get(input.commandId)?.mode, "files-only");
      assert.isFalse(fixture.events.some((event) => event.startsWith("provider:")));
      assert.isFalse(fixture.events.some((event) => event.startsWith("cursor:")));
    }),
  );
});

it.effect(
  "recovers files-only operations at every filesystem boundary without provider state",
  () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly phase: CheckpointNavigationPhase;
        readonly recoveryFromPhase?: CheckpointNavigationPhase;
        readonly restoresRescue: boolean;
      }> = [
        { phase: "prepared", restoresRescue: false },
        { phase: "rescue-ready", restoresRescue: true },
        { phase: "filesystem-restored", restoresRescue: true },
        { phase: "compensating-filesystem", restoresRescue: true },
        {
          phase: "needs-recovery",
          recoveryFromPhase: "filesystem-restored",
          restoresRescue: true,
        },
      ];

      for (const testCase of cases) {
        const fixture = makeNavigationFixture({ capability: "rollback-only" });
        const operation = fixture.seedOperation(testCase.phase, {
          operationId: `files-only-${testCase.phase}`,
          mode: "files-only",
          oldProviderBindingJson: "",
          targetProviderBindingJson: "",
          preparedProviderCursorJson: "",
          recoveryFromPhase: testCase.recoveryFromPhase ?? null,
        });

        const recovered = yield* runWith(
          fixture,
          Effect.gen(function* () {
            const restarted = yield* CheckpointNavigationService;
            return yield* restarted.recover();
          }),
        );

        assert.deepStrictEqual(recovered, [operation.operationId], testCase.phase);
        assert.equal(fixture.operations.get(operation.commandId)?.phase, "compensated");
        assert.equal(
          fixture.events.some((event) => event.startsWith("workspace:restore-rescue")),
          testCase.restoresRescue,
          testCase.phase,
        );
        assert.isFalse(
          fixture.events.some(
            (event) =>
              event.startsWith("provider:") ||
              event.startsWith("cursor:") ||
              event === "binding:upsert",
          ),
          testCase.phase,
        );
        assert.equal(fixture.getCursor().currentOrdinal, 4, testCase.phase);
        assert.equal(fixture.getProviderBindingValue(), "binding-4", testCase.phase);
      }
    }),
);

it.effect("resumes a failed files-only filesystem compensation after restart", () => {
  const fixture = makeNavigationFixture({
    capability: "rollback-only",
    failures: ["restore-target-after-mutation", "restore-rescue"],
  });
  return Effect.gen(function* () {
    yield* runWith(
      fixture,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        yield* service
          .navigate({
            commandId: "files-only-needs-recovery",
            threadId,
            kind: "undo",
            filesOnlyConfirmed: true,
          })
          .pipe(Effect.flip);
      }),
    );
    assert.equal(fixture.operations.get("files-only-needs-recovery")?.phase, "needs-recovery");
    assert.isFalse(fixture.events.some((event) => event.startsWith("provider:")));
    assert.isFalse(fixture.events.some((event) => event.startsWith("cursor:")));

    fixture.failures.delete("restore-rescue");
    fixture.events.length = 0;
    const recovered = yield* runWith(
      fixture,
      Effect.gen(function* () {
        const restarted = yield* CheckpointNavigationService;
        return yield* restarted.recover();
      }),
    );

    assert.equal(recovered.length, 1);
    assert.equal(fixture.operations.get("files-only-needs-recovery")?.phase, "compensated");
    assert.equal(fixture.getWorkspaceState(), "original");
    assert.equal(fixture.getCursor().currentOrdinal, 4);
    assert.equal(fixture.getProviderBindingValue(), "binding-4");
    assert.isFalse(fixture.events.some((event) => event.startsWith("provider:")));
    assert.isFalse(fixture.events.some((event) => event.startsWith("cursor:")));
  });
});

it.effect("recovers deterministically from every durable in-progress phase after restart", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<{
      readonly phase: CheckpointNavigationPhase;
      readonly cursorMoved?: boolean;
      readonly providerActivated?: boolean;
      readonly expected: ReadonlyArray<string>;
    }> = [
      { phase: "prepared", expected: [] },
      { phase: "rescue-ready", expected: [] },
      {
        phase: "provider-prepared",
        expected: ["provider:restore:binding-4", "provider:dispose", "workspace:restore-rescue"],
      },
      {
        phase: "filesystem-restored",
        expected: ["provider:restore:binding-4", "provider:dispose", "workspace:restore-rescue"],
      },
      {
        phase: "provider-activated",
        providerActivated: true,
        expected: ["provider:restore:binding-4", "provider:dispose", "workspace:restore-rescue"],
      },
      {
        phase: "cursor-committed",
        cursorMoved: true,
        providerActivated: true,
        expected: [
          "cursor:move:entry-4",
          "provider:restore:binding-4",
          "provider:dispose",
          "workspace:restore-rescue",
        ],
      },
      {
        phase: "compensating-cursor",
        cursorMoved: true,
        providerActivated: true,
        expected: [
          "cursor:move:entry-4",
          "provider:restore:binding-4",
          "provider:dispose",
          "workspace:restore-rescue",
        ],
      },
      {
        phase: "compensating-provider",
        providerActivated: true,
        expected: ["provider:restore:binding-4", "provider:dispose", "workspace:restore-rescue"],
      },
      { phase: "compensating-filesystem", expected: ["workspace:restore-rescue"] },
    ];

    for (const testCase of cases) {
      const fixture = makeNavigationFixture();
      const operation = fixture.seedOperation(testCase.phase);
      if (testCase.cursorMoved) {
        fixture.setCursor({
          ...fixture.getCursor(),
          currentEntryId: "entry-3",
          currentOrdinal: 3,
          navigationVersion: 1,
        });
      }
      if (testCase.providerActivated) fixture.setProviderBinding("binding-3");

      // Creating the service layer here models a process restart over the persisted fakes.
      const recovered = yield* runWith(
        fixture,
        Effect.gen(function* () {
          const service = yield* CheckpointNavigationService;
          return yield* service.recover();
        }),
      );
      assert.deepStrictEqual(recovered, [operation.operationId], testCase.phase);
      assert.equal(
        fixture.operations.get(operation.commandId)?.phase,
        "compensated",
        testCase.phase,
      );
      const compensationEvents = fixture.events.filter(
        (event) =>
          event.startsWith("cursor:move") ||
          event.startsWith("provider:restore") ||
          event === "provider:dispose" ||
          event.startsWith("workspace:restore-rescue"),
      );
      assert.deepStrictEqual(
        compensationEvents.map((event) => event.replace(/:nav-rescue-.+$/, "")),
        testCase.expected,
        testCase.phase,
      );
      assert.equal(fixture.getProviderBindingValue(), "binding-4", testCase.phase);
      assert.equal(fixture.getCursor().currentOrdinal, 4, testCase.phase);
    }
  }),
);

it.effect(
  "recovers activation that completed before the filesystem-restored phase advanced",
  () => {
    const fixture = makeNavigationFixture();
    const operation = fixture.seedOperation("filesystem-restored", {
      operationId: "activated-before-phase-advance",
    });
    fixture.setProviderBinding("binding-3");

    return runWith(
      fixture,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        const recovered = yield* service.recover();

        assert.deepStrictEqual(recovered, [operation.operationId]);
        assert.equal(fixture.getProviderBindingValue(), "binding-4");
        assert.equal(fixture.operations.get(operation.commandId)?.phase, "compensated");
        assert.deepStrictEqual(fixture.events, [
          "phase:compensating-provider",
          "provider:restore:binding-4",
          "provider:dispose",
          "phase:compensating-filesystem",
          `workspace:restore-rescue:${operation.rescueSnapshotId}`,
          "phase:compensated",
        ]);
      }),
    );
  },
);

it.effect("compensates failures before and after every externally visible phase", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<{
      readonly failure: NavigationFailurePoint;
      readonly expectedTargetRestore: boolean;
      readonly expectedDispose?: boolean;
    }> = [
      { failure: "capture-rescue", expectedTargetRestore: false },
      { failure: "record-rescue", expectedTargetRestore: false },
      { failure: "advance:rescue-ready", expectedTargetRestore: false },
      { failure: "prepare-provider", expectedTargetRestore: false },
      { failure: "advance:provider-prepared", expectedTargetRestore: true, expectedDispose: true },
      { failure: "restore-target", expectedTargetRestore: true, expectedDispose: true },
      {
        failure: "restore-target-after-mutation",
        expectedTargetRestore: true,
        expectedDispose: true,
      },
      {
        failure: "advance:filesystem-restored",
        expectedTargetRestore: true,
        expectedDispose: true,
      },
      { failure: "activate-provider", expectedTargetRestore: true, expectedDispose: true },
      { failure: "advance:provider-activated", expectedTargetRestore: true },
      { failure: "move-cursor", expectedTargetRestore: true },
      { failure: "advance:cursor-committed", expectedTargetRestore: true },
      { failure: "upsert-binding", expectedTargetRestore: true },
      { failure: "schedule-retention", expectedTargetRestore: true },
      { failure: "advance:committed", expectedTargetRestore: true },
    ];

    for (const testCase of cases) {
      const fixture = makeNavigationFixture({ failures: [testCase.failure] });
      yield* runWith(
        fixture,
        Effect.gen(function* () {
          const service = yield* CheckpointNavigationService;
          yield* service
            .navigate({ commandId: `failure-${testCase.failure}`, threadId, kind: "undo" })
            .pipe(Effect.flip);
        }),
      );
      const operation = [...fixture.operations.values()][0];
      assert.equal(operation?.phase, "compensated", testCase.failure);
      assert.equal(fixture.getCursor().currentOrdinal, 4, testCase.failure);
      assert.equal(fixture.getProviderBindingValue(), "binding-4", testCase.failure);
      if (testCase.expectedTargetRestore) {
        assert.isTrue(
          fixture.events.some((event) => event.startsWith("workspace:restore-rescue")),
          testCase.failure,
        );
      }
      if (testCase.expectedDispose) {
        assert.isTrue(fixture.events.includes("provider:dispose"), testCase.failure);
      }
      assert.equal(fixture.getWorkspaceState(), "original", testCase.failure);
    }
  }),
);

it.effect("restores rescue state when target restore mutates and then fails", () => {
  const fixture = makeNavigationFixture({ failures: ["restore-target-after-mutation"] });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      yield* service
        .navigate({ commandId: "mid-restore-failure", threadId, kind: "undo" })
        .pipe(Effect.flip);
      assert.equal(fixture.getWorkspaceState(), "original");
      assert.equal(fixture.operations.get("mid-restore-failure")?.phase, "compensated");
      assert.deepStrictEqual(
        fixture.events.filter((event) => event.startsWith("workspace:restore")),
        [
          "workspace:restore-target:snapshot-3",
          `workspace:restore-rescue:nav-rescue-${
            fixture.operations.get("mid-restore-failure")?.operationId ?? "missing"
          }`,
        ],
      );
    }),
  );
});

it.effect("compensates cursor, provider, then filesystem in that order", () => {
  const fixture = makeNavigationFixture({ failures: ["upsert-binding"] });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      yield* service
        .navigate({ commandId: "ordered-compensation", threadId, kind: "undo" })
        .pipe(Effect.flip);
      const cursorIndex = fixture.events.lastIndexOf("cursor:move:entry-4");
      const providerIndex = fixture.events.lastIndexOf("provider:restore:binding-4");
      const filesystemIndex = fixture.events.findIndex((event) =>
        event.startsWith("workspace:restore-rescue"),
      );
      assert.isTrue(cursorIndex >= 0);
      assert.isTrue(cursorIndex < providerIndex);
      assert.isTrue(providerIndex < filesystemIndex);
    }),
  );
});

it.effect("persists needs-recovery on compensation failure and resumes it after restart", () => {
  const fixture = makeNavigationFixture({
    failures: ["activate-provider", "restore-rescue"],
  });
  return Effect.gen(function* () {
    yield* runWith(
      fixture,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        yield* service
          .navigate({ commandId: "needs-recovery", threadId, kind: "undo" })
          .pipe(Effect.flip);
      }),
    );
    assert.equal(fixture.operations.get("needs-recovery")?.phase, "needs-recovery");
    assert.equal(
      fixture.operations.get("needs-recovery")?.compensationFailureCode,
      "restore-rescue",
    );
    fixture.failures.delete("restore-rescue");
    fixture.events.length = 0;

    const recovered = yield* runWith(
      fixture,
      Effect.gen(function* () {
        const restarted = yield* CheckpointNavigationService;
        return yield* restarted.recover();
      }),
    );
    assert.equal(recovered.length, 1);
    assert.equal(fixture.operations.get("needs-recovery")?.phase, "compensated");
    assert.isTrue(fixture.events.some((event) => event.startsWith("workspace:restore-rescue")));
    assert.equal(fixture.getProviderBindingValue(), "binding-4");
    assert.equal(fixture.getCursor().currentOrdinal, 4);
  });
});

it.effect("rejects a rescue captured for an unrelated worktree before target mutation", () => {
  const fixture = makeNavigationFixture({ rescueWorktreeKey: unrelatedWorktreeKey });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const error = yield* service
        .navigate({ commandId: "wrong-worktree", threadId, kind: "undo" })
        .pipe(Effect.flip);
      assert.equal(error.code, "worktree-identity-mismatch");
      assert.isFalse(fixture.events.some((event) => event.startsWith("workspace:restore-target")));
      assert.equal(fixture.getCursor().currentOrdinal, 4);
      assert.equal(fixture.getProviderBindingValue(), "binding-4");
    }),
  );
});

it.effect("blocks all navigation mutation while an unresolved operation exists", () => {
  const fixture = makeNavigationFixture();
  const unresolved = fixture.seedOperation("rescue-ready", { operationId: "unresolved-op" });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const error = yield* service
        .navigate({ commandId: "blocked-command", threadId, kind: "undo" })
        .pipe(Effect.flip);
      assert.equal(error.code, "navigation-recovery-required");
      assert.equal(error.operationId, unresolved.operationId);
      assert.deepStrictEqual(fixture.events, []);
      assert.equal(fixture.operations.size, 1);
    }),
  );
});

it.effect("abandons forward history exactly once before a new turn", () =>
  Effect.gen(function* () {
    const atTip = makeNavigationFixture();
    const unchanged = yield* runWith(
      atTip,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        return yield* service.abandonForwardHistory(threadId);
      }),
    );
    assert.isFalse(unchanged.abandoned);
    assert.deepStrictEqual(atTip.events, []);

    const behindTip = makeNavigationFixture({ currentOrdinal: 2 });
    const abandoned = yield* runWith(
      behindTip,
      Effect.gen(function* () {
        const service = yield* CheckpointNavigationService;
        const first = yield* service.abandonForwardHistory(threadId);
        const second = yield* service.abandonForwardHistory(threadId);
        return { first, second };
      }),
    );
    assert.isTrue(abandoned.first.abandoned);
    assert.equal(abandoned.first.abandonedGeneration, 0);
    assert.equal(abandoned.first.activeGeneration, 1);
    assert.equal(abandoned.first.cursorVersion, 1);
    assert.isFalse(abandoned.second.abandoned);
    assert.deepStrictEqual(behindTip.events, ["cursor:fork:1"]);
    assert.equal(behindTip.getCursor().forwardTipOrdinal, 2);
  }),
);

it.effect("undoes into an ancestor and redoes onto the new branch after a forked turn", () => {
  const fixture = makeNavigationFixture({ currentOrdinal: 2 });
  return runWith(
    fixture,
    Effect.gen(function* () {
      const service = yield* CheckpointNavigationService;
      const forked = yield* service.abandonForwardHistory(threadId);
      assert.isTrue(forked.abandoned);

      const branchEntry = {
        ...fixture.entries[2]!,
        entryId: "branch-entry-3",
        timelineGeneration: 1,
        turnId: "branch-turn-3",
        providerTurnId: "branch-provider-turn-3",
        snapshotId: "branch-snapshot-3",
        assistantMessageId: "branch-assistant-3",
      };
      fixture.entries.push(branchEntry);
      fixture.setCursor({
        ...fixture.getCursor(),
        currentEntryId: branchEntry.entryId,
        currentOrdinal: branchEntry.ordinal,
        forwardTipEntryId: branchEntry.entryId,
        forwardTipOrdinal: branchEntry.ordinal,
      });

      const undo = yield* service.navigate({
        commandId: "branch-undo-ancestor",
        threadId,
        kind: "undo",
      });
      assert.equal(undo.status, "completed");
      if (undo.status === "completed") assert.equal(undo.targetEntryId, "entry-2");
      assert.equal(fixture.getCursor().activeGeneration, 1);
      assert.equal(fixture.getCursor().currentOrdinal, 2);

      const redo = yield* service.navigate({
        commandId: "branch-redo-child",
        threadId,
        kind: "redo",
      });
      assert.equal(redo.status, "completed");
      if (redo.status === "completed") assert.equal(redo.targetEntryId, "branch-entry-3");
      assert.equal(fixture.getCursor().activeGeneration, 1);
      assert.equal(fixture.getCursor().currentEntryId, "branch-entry-3");
      assert.deepStrictEqual(
        fixture.events.filter((event) => event.startsWith("workspace:restore-target")),
        ["workspace:restore-target:snapshot-2", "workspace:restore-target:branch-snapshot-3"],
      );
    }),
  );
});
