import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import * as ClaudeAdapter from "./ClaudeAdapterV2.ts";

const sdk = vi.hoisted(() => ({ query: vi.fn(), resolve: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: sdk.query,
}));
vi.mock("../../provider/Drivers/ClaudeExecutable.ts", () => ({
  resolveClaudeSdkExecutablePath: sdk.resolve,
}));
beforeEach(() => {
  sdk.query.mockReset();
  sdk.resolve.mockReset();
});
const layer = ClaudeAdapter.layerQueryRunner.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);
const input = (command = "C:/explicit/claude.exe"): ClaudeAdapter.ClaudeAgentSdkQueryOpenInput => ({
  threadId: ThreadId.make("sdk-startup"),
  providerSessionId: ProviderSessionId.make("sdk-startup-session"),
  executableCommand: command,
  options: {
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    sessionId: "native-startup",
    pathToClaudeCodeExecutable: "C:/stale/claude.exe",
  },
});

it.effect("waits for the SDK readiness handshake before accepting a prompt", () =>
  Effect.gen(function* () {
    const ready = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<void>();
    let opened = false;
    const close = vi.fn();
    sdk.query.mockImplementation(() => ({
      initializationResult: () => {
        opening.resolve();
        return ready.promise;
      },
      close,
    }));
    const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
    const fiber = yield* runner.open(input()).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          opened = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.promise(() => opening.promise);
    assert.isFalse(opened);
    ready.resolve();
    const session = yield* Fiber.join(fiber);
    assert.isTrue(opened);
    yield* session.close;
    assert.equal(close.mock.calls.length, 1);
    assert.equal(sdk.query.mock.calls.length, 1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "closes failed SDK attempts and retries a PATH command once before any prompt is offered",
  () =>
    Effect.gen(function* () {
      const close = vi.fn();
      sdk.query.mockReturnValueOnce({
        initializationResult: () =>
          Promise.reject(
            Object.assign(new Error("missing"), { code: "ENOENT", syscall: "spawn claude" }),
          ),
        close,
      });
      sdk.query.mockReturnValueOnce({
        initializationResult: () => Promise.resolve({}),
        close: vi.fn(),
      });
      sdk.resolve.mockReturnValue(Effect.succeed("C:/fresh/claude.exe"));
      const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open(input("claude"));
      assert.equal(close.mock.calls.length, 1);
      assert.equal(sdk.query.mock.calls.length, 2);
      assert.equal(
        sdk.query.mock.calls[1]?.[0].options.pathToClaudeCodeExecutable,
        "C:/fresh/claude.exe",
      );
      yield* session.close;
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  [
    "C:/explicit/claude.exe",
    Object.assign(new Error("missing"), { code: "ENOENT", syscall: "spawn claude" }),
  ],
  ["claude", new Error("provider authentication failed")],
] as const)(
  "does not retry an authoritative path or a non-launch failure: %s",
  ([command, cause]) =>
    Effect.gen(function* () {
      const close = vi.fn();
      sdk.query.mockReturnValue({ initializationResult: () => Promise.reject(cause), close });
      const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
      yield* runner.open(input(command)).pipe(Effect.flip);
      assert.equal(close.mock.calls.length, 1);
      assert.equal(sdk.query.mock.calls.length, 1);
      assert.equal(sdk.resolve.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
);
