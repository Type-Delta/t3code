# t3code Fork

This fork keeps the Windows reliability, durable checkpointing, and workspace capabilities that are still not supplied by the shared base.

Git repository cache keys use Node's native `realpath` so Windows long paths and their 8.3 aliases share one VCS snapshot and refresh history.

## Upstream sync — 2026-08-28

Merged upstream `f6f2be32d8bc072e87753e41ad77c7c67e8b0b95` into the fork while preserving durable checkpoint navigation, split workspaces, existing-worktree selection, subagent transcript isolation and receiver-only Codex child routing, preview and zrok recovery, Windows and Claude packaging safeguards, desktop tray and backend continuity, environment-scoped thread tools, and progressive multi-environment usage. The integration adopts upstream provider approval, interrupt, and lifecycle fixes including Codex 0.150 events; Git push-base, missing-worktree, and submodule fixes; uploads, HEIC handling, file reveal, pull-request linking, and settle restoration; usage filtering, sorting, and layout updates; desktop release, signing, and Clerk changes; and the current server, web, and mobile fixes. Deployed fork migrations `036` through `047` remain unchanged. Upstream linked-pull-request and unsettled-thread migrations use fresh IDs `048` and `049`.

## Previous upstream sync — 2026-08-24

Merged upstream `b4be33f0747445f1c9df126e932c7b9792f322d5` into the fork while preserving durable checkpoints, split workspaces, existing-worktree selection, read-only subagent transcripts, preview recovery, zrok sharing, subscription usage, Windows portability, and desktop backend continuity. The integration adopts upstream Codex feedback, provider lifecycle and liveness fixes, normal-tool activity collapsing, redesigned skill menus, background thread creation, appearance contrast, workspace images, client-origin analytics, remote default-branch fallback, and current web/mobile/desktop packaging fixes. Fork migrations `036`–`045` remain deployed in place; idempotent migration `046` repairs databases that previously followed upstream through migration `041`, and upstream auth-session client metadata is assigned `047`. Upstream lifecycle identity and failure semantics remain authoritative while fork receiver-only child routing, transcript isolation, and clickable subagent rows survive. Closing the last desktop window continues to keep the fork backend alive, while explicit quit adopts upstream's activation guard and destroy-windows-before-shutdown cleanup.

## Earlier upstream sync — 2026-08-17

Merged upstream `cd096b9ad5a4156ffeab85de617cbb219057007f` into the fork while preserving durable checkpoints, split workspaces, existing-worktree selection, read-only subagent transcripts, preview recovery, zrok sharing, subscription usage, Windows portability, and desktop backend continuity. The integration adopts upstream pull-request and remote-editor services, project access controls, right-panel maximization and file drops, project favicons, default thread environment modes, usage-resolution changes, and the latest web/mobile/desktop refinements. Fork migrations `036`–`043` remain deployed in place; upstream default-thread-environment and favicon migrations are assigned `044`–`045`. The right-panel store advances to version `12` so pull-request surfaces and fork subagent transcript surfaces coexist, and hourly usage aggregation retains a printable `\u001f` four-part key. Upstream's Codex missing-rollout recovery and hermetic Claude text-generation fixture replace their fork equivalents while the fork's additional assertions and provider behavior remain.

## Earlier upstream sync — 2026-08-08

Merged upstream `8101cd044911c7dc2a2adf7c7a9ba7962abf57b6` into the fork while preserving durable checkpoints, existing-worktree selection, split workspaces, and read-only subagent transcripts. The integration adopts upstream native agent/workflow observability as the lifecycle authority and keeps transcript events agent-scoped outside the parent timeline: native child message completions finalize their matching transcript, persisted child rows enable transcript access from the matching agent row, transcript headers use native lifecycle metadata, child rows stay out of web and mobile parent feeds, and bounded thread-detail reads retain subagent identity. Paginated clients persist the requested user-turn width so checkpoint navigation refreshes the complete loaded window. The latest upstream additions provide main-window desktop zoom controls, a consolidated mobile thread-settings sheet, and cross-environment provider transcript usage reporting; composite in-memory keys use printable source escapes so repository tools continue treating their TypeScript as text. Fork migrations remain `36`–`40`; upstream pinning and pagination migrations are assigned `41`–`43` to preserve deployed fork databases.

## Earlier upstream sync — 2026-08-01

Merged upstream `0ad91b6e7fc1fcb6d5f4bc736d84c337e912bc62` into the fork without dropping checkpoint navigation, split workspaces, existing-worktree selection, preview recovery, provider usage, Claude Windows packaging, or stale-mutation retry/drafts. The integration adopts upstream title regeneration, branch-drift handling, sidebar search and shell loading, preview PiP/runtime identities, telemetry/compression, and VCS cache invalidation. Migration IDs `33`–`35` remain upstream-compatible; checkpoint migrations now occupy `36`–`38`, and idempotent migration `39` reconciles both previously deployed histories.

## Divergence Log

This is a current-state record only. Each entry describes a surviving difference between `HEAD` and the latest shared base, determined with `git merge-base HEAD upstream/main` (currently `f6f2be32d8bc072e87753e41ad77c7c67e8b0b95`). A feature adopted from upstream is not a divergence merely because it was involved in a merge.

Keep stable IDs when updating this section; gaps are intentional. When upstream absorbs a difference, remove or rewrite the entry rather than preserving chronology here. Update its behavior, implementation evidence, and validation when the surviving difference changes.

### DL001 — Claude Windows resolver and artifact safeguards

The fork retains the Windows-specific protection around `@anthropic-ai/claude-agent-sdk@0.3.170`: when the configured Claude command is a Windows shell shim, the patch selects the bundled native `claude.exe`, while explicit native `.exe` paths continue to work. In a packaged Electron build, the virtual `app.asar` path is remapped to its real `app.asar.unpacked` executable.

The server and desktop artifact builder pin the patched SDK version, including lockfile-free staging, so a build cannot silently resolve an unpatched SDK or fail with an unused-patch error. Provider snapshots and DevTools expose only sanitized resolver diagnostics; startup provenance identifies installed web artifacts without exposing command output or environment values.

**Implementation evidence:** `patches/@anthropic-ai__claude-agent-sdk@0.3.170.patch`, `apps/server/src/provider/Layers/ClaudeProvider.ts`, `apps/server/src/provider/providerSnapshot.ts`, `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`.

**Recorded validation:** Windows Claude initialization and adapter coverage, server build, `vp check`, `vp run typecheck`, and Windows x64 NSIS packaging with native Claude binaries.

**Last updated:** 2026-07-27

### DL002 — Workspace context beside the empty-state hero

The upstream draft hero remains the empty-state headline. The fork preserves workspace context as its supporting line and in the existing non-draft empty state: `In <project-name>` opens the current project/worktree in the preferred editor, while `On <machine-name>` identifies an environment without a project. This is additive context, not a replacement for the upstream hero.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`, and `apps/web/src/components/chat/MessagesTimeline.test.tsx`.

**Recorded validation:** `vp test apps/web/src/components/chat/MessagesTimeline.test.tsx`, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-07-27

### DL003 — Subscription usage for Claude and Codex

Authenticated Claude and Codex snapshots carry best-effort session and weekly quota windows (`usedPercent` and `resetsAt`). The drivers read their CLI-managed OAuth credentials and enrich the regular snapshot cycle; missing credentials, scopes, network access, or endpoint failures leave `usage` absent without affecting provider health. Cursor and Grok are intentionally excluded.

Provider settings show session and weekly bars, and the active thread header shows matching remaining-quota meters with low-quota thresholds and reset-time details.

**Implementation evidence:** `packages/contracts/src/server.ts`, `apps/server/src/provider/subscriptionUsage.ts`, `apps/server/src/provider/Drivers/{ClaudeDriver,CodexDriver}.ts`, `apps/web/src/components/SubscriptionUsage.tsx`, `apps/web/src/components/chat/ChatHeader.tsx`, and `apps/web/src/components/settings/ProviderInstanceCard.tsx`.

**Recorded validation:** subscription-usage mapping tests, live Claude and Codex fetcher smoke tests, and contracts/server/web typecheck and lint coverage.

**Last updated:** 2026-07-17

### DL004 — Preview navigation and automation hardening

The fork hardens desktop collaborative preview control. A debugger detach invalidates the cached Chrome DevTools Protocol attachment, URL-bearing `preview_open` waits for new and reused tab readiness, and a committed `LoadFailed` state is returned as an automation failure rather than a successful load.

Automation also retries dynamic click/type targets, re-resolves click targets after cursor movement, keeps snapshots coherent across DOM mutations, bounds guest viewport work, and quarantines an unresponsive host so later requests can fail over and recover without reconnecting the environment. Hung native control work now times out below the broker deadline and detaches only its cached debugger session, so the same tab can reattach instead of retaining a blocked control permit.

Browser development's single-origin Vite proxy behavior, including shared and Tailscale origins, is upstream behavior and is not a fork divergence. Explicit IPv4 loopback URLs remain only for the desktop renderer and local-preview automation, where they protect Windows local routing.

**Implementation evidence:** `apps/desktop/src/preview/Manager.ts`, `apps/web/src/components/preview/`, `apps/server/src/mcp/PreviewAutomationBroker.ts`, `apps/server/src/mcp/toolkits/preview/handlers.ts`, and `packages/contracts/src/previewAutomation.ts`.

**Recorded validation:** focused desktop preview, web readiness/viewport, broker, MCP, and dev-runner coverage (including same-tab recovery from stalled CDP and capture work, stale-host failover, and `LoadFailed`); `vp check` and `vp run typecheck`.

**Last updated:** 2026-08-21

### DL005 — Windows portability in CLI fixtures, Git, and tests

The shared fixture launcher dispatches by shebang: shell fixtures use Git for Windows `sh.exe` and Node fixtures use the current Node executable. Windows-specific expectations cover command shims, temporary and canonical Git paths, `.exe` names, CRLF checkout conversion, process shutdown, and slower polling or temporary-repository deadlines. POSIX-only FIFO, signal-handler, and filename assertions stay conditionally gated.

Git worktree comparison uses native realpaths and case-folding on Windows so Git for Windows path canonicalization cannot mistake the main checkout for another worktree.

**Implementation evidence:** `packages/shared/src/shell.ts`, `apps/server/src/git/GitManager.ts`, affected provider/text-generation/orchestration/Git test suites, desktop environment tests, `packages/tailscale/src/tailscale.test.ts`, and `oxlint-plugin-t3code/test/utils.ts`.

**Recorded validation:** targeted Cursor/Grok ACP, provider-runtime ingestion, checkpoint, Git PR-selector, desktop, relay, workspace, Tailscale, and oxlint suites on Windows; `vp check` and `vp run typecheck`.

**Last updated:** 2026-07-15

### DL006 — Durable sidecar checkpoints and recoverable navigation

Checkpoint capture and navigation are durable server services. Private bare-Git sidecars hold opaque `t3-sidecar:v1:` snapshots without modifying the project repository; capture, import, restore, retention, and cleanup are serialized and cover linked worktrees, binaries, symlinks, Windows paths, and non-Git workspaces safely.

SQLite persists capture jobs, immutable checkpoint entries, timeline generations and cursors, provider bindings, retention data, and restart-recoverable navigation journals. Undo, redo, and rewind share a compensating navigation saga; providers without a verified non-destructive branch capability are explicitly limited, and filesystem-only rollback requires confirmation without moving the provider conversation cursor.

Fork migrations `036`–`038` establish the durable checkpoint state (`036_CheckpointDurableState`, `037_CheckpointLegacyMigration`, and `038_CheckpointCaptureProviderMetadata`). Upstream lifecycle and title-regeneration migrations retain canonical IDs `033`–`035`; idempotent migration `039_ReconcileCheckpointAndTitleHistory` replays the `036`–`038` checkpoint schema before supplying checkpoint navigation mode and title-regeneration columns for upstream-ledger databases that skipped those fork migrations.

Migration `046_ReconcileUpstream41History` extends that repair path for databases already carrying upstream ledger entries `036`–`041`: it idempotently restores checkpoint state, navigation metadata, and both subagent projection columns before upstream auth-session client metadata runs as migration `047`.

Upstream linked-pull-request and unsettled-thread columns follow this deployed fork history as migrations `048_ProjectionThreadLinkedPullRequest` and `049_ProjectionThreadsUnsettledAt`. Both migrations check the existing schema before adding their columns, so upgraded and partially reconciled databases remain safe.

Terminal provider events end the workspace mutation for their exact turn before local VCS status refresh, but the next provider turn remains behind a capture-finalization barrier until that full user/assistant/tool-call turn has been checkpointed and projected. Capture and mutation intervals are serialized instead of preempting one another, preventing normal provider turns from producing `workspace-mutated` checkpoints. A capture waiting for active work releases the worktree gate, so provider turns in other threads can join the same mutation cohort and share its next stable checkpoint boundary; an already-running capture and checkpoint navigation remain exclusive. Aborted turns and provider-turn handoff ownership retain the same exact-owner completion semantics. A stale lease with no active provider turn is recovered automatically; if ownership is ambiguous, the provider turn continues without checkpoint navigation instead of blocking the conversation. Failed mutation-blocked text messages expose a retry action that reuses the persisted user message when available or recreates an optimistic-only message without duplicating it in the UI.

Capture jobs that first lose the workspace-mutation race or fail can be re-enqueued for the same logical turn boundary. The durable row is reset to pending and remains the single job for its snapshot, while pending, running, and ready jobs are still deduplicated.

**Implementation evidence:** `apps/server/src/checkpointing/`, `apps/server/src/persistence/Migrations/{036_CheckpointDurableState,037_CheckpointLegacyMigration,038_CheckpointCaptureProviderMetadata,039_ReconcileCheckpointAndTitleHistory,046_ReconcileUpstream41History,047_AuthSessionClientConnection,048_ProjectionThreadLinkedPullRequest,049_ProjectionThreadsUnsettledAt}.ts`, `apps/server/src/orchestration/`, `packages/contracts/src/orchestration.ts`, `packages/client-runtime/src/`, and checkpoint-aware web composer and chat components including `ThreadErrorBanner.tsx`.

**Recorded validation:** migration and durability regression matrices, sidecar characterization (including unborn repositories, submodules, and linked worktrees), orchestration integration including serialized full-turn capture, deterministic post-capture lease release, stale-lease recovery, non-blocking checkpoint degradation, and persisted-message retry, Windows isolation slices, upstream-ledger reconciliation through migration `047`, full `vp test`, `vp check`, `vp run typecheck`, and `git diff --check`.

**Last updated:** 2026-08-24

### DL008 — Persistent multi-thread split workspaces

The fork supports up to four visible thread panes in an equal full-height grid, with focused-pane routing, a shared toolbar, one right panel, and controlled ownership of global keyboard, preview, and composer behavior. Panes can be opened or detached from the sidebar, safely reconcile draft promotion/archive/deletion, and animate layout changes without leaving stale portals or listeners.

Split membership is persisted as multiple ordered local groups with active state and stable group colors. Selecting any member restores its group; the current and legacy sidebars preserve group tinting, support pane and thread drag placement, and show complete left/right drop intent. The group tint is textured with an inline desaturated SVG grain so the color-coded row reads as a surface rather than a flat slab. The grain is a masked pseudo-element rather than a second background layer, because background layers cannot carry their own mask and unmasked grain also covers the gradient's faded tail, flattening the row back into a uniform slab; the overlay shares the tint's fade axis and stops short of its extent so the texture is gone before the color is. Group hues carry a hue-dependent chroma: a flat chroma across the wheel does not read as a flat saturation, since yellow-green renders at full strength while red and blue are gamut-clipped, so chroma eases down around yellow-green. Rows supply only the hue and that chroma, leaving the stylesheet to compose per-theme lightness and strength — light mode takes a deeper, less translucent tint because the translucency that reads as a clear band on the near-black sidebar washes out against zinc-50. The current sidebar also names the other panes in each grouped thread's details tooltip, keeps displayed panes visible when settled or snoozed shelves are collapsed, and preserves split actions in its context menu. Right-panel ownership remains useful when focus moves to a pane with no surface of its own.

**Implementation evidence:** `apps/web/src/splitViewStore.ts`, `apps/web/src/splitViewDrag.ts`, `apps/web/src/components/{SplitThreadWorkspace,SplitPaneDropHint,Sidebar,LegacySidebar,RightPanelTabs,ChatView}.tsx`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/index.css`, `apps/web/src/hooks/useThreadActions.ts`, and the chat routes.

**Recorded validation:** split-store, sidebar, workspace, right-panel, and drag/drop tests; web typecheck; `vp check`; `git diff --check`; and Electron runtime verification of context menus, routing, pane layout, persistent groups, and right-panel attribution.

**Last updated:** 2026-08-24

### DL012 — Prompt preservation during draft promotion

The initial optimistic prompt remains visible while a draft route becomes its server-backed thread. Chat timeline state resets only when the scoped thread identity changes, so the projected `thread.message-sent` event replaces the prompt instead of briefly erasing it. Orchestration commands require an acknowledgement within ten seconds; a lost WebSocket reply therefore enters the existing visible failure path and restores the durable composer draft instead of leaving a refresh-only optimistic message indefinitely.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx` and `packages/client-runtime/src/operations/commands.ts`.

**Recorded validation:** `vp check`, `vp run typecheck`, and the repository `dev` startup smoke test.

**Last updated:** 2026-08-10

### DL013 — Codex availability through catalog and turn failures

Codex model and skill discovery is bounded, optional catalog enrichment after a healthy authenticated app-server session starts. Catalog failure cannot replace that healthy snapshot with a provider-status error.

App-server errors are classified by scope: retryable transport errors remain warnings, while a typed non-retryable turn error emits the terminal failed-turn lifecycle needed to release the thread for a follow-up message. A root Codex collaboration `wait` that remains open for 30 minutes is failed explicitly after bounded child-then-parent interruption; matching item or turn completion cancels that deadline. Actual process or transport failure still marks the session unavailable. Upstream terminal-state, hard-stop, tool-identity, and liveness fixes remain authoritative; in particular, a late collaboration `interacted` event can enrich an existing child without restarting one that already completed.

**Implementation evidence:** `apps/server/src/provider/Layers/{CodexProvider,CodexSessionRuntime,CodexAdapter}.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, and `packages/contracts/src/providerRuntime.ts`.

**Recorded validation:** focused Codex adapter, collaboration-runtime, provider-runtime ingestion, mixed-tool lifecycle, and transfer-budget tests, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-08-24

### DL014 — Loadable checkpoint diffs with a legacy baseline fallback

Turn diff summaries are published only for successfully captured, loadable sidecar checkpoints. Each summary and DiffPanel query compares the completed full turn against the immediately preceding turn boundary; an empty turn remains loadable but produces no diff card. Provider-reported `file_change` items are not synthesized into checkpoint references, and the client hides legacy non-ready rows that cannot load a diff.

Diff queries use the active checkpoint timeline generation and the stable pre-turn sidecar identity. For an older thread with no captured baseline, the remaining compatibility fallback compares against repository `HEAD`. This absorbs only the surviving baseline-fallback behavior from former DL011; provider-derived summary fallback is not retained.

**Implementation evidence:** `apps/server/src/checkpointing/{CheckpointIds,CheckpointDiffQuery,CheckpointStore}.ts`, `apps/server/src/orchestration/Layers/{CheckpointReactor,ProjectionSnapshotQuery}.ts`, `apps/server/src/git/Utils.ts`, and `apps/web/src/hooks/useTurnDiffSummaries.ts` with their tests.

**Recorded validation:** focused checkpoint query, nested-worktree, projection, and web-summary tests; rapid multi-turn orchestration integration covering pre-thread changes, consecutive edit turns, a no-edit turn, durable capture, projection summaries, and DiffPanel queries; `vp check`; and `vp run typecheck`.

**Last updated:** 2026-07-30

### DL015 — Live project-scoped working tree diffs

Diff previews for an active project are authorized against that registered project root, including projects outside the server startup directory. The web client no longer substitutes the environment startup repository when the selected project is outside that directory.

While DiffPanel is open, working-tree and branch previews refresh once per second. Its implicit scope also follows the resolved Git status, so a panel mounted before status arrives changes from branch to working-tree view when the checkout is dirty; an explicit user scope selection still wins.

**Implementation evidence:** `apps/server/src/review/ReviewService.ts`, `apps/server/src/ws.ts`, `apps/web/src/components/DiffPanel.tsx`, and `packages/client-runtime/src/state/review.ts`.

**Recorded validation:** focused review-service authorization and DiffPanel store tests; controlled-browser reproduction and verification with an external registered project, including a file modification made while the panel remained open; `vp check`; and `vp run typecheck`.

**Last updated:** 2026-07-27

### DL016 — Project-selecting local thread shortcut

The configured Chat: New Local shortcut opens the command palette's "New thread in..." project picker instead of immediately creating a draft in the active project. The same shortcut enters that picker when the command palette already has focus, while the active-project quick-create remains available as a separate palette action.

**Implementation evidence:** `apps/web/src/routes/_chat.tsx`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/CommandPalette.logic.ts`, and `apps/web/src/commandPaletteBus.ts`.

**Recorded validation:** focused command-palette and keybinding tests; controlled-browser verification from the main app and an already-focused palette; `vp check`; `vp run typecheck`; and `git diff --check`.

**Last updated:** 2026-07-29

### DL017 — Existing-worktree selection for new threads

The new-thread Workspace controls expose a neighboring Worktree selector in Current checkout mode. It defaults to Git's primary checkout and can pin the draft to any existing branched or detached worktree without switching branches or creating another checkout. When the thread materializes, that control becomes an immutable label using the same compact naming: `Main` for the primary checkout, the branch name for branched worktrees, and the seven-character HEAD hash plus `[detached]` for detached worktrees. Locked-thread label resolution uses a one-shot lookup rather than maintaining worktree polling; while that lookup is pending for a detached checkout, the honest fallback is `[detached]`. Git worktree discovery is environment-scoped, uses NUL-delimited porcelain output for path safety, and distinguishes the primary checkout independently of its branch name.

**Implementation evidence:** `packages/contracts/src/git.ts`, `packages/client-runtime/src/state/vcs.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/ws.ts`, `apps/web/src/state/queries.ts`, and `apps/web/src/components/{BranchToolbar,BranchToolbarWorktreeSelector}.tsx`.

**Recorded validation:** focused contract, Git driver, and BranchToolbar logic tests; `vp check`; `vp run typecheck`; and an isolated paired dev-app startup. The live preview rerun was blocked by the unavailable T3 preview host tracked in Papercut #36.

**Last updated:** 2026-07-31

### DL018 — Read-only subagent transcripts in the right panel

Codex collaboration-agent output and Claude Task output are correlated with their native child or
parent tool-use identifiers, persisted separately from the parent assistant stream, and omitted
from the main transcript. Unmatched historical correlations fall back to the main transcript so a
provider routing defect cannot hide a parent response. The spawn remains visible as one native
task lifecycle row; selecting that row or its authoritative Agents-panel entry opens a normal chat
transcript without a composer in the right panel. The provider item remains persisted only for
transcript correlation and does not create a duplicate spawn row. When the provider reports it,
the complete, unchanged spawn prompt is synthesized as the
transcript's first user message.
Current Codex multi-agent v2 events expose the child thread and path but omit the spawn prompt,
model, and reasoning effort, so the client labels that metadata unavailable instead of inventing
it; Claude and legacy rich Codex collaboration events retain the complete metadata. Child plan
activity cannot
replace the parent plan, and child assistant messages cannot become the parent turn's checkpoint
message. Spawn rows show the reported subagent model and reasoning effort, while a count-labeled
Subagents dropdown between the composer Worktree and branch controls lists every run and opens its
transcript directly. Its label contracts from `N Subagents` to `N Sub` with the available composer
width. The aggregate label and each menu item's bot icon reflect completed, working, and failed
states; active work breathes, while terminal errors remain static. The composer context strip keeps
the same left-aligned workspace group and right-aligned subagent/branch group at every viewport
width. Native lifecycle-only agents are merged into the same dropdown, and native tool rows
attributed through `agentId` render inside their subagent transcript while remaining hidden from
the parent timeline. Claude output without a parent Task identifier remains in the main transcript.

Projection migration `040_ProjectionSubagentIds` adds durable correlation columns for messages and
activities. Upstream native `task.*` events remain the sole Codex lifecycle and Agents-panel status
authority; child message deltas use the same native agent/thread identity only to populate the
separate transcript. Child thread, turn, name, token, and plan chatter cannot mutate the parent.
Codex app-server builds that report a spawned or resumed child only through the completed
`collabAgentToolCall.receiverThreadIds` provisionally register each non-sender receiver, emit the
native child lifecycle, and scope its subsequent tool and assistant items to that child. Each child
tool keeps its native started/completed rows and complete output alongside task progress. Resume
reactivates an existing child, while later thread-start or subagent-activity metadata enriches the
identity without restarting a settled task. Only root-owned routing items can provision children,
so nested child activity and child-to-root input cannot suppress or pollute the root transcript.
Upstream `sourceActivityKind` semantics and normal-tool collapsing apply to ordinary work-log rows. Fork-owned subagent lifecycle rows remain visible and clickable instead of collapsing away, preserving transcript navigation and native child attribution.

The main timeline names started, messaged, resumed, waited, stopped,
interrupted, failed, and finished subagent operations instead of grouping them under a generic
task label. Only spawn/resume events can establish child routing, so a child message sent back to
the parent cannot capture the parent thread or suppress its final completion. The stale-session
reaper also settles an old active turn when no live provider session owns it, while preserving
genuinely live long-running turns. Codex and Claude are supported; other provider adapters remain
unchanged.

**Implementation evidence:** `packages/contracts/src/{provider,providerRuntime,orchestration}.ts`,
`apps/server/src/provider/Layers/{CodexSessionRuntime,CodexAdapter,ClaudeAdapter,ProviderSessionReaper}.ts`,
`apps/server/src/orchestration/`, `apps/server/src/persistence/Migrations/040_ProjectionSubagentIds.ts`,
and `apps/web/src/components/{BranchToolbar,ChatView,RightPanelTabs}.tsx`,
`apps/web/src/components/BranchToolbar.logic.ts`,
`apps/web/src/components/chat/{MessagesTimeline,SubagentPanel}.tsx`, `apps/web/src/session-logic.ts`,
and `apps/web/src/rightPanelStore.ts`.

**Recorded validation:** focused Codex and Claude adapter tests, provider-runtime ingestion and
projection migration tests, web session/timeline/right-panel and aggregate subagent-status tests,
package typechecks, `vp check`, `vp run typecheck`, and an isolated paired web-app verification at
narrow panel width. A real Codex 0.146.0 turn also spawned and completed a v2 child through T3,
confirming the canonical spawn activity, child-correlated output, and working-to-completed status
transition. The spawn row, complete prompt where supplied, separate child transcript, completed
status,
status-aware dropdown, invariant context-strip grouping across the former mobile breakpoint, and
absent composer were confirmed in the live client.
The receiver-only Codex v2 path is covered by a focused runtime integration replay that verifies
the synthesized spawn/resume lifecycle, late metadata ordering, parent-route isolation, and
child-scoped tool and assistant items. Adapter and ingestion regressions preserve each child tool's
full native lifecycle and terminal output through projection.

**Last updated:** 2026-08-24

### DL019 — Desktop backend continuity and owned process-tree cleanup

Closing the last desktop window leaves Electron's main process and local T3 backend running. A native OS tray or status item keeps the app discoverable, opens or activates the window, and shows a live count of threads with active foreground or background work. Launching the desktop app again activates or recreates the window against that existing backend, while explicit quit terminates the backend through the owned lifecycle and update and signal shutdown paths retain their normal cleanup semantics. Explicit quit now ignores activation while shutdown is underway and destroys renderer windows before backend cleanup, adopting upstream's cleanup ordering without changing the fork's last-window policy. This is intentionally process-local continuity rather than a detached provider daemon: an Electron main-process crash or OS-forced termination still ends the backend.

On Windows, the standalone service launcher terminates the known server PID and its descendants during stop, update, and fatal shutdown. This prevents launcher-owned provider processes from surviving as orphaned Codex writers without scanning or killing processes by name; direct-child signaling remains the fallback when process-tree termination fails.

**Implementation evidence:** desktop lifecycle and native tray/status-item modules and their focused tests under `apps/desktop/src/`, dedicated macOS template-image assets and packaging checks, the count-only orchestration HTTP contract and projection query, plus `apps/server/src/serviceLauncher.ts`.

**Recorded validation:** focused desktop tray, lifecycle, running-count projection, packaging, and Windows process-tree integration tests; Windows notification-area runtime verification of the count, open, and graceful quit controls; `vp check`; `vp run typecheck`; and `git diff --check`.

**Last updated:** 2026-08-24

### DL020 — Provider turns survive stalled checkpoint captures

Starting a provider turn no longer waits indefinitely when the previous turn has finished but its post-turn checkpoint capture is still pending. In that state, the server dispatches the next turn without a checkpoint mutation so authentication failures and stalled captures cannot freeze the thread. Active provider mutations retain their existing brief handoff grace period. This behavior applies to every provider through the shared command reactor.

Checkpoint workers also reclaim expired leases while the server remains running, retry transient capture errors up to three times, and terminate an executor that exceeds five minutes. Structured lifecycle logs identify the job, thread, boundary, durable attempt, execution attempt, result, and recovery action so capture failures can be diagnosed without inspecting SQLite.

**Implementation evidence:** `apps/server/src/checkpointing/CheckpointCaptureQueue.ts`, `apps/server/src/checkpointing/CheckpointCaptureQueue.test.ts`, `apps/server/src/orchestration/Layers/CheckpointReactor.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, and `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`.

**Recorded validation:** focused checkpoint queue recovery, retry, timeout, and provider command barrier regressions; `vp check`; and `vp run typecheck`.

**Last updated:** 2026-08-11

### DL021 — Clickable Windows file links in thread Markdown

Thread Markdown preserves local Windows drive-letter destinations through URL sanitization and resolves the encoded backslash form emitted by the Markdown parser. These links open through the existing file chip behavior instead of rendering as inert anchors. This coexists with upstream workspace images, spaced-folder command-click handling, contrast-aware annotation styling, and full-path link tooltips.

**Implementation evidence:** `apps/web/src/components/ChatMarkdown.tsx` and `apps/web/src/markdown-links.test.ts`.

**Recorded validation:** focused Markdown link tests, an isolated paired web-client pass with a drive-letter link in both user and assistant messages, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-08-24

### DL022 — Ephemeral zrok public sharing from Connection Settings

The server owns an in-memory, ephemeral zrok share service. Starting a share prefers the current v2 `zrok2` command and uses legacy v1 `zrok` only when `zrok2` cannot be resolved; it does not fall back after a resolved v2 command fails. It launches `share public --headless --force-local` against a bind-host-aware backend URL: wildcard binds map to loopback while specific IPv4 and IPv6 binds are preserved. It parses zrok's announced HTTP(S) endpoint from either plain or JSON-formatted headless logs and exposes a public endpoint with matching `ws:`/`wss:` access and hosted-HTTPS compatibility. Starts are single-flight and cancellation-safe; launch and stop are serialized in order, readiness has a bounded timeout, unexpected exit becomes a failed status, and stopping or server shutdown terminates the child with signal cleanup. The share is not persisted, and zrok must be available on this server's `PATH`, already authenticated, and enabled. An unavailable state is retryable after the executable or authentication is fixed.

Three environment RPCs expose status, start, and stop. Status observation uses `orchestration:read`; start and stop require `access:write`. Connection Settings shows the share control only when status can be observed, and enables mutation only when both the read and access-write scopes are present. Its access-scope disclosure identifies Manage access as the permission for starting or stopping public zrok exposure; unavailable or failed starts report the PATH/authentication requirement, and stopping requires confirmation because the public URL and dependent pairing links will stop working.

An active zrok endpoint is merged into the advertised endpoint list and is the automatic reachable URL and QR preference, while an explicit user endpoint selection still wins. Pairing URLs preserve the complete token for the zrok HTTPS host; when local network access is unavailable, the zrok endpoint remains available as the remote share route.

**Implementation evidence:** `apps/server/src/remoteAccess/ZrokShare.ts`, `apps/server/src/remoteAccess/ZrokShare.test.ts`, `apps/server/src/startupAccess.ts`, `apps/server/src/{server,ws}.ts`, `apps/server/src/auth/{RpcAuthorization,RpcAuthorization.test}.ts`, `packages/contracts/src/{remoteAccess,rpc}.ts`, `packages/contracts/src/rpc.zrok.test.ts`, `apps/web/src/state/zrokShare.ts`, `apps/web/src/components/settings/ConnectionsSettings.tsx`, `apps/web/src/components/settings/ConnectionsSettings.logic.ts`, and the focused settings/pairing tests.

**Recorded validation:** 38 focused tests cover bind-host targeting, zrok v2/v1 resolution, plain and JSON headless logs, lifecycle ordering, concurrency, cancellation, cleanup, RPC scopes/contracts, endpoint and QR preference, reachable-rail visibility, permission gating, and pairing URLs. An isolated paired web-client pass with an authenticated zrok installation verified start, public reachability, hosted pairing and QR selection, and confirmed stop. Repository-wide `vp check` and `vp run typecheck` pass.

**Last updated:** 2026-08-16

### DL023 — Environment-scoped agent thread tools

Codex, Claude Code, Cursor, Grok, and OpenCode agents can create, list, read, message, and wait
on durable T3 threads in their current environment. These threads are user-visible conversations,
distinct from the providers' internal subagents. New work can stay in the current checkout or use
a new Git worktree. The caller's permission mode applies to a new thread, while a message sent to
an existing thread keeps that thread's mode.

The tools share the server-owned provider MCP credential. They cannot access another environment,
and a thread cannot message itself. Lists default to 50 threads and cap at 200. Reads default to
10 turns, hide output, and cap at 50 turns and 20,000 characters per item. Wait targets are
limited to eight threads and five minutes. A failed worktree bootstrap closes its setup terminal,
deletes the durable thread, removes the worktree when safe, and then removes its generated branch.

**Implementation evidence:** `packages/contracts/src/threadTools.ts`,
`apps/server/src/mcp/{McpHttpServer,McpSessionRegistry,toolkits/threads}/`,
`apps/server/src/orchestration/ThreadCommandDispatcher.ts`, and the existing product MCP provider
integration.

**Recorded validation:** focused thread-tool contract, MCP, dispatcher, and Codex developer
instruction tests, plus `vp check` and `vp run typecheck`.

**Last updated:** 2026-08-24

### DL024 — Progressive multi-environment usage

The web Usage page shows totals as soon as one environment reports them. A device progress strip
keeps the remaining scans visible, and the page updates the merged totals as later results arrive.
Mobile already follows the same progressive behavior.

**Implementation evidence:** `apps/web/src/components/usage/UsagePage.tsx`,
`apps/web/src/components/usage/UsagePage.test.tsx`, and `docs/user/usage.md`.

**Recorded validation:** focused Usage page regression coverage, an isolated two-environment
browser pass that displayed first-host totals while the second host was still scanning,
`vp check`, and `vp run typecheck`.

**Last updated:** 2026-08-25

## Merge History

This is an append-only historical decision record. It provides context for integrations but never, by itself, establishes an ongoing fork divergence; use the current Divergence Log for that determination.

Don't forget to update the `base` tag after each merge to track the latest shared base with upstream/main.

### 2026-08-28 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `f3caafe741e9ca21d48788803a9e202c97d6d1ce` (fork) and `f6f2be32d8bc072e87753e41ad77c7c67e8b0b95` (upstream/main)

The integration made these semantic choices:

- **Persistence migrations:** kept deployed fork migrations `036` through `047` in place and assigned upstream linked-pull-request and unsettled-thread migrations to `048` and `049`, with schema guards and ledger coverage.
- **Providers and orchestration:** adopted upstream approval, interrupt, session recovery, Codex 0.150, Claude, and Grok fixes while retaining checkpoint barriers, receiver-only Codex child routing, child transcript isolation, and environment-scoped durable thread tools.
- **Git and thread startup:** retained existing-worktree selection and the fork's cleanup-aware shared thread dispatcher, then added upstream missing-worktree recreation, push-base protection, worktree pruning, and submodule initialization.
- **Web and mobile:** adopted uploads, HEIC conversion, file reveal, linked pull requests, settle restoration, usage sorting and filtering, and current layout fixes while retaining split-pane composer ownership, checkpoint navigation, clickable subagent transcripts, and progressive multi-environment usage.
- **Desktop and packaging:** retained tray-backed backend continuity, Windows process and Claude safeguards, and lockfile-free patch pinning while adopting upstream macOS signing, preview release, Clerk, and dependency-staging changes.
- **Post-merge QA:** conflict and regression suites passed, including migrations `048` and `049`, Git and provider integration, progressive usage, desktop packaging, and the transfer-budget test rerun in isolation. `vp check`, `vp run typecheck`, `vp run lint:mobile`, and `git diff --check` passed. An isolated paired web client rendered progressive usage and the merged draft composer. Mobile emulator verification was unavailable because this Windows host has no Android SDK or ADB.

### 2026-08-24 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `2382ae6d4824f4eea30d96404f7b22df5309c05e` (fork) and `b4be33f0747445f1c9df126e932c7b9792f322d5` (upstream/main)

The integration made these semantic choices:

- **Persistence migrations:** preserved deployed fork migrations `036`–`045`, added idempotent migration `046` to reconcile databases that previously followed upstream through `041`, and assigned upstream auth-session client metadata to `047`.
- **Providers and orchestration:** adopted upstream feedback upload, hard-stop handling, lifecycle identity, liveness, mixed-tool failure, and terminal-state fixes while retaining fork checkpoint navigation, provider health behavior, receiver-only Codex child routing, Claude child persistence, and parent transcript isolation.
- **Tool and subagent UI:** adopted upstream work-log source semantics and collapsing for ordinary tools while retaining visible, clickable fork subagent rows, transcript actions, native lifecycle metadata, and split-pane/right-panel ownership.
- **Composer and Markdown:** combined upstream skill menus, background thread creation, draft recovery, workspace images, link tooltips, and appearance contrast with fork checkpoint commands, prompt preservation, workspace context, and Windows drive-letter links.
- **Desktop and preview:** retained last-window backend continuity and bounded preview automation recovery while adopting upstream explicit-quit cleanup, activation guard, hidden-preview throttling, and current updater behavior.
- **Git, dependencies, and packaging:** kept existing-worktree selection, patched Claude SDK pinning, native binary exclusions, and zrok sharing alongside upstream remote default-branch, pull-request association, Clerk, release, and package updates.
- **Repository cleanup:** adopted upstream removal of obsolete plans, PR assets, preview loading helpers, marketing architecture helpers, and superseded skill-presentation helpers.
- **Post-merge QA:** focused conflict and regression suites passed, including the upstream-ledger migration through `047`, provider/orchestration contracts, web/mobile timeline behavior, desktop lifecycle/preview, and the rebaselined per-snapshot transfer budget. `vp check`, `vp run typecheck`, and `vp run lint:mobile` passed on Node `24.13.1`; the mobile wrapper skipped unavailable SwiftLint, ktlint, and detekt binaries. An isolated paired web client rendered the merged command/skill UI, created a real thread, and received a provider response. Representative mobile emulator verification was unavailable because this Windows host has no Android SDK or ADB and cannot run iOS Simulator tooling.

### 2026-08-17 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `76b158036c279fe49141c74c072ac18a48a61795` (fork) and `cd096b9ad5a4156ffeab85de617cbb219057007f` (upstream/main)

The integration made these semantic choices:

- **Persistence migrations:** preserved deployed fork migrations `039`–`043` and assigned upstream project default-environment and favicon migrations to `044`–`045`, including their loader, ledger, and focused test references.
- **Providers:** adopted upstream's Codex missing-rollout recovery and hermetic Claude fixture while retaining fork collaboration wait handling, subagent routing assertions, patched Claude SDK resolution, and subscription usage.
- **Right panel and workspaces:** retained split-pane ownership, pane-local composer routing, checkpoint navigation, and subagent source attribution while adding upstream pull-request surfaces, file drops, maximization, favicons, and sidebar behavior. Persisted right-panel state now uses version `12`.
- **Remote access and authorization:** kept the zrok service and its RPC scopes alongside upstream remote-open targets, pull-request services, project access controls, and permission-aware UI.
- **Preview:** adopted upstream browser-default/open behavior and favicon lifecycle while retaining navigation readiness, `LoadFailed` propagation, stale-host recovery, and diagnostics reset on navigation.
- **Usage and packaging:** retained printable `\u001f` usage keys with upstream hourly four-part buckets, preserved fork Claude/mobile patches with upstream Clerk and dependency updates, and kept patched-version pinning inside upstream's split desktop staging sets.
- **Agent policy:** adopted upstream's removal of the rebase-before-PR rule while preserving this fork's explicit-consent and semantic-sync requirements.
- **Post-merge QA:** passed `vp check`, `vp run typecheck`, the mobile native static-check wrapper, focused server/web/desktop suites, and a fresh isolated migration through `045`. The authenticated web shell rendered, but interactive web automation was unavailable after the T3 preview host detached; mobile emulator verification and platform-native linters were unavailable on this Windows host because the Android SDK and native lint tools are not installed.

### 2026-08-08 — Merge upstream/main into main

**Primary merge commit:** `c6660dec6dd6e42ffed0cc4fb6a95fb24defbd74`
**Parents:** `cb54c741c0005c27b57894f6829cd590e6965b17` (fork) and `2c7267ad43a05cf3e30343400c76fd9ac47698e7` (upstream/main)

**Latest-tip merge commit:** `b20da786b74b45e74d52d4f6360d69b326dbb123`
**Parents:** `c6660dec6dd6e42ffed0cc4fb6a95fb24defbd74` (integrated fork) and `8101cd044911c7dc2a2adf7c7a9ba7962abf57b6` (upstream/main)

The integration made these semantic choices:

- **Subagent observability:** adopted upstream's native `task.*` lifecycle and Agents surface as authoritative while retaining fork child-scoped transcript persistence and transcript access from matching native agent rows. Child messages remain outside the parent web and mobile feeds.
- **Codex child lifecycle:** retained native task progress, usage, idle/resumable state, and reaper liveness while also finalizing child assistant output into the fork transcript without mutating parent turn, diff, or checkpoint state.
- **Persistence migrations:** preserved fork migrations `036`–`040`, moved upstream pinning and pagination migrations to `041`–`043`, and kept migration `039` as the idempotent repair path for databases carrying the upstream `036`–`038` ledger.
- **Checkpoint pagination:** combined fork checkpoint navigation and cursor behavior with upstream bounded thread snapshots; clients retain the complete requested turn window across cache rehydration and navigation refreshes.
- **Sidebar and split workspaces:** followed upstream's `SidebarV2` to `Sidebar` promotion while retaining fork split-group styling, drag/detach behavior, accessibility, and context actions alongside upstream pinning.
- **Authorization and session safety:** retained workspace-root authorization for review file reads and ordered background-agent liveness ahead of orphaned-turn cleanup so a live child cannot be stopped accidentally.
- **Latest upstream additions:** integrated desktop preview zoom controls, the consolidated mobile thread-settings sheet, and cross-environment provider transcript usage reporting without replacing surviving fork behavior.
- **Post-merge QA:** fixed snapshot identity decoding, checkpoint-navigation delivery, cached pagination width, child transcript propagation and live-follow, mobile child-message filtering, Windows transfer-test timing, and source NUL delimiters found by focused tests, live paired verification, and independent Opus review.

### 2026-07-27 — Merge upstream/main into main

**Merge commit:** `e9ef500ee4f779df65864f0c0e5c599bb740b870`
**Parents:** `a193276b47626a2556690408a87e4eab7325ea1e` (fork) and `23b55022175e69938514934f65c5a607d38f1e47` (upstream/main)

The merge reconciled the following textual conflict surfaces and made these semantic choices:

- **Agent guidance:** combined both `AGENTS.md` verification requirements rather than dropping either workflow.
- **Persistence migrations:** retained fork checkpoint migrations `033`–`036` and placed upstream settled/snoozed projection migrations at `037`–`038`, resolving the migration-number collision without rewriting existing fork installations.
- **Checkpoint and lifecycle projections/contracts:** merged checkpoint commands, cursor-aware projection, and durable state with upstream settled/snoozed thread projection and the corresponding contracts and schemas.
- **Provider lifecycle:** preserved explicit provider starting/error states while treating catalog enrichment and turn-scoped errors as nonfatal for an otherwise healthy session; only genuine startup, process, or transport failure makes it unavailable.
- **Claude executable handling:** selected the upstream resolver as the primary path and retained the fork's packaged `app.asar.unpacked` fallback, patched SDK pinning, and sanitized diagnostics for Windows artifacts.
- **Sidebar and split workspaces:** adopted Sidebar V2 while retaining persistent split groups, split actions, and displayed panes remaining open when settled or snoozed shelves are collapsed.
- **Draft empty state:** kept the upstream draft hero, retained prompt preservation during promotion, and placed the fork workspace/location context as the supporting line.
- **Timeline minimap:** chose the upstream side-gutter minimap and dropped the obsolete fork `w-5` minimap-width change.
- **Preview behavior:** adopted upstream preview URL and color-scheme behavior while retaining fork navigation readiness, `LoadFailed` reporting, host failover, and recovery hardening.
- **Development addressing:** adopted upstream browser single-origin and Tailscale behavior; explicit loopback remains limited to desktop and local-preview paths.
- **Root helpers:** retained both sets of root helper configuration instead of treating either as a replacement.
- **Cross-platform test coverage:** merged `/userdata` and Windows portability coverage so desktop, server, and shared tests use platform-correct paths and fixtures.
- **QA reconciliation:** merged command, schema, and test-fixture changes and fixed Claude/Codex cleanup issues discovered during post-merge validation.
