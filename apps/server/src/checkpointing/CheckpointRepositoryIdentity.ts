// @effect-diagnostics nodeBuiltinImport:off
/**
 * Canonical Git repository/worktree identity for checkpoint sidecars.
 *
 * A linked worktree has its own `.git` file but shares the common Git
 * directory.  The two keys deliberately model those separate identities.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { VcsProcessExitError, type VcsError } from "@t3tools/contracts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export interface CheckpointRepositoryIdentity {
  /** SHA-256 of the versioned Git-family identity payload. */
  readonly repositoryKey: string;
  /** SHA-256 of the versioned resolved worktree path. */
  readonly worktreeKey: string;
  readonly commonDir: string;
  readonly worktreeRoot: string;
  readonly objectFormat: "sha1" | "sha256";
}

export class CheckpointRepositoryIdentityResolver extends Context.Service<
  CheckpointRepositoryIdentityResolver,
  {
    readonly resolve: (cwd: string) => Effect.Effect<CheckpointRepositoryIdentity, VcsError>;
  }
>()("t3/checkpointing/CheckpointRepositoryIdentity/CheckpointRepositoryIdentityResolver") {}

/** Drop ambient Git plumbing before invoking Git for a checkpoint operation. */
export const sanitizedGitEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(globalThis.process.env)) {
    // Git has a broad environment API (config injection, object alternates,
    // worktree/index overrides, tracing and credential helpers). Checkpoint
    // plumbing must opt into the few variables it needs instead of inheriting
    // any of those ambient controls.
    if (key.toUpperCase().startsWith("GIT_")) continue;
    environment[key] = value;
  }
  return environment;
};

const hashKey = (payload: string) => NodeCrypto.createHash("sha256").update(payload).digest("hex");

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const hostPlatform = yield* HostProcessPlatform;

  const git = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    process.run({
      operation,
      command: "git",
      args: ["-C", cwd, ...args],
      cwd,
      spawnCwd: globalThis.process.cwd(),
      env: sanitizedGitEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 8_192,
    });

  const resolve: CheckpointRepositoryIdentityResolver["Service"]["resolve"] = Effect.fn(
    "CheckpointRepositoryIdentityResolver.resolve",
  )(function* (cwd) {
    const [worktreeResult, commonDirResult, objectFormatResult] = yield* Effect.all([
      git("CheckpointRepositoryIdentity.worktree", cwd, ["rev-parse", "--show-toplevel"]),
      git("CheckpointRepositoryIdentity.commonDir", cwd, ["rev-parse", "--git-common-dir"]),
      git("CheckpointRepositoryIdentity.objectFormat", cwd, ["rev-parse", "--show-object-format"]),
    ]);
    const worktreeOutput = worktreeResult.stdout.trim();
    const commonDirOutput = commonDirResult.stdout.trim();
    const objectFormat = objectFormatResult.stdout.trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      // Keep the error in the existing VCS error channel rather than allowing
      // an unrecognised object format to select an incompatible sidecar.
      return yield* new VcsProcessExitError({
        operation: "CheckpointRepositoryIdentity.objectFormat",
        command: "git rev-parse",
        cwd,
        exitCode: 1,
        detail: "Git reported an unsupported object format.",
      });
    }

    const worktreeCandidate = path.isAbsolute(worktreeOutput)
      ? worktreeOutput
      : path.resolve(cwd, worktreeOutput);
    const commonDirCandidate = path.isAbsolute(commonDirOutput)
      ? commonDirOutput
      : path.resolve(cwd, commonDirOutput);
    const canonicalRealPath = (candidate: string) =>
      Effect.tryPromise({
        // Node's native Windows realpath expands 8.3 aliases; Effect's
        // lexical fallback intentionally does not, which would split one
        // linked-worktree family across two repository keys.
        try: () => NodeFSP.realpath(candidate),
        catch: () =>
          new VcsProcessExitError({
            operation: "CheckpointRepositoryIdentity.realPath",
            command: "git rev-parse",
            cwd,
            exitCode: 1,
            detail: "Git worktree identity changed while resolving its canonical path.",
          }),
      }).pipe(
        Effect.map((resolved) => (hostPlatform === "win32" ? resolved.toLowerCase() : resolved)),
      );
    const [worktreeRoot, commonDir] = yield* Effect.all([
      canonicalRealPath(worktreeCandidate),
      canonicalRealPath(commonDirCandidate),
    ]);

    return {
      repositoryKey: hashKey(`t3-sidecar-repository:v1\0${commonDir}\0${objectFormat}`),
      worktreeKey: hashKey(`t3-sidecar-worktree:v1\0${worktreeRoot}`),
      commonDir,
      worktreeRoot,
      objectFormat,
    };
  });

  return CheckpointRepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(CheckpointRepositoryIdentityResolver, make).pipe(
  Layer.provide(VcsProcess.layer),
);
