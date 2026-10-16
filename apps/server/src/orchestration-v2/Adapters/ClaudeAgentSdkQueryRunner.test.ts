// @effect-diagnostics nodeBuiltinImport:off -- Uses a real fake CLI and process tree.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ClaudeAdapter from "./ClaudeAdapterV2.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const sdk = vi.hoisted(() => ({ query: vi.fn(), resolve: vi.fn(), realQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => {
  const module = await original<typeof import("@anthropic-ai/claude-agent-sdk")>();
  sdk.realQuery = module.query as unknown as typeof sdk.realQuery;
  return { ...module, query: sdk.query };
});
vi.mock("../../provider/Drivers/ClaudeExecutable.ts", () => ({
  resolveClaudeSdkExecutablePath: sdk.resolve,
}));
beforeEach(() => {
  sdk.query.mockReset().mockImplementation(sdk.realQuery);
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

it.effect("logs successful task stops for replay and omits failed stops", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const stopTask = vi.fn(async (_taskId: string) => {});
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      stopTask,
      initializationResult: () => Promise.resolve({}),
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const threadId = ThreadId.make("thread-stop");
    const providerSessionId = ProviderSessionId.make("session-stop");
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId,
        providerSessionId,
        options: {
          sessionId: "native-session-stop",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      writes.length = 0;
      yield* session.stopTask("workflow-task");
      assert.deepEqual(stopTask.mock.calls, [["workflow-task"]]);
      assert.deepEqual(writes, [
        {
          provider: "claudeAgent",
          protocol: ClaudeAdapter.CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId,
          event: {
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.stop_task", taskId: "workflow-task" },
          },
        },
      ]);
      stopTask.mockRejectedValueOnce(new Error("Stop failed"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.stopTask("failed-task"))));
      assert.equal(writes.length, 1);
    }).pipe(
      Effect.provide(
        ClaudeAdapter.layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
              native: {
                filePath: "/tmp/events.log",
                write: (event) =>
                  Effect.sync(() => {
                    writes.push(event);
                  }),
                close: () => Effect.void,
              },
              canonical: undefined,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const realQueryRunner = ClaudeAdapter.layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

/** Writes an executable stand-in for the Claude CLI into a fresh directory. */
function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The CLI stops the MCP servers it started, but not their children: a
  // plugin's `bun server.ts` outlives its `bun run` wrapper (#3089). The fake
  // CLI leaves a child running the same way. The child holds a FIFO open, so
  // its death reads as end-of-file here, with no polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          `while IFS= read -r line; do printf '%s\\n' "$line" | '${process.execPath}' -e 'const fs = require("fs"); const m = JSON.parse(fs.readFileSync(0, "utf8")); if (m.type === "control_request") console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: m.request_id, response: {}}}));'; done`,
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // Only does anything when the test fails: do not leak its child.
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const session = yield* openFakeCli(cli);
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
    }).pipe(Effect.provide(realQueryRunner)),
  );
});
