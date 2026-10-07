# t3code Fork

This fork keeps the Windows reliability, durable checkpointing, and workspace capabilities that are still not supplied by the shared base.

Git repository cache keys use Node's native `realpath` so Windows long paths and their 8.3 aliases share one VCS snapshot and refresh history.

## Divergence Log

### DL001 — Claude Windows resolver and artifact safeguards

Windows Claude commands are resolved before the Agent SDK starts a session. The resolver follows npm launcher shims to the installed native executable or JavaScript entry point and preserves explicit executable paths. Provider snapshots and DevTools expose sanitized resolver diagnostics; startup provenance identifies installed web artifacts without exposing command output or environment values.

When a PATH-based provider executable disappears before startup, the backend resolves it again and retries once. Claude waits for the SDK initialization handshake before reporting ready and caches a replacement path only after successful initialization. Codex, Cursor, Grok, local OpenCode, and Claude/Codex metadata commands apply the retry at process launch; Antigravity reacquires its PATH installation and harness together. Explicit executable paths and managed Antigravity installations never use this fallback. Failures after a process starts do not replay agent work.

Older failed Claude startups could persist a generated session ID before its transcript existed. If Claude explicitly rejects that resume ID and the cursor records zero turns with no assistant checkpoint or turn boundaries, the adapter recreates the session with the same ID once before accepting a turn. Missing sessions with recorded history remain errors.

Each Claude startup attempt owns a separate prompt queue. Closing a failed SDK query does not cancel its pending input read, so sharing a queue across retries could lose the replacement session's first prompt. Failed attempts now close their query and shut down their queue before recovery.

The current server bundle includes the SDK and uses the configured Claude installation. Upstream packaging removes unused SDK native optional dependencies; the older SDK patch and lockfile-free patch-pinning workaround are no longer active. Windows and WSL ship separate runtime archives, each with its own platform dependencies.

**Implementation evidence:** `apps/server/src/provider/executableRecovery.ts`, the Claude and Codex adapter runtimes, `apps/server/src/provider/acp/AcpSessionRuntime.ts`, `apps/server/src/provider/opencodeRuntime.ts`, `apps/server/src/provider/Drivers/{ClaudeExecutable,AntigravityDriver}.ts`, `apps/server/src/provider/Layers/ClaudeProvider.ts`, `apps/server/src/provider/providerSnapshot.ts`, `scripts/build-desktop-artifact.ts`, and `pnpm-workspace.yaml`.

**Recorded validation:** 352 focused tests passed across 11 affected suites on Windows, with 14 existing platform skips. Recovery tests cover synchronous and asynchronous Claude startup failures, replacement-path caching, one retry, explicit-path exclusions, real child-process launches, and Antigravity executable/harness reacquisition. The stale Cursor rollback assertion now checks the current navigation contract. Codex metadata tests were run without the inherited `T3CODE_CODEX_LAUNCH_ARGS` override. The OpenCode localhost output fixture timed out in combined runs and passed isolated reruns. `vp check`, `vp run typecheck`, and `git diff --check` passed. Earlier integrations verified initialization and packaging.

The empty-session follow-up initially verified initialization only. A later real-SDK probe reproduced the failed query stealing the replacement's first prompt; the fixed probe delivered that prompt to the replacement and received native `system/init`. All 159 Claude adapter tests passed, including prompt delivery after missing-session and stale-executable recovery.

**Last updated:** 2026-09-30

### DL002 — Machine context beside the empty-state hero

The upstream draft hero remains the empty-state headline. The fork adds `On <machine-name>` as its supporting line and uses the same machine label in the existing non-draft empty state. The project already appears in the hero headline, so the supporting line identifies the environment instead of repeating the project name.

Projectless drafts retain upstream's scratch-project picker beside the machine context.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`, and `apps/web/src/components/chat/MessagesTimeline.test.tsx`.

**Recorded validation:** `vp test apps/web/src/components/chat/MessagesTimeline.test.tsx`, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-10-02

### DL004 — Preview navigation and automation hardening

The fork hardens desktop collaborative preview control. A debugger detach invalidates the cached Chrome DevTools Protocol attachment, URL-bearing `preview_open` waits for new and reused tab readiness, and a committed `LoadFailed` state is returned as an automation failure rather than a successful load.

Automation also retries dynamic click/type targets, re-resolves click targets after cursor movement, keeps snapshots coherent across DOM mutations, bounds guest viewport work, and quarantines an unresponsive host so later requests can fail over and recover without reconnecting the environment. Hung native control work now times out below the broker deadline and detaches only its cached debugger session, so the same tab can reattach instead of retaining a blocked control permit.

Desktop hosts now acknowledge receipt to the broker before starting page work. A slow navigation or snapshot can therefore time out without being mistaken for a disconnected host, while a stream that never acknowledges is still quarantined and failed over. Timeout cleanup also preserves hosts whose completion arrived after the deadline. Automation navigation starts Electron loads without waiting for every subresource, then applies the requested readiness milestone in the renderer.

Browser development's single-origin Vite proxy behavior, including shared and Tailscale origins, is upstream behavior and is not a fork divergence. Explicit IPv4 loopback URLs remain only for the desktop renderer and local-preview automation, where they protect Windows local routing.

**Implementation evidence:** `apps/desktop/src/preview/Manager.ts`, `apps/web/src/components/preview/`, `apps/server/src/mcp/PreviewAutomationBroker.ts`, `apps/server/src/mcp/toolkits/preview/handlers.ts`, and `packages/contracts/src/previewAutomation.ts`.

Upstream owns the pinned Electron debugger reference and bounded screenshot retries. Those fixes compose with the fork's stale-session detection and control deadlines; a screenshot that succeeds on retry keeps its debugger session.

**Recorded validation:** focused desktop preview, web readiness/viewport, broker, MCP, and dev-runner coverage, including same-tab recovery from stalled CDP and capture work, stale-host failover, acknowledged slow-operation recovery, timeout cleanup races, and `LoadFailed`; `vp check` and `vp run typecheck`. An isolated Electron run reproduced a full-load timeout against a page with a never-ending image request, then confirmed same-tab evaluate and snapshot remained available. The 2026-09-01 merge-focused suites reran the affected desktop, server, and web preview recovery paths.

**Last updated:** 2026-09-30

### DL005 — Windows portability in CLI fixtures, Git, and tests

The shared fixture launcher dispatches by shebang: shell fixtures use Git for Windows `sh.exe` and Node fixtures use the current Node executable. These dispatch rules and the remaining platform-specific test expectations compose with upstream's broader Windows fixture portability fixes.

Git fixtures set repository-local `core.autocrlf=false` when exact LF content is part of an assertion, preserving the tested reset and restore behavior across Windows installations.

Git worktree comparison uses native realpaths and case-folding on Windows so Git for Windows path canonicalization cannot mistake the main checkout for another worktree.

Server-router and HTTP MCP fixtures use native HTTP clients with OS-assigned loopback ports. Windows can assign port `6566`, which Fetch blocks before connecting. Explicit compression checks retain Fetch and its automatic decompression. The fixtures retain real HTTP requests and their status, body, and session assertions.

**Implementation evidence:** `packages/shared/src/shell.ts`, `apps/server/src/git/GitManager.ts`, their remaining fork-specific fixture and canonical-path tests, `apps/server/src/server.test.ts`, `apps/server/src/mcp/McpHttpServer.test.ts`, `packages/tailscale/src/tailscale.test.ts`, and `oxlint-plugin-t3code/test/utils.ts`.

**Recorded validation:** targeted Cursor/Grok ACP, provider-runtime ingestion, checkpoint, Git PR-selector, desktop, relay, workspace, Tailscale, and oxlint suites on Windows; `vp check` and `vp run typecheck`.

**Last updated:** 2026-10-02

### DL006 — Durable sidecar checkpoints and recoverable navigation

Checkpoint capture and navigation are durable server services. Private bare-Git sidecars hold opaque `t3-sidecar:v1:` snapshots without modifying the project repository; capture, import, restore, retention, and cleanup are serialized and cover linked worktrees, binaries, symlinks, Windows paths, and non-Git workspaces safely.

SQLite persists capture jobs, immutable checkpoint entries, timeline generations and cursors, provider bindings, retention data, and restart-recoverable navigation journals. Undo, redo, and file-state recovery use the V2 checkpoint service; provider conversation rollback/fork and direct active steering are intentionally not part of the fork's retained checkpoint surface.

Fork migrations `036`–`038` establish durable checkpoint state. The reconciliation migrations retain compatibility with databases that used upstream's overlapping migration numbers. Existing fork history through `052_RemoveManagementApiKeyRuntimeModes` remains unchanged.

Migration 053_ReconcileUpstream47History repairs a database carrying upstream history through 047, restoring fork checkpoint and subagent state skipped by the overlapping numbers. Fork management-key and auto-resume migrations remain at 050-052. Incoming upstream behavior then runs as 054-061, with fork prompt suggestions at 062, and the latest upstream title-state, pull-request-file, auto-settle, and V2 cutover migrations at 063-067. The current sync assigns upstream webhook migrations to 068-069. Migration 065_ReconcileBranchPullRequestHistory repairs the known deployed-ID-58 collision idempotently before startup. Migration 067_CoreV2Cutover imports legacy V1 thread shells and messages into V2 projections and removes obsolete V1 runtime state. Schema checks keep these changes safe for both fork and upstream database histories.

Upstream's per-thread auto-settle migration runs at 066, followed by the V2 cutover at 067, preserving the deployed fork ledger. The isolated migration helper accepts documented historical ledger names only after it verifies their reconciliation markers and repaired schema. Codex checkpoint navigation uses the current native thread/revert protocol and retains the fork's conversation cursor safeguards.

Terminal provider events end the workspace mutation for their exact turn and settle the run before local VCS status refresh or checkpoint capture. Checkpoint capture runs as a follow-up effect and records the checkpoint when it succeeds, so a slow or unavailable VCS backend cannot leave the conversation showing as active. Capture and mutation intervals are serialized instead of preempting one another, preventing normal provider turns from producing `workspace-mutated` checkpoints. A capture waiting for active work releases the worktree gate, so provider turns in other threads can join the same mutation cohort and share its next stable checkpoint boundary; an already-running capture and checkpoint navigation remain exclusive. Aborted turns and provider-turn handoff ownership retain the same exact-owner completion semantics. A stale lease with no active provider turn is recovered automatically; if ownership is ambiguous, the provider turn continues without checkpoint navigation instead of blocking the conversation. Failed mutation-blocked text messages expose a retry action that reuses the persisted user message when available or recreates an optimistic-only message without duplicating it in the UI.

Durable completion retains the provider placeholder assistant-message identity, including interrupted turns. Workspace status refresh runs through a coalesced background worker after capture receipts, so slow Git inspection cannot delay turn completion.

Sidecar repositories inherit the workspace's `core.autocrlf` and `core.eol` settings so restoring a checkpoint preserves its line endings under Windows Git defaults. Empty nested workspaces remain present after checkpoint cleanup.

Batched allowlisted config reads preserve Git includes and global/local precedence. The sidecar skips unchanged writes and clears removed line-ending overrides only when present. This avoids repeated Windows process cleanup after normal missing-setting queries.

Capture jobs that first lose the workspace-mutation race or fail can be re-enqueued for the same logical turn boundary. The durable row is reset to pending and remains the single job for its snapshot, while pending, running, and ready jobs are still deduplicated.

Sidecar capture excludes deleted tracked paths from `git add`. Its private index starts empty, so those paths already represent deletions; including them as pathspecs would reject an otherwise valid capture. Deleted and renamed files restore correctly without changing the user's Git index.

**Implementation evidence:** `apps/server/src/checkpointing/`, `apps/server/src/persistence/Migrations/{036_CheckpointDurableState,037_CheckpointLegacyMigration,038_CheckpointCaptureProviderMetadata,039_ReconcileCheckpointAndTitleHistory,046_ReconcileUpstream41History,047_AuthSessionClientConnection,048_ProjectionThreadLinkedPullRequest,049_ProjectionThreadsUnsettledAt,053_ReconcileUpstream47History,054_ClearAutomaticProjectModelDefaults,055_ProjectionProjectsAutoPull,056_RepairAutomaticSettlementTimestamps,057_ProjectionProjectIcon}.ts`, `apps/server/src/orchestration/`, `packages/contracts/src/orchestration.ts`, `packages/client-runtime/src/`, and checkpoint-aware web composer and chat components including `ThreadErrorBanner.tsx`.

**Recorded validation:** migration and durability regression matrices, sidecar characterization (including unborn repositories, submodules, and linked worktrees), orchestration integration including serialized full-turn capture, deterministic post-capture lease release, stale-lease recovery, non-blocking checkpoint degradation, and persisted-message retry, Windows isolation slices, upstream-ledger reconciliation through migration `047`, full `vp test`, `vp check`, `vp run typecheck`, and `git diff --check`. The 2026-09-01 merge-focused server tests also covered checkpoint projection and reactor behavior after upstream bounded activity hydration and provider event-lifecycle fixes were integrated. The deletion/rename regression and all 15 sidecar checkpoint tests passed on Windows with the user-index preservation assertion.

The 2026-10-02 config repair passed all 28 checkpoint-store tests, including exact restored bytes, conditional includes, repeated values, and removed overrides. A single-file capture benchmark measured 3.2–3.4 seconds against 4.6–4.8 seconds for the original fork implementation.

The 2026-10-05 completion split passed the focused RunExecutionService, CheckpointCaptureService, CheckpointService, runtime-layer, recovery, projection, `vp check`, and `vp run typecheck` checks. Settled provider turns now remain settled when follow-up checkpoint capture is slow or unavailable.

**Last updated:** 2026-10-07

### DL008 — Persistent multi-thread split workspaces

Sidebar pointer drags use the same thread-row component inside and outside the sidebar. The opaque overlay follows the pointer across panels while the hidden source row preserves its gap until release or cancellation. Split-pane drops suppress composer context-drop highlighting and dispatch, and pointer capture keeps release cleanup reliable across panel boundaries.

Collapsed Working, snoozed, and settled shelves keep all displayed split panes visible in the sidebar.

The fork supports up to ten visible thread panes in five columns and two rows. Panes fill columns at full height until a sixth pane opens the lower row. A full-height pane accepts a thread above or below it in its outer quarters; its middle half accepts left/right placement while fewer than five columns exist. A stacked column accepts only left/right placement while fewer than five columns exist. Left/right drop hints cover the full destination column, including both rows of a stacked column. Blocked drop areas show no hint. Split layouts retain focused-pane routing, a shared toolbar, one right panel, and controlled ownership of global keyboard, preview, and composer behavior. The right-panel toggle reflects the shared split layout and closes every open pane panel together, so changing focus cannot reopen a panel owned by another pane. Panes can be opened or detached from the sidebar, safely reconcile draft promotion/archive/deletion, and animate layout changes without leaving stale portals or listeners. Reconciliation never returns a deleted thread as the fallback when all panes disappear.

Both pointer drags and native legacy-sidebar drags can create the first split on either side of a thread or place a pane above or below an unstacked column, with the hint and insertion using the same pointer position. Detaching the focused pane through the legacy sidebar routes to the remaining pane. Thread context menus can detach one pane or dissolve the entire containing split group. Entering a thread route restores its saved group, including navigation from the command palette, notifications, citations, and browser history; preloading a route leaves the current layout alone.

Split membership is persisted as multiple ordered local groups with active state and stable group colors. Selecting any member restores its group; the current and legacy sidebars preserve group tinting, support pane and thread drag placement, and show complete left/right drop intent. The group tint is textured with an inline desaturated SVG grain so the color-coded row reads as a surface rather than a flat slab. The grain is a masked pseudo-element rather than a second background layer, because background layers cannot carry their own mask and unmasked grain also covers the gradient's faded tail, flattening the row back into a uniform slab; the overlay shares the tint's fade axis and stops short of its extent so the texture is gone before the color is. Group hues carry a hue-dependent chroma: a flat chroma across the wheel does not read as a flat saturation, since yellow-green renders at full strength while red and blue are gamut-clipped, so chroma eases down around yellow-green. Rows supply only the hue and that chroma, leaving the stylesheet to compose per-theme lightness and strength — light mode takes a deeper, less translucent tint because the translucency that reads as a clear band on the near-black sidebar washes out against zinc-50. The current sidebar also names the other panes in each grouped thread's details tooltip, keeps displayed panes visible when settled or snoozed shelves are collapsed, and preserves split actions in its context menu. Right-panel ownership remains useful when focus moves to a pane with no surface of its own.

**Implementation evidence:** `apps/web/src/{splitViewStore,splitViewDrag,splitViewNavigation}.ts`, `apps/web/src/components/{SplitThreadWorkspace,ThreadRouteView,SplitPaneDropHint,Sidebar,LegacySidebar,CommandPalette,RightPanelTabs,ChatView,chat/ChatComposer}.tsx`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/index.css`, `apps/web/src/hooks/useThreadActions.ts`, and the chat routes.

**Recorded validation:** 248 focused tests across split state, navigation, native drag events, route history, sidebar logic, workspace, right-panel, notification, and citation behavior; `vp check`; `vp run typecheck`; and `git diff --check`. The 2026-09-28 isolated paired-browser pass confirmed that pointer hints switch between left and right and a left drop places the dragged thread before the original. The Browser panel then lost its automation host, so the remaining live flows and screenshot capture could not be completed. Native legacy drops and route restoration were verified by automated tests. An unrelated existing command-palette sorting test still fails in unchanged code. Earlier integrated checks cover composer shortcut ownership and shared right-panel closing. The 2026-09-29 5x2 extension passed 211 focused tests, `vp check`, `vp run typecheck`, and an isolated paired-browser pass at 2560x1440 showing five full-height columns and a sixth pane below the first. The drop-area correction passed 214 focused tests; an isolated paired-browser pass confirmed top and bottom native drops, and confirmed that a filled column at five columns accepts no drop or hint while an unstacked column still offers the top hint. The 2026-09-29 standalone vertical-drop and group-detach update passed 220 focused tests, including top/bottom native and pointer targets, active/inactive group dissolution, and both sidebar menu paths; the isolated browser pass confirmed the new menu item, top and bottom first-split hints, and the resulting stacked two-pane layout.

The 2026-10-07 drag update passed 90 focused drag tests, `vp check`, `vp run typecheck`, and `git diff --check`. Remote user verification confirmed the full thread-row overlay follows the pointer and the source gap remains visible outside the sidebar.

**Last updated:** 2026-10-07

### DL012 — Prompt preservation during draft promotion

The initial optimistic prompt remains visible while a draft route becomes its server-backed thread. Chat timeline state resets only when the scoped thread identity changes, so the projected `thread.message-sent` event replaces the prompt instead of briefly erasing it. Orchestration commands require an acknowledgement within ten seconds; a lost WebSocket reply therefore enters the existing visible failure path and restores the durable composer draft instead of leaving a refresh-only optimistic message indefinitely.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx` and `packages/client-runtime/src/operations/commands.ts`.

**Recorded validation:** `vp check`, `vp run typecheck`, and the repository `dev` startup smoke test.

**Last updated:** 2026-08-10

### DL013 — Codex availability through catalog and turn failures

Codex model and skill discovery is bounded, optional catalog enrichment after a healthy authenticated app-server session starts. Catalog failure cannot replace that healthy snapshot with a provider-status error.

App-server errors are classified by scope: retryable transport errors remain warnings, while a typed non-retryable turn error emits the terminal failed-turn lifecycle needed to release the thread for a follow-up message. A root Codex collaboration `wait` that remains open for 30 minutes is failed explicitly after bounded child-then-parent interruption; matching item or turn completion cancels that deadline. Actual process or transport failure still marks the session unavailable. Upstream terminal-state, hard-stop, tool-identity, and liveness fixes remain authoritative; in particular, a late collaboration `interacted` event can enrich an existing child without restarting one that already completed.

**Implementation evidence:** `apps/server/src/provider/Layers/{CodexProvider,CodexSessionRuntime,CodexAdapter}.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, and `packages/contracts/src/providerRuntime.ts`.

**Recorded validation:** focused Codex adapter, collaboration-runtime, provider-runtime ingestion, mixed-tool lifecycle, and transfer-budget tests, `vp check`, and `vp run typecheck`. The 2026-09-01 merge-focused provider suites also covered bounded collaboration waits, turn-scoped failure recovery, and upstream child-model enrichment.

**Last updated:** 2026-09-01

### DL014 — Loadable checkpoint diffs with a legacy baseline fallback

Sidecar summary requests use upstream's NUL-delimited numstat format, including the repository-HEAD compatibility fallback, and reject output overflow rather than publishing an incomplete file list. Full patch requests remain available for the diff viewer.

Turn diff summaries are published only for successfully captured, loadable sidecar checkpoints. Each summary and DiffPanel query compares the completed full turn against the immediately preceding turn boundary; an empty turn remains loadable but produces no diff card. Provider-reported `file_change` items are not synthesized into checkpoint references, and the client hides legacy non-ready rows that cannot load a diff.

Diff queries use the active checkpoint timeline generation and the stable pre-turn sidecar identity. For an older thread with no captured baseline, the remaining compatibility fallback compares against repository `HEAD`. This absorbs only the surviving baseline-fallback behavior from former DL011; provider-derived summary fallback is not retained.

**Implementation evidence:** `apps/server/src/checkpointing/{CheckpointIds,CheckpointDiffQuery,CheckpointStore}.ts`, `apps/server/src/orchestration/Layers/{CheckpointReactor,ProjectionSnapshotQuery}.ts`, `apps/web/src/hooks/useTurnDiffSummaries.ts` with their tests.

**Recorded validation:** focused checkpoint query, nested-worktree, projection, and web-summary tests; rapid multi-turn orchestration integration covering pre-thread changes, consecutive edit turns, a no-edit turn, durable capture, projection summaries, and DiffPanel queries; `vp check`; and `vp run typecheck`.

**Last updated:** 2026-09-05

### DL015 — Case-safe composer subagent utility filename

The composer subagent utility module uses a distinct basename from the `ComposerSubagents.tsx` component so Windows case-insensitive resolution cannot merge the two modules during typecheck.

**Implementation evidence:** `apps/web/src/components/chat/composerSubagentUtils.ts`, `apps/web/src/components/chat/ComposerSubagents.tsx`, and `apps/web/src/components/chat/composerSubagents.test.ts`.

**Recorded validation:** mobile typecheck and repository typecheck on Windows.

**Last updated:** 2026-09-24

This is a current-state record only. Each entry describes a surviving difference between `HEAD` and the latest shared base, determined with `git merge-base HEAD upstream/main` (updated by the latest sync merge). A feature adopted from upstream is not a divergence merely because it was involved in a merge.

Keep stable IDs when updating this section; gaps are intentional. When upstream absorbs a difference, remove or rewrite the entry rather than preserving chronology here. Update its behavior, implementation evidence, and validation when the surviving difference changes.

### DL016 — Repository identity for partial clones

Git may append a filter annotation to `git remote -v` fetch lines for partial clones. The repository identity resolver accepts those lines so projects using the same remote can group across environments.

**Implementation evidence:** `apps/server/src/project/RepositoryIdentityResolver.ts` and its focused test.

**Recorded validation:** resolver regression test, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-09-24

### DL017 — Existing-worktree selection for new threads

The new-thread Workspace controls expose a neighboring Worktree selector in Current checkout mode. It defaults to Git's primary checkout and can pin the draft to any existing branched or detached worktree without switching branches or creating another checkout. When the thread materializes, that control becomes an immutable label using the same compact naming: `Main` for the primary checkout, the branch name for branched worktrees, and the seven-character HEAD hash plus `[detached]` for detached worktrees. Locked-thread label resolution uses a one-shot lookup rather than maintaining worktree polling; while that lookup is pending for a detached checkout, the honest fallback is `[detached]`. Git worktree discovery is environment-scoped, uses NUL-delimited porcelain output for path safety, and distinguishes the primary checkout independently of its branch name.

**Implementation evidence:** `packages/contracts/src/git.ts`, `packages/client-runtime/src/state/vcs.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/ws.ts`, `apps/web/src/state/queries.ts`, and `apps/web/src/components/{BranchToolbar,BranchToolbarWorktreeSelector}.tsx`.

**Recorded validation:** focused contract, Git driver, and BranchToolbar logic tests; `vp check`; `vp run typecheck`; and an isolated paired dev-app startup. The live preview rerun was blocked by the unavailable T3 preview host tracked in Papercut #36.

**Last updated:** 2026-07-31

### DL018 – Child-thread navigation and retained composer metadata

Orchestrator V2 models provider-native subagents as real child threads with durable lineage. The
parent projection records each child thread, parent/root identifiers, relationship, status, model,
reasoning effort, and result. Child activity remains isolated from the parent's message stream and
checkpoint state. Selecting a child uses the normal thread route; a child route exposes lineage
controls that return to its parent or open related children. The old Agents panel and right-panel
transcript view are removed.

The fork retains the composer Subagents dropdown and its status, provider/model, reasoning, and
branch metadata. The dropdown and timeline links both navigate to the same child-thread routes, so
the child transcript is a normal conversation without a second panel or composer. Provider-native
child lifecycle events remain authoritative, while T3-owned child threads keep the V2 persistence,
notification, and recovery behavior.

Implementation evidence: orchestrationV2 contracts and server layers; ChatView, Sidebar,
ThreadRelationshipsControl, ComposerSubagents, V2LifecycleRow, V2ItemInspector, rightPanelStore,
and session-logic.

Recorded validation: focused V2 projection, provider-adapter, lineage-control, timeline, sidebar,
and composer tests; vp check; vp run typecheck; and an isolated paired web-app smoke test that
loaded a V2 thread route, confirmed the Agents/right-transcript surface is absent, and confirmed the
composer rendered. The preview client's accessibility snapshot and click calls failed after the app
loaded, so child-route interaction and lineage-control behavior were covered by code/tests only; the
smoke evidence used DOM evaluation and server responses.

Last updated: 2026-10-04

### DL019 — Desktop backend continuity and owned process-tree cleanup

Closing the last desktop window leaves Electron's main process and local T3 backend running. A native OS tray or status item keeps the app discoverable, opens or activates the window, and shows a live count of threads with active foreground or background work. Launching the desktop app again activates or recreates the window against that existing backend, while explicit quit terminates the backend through the owned lifecycle and update and signal shutdown paths retain their normal cleanup semantics. Explicit quit now ignores activation while shutdown is underway and destroys renderer windows before backend cleanup, adopting upstream's cleanup ordering without changing the fork's last-window policy. This is intentionally process-local continuity rather than a detached provider daemon: an Electron main-process crash or OS-forced termination still ends the backend.

The desktop main process owns one shared bearer session per local backend for the window, tray polling, and parallel WSL connections. This preserves upstream's replacement of stale desktop sessions without allowing a tray refresh or another renderer to revoke the active window's login. Closing and reopening the window reuses the backend's shared session.

Tray refresh waits for backend readiness before requesting a bearer session or thread counts. An early tray token exchange therefore cannot delay renderer authentication. Failed count requests retain the last known count and recover without replacing the shared session.

On Windows, the standalone service launcher terminates the known server PID and its descendants during stop, update, and fatal shutdown. This prevents launcher-owned provider processes from surviving as orphaned Codex writers without scanning or killing processes by name; direct-child signaling remains the fallback when process-tree termination fails.

**Implementation evidence:** desktop lifecycle and native tray/status-item modules and their focused tests under `apps/desktop/src/`, dedicated macOS template-image assets and packaging checks, `apps/server/src/orchestration/http.ts`, `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, `packages/contracts/src/environmentHttp.ts`, and `apps/server/src/serviceLauncher.ts`.

Updater-controlled exits retain upstream's synchronous window destruction before process shutdown. Closing the last UI window still keeps the fork's tray-backed backend available.

**Recorded validation:** focused desktop tray, lifecycle, running-count projection, packaging, and Windows process-tree integration tests; Windows notification-area runtime verification of the count, open, and graceful quit controls; `vp check`; `vp run typecheck`; and `git diff --check`. The 2026-09-01 merge-focused desktop and server suites reran tray continuity and running-count behavior with upstream activity-liveness fixes.

The 2026-09-05 authentication fix passed 48 focused tests, including a tray integration regression that fails with the original independent token exchange. An isolated Windows Electron run verified automatic login, continued authentication after tray polling, and closing and reopening the window against the same backend. A separate browser paired successfully with cookie authentication. `vp check` and `vp run typecheck` passed.

The 2026-10-02 readiness guard passed 12 focused tests. An isolated source startup exchanged its token after readiness and completed 16 count polls without errors. Renderer bearer acquisition took 0.21 ms. The final packaged startup completed 17 count polls without errors. The integration test also verifies recovery from a failed count request without another token exchange.

**Last updated:** 2026-09-05

### DL020 — Provider turns survive stalled checkpoint captures

Starting a provider turn no longer waits indefinitely when the previous turn has finished but its post-turn checkpoint capture is still pending. In that state, the server dispatches the next turn without a checkpoint mutation so authentication failures and stalled captures cannot freeze the thread. Active provider mutations retain their existing brief handoff grace period. This behavior applies to every provider through the shared command reactor.

Checkpoint workers also reclaim expired leases while the server remains running and retry transient capture errors up to three times. Their lease heartbeat and five-minute deadline cover both the workspace gate wait and capture execution. Cancellation releases an acquired gate ticket, and a long gate wait cannot let the same job occupy both capture workers through lease expiry. Structured lifecycle logs identify the job, thread, boundary, durable attempt, execution attempt, result, and recovery action so capture failures can be diagnosed without inspecting SQLite.

Provider intents are processed in order per thread. An unanswered interrupt or approval response in one thread no longer blocks other threads. Codex transport and notification-consumer failures terminate the affected session with visible error and exit events, reject pending requests, and stop the owned subprocess. Recoverable provider turn errors still permit session reuse, and failed agent work is never replayed automatically.

Compaction replay waits for each provider send to finish before resuming the next queued message. Stopping during a blocked send therefore reports the remaining queued message as canceled instead of silently dispatching it later.

**Implementation evidence:** `apps/server/src/checkpointing/CheckpointCaptureQueue.ts` and its tests, `apps/server/src/orchestration/Layers/{CheckpointReactor,ProviderCommandReactor}.ts`, the provider command tests, `apps/server/src/provider/Layers/{CodexSessionRuntime,CodexAdapter}.ts` and their regressions, and `packages/effect-codex-app-server/src/{client,protocol}.ts` and protocol tests.

**Recorded validation:** 82 provider command tests, six capture queue tests, and 159 Codex protocol/client/runtime/adapter tests passed. Deterministic regressions cover gate-wait lease renewal and timeout, post-timeout ticket release, cross-thread progress with same-thread command ordering, compaction replay cancellation, and visible transport failures. `vp check`, `vp run typecheck`, and `git diff --check` passed.

**Last updated:** 2026-09-30

### DL021 — Clickable Windows file links in thread Markdown

Thread Markdown preserves local Windows drive-letter destinations through URL sanitization and resolves the encoded backslash form emitted by the Markdown parser. These links open through the existing file chip behavior instead of rendering as inert anchors. Sanitization also preserves validated `t3-context` references in both link and image destinations so structured context records render as chips instead of inert Markdown. This coexists with upstream workspace images, spaced-folder command-click handling, contrast-aware annotation styling, and full-path link tooltips.

**Implementation evidence:** `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/ChatMarkdown.test.tsx`, `apps/web/src/components/chat/MessagesTimeline.test.tsx`, and `apps/web/src/markdown-links.test.ts`.

**Recorded validation:** focused Markdown link tests, ChatMarkdown and MessagesTimeline context-reference tests, an isolated paired web-client pass with a drive-letter link in both user and assistant messages, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-09-23

### DL023 – Scoped V2 MCP thread and project tools

The upstream singular V2 MCP toolkit remains authoritative. Provider callers resolve to project or
global scope per project setting: Git-backed projects default to project scope, non-Git projects
default to global scope, and every project can override the default. Project-scoped callers can
operate only inside their project; global callers may read, launch, send, and wait across projects,
with the upstream user-attached cross-project read exception preserved.

t3_thread_wait accepts up to eight targets and applies the upstream one-hour cap. t3_thread_send can
select a provider instance and model, and rejects a provider caller that targets its own thread.
create_threads remains a project-scoped provider tool and is not available to management-key callers.
Management-key discovery and invocation is limited to the reviewed orchestrator_capabilities,
t3_thread**, and t3_project** allowlist (with create_threads excluded); all other MCP toolkits retain
upstream discovery and capability rules.

Implementation evidence: McpInvocationContext, McpHttpServer, McpToolScope, threadAccess, the
orchestrator/project/thread toolkits, orchestratorMcp and managementApiKeys contracts, and
ProjectMcpToolScopeSettings.

Recorded validation: focused MCP scope, management-key filtering, provider self-send, cross-project
authorization, model/provider selection, wait-target, and toolkit registration tests; 129 focused
native-session/MCP/checkpoint tests; vp check; and vp run typecheck.

Project-scoped search applies its project predicate before ranking and limiting results, so a recent
thread from another project cannot hide a matching local result.

Last updated: 2026-10-04

### DL026 — Per-instance API gateway model catalogs

Codex and Claude provider instances can declare a compatible API gateway in the add-instance
wizard or provider settings. The server fetches Codex, Anthropic, or OpenAI model catalogs with a
provider-environment credential reference, normalizes model context and reasoning metadata, and
caches the last successful response per instance. The gateway form accepts opaque API keys in a
password field and stores them through the sensitive provider environment path under a generated
safe variable name. It also migrates invalid key values written by the earlier variable-name field.
Gateway settings respect the environment's read-only session controls.
Catalog failure retains cached or provider models and does not make an otherwise healthy provider
unavailable.

Gateway and manual metadata compose with upstream's custom-model display-name and option-descriptor editor.

Models carry usable context, theoretical maximum context, maximum output, and metadata provenance.
Every visible model accepts manual display, context, output, and reasoning overrides; manual values
win over gateway and harness metadata. The Models information tooltip shows every known value
without inventing missing metadata.

The gateway controls remain part of upstream's split provider settings editor. Existing opaque
credentials survive settings refreshes, and the UI replaces or removes a stored key without
round-tripping its value through provider snapshots.

Codex gateway controls apply to CLI-managed instances. Managed ChatGPT accounts use upstream authentication and hide gateway controls that cannot affect those accounts. Saved gateway configuration remains available for CLI-managed instances.

The add-instance wizard keeps its title, description, and step tabs pinned above a single scrollable
step body, with the Back and confirm buttons pinned below, so the long Config step scrolls inside the
dialog instead of overflowing past the viewport.

Codex receives a managed Responses API provider, Codex-format `model_catalog_json`, selected
reasoning effort, and a per-model `model_context_window`. Its adapter normalizes the configured
gateway path to end in `/v1`, so users can enter the gateway origin without knowing Codex's URL
joining rules. Claude receives its gateway environment, gateway discovery flag, selected reasoning
effort, and a context-aware plain or `[1m]` model ID. Metadata with no matching harness control
remains informational. Authoritative gateway inventories also keep gateway-discovered custom rows
available to the chat model picker, while stale manual rows remain scoped to the current settings.
The generated Codex catalog is deep-merged from the configured Codex JSON, or the instance's
native `models_cache.json` when no Codex JSON is configured, with explicit custom models appended
by slug so nested native metadata is retained.

**Implementation evidence:** `packages/contracts/src/{model,server,settings}.ts`,
`apps/server/src/provider/GatewayModelCatalog.ts`,
`apps/server/src/provider/{Drivers,Layers}/`,
`apps/server/src/textGeneration/ClaudeTextGeneration.ts`,
`apps/web/src/components/settings/{AddProviderInstanceDialog,CompatibleApiGatewaySection,CustomModelMetadataDialog,ProviderInstanceCard,ProviderModelsSection,ProviderSettingsPanel}.tsx`,
and `apps/web/src/components/settings/providerModelDetails.ts`.

**Recorded validation:** focused gateway parsing and cache tests, Codex and Claude provider relay
tests, settings and server contract tests, provider-settings component tests, model-picker regression
tests for authoritative gateway rows, `vp check`, `vp run typecheck`, and integrated web verification
of gateway configuration, custom model metadata, and model-detail tooltips. The 2026-09-03
add-instance dialog scroll fix was verified in a browser at 1000x720 and 390x700 with the gateway
section expanded.

**Last updated:** 2026-09-21

### DL027 — Remote editor links select the server account

Remote open-in-editor targets advertise the operating-system account running the
server when it can be resolved. The web client includes that account inside the
VS Code Remote-SSH authority (`ssh-remote+user@host`), so Windows clients do not
fall back to their local username. Windows AD accounts use `USERDOMAIN\\username`
only when `USERDNSDOMAIN` confirms a domain and the name is not the local
computer/workgroup. Local accounts use the unqualified username. Systems that
cannot resolve an account omit the field and retain host-only behavior.
Desktop-managed SSH aliases remain authoritative and continue to omit the
advertised account. The username field is optional for compatibility with older
server configurations.

**Implementation evidence:** `packages/shared/src/hostProcess.ts`,
`packages/contracts/src/editor.ts`, `apps/server/src/environment/RemoteOpenTargets.ts`,
`apps/web/src/remoteOpen.ts`, `apps/web/src/components/chat/OpenInPicker.tsx`, and
`apps/desktop/src/electron/ElectronShell.test.ts`.

**Recorded validation:** focused contract, server target discovery, web remote-open,
and Electron shell tests.

**Last updated:** 2026-09-01

### DL028 — Isolated Windows x64 GitHub releases

The fork has a manual Windows x64 release workflow that uses GitHub-hosted runners. It builds the
Linux CLI archive required by the packaged WSL backend, produces an unsigned NSIS installer, and
publishes only the Windows installer and updater files to this repository's GitHub Releases.
It does not publish packages, build other desktop platforms, deploy hosted services, announce the
release, or invoke another release workflow.

The packaged local server remains available. Remote server self-update to the fork version is not
available because this workflow deliberately does not publish a matching `t3` package.

**Implementation evidence:** `.github/workflows/fork-windows-release.yml`.

The Windows job also uses upstream's corrected Visual Studio Spectre runtime component identifier when installing packaging prerequisites. The WSL archive handoff follows the current desktop artifact builder's `--wsl-runtime` interface.

**Recorded validation:** workflow YAML and handoff contract checks, focused desktop artifact
tests, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-09-26

### DL029 — Selectable sidebar thread ordering

When Working is disabled, the web and desktop sidebar offers **Manual** ordering by default and **Last input** ordering in General settings. Manual preserves saved positions and sidebar drag actions. Last input ignores saved active-order keys and promotes threads on user messages while retaining creation and un-settle lifecycle anchors. Switching modes preserves saved keys. While upstream Working is enabled, the Inbox uses return-priority order, placing threads that most recently returned for attention first. Disabling Working restores the saved Manual or Last input preference. Active-row manual reordering is unavailable while Working is enabled; pin actions, shelf moves, and dragging into splits remain available. Dragging a row into the conversation creates or extends a split in either mode, without a separate grip control. Initial split creation reuses the existing pane-drop overlay to show its right-side placement. The dragged row uses the same row appearance in a document-level drag overlay, preserving sidebar scroll position and avoiding clipping behind the conversation.

**Implementation evidence:** `packages/contracts/src/settings.ts`, `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/Sidebar.logic.ts`, and their focused tests.

**Recorded validation:** focused settings, sidebar sorting, pointer lifecycle, and split target tests; isolated browser checks for initial split creation, pane placement, manual reordering, Last input mode, and settings persistence; `vp check`; and `vp run typecheck`.

**Last updated:** 2026-10-02

### DL030 — Isolated macOS GitHub releases

The fork has a manual macOS release workflow that uses GitHub-hosted `macos-15` runners. It builds
unsigned, non-notarized DMG and ZIP artifacts for Apple Silicon and Intel, merges the per-arch
updater manifests into one `latest-mac.yml`, and publishes only those files to this repository's
GitHub Releases. Like DL028 it does not publish packages, build other platforms, or deploy hosted
services, and it does not publish a matching `t3` package.

Because the build is unsigned, Gatekeeper blocks first launch until the user opens the app via
right-click → Open or clears the quarantine attribute, and in-app auto-update does not work. Signing
and notarization need a Developer ID certificate (`CSC_LINK`/`CSC_KEY_PASSWORD`), an App Store
Connect API key (`APPLE_API_KEY*`), and for passkeys an `APPLE_TEAM_ID` plus provisioning profile;
the workflow can adopt upstream's `--signed` path once those secrets exist.

**Implementation evidence:** `.github/workflows/fork-macos-release.yml`.

**Recorded validation:** actionlint, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-09-03

### DL031 — Durable management API keys for external MCP clients

Management-key HTTP requests use request-time authorization and relay endpoint resolution, including one credential renewal retry for an invalid credential. Insufficient-scope errors do not retry. Bearer and DPoP requests explicitly omit browser cookies so a stale session cookie cannot override the selected environment credential; cookie-authenticated requests continue to include cookies. Regression coverage checks the credential modes and reproduces the collision against the server.

Integrations settings can select any known machine and create environment-wide management API keys
there with named read-only, thread-orchestration, or custom scopes and explicit expiration. The
selected environment's prepared HTTP connection supplies its own URL and
cookie, bearer, or DPoP authorization, so listing and every mutation reach the chosen machine. A
disconnected machine stays selectable but cannot mutate keys. The secret is revealed only once
after creation or rotation; list rows retain only a display prefix and key metadata, while rotation
invalidates the previous secret and revocation takes effect immediately.

Direct pairing preserves the scopes carried by the pairing credential instead of always requesting
the standard client scope set. Standard links therefore remain constrained, while an administrative
startup link can manage keys on the paired machine without inventing or broadening privileges.

The existing HTTP MCP endpoint accepts these persistent keys alongside ephemeral provider-session
credentials and enforces one management scope per thread operation. Management callers can select
projects, create and message threads, read and wait on threads, and list models. Runtime permissions
belong to threads rather than keys: external creation uses the normal T3 Code default and messages
keep the target thread's current mode. Management keys cannot use preview automation or environment
administration. State-changing
orchestration events retain the key ID and name without retaining its secret or display prefix.

Effect MCP registers tools server-wide, so `tools/list` still advertises preview tool names to a
management client. Preview handlers require a provider-session principal and reject every management
key call. Keeping that authorization check at the handler boundary avoids a transport-level response
rewriter and matches the MCP plan's fallback for server-wide registration.

The settings surface includes copyable generic JSON HTTP MCP and Codex `bearer_token_env_var`
examples, and keeps the one-time secret in transient dialog state only. Persistence stores a SHA-256
hash of each token, checks expiration and revocation on authentication, throttles last-used writes,
and coordinates concurrent resolution, rotation, and revocation without exposing two active
secrets.

**Implementation evidence:** `apps/web/src/components/settings/ManagementApiKeysSettings.tsx`,
`apps/web/src/components/settings/ManagementApiKeysSettings.logic.ts`,
`apps/web/src/environments/managementApiKeys.ts`,
`packages/client-runtime/src/state/managementApiKeys.ts`,
`packages/client-runtime/src/connection/onboarding.ts`,
`apps/server/src/auth/ManagementApiKeyService.ts`,
`apps/server/src/persistence/ManagementApiKeys.ts`,
`apps/server/src/persistence/Migrations/050_ManagementApiKeys.ts`,
`apps/server/src/persistence/Migrations/052_RemoveManagementApiKeyRuntimeModes.ts`,
`apps/server/src/mcp/McpInvocationContext.ts`, `apps/server/src/mcp/McpHttpServer.ts`,
`apps/server/src/mcp/toolkits/threads/handlers.ts`, `packages/contracts/src/managementApiKeys.ts`,
and `docs/user/thread-tools.md`.

**Recorded validation:** focused persistence, migration, service concurrency and interruption,
administration HTTP, MCP authentication, provider-session regression, scope enforcement, preview
denial, thread-handler, attribution, contracts, and settings UI tests. An isolated paired web client
created, rotated, and revoked a key; a real external MCP client used it to list models and threads,
create, read, message, and wait on a Codex thread; the old rotated token and revoked replacement both
returned the generic 401 response. Database and log inspection confirmed hash-only persistence and
key-ID/name-only event attribution. A two-server web pass paired an administrative remote
environment, created separate keys on the primary and remote machines, showed each machine's own
MCP endpoint, kept the two lists isolated while switching the selector, and revoked both disposable
keys. Repository-wide `vp check` and `vp run typecheck` passed.

**Last updated:** 2026-09-05

### DL032 – Automatic resume after native provider usage limits

Auto-resume remains enabled by default for all threads and can be turned off under Settings ->
General -> Auto-resume after usage limits. V2 persists the failed run's exact provider reset time
and recovery identity. A shared five-second scheduler checks durable failed-thread candidates; it
does not wait for a provider-specific timer. A candidate is dispatched only when its reset time has
passed, the thread is still eligible, and its persisted run/message identity is unchanged. The
scheduler's tick therefore adds at most five seconds of timing slack, while the provider reset time
controls the earliest continuation.

The fork retains its explicit continuation prompt, which asks the provider to resume only incomplete
work, inspect the current workspace and subagent state, repair partial operations, and avoid
repeating completed work or expanding scope. Restart, archive, settle, a newer turn, or a changed
provider selection invalidates the saved recovery. The one-hour wait and scheduler behavior are
upstream V2 behavior; the default and prompt are the fork's surviving differences.

Implementation evidence: UsageLimitRecoveryWorker, Orchestrator, Scheduler, orchestrationV2/settings
contracts, serverSettings, and SettingsPanels.

Recorded validation: focused usage-limit parsing, scheduler, recovery-worker, V2 runtime, and
server-settings tests; vp check; vp run typecheck; and the isolated migration/startup smoke.

Last updated: 2026-10-04

### DL033 — Model search within the selected group

The shared web and desktop model picker searches only the selected provider instance or Favorites.
An All providers group searches across available instances. The group rail stays visible during
search, and switching groups preserves the query. Provider and continuation restrictions still apply.

**Implementation evidence:** `apps/web/src/components/chat/ModelPickerContent.tsx`,
`ModelPickerSidebar.tsx`, and `ModelPickerContent.test.ts`.

**Last updated:** 2026-09-07

### DL034 — Prompt suggestion ghost text from the agent's own turn

When the client setting `enablePromptSuggestion` is on (default off), Codex and Claude sessions
receive a standing instruction to end each reply with a tagged one-line proposal for the user's
next prompt. The agent writes it from its real context (repository instructions, memory, and the
conversation so far); no separate model call, provider session, or transcript summary is made.
`ProviderRuntimeIngestion` withholds any partial or open tag from streamed and buffered deltas,
strips every tagged block at completion, and carries the sanitized text as `suggestion` on the
assistant message through the decider, projector, client reducer, and SQLite projection
(migration `062`). The web composer shows it as ghost text once the thread is idle and the
composer is empty; Tab accepts it, typing dismisses it for that message, and a new message or
thread resets it. Cursor, Grok, OpenCode, and Antigravity receive no instruction. Mobile has no
toggle or ghost text. An optional `promptSuggestionInstructions` setting appends extra guidance to
the built-in instruction. Both settings live under Settings → General → Prompt suggestion.
They persist on the client and travel with turn requests to local or remote environments;
server settings do not control them. Codex applies the submitting client's preference per
turn. Claude pins the preference and instructions at its first session start in a thread,
preserving them across session recovery and restarts. Each viewing client independently
controls whether suggestions appear in its composer. See [prompt suggestions](docs/user/composer.md#prompt-suggestions).

Suggestion-less streaming updates retain message and timeline-row identity. Clearing an existing suggestion still updates the message metadata.

**Implementation evidence:** `packages/shared/src/promptSuggestion.ts`,
`packages/contracts/src/{settings,orchestration,provider}.ts`,
`apps/server/src/provider/Layers/{ProviderService,CodexSessionRuntime,ClaudeAdapter}.ts`,
`apps/server/src/provider/CodexDeveloperInstructions.ts`,
`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`,
`apps/server/src/orchestration/{decider,projector}.ts`,
`apps/server/src/persistence/Migrations/062_ProjectionThreadMessageSuggestions.ts`,
`packages/client-runtime/src/state/threadReducer.ts`,
`apps/web/src/promptSuggestion.logic.ts`, `apps/web/src/components/chat/usePromptSuggestion.ts`,
`apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/ComposerPromptEditor.tsx`,
and `apps/web/src/components/settings/SettingsPanels.tsx`.

**Last updated:** 2026-10-02

### DL035 — Manual-only release actions

The fork's release workflow runs only through an explicit `workflow_dispatch` request. Automatic tag and scheduled triggers are disabled, so releases are started manually with the selected preview, stable, or nightly channel.

**Implementation evidence:** `.github/workflows/release.yml`.

**Recorded validation:** workflow trigger inspection and focused YAML review.

**Last updated:** 2026-09-24

### DL036 — Ignore route tests during web route generation

The web router ignores `.test.ts` files in the routes directory so route tests do not produce missing-Route warnings during builds.

**Implementation evidence:** `apps/web/vite.config.ts`.

**Recorded validation:** web build, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-09-28

### DL037 — Forgiving CLIProxyAPI usage and redemption

Hub requests pause after management HTTP 401/403 until the URL or management key changes. Optional malformed quota fields and array entries no longer discard usable windows; Codex plan fallback accepts both field names and relative reset times. Credit redemption sends only a stable `redeem_request_id`, preserves known outcomes, and reports unfamiliar successful responses as accepted before refreshing usage. T3 leaves cooldown clearing to CPA instead of resetting the entire account. Web, desktop, and mobile display the accepted result.

**Implementation evidence:** `apps/server/src/usage/cliproxyApi.ts`, its focused tests, `packages/contracts/src/providerUsageLimits.ts`, and the web/mobile usage components.

**Recorded validation:** 26 focused adapter and source-refresh tests, `vp check`, `vp run typecheck`, and `vp run lint:mobile`. Integrated web verification is blocked by `PreviewAutomationNoAvailableHostError`; native mobile verification is blocked by disabled device access.

**Last updated:** 2026-09-30

### DL038 — Precise transcript identity checks on Windows

Session scanning skips parsing completed history from matching file metadata only when the inode is present and a safe JavaScript integer. Windows can omit inode values or round NTFS file IDs, making a replacement file look unchanged. The scanner validates these completed files with a separate bounded budget so retries can import the next batch of new histories. Both budgets allow 100 transcripts, 4 GiB, and 100,000 records per scan. Replacements also consume the new-history budget. Completed files beyond the validation budget remain conservatively skipped; identical-metadata replacements there are not guaranteed to be discovered on retries.

**Implementation evidence:** `apps/server/src/project/AgentSessionScanner.ts`, its replacement identity tests, and bounded retry tests in `AgentSessionImporter.test.ts`.

**Recorded validation:** 100 scanner/importer tests, including 201-history imports across three attempts with missing or unsafe inodes. Server typecheck, scoped lint, and formatting passed.

**Last updated:** 2026-10-02

### DL039 — Graceful Codex shutdown before Windows tree termination

Codex app-server sessions and probes drain their protocol writer and close stdin before waiting up to three seconds for exit. Output readers stay open during cleanup; an unresponsive app-server still receives a forced termination. Transport failures use the same stdin-first shutdown.

On Windows, the service launcher requests shutdown over its existing IPC channel and allows five seconds for server cleanup before `taskkill /T /F`. Native desktop backends use stdin EOF to request server shutdown and allow four seconds before the process spawner forces termination, within the existing five-second desktop stop budget. Linux, macOS, and WSL retain their signal-based server shutdown. Older servers that do not recognize these requests still reach the forced fallback.

This is an experiment to reduce abrupt termination. It does not establish or fix the cause of the intermittent zero-handle Codex processes stuck in Windows termination.

**Implementation evidence:** `packages/effect-codex-app-server/src/{client,protocol}.ts`, `apps/server/src/{serviceLauncher,server}.ts`, `apps/server/src/process/ParentProcessShutdown.ts`, `apps/server/src/provider/Layers/CodexSessionRuntime.ts`, and `apps/desktop/src/backend/DesktopBackendManager.ts`.

**Recorded validation:** Focused client, protocol, launcher, parent shutdown, Codex runtime/probe, and desktop lifecycle tests passed. Three isolated installed-Codex initialization/EOF cycles exited with code 0. One full server shutdown through launcher IPC and two through desktop stdin EOF exited with code 0 in 2.7–2.8 seconds. `vp check` and `vp run typecheck` passed.

**Last updated:** 2026-10-02

### DL040 — Live project-scoped working tree diffs

Diff previews for an active project are authorized against that registered project root, including projects outside the server startup directory. The web client no longer substitutes the environment startup repository when the selected project is outside that directory.

While DiffPanel is open, working-tree and branch previews refresh once per second. The panel's Git-status-based scope selection is upstream behavior.

**Implementation evidence:** `apps/server/src/review/ReviewService.ts`, `apps/server/src/ws.ts`, and `packages/client-runtime/src/state/review.ts`.

**Recorded validation:** focused review-service authorization and DiffPanel store tests; controlled-browser reproduction and verification with an external registered project, including a file modification made while the panel remained open; `vp check`; and `vp run typecheck`.

**Last updated:** 2026-09-05

### DL041 — Project-selecting local thread shortcut

The configured Chat: New Local shortcut opens the command palette's "New thread in..." project picker instead of immediately creating a draft in the active project. The same shortcut enters that picker when the command palette already has focus, while the active-project quick-create remains available as a separate palette action.

**Implementation evidence:** `apps/web/src/routes/_chat.tsx`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/CommandPalette.logic.ts`, and `apps/web/src/commandPaletteBus.ts`.

**Recorded validation:** focused command-palette and keybinding tests; controlled-browser verification from the main app and an already-focused palette; `vp check`; `vp run typecheck`; and `git diff --check`.

**Last updated:** 2026-07-29

### DL042 – Native conversation adoption during V2 cutover

V2 imports valid saved Codex and Claude native conversation cursors into a durable provider-thread
projection. Legacy threads with a matching provider runtime cursor now retain a strong native thread
reference, so the first V2 turn resumes the provider conversation instead of sending the migrated
transcript as a new conversation. Unknown providers, malformed cursors, and instance mismatches keep
the safe context-handoff path.

Implementation evidence: LegacyV1ThreadImporter, Core V2 cutover migration, provider-thread
projection, Codex and Claude V2 adapters, and the legacy importer/cutover tests.

Last updated: 2026-10-04

### DL043 — Codex compaction context usage restored

Compaction timeline rows retain the Codex context-window counts by pairing the
latest token-usage snapshots with the native compaction item, so the completed
row shows the before and after token totals.

**Implementation evidence:** `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`
and its focused replay test.

**Recorded validation:** focused Codex compaction replay. The full Codex adapter
suite retains one unrelated pre-existing 180-second timeout in its
background-command test.

**Last updated:** 2026-10-05

## Merge History

This is an append-only historical decision record. It provides context for integrations but never, by itself, establishes an ongoing fork divergence; use the current Divergence Log for that determination.

Don't forget to update the `base` tag after each merge to track the latest shared base with upstream/main.

### 2026-10-07 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `dba09c35aa` (fork) and `079e4bccdc` (upstream/main)

- Used upstream's stable Effect 4 APIs, dependency catalog, service layout, WebSocket transport, VCS driver, provider registry, MCP authorization, and desktop/web client contracts as the integration base. Reapplied the fork's split workspaces, durable sidecar checkpoints, Windows path/process handling, desktop tray continuity, preview control safeguards, prompt preservation, and provider recovery behavior where the APIs still exist.
- Preserved the deployed fork migration ledger through `067_CoreV2Cutover`. Incoming webhook migrations are assigned to `068_ScheduledTaskWebhooks` and `069_WebhookRelayDeliveries`; fork checkpoint migrations and reconciliation history remain authoritative. The duplicate upstream title-state migration is not loaded under its upstream number.
- Removed stale fork-only copies of server modules that upstream deleted or refactored, while retaining fork-only checkpointing and migration files. Restored the running-thread-count and worktree-list RPC contracts and kept MCP wait/capability results compatible with the current schemas.
- Validation: `vp run typecheck`, `vp check`, focused checkpoint/migration/timeline/desktop tests (191 passing), and a conflict-marker scan passed. The full unrestricted test suite and live client verification were not run as part of this synchronization pass.

### 2026-10-04 — Orchestrator V2 sync

**Merge commit:** `8f5699626c824140598278078461819e6a17152d`
**Parents:** `579b37a9f7b5f9b8ad3cd6056c3ce9ab675cdbf8` (fork) and `fed41fa88bb27cb4325cb208d571393850bc63c2` (upstream/main)

- Adopted upstream Orchestrator V2 as the runtime and cut over legacy V1 execution, while retaining the
  legacy importer needed to hydrate existing thread shells and messages. The migration smoke imported
  331 thread shells and 619 messages and reached a listening server.
- Preserved exact native Codex and Claude conversation identities when transcript and workspace checks
  succeed, including legacy V1 threads with a valid saved provider cursor. Preserved the fork's sidecar checkpoint capture/restore and non-Git handling, while leaving
  provider conversation rollback/fork and direct active steering to V2's upstream behavior.
- Adopted child-thread routes and lineage controls, removed the Agents/right-transcript panel, and
  retained the composer subagent dropdown and metadata.
- Adopted the V2 usage-limit scheduler and Cursor SDK. Auto-resume stays enabled by default globally,
  with the fork continuation prompt.
- Combined MCP behavior with the project/global scope policy, management-key allowlist, cross-project
  restrictions, eight-target wait, one-hour cap, provider/model send selection, and self-send guard.
- Restored upstream Git command gating and sanitized remote failure classification, and made ACP
  process-tree cleanup one-shot after successful explicit termination while retaining finalizer retry
  after failure. Project-scoped thread search now filters before SQL LIMIT.
- On Windows, the first V2 desktop launch seeds `%APPDATA%\t3code-v2\Local State` from the default `t3code` profile before falling back to `T3 Code (Alpha)`. Upstream prefers `T3 Code (Alpha)`. In the fork, Electron loaded the safe-storage key from `t3code` before switching `userData`, so desktop secrets such as `connection-catalog.json` were encrypted with that key. On machines with both profiles, the upstream order copied an unused key. The renderer then could not decrypt its connection catalog and never connected to the local backend, which showed as no threads and a disconnected settings page.

**Validation**: vp check, vp run typecheck, vp run lint:mobile, focused MCP/native-session/checkpoint,
ACP, VCS, search, and migration suites, web tests, desktop smoke, and a Windows x64 NSIS artifact
build. The preview accessibility snapshot and click endpoints failed after the app loaded, so live
browser evidence used DOM evaluation. Device tools were disabled, so native mobile verification
could not run. The unrestricted full suite was stopped after unrelated long-running Windows VCS and
provider tests; the affected VCS file passed all 120 runnable tests.

### 2026-10-02 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `1a906fc529` (fork) and `b33eda1399` (upstream/main)

- Preserved deployed fork migrations through `065` and appended upstream's per-thread auto-settle migration at `066`. The isolated clone helper verifies known historical ledger aliases against reconciliation markers and repaired schema, prunes child records before parents, and clears copied runtime jobs and management credentials.
- Working uses upstream return-priority Inbox ordering. Disabling Working restores the saved Manual or Last input preference. Visible split panes remain accessible in collapsed shelves, and the scratch hero retains machine context.
- Retained provider gateway metadata, launch recovery, prompt suggestions, automatic resume, compact usage meters, subagent transcript isolation, and durable checkpoints while adopting upstream title refinement, deferred worktree input, paced reasoning, current Claude SDK, and native Codex `thread/revert`.
- Combined upstream tracked worktree setup, cancellation, submodules, and scoped fetches with the fork's shared dispatcher and cleanup fences. Restored upstream review-index isolation, per-file preview limits and complete stats, plus carriage-return progress and callbacks after stored-output truncation. Thread deletion completes worktree cleanup even when client navigation fails. Retained UI styles use the upstream component variants and named theme utilities required by the new lint rules.
- Retained sidecar checkpoint navigation and provider cursor guards. Mid-turn placeholders do not replace durable capture jobs; completed and aborted turns retain their assistant-message identity. Coalesced workspace refresh runs after receipt delivery. Dedicated worktrees follow an agent-renamed branch even when the saved branch was a temporary placeholder; temporary current checkouts and shared worktrees remain guarded.
- Session scanning uses metadata-only completion skipping only when the file inode is present and a safe JavaScript integer. Separate bounded validation of completed histories preserves retry progress with missing or imprecise Windows inodes. The standalone runtime uses exact bigint file identity when numeric metadata cannot reject a hard link to itself.
- Checkpoint sidecars inherit workspace line-ending settings, and empty nested workspaces survive restore cleanup. Batched allowlisted config reads preserve effective precedence and avoid repeated Windows cleanup for missing settings. Streaming updates preserve unchanged message identity when no prompt suggestion exists. Timestamp fallbacks follow upstream for threads without valid user input. Integration settings retain both Devices and fork management keys.
- Tray refresh waits for backend readiness before authentication and count requests. The shared renderer/tray session remains stable through count-request failures.
- Restored stale orphan-session recovery while retaining live-turn and background-work guards. Screenshot cleanup shares one completion promise. Windows-built npm platform archives preserve executable modes, symlinks, and file contents. Root tests load the terminal's WebAssembly assets; standalone CI scripts run with Node's test runner.
- Server-router and HTTP MCP fixtures use native HTTP clients because Windows can assign ports that Fetch blocks. A listening server on port `6566` returned HTTP 200 through `node:http`, while Fetch rejected it before connecting.
- Migration smoke used a read-only snapshot of the live database. The pruned isolated copy passed SQLite integrity and foreign-key checks and applied `066`. Authenticated Codex and Claude turns wrote files, persisted replies, and produced ready checkpoints; settle/unsettle and archive/unarchive roundtrips passed. Claude's completed checkpoint recovered after a development-watcher restart.
- An authenticated web client rendered the migrated history and checkpoint diff. A real Codex follow-up moved into Working and returned to the top of the Inbox after completion while the saved ordering remained Manual. Further web checks verified saved Last input across Working toggles, split-pane attach/detach, terminal splitting, and Devices alongside management keys. A final packaged Browser-panel pass could not proceed because open/navigation calls timed out. Native mobile verification remained unavailable because device access was disabled.
- `vp check` and `vp run typecheck` passed on the final source. Windows x64 desktop and unsigned NSIS packaging passed, including validation of 46 payload files and 16 native sidecars. The isolated packaged app authenticated after backend readiness, completed all 17 observed tray polls, and advanced onboarding with no renderer page or request errors. All captured app and child processes stopped. The mobile static-check wrapper passed while skipping unavailable SwiftLint, ktlint, and detekt binaries.
- The final full suite recorded 1,403 passing files, 11 skipped files, and two failing files. It recorded 18,771 passing tests, 148 skipped tests, and two loopback connection timeouts. Both failed cases passed unchanged reruns. The affected files then passed all 201 server tests and 19 MCP tests with the native HTTP fixtures. Each original failed case also passed 10 serial reruns. The exact cause of the original TCP timeouts remains unproven. The original failure logs remain available.

### 2026-09-23 — Audit of September sync regressions

- Restored saved split-group colors and accessible group descriptions in both compact and card rows of the default sidebar, using the existing light/dark theme tint.
- Restored dropped desktop IPC contracts for recording input, file paths, notification badges, and local-environment controls. Bearer-token requests preserve the selected environment, and iframe keyboard cleanup preserves its CDP session while retaining bounded cleanup.
- Reconnected split-pane header and panel ownership, active-pane focus, the split workspace route, the default sidebar's split actions and saved manual order, subagent transcripts, checkpoint composer controls, prompt suggestion text, and model-picker selection. Providers without conversation rollback can reach the confirmed files-only checkpoint path. Saved split layouts survive partial environment bootstrap. Shared client state again negotiates reasoning subscriptions, clears obsolete page-loading state, retains completed turns across batched starts, and invalidates worktree lists after revision changes.
- Restored the status-aware subagent dropdown in the composer context strip, linking each run to its transcript and keeping the subagent and branch controls grouped at narrow widths.
- Restored machine context below the empty-state heading and compact subscription meters in the active thread header.
- Restored default-sidebar split membership details, including peer-pane names in row tooltips, active panes in collapsed shelves, and split-thread drag payloads without intercepting ordinary file or sortable-row drags.
- Preserved legacy message-event decoding, upstream project-monogram validation, and the fork's attachment limits. These repairs reconcile the retained consumers and tests rather than introducing a new migration history.
- Restored Git branch/path disambiguation, scoped remote fetches, worktree progress and cancellation callbacks, and complete file metadata for review diffs. Checkpoint file restoration now checks workspace ownership on the active navigation path rather than relying on an obsolete reactor command.
- Reconnected WebSocket worktree turn creation to the bootstrap workflow, restoring scoped fetches, setup progress, cancellation, and failure cleanup. Worktree preparation waits for its completion response without the ordinary command's ten-second deadline. Ordinary thread commands continue through the shared dispatcher with their existing deadline.
- Restored Claude usage-limit retry metadata, subagent tool-input isolation, and prompt-suggestion instructions while retaining upstream's subagent narration filtering. Provider ingestion again handles diff checks separately from turn settlement, ignores diffs for non-running turns, and persists reasoning with separate parent and subagent identities. Failed turns retain their error state when the provider session remains reusable and checkpoint capture succeeds.
- Restored Codex permission-approval request mapping and preserved native usage-limit reset metadata needed for automatic resume while still suppressing duplicate generic limit errors.
- Restored Codex image attachments as path-based `localImage` inputs so large files do not expand `turn/start` requests; the adapter and runtime tests cover the restored contract.
- Reconciled test fixtures with current service layers and APIs. Packaging removals were audited separately: the dedicated WSL runtime archive and explicit Claude executable resolution supersede the older staging and SDK-patch mechanisms.

### 2026-09-22 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `7ff559cb7c` (fork) and `76cc9b08f1` (upstream/main)

- Restored upstream preview recording input contracts and the recording bridge's `onInput` subscription lost during the merge. The existing desktop recording manager and web compositor depend on these definitions; their omission prevented desktop bundling.

- The 2026-09-23 follow-up declares the missing activity-table alias in the user-input lookup introduced by post-sync reconciliation. This restores answer and dismissal commands without a migration; regression coverage checks pending, resolved, and missing requests through the SQLite-backed query service.

- Preserved the fork's durable checkpoints, sidecar navigation, split workspaces, Windows portability, provider credentials, preview safeguards, and compact subscription meters while absorbing the upstream web, mobile, desktop, provider, pull-request, and release updates.
- Kept the deployed fork migration ledger authoritative. Upstream's colliding migrations `052`–`053` are appended as `063`–`064`; `065_ReconcileBranchPullRequestHistory` idempotently repairs databases that recorded the old fork suggestion migration at ID 58 before startup.
- Validation for this sync includes the read-only migration collision audit (SQLite integrity, duplicate-ID, ledger-name, and required-column checks), conflict-marker scan, and `vp check`. The follow-up reconciliation restores the fork's worktree-list compatibility APIs alongside upstream worktree-setup subscriptions, adds the missing projection-checkpoint repository layer, and reconciles the Node-only server/provider contracts, title-state/user-append contracts, and provider streaming/runtime types. `vp check`, focused server/client-runtime/SSH typechecks, and the non-test server typecheck pass; the repository typecheck remains affected by unrelated upstream web contract drift and a resource-killed mobile worker. No live server restart was performed against the known stale worktree database.

### 2026-09-16 — Merge `feat/prompt-suggestion` into `main`

**Merge commit:** this merge commit
**Parents:** `0283c3542` (fork main) and `1717a5dc9` (feature branch)

- Reapplied the prompt suggestion feature after the upstream sync while preserving the current scoped settings model, inline context records, prompt-history navigation, pull-request autocomplete, and expanded MCP tool availability.
- Kept upstream migration `058_ProjectionThreadBranchPullRequest` and the fork's idempotent `062_ProjectionThreadMessageSuggestions`; discarded only the obsolete feature-branch migration files that reused ID `058`.
- Preserved prompt suggestion preferences as client-local settings and reconciled Codex per-turn delivery and Claude per-thread pinning with the current provider-service recovery flow.
- Recomposed fork auto-resume and task-title recovery with upstream's repository-backed ingestion: auto-resume reads the latest user-message id and thread shell instead of hydrating full thread detail, and the latest-task activity query now returns the `subagentId` column its decoder expects.

### 2026-09-14 — Post-merge migration repair (follow-up to the 2026-09-13 merge)

The 2026-09-13 merge assigned upstream migrations `058`–`061` after the fork's deployed history, but the deployed fork database had already recorded a different `058` (`ProjectionThreadMessageSuggestions`, from the `feat/prompt-suggestion` line) under the same ID. The migrator tracks applied migrations by ID, so upstream's `058_ProjectionThreadBranchPullRequest` was silently skipped against the live database and the server crashed on startup (`no such column: branch_pull_request_json`).

Repairs:

- **Deployed database:** backed up (`VACUUM INTO`), then the skipped migration's DDL was applied by hand (`ALTER TABLE projection_threads ADD COLUMN branch_pull_request_json TEXT`) and the `effect_sql_migrations` record for ID 58 was corrected to `ProjectionThreadBranchPullRequest`.
- **Code:** the fork's suggestion column migration was re-added as `062_ProjectionThreadMessageSuggestions` (import + manifest entry in `Migrations.ts`). It is deliberately idempotent — it checks for the column before altering — because deployed databases already carry `suggestion` from the old 058, while fresh databases (including upstream lineage) do not.
- Validation: focused `vp test run` on `062_ProjectionThreadMessageSuggestions.test.ts` (2 passing: column added from empty, idempotent re-run), full `vp check` / `vp run typecheck` / web + server builds, service restart with HTTP 200 on `127.0.0.1:21013`, build stamp newer than HEAD.

### 2026-09-13 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `12efb3f9c6ef0fb4e42cab26b4489bb7a7e2792e` (fork) and `0e0ddaeedf30698bec131caf040a8e8d7b2e3f37` (upstream/main)

- Preserved durable fork checkpoints, sidecar recovery, undo/redo/jump navigation, split workspaces, Windows path handling, gateway catalogs, subscription meters, zrok sharing, management keys, and automatic usage-limit resume. Upstream's conversation rewind maps to the existing checkpoint jump flow with file restoration disabled when requested.
- Adopted upstream thread notifications and sounds, inline previews and attachment chips, context-paste attachments, default diff state, provider account-home usage limits, screen-reader headings, linked pull-request collections, active-order persistence, and saved-environment disabling. Incoming migrations `058`–`061` were assigned after the fork's deployed migration history.
- Combined provider lifecycle and adapter fixes: Claude retains fork rate-limit and terminal-reason handling alongside upstream outcome classification; Claude resolves packaged Windows binaries with the gateway model catalog; Codex keeps text-generation and MCP app-server capabilities. Provider runtime ingestion keeps fork assistant/proposed-plan correlation helpers.
- Merged sidebar, subagent, right-panel, and composer changes while retaining split-pane ownership, checkpoint actions, and environment-scoped controls. Reconciled the upstream `conversation.revert` request with fork checkpoint controls and kept message context in turn-start queries.
- Validation: `vp check`, serial `vp run --concurrency-limit 1 typecheck`, focused AgentSessionImporter and OrchestrationReactor tests, and web/server typechecks passed. The full CheckpointReactor suite was started but exceeded the local command window; no browser verification was run.

### 2026-09-05 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `e6d4fa2ce8b0f7c8d6c597b221ab6e70882bcb8e` (fork) and `2fb99a7a664faf045f1884f38c620016b34874cb` (upstream/main)

- Preserved deployed fork migrations `036` through `052`. Migration `053` reconciles overlapping upstream history; incoming project defaults, auto-pull, settlement timestamp repair, and project icons run as `054` through `057`.
- Retained durable sidecar checkpoints, navigation barriers, child transcript correlation, split workspaces, API gateway catalogs, management keys, and automatic usage-limit resume. Sidecar summaries now use upstream numstat parsing, including the repository-HEAD fallback.
- Adopted upstream Usage and Limits, provider authentication and catalog changes, Antigravity presentation, async-question retention, replay and settlement fixes, panel lifecycle, custom-model editing, citations, and media updates. Compact fork subscription meters remain alongside Limits. Retired DL024 and DL025 because upstream now provides progressive Usage results and service-file durability.
- Restored upstream primary-turn pull-request refresh while retaining fork branch-specific status refresh. Removed the unreachable legacy revert handler; normalized checkpoint commands run through the durable navigation reactor.
- Retained the patched Claude SDK at `0.3.170` and handled newer wire values structurally. Fixed ACP completion draining exposed by the merged Grok tests. Management-key requests now share upstream request-time DPoP renewal and relay endpoint refresh; read-only sessions cannot edit gateways.
- Preserved desktop tray-backed backend lifetime and preview reattachment safeguards while adopting synchronous updater window destruction, pinned debugger capture retries, and Linux browser-secret packaging. Windows release setup uses upstream's Spectre runtime component. Timeline status indicators use the app tooltip component.
- Validation passed provider/contracts, web, mobile, client-runtime, desktop, packaging, backend, and migration tests. Final focused checkpoint and navigation suites passed 59 tests, checkpoint storage passed 24, and migration reconciliation/repair passed 3. Repository-wide `vp check` and `vp run typecheck` passed. `vp run lint:mobile` completed, but SwiftLint, ktlint, and detekt were unavailable and skipped.
- An isolated copy of the real database migrated through `057`, passed SQLite integrity checks, and retained all 52 existing threads. A paired web client completed two real Codex turns, loaded the correct sidecar diff, opened and detached split panes, loaded Usage costs and rendered Limits at desktop and phone widths, persisted and removed a gateway setting, and created and revoked a temporary management key. A narrowed session-response fixture verified read-only gateway controls block interaction. Files-only checkpoint restore changed the isolated project's file to its earlier contents while preserving chat history. No browser exceptions occurred during these final flows. Native mobile runtime verification was unavailable because this Linux host has no Android SDK or emulator and cannot run iOS Simulator.

### 2026-09-01 — Merge upstream/main into main

**Merge commit:** this merge commit
**Parents:** `51acfe8775be51bf6937c2c998e5770bd52e2515` (fork) and `0bfb6df34b26dfe0162db6c09dca00bc8c5a5ec4` (upstream/main)

The integration made these semantic choices:

- **Providers and credentials:** preserved the fork's patched and pinned Claude SDK, Claude and Codex subscription usage, per-instance API gateway catalogs, normalized Codex Responses URL, and opaque gateway credential UI. Adopted upstream OpenCode ownership, child approvals and stops, provider catalog refresh, project-default model handling, and the split provider settings editor.
- **Checkpoints and subagents:** retained durable checkpoint navigation, child-scoped transcripts, receiver-only Codex routing, parent transcript isolation, and bounded root collaboration waits. Adopted upstream Codex child model lookup and kept newer child settings and reroutes authoritative.
- **Thread lifecycle and remote access:** retained zrok sharing, environment-scoped thread tools, tray-backed desktop continuity, and liveness-aware running-thread counts. Centralized the post-create deletion drain in `ThreadCommandDispatcher`, so every thread creation waits for older deletion cleanup before bootstrap work continues.
- **Preview:** retained debugger reattachment, bounded native control work, stale-host quarantine, URL readiness, `LoadFailed` propagation, and same-tab recovery while adopting upstream preview recording, popup, battery, and agent-created-thread fixes.
- **Web and mobile:** adopted upstream generalized web attachments, mobile upload and file sharing, native image, PDF, and video preview, environment themes, composer and activity presentation changes, settings search, pull-request filters, and Expo 57 with React Native 0.86.3. Fork split workspaces, checkpoint controls, subagent navigation, and Windows file links remain composed with those changes.
- **Authentication, analytics, and performance:** adopted upstream DPoP diagnostics and replay handling, connected-client analytics, bounded activity payload loading, reduced full tool-output hydration, lower idle CPU use, and provider event-listener cleanup.
- **Post-merge QA:** merge-focused validation passed 403 server and contracts tests, 548 web tests, 26 mobile tests, and scoped lint and typechecks. Repository-wide `vp check`, `vp run typecheck`, and `vp run lint:mobile` passed. An isolated paired web client verified the merged draft composer, provider subscription and gateway settings, opaque-secret handling, and environment themes through Chrome CDP with no browser exceptions. Representative mobile emulator verification was unavailable because this Linux host has no Android SDK or ADB and cannot run iOS Simulator tooling.

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
