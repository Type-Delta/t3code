import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const ClaudeTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const binDir = path.join(dir, "bin");
    const scriptPath = path.join(binDir, "fake-claude.cjs");
    const claudePath = path.join(binDir, platform === "win32" ? "claude.cmd" : "claude");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      scriptPath,
      [
        '"use strict";',
        'const args = process.argv.slice(2).join(" ");',
        'let stdinContent = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { stdinContent += chunk; });',
        'process.stdin.on("end", () => {',
        "  const env = process.env;",
        "  if (env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN && !args.includes(env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN)) {",
        '    process.stderr.write("args missing expected content\\n");',
        "    process.exit(2);",
        "  }",
        "  if (env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN && args.includes(env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN)) {",
        '    process.stderr.write("args contained forbidden content\\n");',
        "    process.exit(3);",
        "  }",
        "  if (env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN && !stdinContent.includes(env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN)) {",
        '    process.stderr.write("stdin missing expected content\\n");',
        "    process.exit(4);",
        "  }",
        "  if (env.T3_FAKE_CLAUDE_HOME_MUST_BE && env.HOME !== env.T3_FAKE_CLAUDE_HOME_MUST_BE) {",
        '    process.stderr.write(`HOME was ${env.HOME ?? ""}\\n`);',
        "    process.exit(5);",
        "  }",
        "  if (env.T3_FAKE_CLAUDE_STDERR) process.stderr.write(`${env.T3_FAKE_CLAUDE_STDERR}\\n`);",
        '  process.stdout.write(env.T3_FAKE_CLAUDE_OUTPUT ?? "");',
        '  process.exit(Number(env.T3_FAKE_CLAUDE_EXIT_CODE ?? "0"));',
        "});",
        "",
      ].join("\n"),
    );
    if (platform === "win32") {
      yield* fs.writeFileString(
        claudePath,
        `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      );
    } else {
      yield* fs.writeFileString(
        claudePath,
        `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
      );
      yield* fs.chmod(claudePath, 0o755);
    }
    return claudePath;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    homeMustBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const claudePath = yield* makeFakeClaudeBinary(tempDir);
    const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousHomeMustBe = process.env.T3_FAKE_CLAUDE_HOME_MUST_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.homeMustBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_HOME_MUST_BE = input.homeMustBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_HOME_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.T3_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDERR;
          } else {
            process.env.T3_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousHomeMustBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_HOME_MUST_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_HOME_MUST_BE = previousHomeMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings({ ...input.claudeConfig, binaryPath: claudePath });
    const textGeneration = yield* makeClaudeTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-haiku-4-5", [
                { id: "thinking", value: false },
                { id: "effort", value: "high" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain: '--effort max --settings {"fastMode":true}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/claude-effect",
            commitSummary: "Improve orchestration",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ]),
            },
          });

          expect(generated.title).toBe("Improve orchestration flow");
        }),
    ),
  );

  it.effect("generates thread titles through the Claude provider", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title:
              '  "Reconnect failures after restart because the session state does not recover"  ',
          },
        }),
        stdinMustContain: "You write concise thread titles for coding conversations.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate reconnect failures after restarting the session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe(
            sanitizeThreadTitle(
              '"Reconnect failures after restart because the session state does not recover"',
            ),
          );
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured Claude HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeHome = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          homeMustBe: claudeHome,
          claudeConfig: { homePath: claudeHome },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );
});
