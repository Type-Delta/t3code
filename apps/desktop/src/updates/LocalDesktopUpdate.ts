import { ChildProcess } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Keep the update steps in a visible terminal. A local checkout is required:
 * packaged applications do not contain the source or the build toolchain.
 */
export const localDesktopUpdatePowerShell = String.raw`
$ErrorActionPreference = "Stop"
$SourceDirectory = $env:T3CODE_LOCAL_UPDATE_SOURCE
$failed = $false

function Invoke-UpdateStep {
  param([string]$Label, [scriptblock]$Command)
  Write-Host "\`n==> $Label" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)." }
}

try {
  Set-Location -LiteralPath $SourceDirectory
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory ".git"))) {
    throw "The selected folder is not a Git checkout."
  }

  $changes = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Could not read the Git working tree." }
  if ($changes) {
    throw "Your checkout has uncommitted changes. Commit or stash them before updating."
  }

  $remotes = @(git remote)
  if ($LASTEXITCODE -ne 0) { throw "Could not read the configured Git remotes." }
  $remote = if ($remotes -contains "upstream") { "upstream" } elseif ($remotes -contains "origin") { "origin" } else { $null }
  if (-not $remote) {
    throw "This checkout has no 'upstream' or 'origin' remote to update from."
  }

  Invoke-UpdateStep "Fetching $remote" { git fetch $remote }
  $remoteHead = git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD"
  if ($LASTEXITCODE -ne 0 -or -not $remoteHead) {
    git remote set-head $remote --auto | Out-Null
    $remoteHead = git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD"
  }
  if (-not $remoteHead) {
    throw "The $remote remote has no default branch. Run 'git remote set-head $remote --auto', then try again."
  }
  Invoke-UpdateStep "Merging $remoteHead" { git merge --no-edit $remoteHead }
  Invoke-UpdateStep "Checking code" { vp check }
  Invoke-UpdateStep "Checking types" { vp run typecheck }
  Invoke-UpdateStep "Building and opening the installer" { vp run update:local }
  Write-Host "\`nUpdate complete. Continue with the installer that just opened." -ForegroundColor Green
} catch {
  $failed = $true
  Write-Host "\`nUpdate stopped: $($_.Exception.Message)" -ForegroundColor Red
}
Read-Host "Press Enter to close this window"
if ($failed) { exit 1 }
`;

export class LocalDesktopUpdateSourceError extends Schema.TaggedErrorClass<LocalDesktopUpdateSourceError>()(
  "LocalDesktopUpdateSourceError",
  { sourceDirectory: Schema.String },
) {
  override get message(): string {
    return "Select the root folder of a T3 Code Git checkout.";
  }
}

export class LocalDesktopUpdateProcessError extends Schema.TaggedErrorClass<LocalDesktopUpdateProcessError>()(
  "LocalDesktopUpdateProcessError",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return "The local update did not complete. See the PowerShell window for details.";
  }
}

/** Opens a visible terminal; it never runs a shell with a user-provided command string. */
export const launchLocalDesktopUpdate = Effect.fn("desktop.updates.launchLocal")(function* (
  sourceDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isCheckout =
    (yield* fs.exists(path.join(sourceDirectory, ".git"))) &&
    (yield* fs.exists(path.join(sourceDirectory, "package.json")));
  if (!isCheckout) {
    return yield* new LocalDesktopUpdateSourceError({ sourceDirectory });
  }

  const child = yield* ChildProcess.make(
    "powershell.exe",
    ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", localDesktopUpdatePowerShell],
    {
      cwd: sourceDirectory,
      detached: false,
      env: { T3CODE_LOCAL_UPDATE_SOURCE: sourceDirectory },
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new LocalDesktopUpdateProcessError({ exitCode });
  }
});
