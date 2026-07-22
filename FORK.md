# t3code Fork

This fork focuses on fixes and improvements needed for reliable Windows usage.

## Divergence Log

Document changes that diverge from the main t3code repository. Each entry follows the following format:

```
#### <id> - <short description>

<body>

**Files modified:**
<file list>

**Validation:**
<validation steps>

**Change Log:**
- <YYYY-MM-DD> - <description of change>

**Last updated:** <YYYY-MM-DD>
```

If changes were later introduced to any entry, the entry should be updated (body, files modified, validation and last updated should reflect current state of change and not the original state when the entry was created) and includes a brief summary of the change in the change log.
Change log can be omitted if the entry has not been updated since its creation.

### DL001 — Fix Claude Code authentication and session startup on Windows

Claude Code installed through npm exposes a Windows command shim such as `claude.cmd`, while `@anthropic-ai/claude-agent-sdk` expects a direct native executable path. This caused both provider authentication checks and turn startup to fail with a native-binary error.

The fork patches `@anthropic-ai/claude-agent-sdk@0.3.170` to use its bundled native Windows `claude.exe` when the configured executable is a non-native command path. Explicit native `.exe` paths remain supported.

The server pins the SDK to `0.3.170`, and the desktop artifact builder also pins patched dependencies to the exact versions named by their patch entries when creating the lockfile-free staged production workspace. Without these safeguards, the SDK range can resolve a newer unpatched release (for example `0.3.195`) and pnpm either fails with `ERR_PNPM_UNUSED_PATCH` or produces an installer without the fork fix.

Provider authentication is determined by the Claude Agent SDK initialization result, which also supplies account metadata and slash commands. The SDK patch uses its bundled native Claude Code executable on Windows when the configured command is a shell shim, and remaps Electron's virtual `app.asar` path to the physical `app.asar.unpacked` executable in packaged desktop builds. Sanitized probe diagnostics are included in provider snapshots and printed in Chromium DevTools as `[t3code/claude-provider]`; raw command output and environment values are never forwarded. The web bundle also prints `[t3code/startup]` with its version, git commit, dirty state, and build timestamp so installed artifacts can be identified directly.

**Files modified:**

- `patches/@anthropic-ai__claude-agent-sdk@0.3.170.patch`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `apps/server/package.json`
- `apps/server/src/provider/Layers/ClaudeProvider.ts`
- `apps/server/src/provider/Layers/ProviderRegistry.test.ts`
- `apps/server/src/provider/providerSnapshot.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/routes/__root.tsx`
- `apps/web/src/vite-env.d.ts`
- `apps/web/vite.config.ts`
- `packages/contracts/src/server.ts`
- `scripts/build-desktop-artifact.ts`
- `scripts/build-desktop-artifact.test.ts`

**Validation:**

- Claude SDK initialization smoke test succeeds on Windows.
- Claude adapter tests pass.
- `vp check` passes with no errors.
- `vp run typecheck` passes.
- Server build passes.
- Windows x64 NSIS packaging passes and bundles Claude Code native binaries.

**Last updated:** 2026-07-13

### DL002 — Show project workspace name when starting a new thread

An empty thread now identifies the current workspace before prompting for a message. When the thread has an active project, the title reads `In <project-name>` and the project name opens the current project/worktree in the preferred editor, using the same preferred-editor resolution as the existing Open control. When no project is active, the title reads `On <machine-name>` using the current environment label.

The workspace name title is intentionally large enough to be immediately scannable (32px), while the existing “Send a message to start the conversation.” copy remains a muted subtitle. The project link uses the app's established information-link color so it remains consistent with other hyperlinks.

**Files modified:**

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `docs/PRODUCT.md`
- `docs/DESIGN.md`

**Validation:**

- `vp test apps/web/src/components/chat/MessagesTimeline.test.tsx` passes.
- `vp check` passes with existing repository warnings only.
- `vp run typecheck` passes with existing repository suggestions only.

**Last updated:** 2026-07-14

### DL003 — Subscription usage indicators for Claude and Codex

Provider snapshots now carry a best-effort subscription usage block (`ServerProvider.usage`) with a session (5-hour) and weekly (7-day) rate-limit window, each exposing `usedPercent` and `resetsAt`. The server reads the CLI-managed OAuth credential files — `<home>/.claude/.credentials.json` for Claude and `$CODEX_HOME/auth.json` (default `~/.codex`) for Codex — and calls the vendors' usage endpoints (`api.anthropic.com/api/oauth/usage`, `chatgpt.com/backend-api/wham/usage`). The fetch runs in the drivers' snapshot-enrichment step (never inside the unit-tested probe functions), only when the instance is authenticated, honors per-instance `homePath`, and refreshes with the snapshot cycle (every 5 minutes). Any failure — missing credentials, insufficient scopes, network or HTTP errors — degrades to an absent `usage` field and never affects provider status. Cursor and Grok are intentionally not covered.

The UI shows remaining quota in two places:

- Settings → Providers: each provider row renders a `Session ───── | Weekly ─────` bar pair under the auth line, with a muted `|` separator and tooltips showing percent left and reset time.
- Chat title bar (right side): two circular meters (same geometry as the context-window meter) marked `s` and `w` for the active thread's provider.

Both start full in the foreground color (white in the dark theme) and turn yellow at ≤30% remaining, red at ≤15%.

**Files modified:**

- `packages/contracts/src/server.ts`
- `apps/server/src/provider/subscriptionUsage.ts`
- `apps/server/src/provider/subscriptionUsage.test.ts`
- `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- `apps/server/src/provider/Drivers/CodexDriver.ts`
- `apps/web/src/components/SubscriptionUsage.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/ChatHeader.tsx`
- `apps/web/src/components/settings/ProviderInstanceCard.tsx`

**Validation:**

- `subscriptionUsage.test.ts` mapping tests pass (10/10 including touched provider tests).
- Live smoke test of both fetchers returned real session/weekly windows.
- Typecheck and lint pass for contracts, server, and web.
- Pre-existing `ProviderRegistry.test.ts` failure ("re-probes when settings change the codex binaryPath") is unrelated; it fails identically without these changes.

**Change Log:**

- **2026-07-17** — Replaced chat title-bar ring tooltips with `ContextWindowMeter`-style popovers showing remaining percentage, quota bar, and reset time. Settings-page tooltips remain unchanged.

**Last updated:** 2026-07-17

### DL004 — Recover collaborative preview automation and verify navigation failures

Collaborative preview browser-control sessions now invalidate their cached Chrome DevTools
Protocol attachment when Electron reports a debugger detach. The next automation request creates a
fresh session, preventing one failed snapshot or external debugger interruption from poisoning later
operations across the preview client.

URL-bearing `preview_open` requests now wait for navigation readiness on newly created tabs as well
as reused tabs. A committed `LoadFailed` state (including Chromium DNS failures) is returned as an
automation execution failure instead of a successful loaded status.

**Files modified:**

- `apps/desktop/src/preview/Manager.ts`
- `apps/desktop/src/preview/Manager.test.ts`
- `apps/web/src/components/preview/PreviewAutomationHosts.tsx`
- `apps/web/src/components/preview/previewAutomationErrors.ts`
- `apps/web/src/components/preview/previewAutomationOpenReadiness.ts`
- `apps/web/src/components/preview/previewAutomationOpenReadiness.test.ts`

**Validation:**

- `vp test apps/desktop/src/preview/Manager.test.ts apps/web/src/components/preview/previewAutomationOpenReadiness.test.ts` passes (23 tests).
- `vp check` passes with pre-existing repository warnings only.
- `vp run typecheck` passes with pre-existing repository suggestions only.

**Last updated:** 2026-07-15

### DL005 - Run cross-platform CLI fixtures and assertions on Windows

The shared spawn resolver now reads a fixture's shebang instead of relying on its extension. On Windows, shell-backed fixtures are launched through Git for Windows `sh.exe`, while Node-backed fixtures are launched with the current Node executable. This keeps the Cursor and Grok ACP adapter, provider-discovery, and text-generation tests active rather than skipping them. Windows process termination is validated by awaiting the child shutdown; POSIX-only `SIGTERM` handler assertions remain conditional.

Windows test expectations now use the host path semantics where appropriate, including command shims, temporary directories, Git's long-path canonicalization, and cloudflared's `.exe` filename. The orchestration ingestion suite uses a 20-second polling deadline on Windows (2 seconds elsewhere) to accommodate slower filesystem and scheduler behavior. POSIX-only FIFO and long-filename behavior are skipped only on Windows.

Checkpoint file-content assertions normalize Git's Windows CRLF checkout conversion. Git for Windows 2.54 canonicalizes worktree paths differently from Node's non-native realpath (including 8.3 names and casing), so GitManager now uses native realpath and case-folds Windows paths before comparing worktrees. This prevents the main checkout from being mistaken for a separate PR worktree. Git PR-selector tests that create and push temporary repositories use a 60-second Windows-only deadline to accommodate slower Windows filesystem and Git process startup.

**Files modified:**

- `apps/server/src/provider/Layers/CursorAdapter.test.ts`
- `apps/server/src/provider/Layers/CursorProvider.test.ts`
- `apps/server/src/provider/Layers/GrokAdapter.test.ts`
- `apps/server/src/provider/Layers/GrokProvider.test.ts`
- `apps/server/src/textGeneration/CursorTextGeneration.test.ts`
- `apps/server/src/textGeneration/GrokTextGeneration.test.ts`
- `packages/shared/src/shell.ts`
- `packages/shared/src/relayClient.test.ts`
- `packages/shared/src/logging.test.ts`
- `packages/tailscale/src/tailscale.test.ts`
- `apps/server/src/bootstrap.test.ts`
- `apps/server/src/cli/config.test.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`
- `apps/server/src/git/GitManager.test.ts`
- `apps/server/src/git/GitManager.ts`
- `apps/server/src/project/ProjectFaviconResolver.test.ts`
- `apps/server/src/project/RepositoryIdentityResolver.test.ts`
- `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts`
- `apps/server/src/workspace/WorkspaceFileSystem.test.ts`
- `apps/desktop/src/app/DesktopAppIdentity.test.ts`
- `apps/desktop/src/app/DesktopConnectionCatalogStore.test.ts`
- `apps/desktop/src/app/DesktopEnvironment.test.ts`
- `apps/desktop/src/settings/DesktopSavedEnvironments.test.ts`
- `oxlint-plugin-t3code/test/utils.ts`

**Validation:**

- `vp check` passes with 22 existing warnings.
- `vp run typecheck` passes with existing repository suggestions only.
- Targeted Cursor and Grok ACP test slices pass (101 tests).
- `ProviderRuntimeIngestion.test.ts` passes on Windows (39 tests).
- `CheckpointReactor.test.ts` passes on Windows (13 tests); the Windows Git PR-selector slice passes with its Windows-only timeout allowance.
- Windows-specific desktop, bootstrap, relay-client, workspace, Tailscale, and oxlint test slices pass.

**Last updated:** 2026-07-15

### DL006 — Isolated checkpoint sidecars and recoverable undo/redo

Checkpoint capture and navigation are now production server services independent of the provider
test harness. New snapshots live in private bare Git sidecars below the server state directory and
are addressed through opaque `t3-sidecar:v1:` locators. Sidecar commands use explicit Git/worktree
paths and sanitized environments, never write objects, refs, indexes, reflogs, or alternates into the
project repository, and serialize maintenance against capture/import/restore operations. Capture
and atomic restore cover tracked and untracked non-ignored files, deletions, binaries, executable
bits, linked worktrees, symlinks, Windows path canonicalization, and `core.symlinks=false` checkouts.
Provider turn dispatch first performs non-throwing VCS detection: workspaces outside a Git worktree
skip checkpoint identity and mutation setup, while detection or identity failures disable
checkpointing for that turn without blocking the conversation. Steering an already-active provider
turn reserves and reuses only that exact turn's workspace-mutation lease, serializes concurrent
steers for the thread, and hands ownership to a replacement turn id without exposing a mutation gap.
Failed steers retain the running turn and its lease, while stale-turn ownership checks remain exact.

Rollback-only and unsupported providers expose an explicit filesystem-only fallback for `/undo` and
message rewind. The client first confirms that workspace files will be restored while chat history
and the provider conversation remain unchanged, and the server requires that confirmation signal.
This path uses a mode-tagged durable navigation journal, the per-worktree mutation lock,
repository/worktree identity validation, a retained rescue snapshot, and restart-safe filesystem
compensation, but never calls the provider or moves the durable conversation cursor. `/redo`
remains branching-only.

SQLite now owns durable capture jobs, immutable checkpoint entries, timeline generations and
cursors, provider bindings, retention metadata, and crash-recoverable navigation journals. Turn
completion only enqueues bounded per-worktree capture. Workers lease jobs, verify the workspace tree
twice around capture, reject contended boundaries, repair ready jobs whose timeline publication was
interrupted, and recover safely after restart. New turns behind the forward tip fork the logical
timeline while retaining abandoned forward data for its grace period.

Undo, redo, and arbitrary message rewind share one server-side navigation saga. Each operation
captures a rescue snapshot, prepares a non-destructive provider branch, restores the filesystem,
activates the provider binding, moves the visible SQLite cursor, and persists every phase. Failures
compensate the provider, filesystem, and cursor in reverse order; unresolved compensation blocks new
mutations and is resumed at startup. Codex advertises branching only through its verified native
fork/resume path. Providers without a proven non-destructive branch capability remain explicitly
unsupported for conversation navigation, so redo never replays prompts or silently falls back to
destructive rollback.

The projection and client layers are cursor-aware: forward messages, plans, activities, and ready
checkpoint summaries are hidden after undo while their rows and sidecar objects remain available for
redo. Standalone `/undo` and `/redo`, disabled-reason UX, rewind/jump, command contracts, optimistic
client state, and refresh behavior all use the same navigation commands. Legacy project refs remain
dual-readable and can be imported, verified, observed, retained, and cleaned up durably; sidecar-only
GC, startup scavenging, retention grace periods, and diagnostics complete the rollout.

**Primary implementation areas:**

- `apps/server/src/checkpointing/`
- `apps/server/src/persistence/Migrations/033_CheckpointDurableState.ts`
- `apps/server/src/persistence/Migrations/034_CheckpointLegacyMigration.ts`
- `apps/server/src/persistence/Migrations/036_CheckpointNavigationMode.ts`
- `apps/server/src/persistence/{Layers,Services}/Checkpoint*.ts`
- `apps/server/src/orchestration/`
- `apps/server/src/provider/`
- `packages/contracts/src/orchestration.ts`
- `packages/client-runtime/src/`
- `apps/web/src/composer-logic.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/{ChatComposer,ComposerCommandMenu}.tsx`
- `vite.config.ts` (bounded Windows workers for root `vp test`)

**Validation:**

- Migration-focused matrix passes: 29 files, 312 tests; the post-review durability regression matrix
  passes 8 files and 63 tests.
- The exact-turn workspace-mutation regression matrix passes 3 files and 58 tests, including
  restore/turn worker deadlock, stale terminal ownership, terminal-before-bind, interruption cleanup,
  and bounded prior-turn release waiting.
- Provider command coverage verifies that a turn starts outside a Git worktree without invoking
  checkpoint identity resolution.
- Provider command and coordinator coverage verifies that steering reuses the exact active-turn
  mutation while retaining stale-turn rejection: 2 files and 58 tests pass, including old-turn
  completion during handoff, concurrent replacement steers, failed-steer recovery, and interruption
  cleanup.
- Sidecar characterization passes 18/18, including unborn repositories, submodules, and concurrent
  linked-worktree captures.
- Real orchestration integration passes: 11 tests, with 1 provider-capability-gated test skipped.
- Windows/provider isolation slices pass: 279 tests across the affected server, desktop, and web
  files; Git/VCS sidecar slices also pass independently.
- Full `vp test` passes within the 30-minute limit: 596 files and 4,690 tests passed; 2 files and 9
  tests were skipped by existing capability/platform gates (745.92 seconds).
- `vp check`, `vp run typecheck`, and `git diff --check` pass. Remaining lint output consists of
  existing warnings outside this change.
- An independent Fable review was run read-only. Its retention-lineage, in-flight rescue, restarted
  capture, provider-binding boundary, and crash-compensation findings were resolved and covered by
  regression tests. Follow-up review also verified exact provider-turn mutation ownership, atomic
  runtime mutation registration, non-blocking sequential event handling, and prior-turn release
  ordering; its final pass reported no findings.

**Last updated:** 2026-07-17

### DL007 - Reduce TimelineMinimap hitbox

Reduced the TimelineMinimap hitbox from w-18 to w-5 because the larger hitbox was interfering with text selection in the chat area.
The minimap behavior remains unchanged.

**Files modified:**

- `apps/web/src/components/chat/MessagesTimeline.tsx`

**Validation:**

- (none; style change only)

**Last updated:** 2026-07-17

### DL008 — Add multi-thread split view

Threads can now be opened from the sidebar context menu in a split workspace with up to four simultaneously visible panes. The split uses an equal CSS grid without an additional layout dependency: two, three, and four panes stay in one full-height row with explicit two-, three-, and four-column classes and one-pixel vertical gaps; the active pane keeps its focus outline. Pane additions, removals, and column changes animate visually through AutoAnimate (180ms ease-out) on the pane grid. The animation controller is destroyed when the workspace unmounts, while store mutations, routing, pane cleanup, focus, and portal behavior remain synchronous. Clicking or focusing a pane makes it active, updates the canonical thread URL without adding browser-history noise, and moves the shared top toolbar to that thread. Normal navigation to a thread outside the displayed set exits split view.

The right panel remains outside the pane grid and follows the active thread while retaining each thread's existing panel surfaces independently. Right-panel tab tooltips and accessible labels identify the source thread. The sidebar highlights every displayed thread, gives the active pane stronger emphasis, keeps split threads visible through collapsed or truncated project lists, and offers **Detach from split view** without deleting the thread or clearing its composer, terminal, preview, or panel state.

Split membership is intentionally transient and separate from sidebar bulk selection. Draft promotion, new-draft navigation, archive, deletion, and stale-thread reconciliation update or exit the workspace safely. Global keyboard, preview-action, and composer-handle ownership is limited to the active pane so mounting several chat views does not duplicate app-wide behavior.

**Files modified:**

- `apps/web/src/splitViewStore.ts`
- `apps/web/src/splitViewStore.test.ts`
- `apps/web/src/components/SplitThreadWorkspace.tsx`
- `apps/web/src/components/SplitThreadWorkspace.test.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/web/src/components/RightPanelTabs.tsx`
- `apps/web/src/components/RightPanelTabs.test.tsx`
- `apps/web/src/composerHandleContext.ts`
- `apps/web/src/hooks/useThreadActions.ts`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- `apps/web/src/routes/_chat.draft.$draftId.tsx`

**Validation:**

- `pnpm --filter @t3tools/web test` passes: 151 files and 1,307 tests.
- `pnpm --filter @t3tools/web typecheck` passes.
- `vp test apps/web/src/components/SplitThreadWorkspace.test.tsx` passes (1 test).
- `vp check` passes with 23 existing warnings and no errors.
- `git diff --check` passes.
- Electron runtime verification confirms native context-menu opening and detaching, full-height two-column rendering, active-pane URL and toolbar-title changes, sidebar highlighting, and a single right panel outside the grid with source-thread tab attribution.
- Runtime DOM observation confirms one full-height grid row and running 180ms animations for direct-child insertion and removal.
- Store tests cover scoped identity, activation, deterministic detach fallback, reconciliation, the four-pane cap, and rejection of a fifth pane.

**Change Log:**

- **2026-07-17** — Changed three- and four-pane layouts from a 2×2 grid to full-height vertical columns, added pane transition animation with unmount cleanup, and closed pane-owned pull-request dialogs when their pane becomes inactive.

**Last updated:** 2026-07-17

### DL009 — Persist split layouts and add direct thread placement

Split view now saves multiple independent ordered pane groups and active state in local storage. Leaving split mode for a normal thread keeps every group available: selecting any member of a marked group restores that pane set and focuses the selected thread, and all layouts survive an app restart. Each group receives a stable distinct hue. The sidebar shows membership by tinting the full thread-row background with a subtle group-color-to-transparent gradient, including when that group is not currently displayed. The translucent tint layers over the existing hover, active, and selection backgrounds so interaction feedback remains visible.

Each split pane has a compact local header with the thread title, lower-contrast project name, a visible drag affordance, and a detach control. Dragging a pane header onto another pane moves it before or after that pane; dragging it to the sidebar detaches it. Sidebar thread rows are also draggable: dropping one directly onto the normal workspace starts a split, and dropping one into an existing split inserts it at the indicated position. Drop feedback now covers the complete target pane, highlights the selected left or right half, and includes a dashed midpoint divider plus an explicit action label. In a normal single-thread workspace, the overlay is constrained to the thread column and never covers an open right panel.

Right-panel ownership is independent from pane focus inside a split group. If any member has an open browser, diff, file, plan, or terminal surface, that panel remains visible when the user focuses a different pane that has no open panel of its own. Focusing a pane with its own open panel switches the shared right panel to that thread.

**Files modified:**

- `apps/web/src/splitViewStore.ts`
- `apps/web/src/splitViewStore.test.ts`
- `apps/web/src/splitViewDrag.ts`
- `apps/web/src/components/SplitThreadWorkspace.tsx`
- `apps/web/src/components/SplitThreadWorkspace.test.tsx`
- `apps/web/src/components/SplitPaneDropHint.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`

**Validation:**

- `vp test apps/web/src/components/Sidebar.logic.test.ts apps/web/src/splitViewStore.test.ts apps/web/src/components/SplitThreadWorkspace.test.tsx` passes (81 tests).
- `vp run typecheck` passes with three existing suggestions outside this change.
- `vp check` passes with 23 existing repository warnings and no errors.
- `git diff --check` passes.

**Change Log:**

- **2026-07-20** — Added multiple persistent color-coded groups, any-member group restoration, full-pane left/right drop feedback with a midpoint divider, thread-column-only standalone feedback, and persistent right-panel ownership across pane focus changes.
- **2026-07-21** — Stabilized the inactive split-pane selector so React subscribers reuse one empty snapshot instead of entering an update loop when the sidebar mounts.
- **2026-07-21** — Replaced the standalone sidebar group marker with a full-row translucent gradient while preserving the existing hover, active, and selection palettes underneath it.

**Last updated:** 2026-07-21

### DL010 — Stabilize collaborative preview pairing and browser automation

Local development now pins the Vite client, advertised dev URL, and backend client URLs to the
IPv4 loopback address. This prevents Windows from binding Vite only to `::1` while collaborative
environment-port navigation resolves through `127.0.0.1`, which previously made valid pairing URLs
fail with `ERR_CONNECTION_REFUSED` before their fragment could be consumed.

Locator-based click and type operations honor their advertised timeout and retry while dynamic
targets are absent or temporarily non-editable. Clicks resolve semantic targets again after the
visible cursor movement so layout shifts do not dispatch to stale coordinates. Snapshot capture
tracks DOM revisions and retries when semantics, accessibility data, and pixels straddle a mutation.
Snapshot elements include preferred Playwright locators, and browser diagnostics are reset on
main-frame navigation with a smaller bounded history. Guest viewport measurement is also bounded so
a redirect cannot leave `preview_navigate` or `preview_status` waiting forever on a stale webview
execution context. The preview automation broker also quarantines a host that misses its response
deadline and releases that host's provider-session assignments. A follow-up call can therefore fail
over to a healthy desktop client instead of repeatedly waiting 15 seconds on the same stale focused
stream; late responses or focus reports restore a recovered client without reconnecting the entire
environment. `preview_status` uses a three-second host liveness probe and retries through the
remaining twelve seconds, so stale-host failover stays within its original 15-second tool budget.

**Files modified:**

- `scripts/dev-runner.ts`
- `scripts/dev-runner.test.ts`
- `packages/contracts/src/previewAutomation.ts`
- `apps/desktop/src/preview/Manager.ts`
- `apps/desktop/src/preview/Manager.test.ts`
- `apps/web/src/components/preview/PreviewAutomationHosts.tsx`
- `apps/web/src/components/preview/previewWebviewViewport.ts`
- `apps/web/src/components/preview/previewWebviewViewport.test.ts`
- `apps/server/src/mcp/PreviewAutomationBroker.ts`
- `apps/server/src/mcp/PreviewAutomationBroker.test.ts`
- `apps/server/src/mcp/toolkits/preview/handlers.ts`
- `apps/server/src/mcp/McpHttpServer.test.ts`
- `docs/operations/collaborative-preview-pairing-investigation.md`

**Validation:**

- `vp check` passes (0 errors; 23 pre-existing warnings).
- `vp run typecheck` passes for all 15 packages.
- Focused dev-runner, desktop preview, webview viewport, broker, and MCP tests pass (82 tests).
- Contracts and desktop package typechecks pass.
- Live development verification confirms Vite listens on `127.0.0.1`, environment-port navigation
  opens the pairing route, consumes its token, and reaches authenticated app state.
- Rebuilt-harness smoke tests confirm delayed click/type retries, click re-resolution after a layout
  shift, coherent cross-mutation snapshots, preferred snapshot locators, and diagnostic reset.
- Final rebuilt-harness pairing confirms `domContentLoaded` navigation, immediate status, redirect
  completion, and authenticated-state waiting all return without wedging.
- Cold `preview_status` and `preview_open` calls return immediately on the current harness; broker
  regressions cover stale focused-host failover and recovery after renderer activity resumes.

**Last updated:** 2026-07-21

### DL011 — Preserve turn diff summaries when sidecar baselines are unavailable

Turn-completion sidecar diffs now fall back to the repository `HEAD` when the preceding sidecar
snapshot is missing. This keeps changed-file summaries available to the web DiffPanel for older
threads, incomplete migrations, and interrupted baseline captures instead of silently publishing an
empty file list. Checkpoint reactor coverage now verifies both the normal sidecar-to-sidecar summary
and the missing-baseline fallback, while checkpoint-store coverage verifies the sidecar locator
fallback itself.

Provider runtime ingestion also aggregates completed `file_change` items by turn and publishes their
file summaries when a provider completes the turn without emitting `turn.diff.updated`. This keeps
the DiffPanel working with current Codex app-server events while allowing a later sidecar capture to
replace the temporary provider-derived checkpoint. Regression coverage verifies path normalization,
line counts, and the completed-turn projection.

**Last updated:** 2026-07-21

### DL012 — Preserve sent prompts while draft threads are promoted

The first prompt in a new draft thread remains visible while that thread is promoted to its
server-backed representation. The chat view now resets local timeline state only when its scoped
thread identity changes, rather than when the route switches from draft to server. This retains the
optimistic user message until the projected `thread.message-sent` event replaces it.

**Files modified:**

- `apps/web/src/components/ChatView.tsx`

**Validation:**

- `vp check` passes.
- `vp run typecheck` passes.
- The repository `dev` workflow starts successfully and serves the T3 Code HTML entrypoint.

**Last updated:** 2026-07-22

### DL013 — Keep healthy Codex sessions available during catalog and turn errors

Codex provider-status refreshes now treat model and skill discovery as optional catalog enrichment.
Those requests are bounded and fail soft after the app-server has initialized and authenticated, so a
slow or unavailable catalog can no longer replace a healthy provider snapshot with the misleading
"Timed out while checking Codex app-server provider status" error banner.

Codex app-server `error` notifications are turn-scoped. Non-retryable turn errors now remain visible
as runtime errors without marking the app-server session disconnected, and failed turns leave the
session ready for follow-up messages while retaining their error text. Actual process and transport
failures continue to mark the session unavailable.

**Files modified:**

- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.test.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- `packages/contracts/src/providerRuntime.ts`

**Validation:**

- Focused Codex adapter test passes.
- Focused provider-runtime ingestion tests pass.
- `vp check` passes (0 errors; 23 existing warnings).
- `vp run typecheck` passes for all 15 packages (existing suggestions only).

**Last updated:** 2026-07-22
