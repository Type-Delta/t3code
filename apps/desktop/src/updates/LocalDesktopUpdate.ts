import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { DesktopLocalUpdateState, DesktopLocalUpdateStep } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

const LOCAL_UPDATE_SOURCE_ENV = "T3CODE_LOCAL_UPDATE_SOURCE";
const INSTALLED_COMMIT_ENV = "T3CODE_LOCAL_UPDATE_INSTALLED_COMMIT";
const PROGRESS_PREFIX = "::t3-local-update::";
const FAILURE_PREFIX = "::t3-local-update-failed::";

const LocalUpdatePackageMetadata = Schema.Struct({
  t3codeLocalUpdateSource: Schema.optional(Schema.String),
  t3codeCommitHash: Schema.optional(Schema.String),
});
const decodeLocalUpdatePackageMetadata = Schema.decodeEffect(
  Schema.fromJsonString(LocalUpdatePackageMetadata),
);

const LOCAL_UPDATE_STEP_PROGRESS = {
  "resolve-source": 5,
  "inspect-checkout": 10,
  stash: 15,
  fetch: 25,
  merge: 40,
  check: 55,
  typecheck: 70,
  build: 85,
  "open-installer": 92,
  restore: 96,
  "up-to-date": 100,
  completed: 100,
} as const satisfies Partial<Record<DesktopLocalUpdateStep, number>>;

export const initialDesktopLocalUpdateState: DesktopLocalUpdateState = {
  status: "idle",
  step: "idle",
  progressPercent: 0,
  message: null,
};

export class LocalDesktopUpdateSourceError extends Schema.TaggedErrorClass<LocalDesktopUpdateSourceError>()(
  "LocalDesktopUpdateSourceError",
  {},
) {
  override get message(): string {
    return "This installation is not linked to a local Type-Delta checkout. Build and install it with vp run update:local from that checkout first.";
  }
}

export class LocalDesktopUpdateCheckoutError extends Schema.TaggedErrorClass<LocalDesktopUpdateCheckoutError>()(
  "LocalDesktopUpdateCheckoutError",
  {},
) {
  override get message(): string {
    return "The linked Type-Delta checkout is unavailable or is no longer a Git checkout.";
  }
}

export class LocalDesktopUpdateProcessError extends Schema.TaggedErrorClass<LocalDesktopUpdateProcessError>()(
  "LocalDesktopUpdateProcessError",
  { exitCode: Schema.Number, output: Schema.String },
) {
  override get message(): string {
    return (
      this.output ||
      "The local update did not complete. Fix the reported checkout problem, then try again."
    );
  }
}

/**
 * The script emits fixed progress markers while retaining the prior safety
 * checks. Uncommitted work is parked in a temporary stash that is applied and
 * dropped by exact object id, never by position. Source paths travel only in
 * the environment, never as shell text. Failures end with one plain message
 * line so the UI can show it.
 */
export const localDesktopUpdatePowerShell = String.raw`
$ErrorActionPreference = "Continue"
$SourceDirectory = $env:T3CODE_LOCAL_UPDATE_SOURCE
$InstalledCommit = $env:T3CODE_LOCAL_UPDATE_INSTALLED_COMMIT
$StashMessage = "t3code local update: temporary stash of uncommitted changes"
$StashObject = $null
$AlreadyUpToDate = $false

function Invoke-UpdateStep {
  param([string]$Step, [string]$Label, [scriptblock]$Command)
  Write-Output "::t3-local-update::$Step"
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)." }
}

function Get-StashHead {
  $head = git rev-parse --verify --quiet refs/stash
  if ($LASTEXITCODE -ne 0) { return $null }
  return $head
}

function Save-LocalChanges {
  Write-Output "::t3-local-update::stash"
  git stash push --include-untracked --message $StashMessage | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not stash your uncommitted changes. Nothing was fetched or merged." }
  $head = Get-StashHead
  $subject = if ($head) { git log -1 --format=%s $head } else { $null }
  if (-not $head -or -not ($subject -like "*$StashMessage*")) {
    throw "Could not identify the temporary stash. Nothing was fetched or merged."
  }
  $script:StashObject = $head
}

function Restore-LocalChanges {
  if (-not $StashObject) { return }
  Write-Output "::t3-local-update::restore"
  git stash apply --index $StashObject
  if ($LASTEXITCODE -ne 0) {
    throw "Your changes are kept in temporary stash $StashObject but could not be restored automatically. Resolve the conflicts in the working tree, then drop that stash once your work is back."
  }
  if ((Get-StashHead) -ne $StashObject) {
    throw "Your changes were restored, but temporary stash $StashObject was left in place because the stash list changed during the update. Drop it manually once you confirm your work is back."
  }
  git stash drop | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Your changes were restored, but temporary stash $StashObject could not be dropped. Drop it manually." }
}

try {
  Set-Location -LiteralPath $SourceDirectory -ErrorAction Stop
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory ".git"))) {
    throw "The linked folder is not a Git checkout."
  }

  Write-Output "::t3-local-update::inspect-checkout"
  $changes = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Could not read the Git working tree." }
  $remotes = @(git remote)
  if ($LASTEXITCODE -ne 0) { throw "Could not read the configured Git remotes." }
  $remote = if ($remotes -contains "upstream") { "upstream" } elseif ($remotes -contains "origin") { "origin" } else { $null }
  if (-not $remote) {
    throw "This checkout has no 'upstream' or 'origin' remote to update from."
  }

  if ($changes) { Save-LocalChanges }

  $updateError = $null
  try {
    Invoke-UpdateStep "fetch" "Fetching $remote" { git fetch $remote }
    $remoteHead = git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD"
    if ($LASTEXITCODE -ne 0 -or -not $remoteHead) {
      git remote set-head $remote --auto | Out-Null
      $remoteHead = git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD"
    }
    if (-not $remoteHead) {
      throw "The $remote remote has no default branch. Run 'git remote set-head $remote --auto', then try again."
    }
    $remoteCommit = git rev-parse --verify "$remoteHead^{commit}"
    if ($LASTEXITCODE -ne 0 -or -not $remoteCommit) {
      throw "Could not resolve the latest commit from $remoteHead."
    }
    $installedCommit = if ($InstalledCommit -match '^[0-9a-fA-F]{7,40}$') {
      git rev-parse --verify "$InstalledCommit^{commit}" 2>$null
    } else { $null }
    if ($LASTEXITCODE -eq 0 -and $installedCommit) {
      git merge-base --is-ancestor $remoteCommit $installedCommit
      $AlreadyUpToDate = $LASTEXITCODE -eq 0
    }

    if (-not $AlreadyUpToDate) {
      Invoke-UpdateStep "merge" "Merging $remoteHead" { git merge --no-edit $remoteHead }
      Invoke-UpdateStep "check" "Checking code" { vp check }
      Invoke-UpdateStep "typecheck" "Checking types" { vp run typecheck }
      Invoke-UpdateStep "build" "Building installer" { vp run update:local }
      Write-Output "::t3-local-update::open-installer"
    }
  } catch {
    $updateError = $_.Exception.Message
    git rev-parse --verify --quiet MERGE_HEAD | Out-Null
    if ($LASTEXITCODE -eq 0) {
      git merge --abort
      if ($LASTEXITCODE -ne 0) {
        $kept = if ($StashObject) { " Your changes are kept in temporary stash $StashObject; apply it with 'git stash apply --index $StashObject' after the merge is resolved or aborted." } else { "" }
        throw "$updateError The merge could not be aborted, so the checkout was left as is.$kept"
      }
    }
  }

  try {
    Restore-LocalChanges
  } catch {
    if ($updateError) { throw "$updateError $($_.Exception.Message)" }
    throw
  }
  if ($updateError) { throw $updateError }
  if ($AlreadyUpToDate) { Write-Output "::t3-local-update::up-to-date" }
} catch {
  Write-Output "::t3-local-update-failed::$($_.Exception.Message)"
  exit 1
}
`;

/**
 * Build-only variant: packages and opens an installer from the checkout as it
 * is, with no fetch, merge, stash, or verification. Used for testing local work.
 */
export const localDesktopBuildPowerShell = String.raw`
$ErrorActionPreference = "Continue"
$SourceDirectory = $env:T3CODE_LOCAL_UPDATE_SOURCE
try {
  Set-Location -LiteralPath $SourceDirectory -ErrorAction Stop
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory ".git"))) {
    throw "The linked folder is not a Git checkout."
  }
  Write-Output "::t3-local-update::build"
  vp run update:local
  if ($LASTEXITCODE -ne 0) { throw "Building installer failed (exit code $LASTEXITCODE)." }
  Write-Output "::t3-local-update::open-installer"
} catch {
  Write-Output "::t3-local-update-failed::$($_.Exception.Message)"
  exit 1
}
`;

export function getDesktopLocalUpdateStateForStep(
  step: DesktopLocalUpdateStep,
): DesktopLocalUpdateState {
  const progressPercent = step === "idle" ? 0 : LOCAL_UPDATE_STEP_PROGRESS[step];
  return {
    status: step === "completed" ? "completed" : step === "up-to-date" ? "up-to-date" : "running",
    step,
    progressPercent,
    message: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unexpected error occurred during the local update.";
}

export class LocalDesktopUpdates extends Context.Service<
  LocalDesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopLocalUpdateState>;
    readonly start: Effect.Effect<void>;
    readonly startBuild: Effect.Effect<void>;
  }
>()("@t3tools/desktop/updates/LocalDesktopUpdate/LocalDesktopUpdates") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stateRef = yield* Ref.make<DesktopLocalUpdateState>(initialDesktopLocalUpdateState);
  const runningRef = yield* Ref.make(false);

  const emitState = Ref.get(stateRef).pipe(
    Effect.flatMap((state) =>
      electronWindow.sendAll(IpcChannels.LOCAL_UPDATE_STATE_CHANNEL, state),
    ),
  );
  const setState = (state: DesktopLocalUpdateState) =>
    Ref.set(stateRef, state).pipe(Effect.andThen(emitState));

  const resolveSourceDirectory = Effect.fn("desktop.localUpdates.resolveSourceDirectory")(
    function* () {
      if (!environment.isPackaged) {
        return environment.appRoot;
      }

      const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
      const packageJson = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
      if (packageJson._tag === "None") {
        return yield* new LocalDesktopUpdateSourceError();
      }

      const metadata = yield* decodeLocalUpdatePackageMetadata(packageJson.value).pipe(
        Effect.option,
      );
      if (metadata._tag === "None" || !metadata.value.t3codeLocalUpdateSource?.trim()) {
        return yield* new LocalDesktopUpdateSourceError();
      }

      return metadata.value.t3codeLocalUpdateSource.trim();
    },
  );

  const validateSourceDirectory = Effect.fn("desktop.localUpdates.validateSourceDirectory")(
    function* (sourceDirectory: string) {
      const isCheckout =
        (yield* fileSystem.exists(environment.path.join(sourceDirectory, ".git"))) &&
        (yield* fileSystem.exists(environment.path.join(sourceDirectory, "package.json")));
      if (!isCheckout) {
        return yield* new LocalDesktopUpdateCheckoutError();
      }
    },
  );

  const runUpdate = Effect.fn("desktop.localUpdates.run")(function* (
    script: string,
  ): Effect.fn.Return<
    void,
    | LocalDesktopUpdateSourceError
    | LocalDesktopUpdateCheckoutError
    | LocalDesktopUpdateProcessError
    | PlatformError,
    Scope.Scope
  > {
    yield* setState(getDesktopLocalUpdateStateForStep("resolve-source"));
    const sourceDirectory = yield* resolveSourceDirectory();
    yield* validateSourceDirectory(sourceDirectory);

    const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
    const packageJson = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
    const packageMetadata =
      packageJson._tag === "Some"
        ? yield* decodeLocalUpdatePackageMetadata(packageJson.value).pipe(Effect.option)
        : packageJson;
    const installedCommit =
      packageMetadata._tag === "Some" ? (packageMetadata.value.t3codeCommitHash?.trim() ?? "") : "";

    const child = yield* spawner.spawn(
      ChildProcess.make(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        {
          cwd: sourceDirectory,
          env: {
            [LOCAL_UPDATE_SOURCE_ENV]: sourceDirectory,
            [INSTALLED_COMMIT_ENV]: installedCommit,
          },
          extendEnv: true,
          stdin: "ignore",
        },
      ),
    );

    let lastOutput = "";
    let alreadyUpToDate = false;
    yield* child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const trimmed = line.trim();
        const step = trimmed.slice(PROGRESS_PREFIX.length) as DesktopLocalUpdateStep;
        if (trimmed.startsWith(PROGRESS_PREFIX) && step in LOCAL_UPDATE_STEP_PROGRESS) {
          if (step === "up-to-date") alreadyUpToDate = true;
          return setState(getDesktopLocalUpdateStateForStep(step));
        }
        if (trimmed.startsWith(FAILURE_PREFIX)) {
          lastOutput = trimmed.slice(FAILURE_PREFIX.length).slice(-1_000);
        } else if (trimmed) {
          lastOutput = trimmed.slice(-1_000);
        }
        return Effect.void;
      }),
    );

    const exitCode = Number(yield* child.exitCode);
    if (exitCode !== 0) {
      return yield* new LocalDesktopUpdateProcessError({ exitCode, output: lastOutput });
    }

    yield* setState(
      getDesktopLocalUpdateStateForStep(alreadyUpToDate ? "up-to-date" : "completed"),
    );
  });

  const start = Effect.fn("desktop.localUpdates.start")(function* (script: string) {
    const started = yield* Ref.modify(runningRef, (running) => [!running, true] as const);
    if (!started) return;

    yield* Effect.scoped(runUpdate(script)).pipe(
      Effect.catch((error) =>
        setState({
          status: "error",
          step: "idle",
          progressPercent: 0,
          message: errorMessage(error),
        }),
      ),
      Effect.ensuring(Ref.set(runningRef, false)),
    );
  });

  return LocalDesktopUpdates.of({
    getState: Ref.get(stateRef),
    start: start(localDesktopUpdatePowerShell),
    startBuild: start(localDesktopBuildPowerShell),
  });
});

export const layer = Layer.effect(LocalDesktopUpdates, make);
