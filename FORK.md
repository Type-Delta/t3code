# t3code Fork

This fork keeps the Windows reliability, durable checkpointing, and workspace capabilities that are still not supplied by the shared base.

Git repository cache keys use Node's native `realpath` so Windows long paths and their 8.3 aliases share one VCS snapshot and refresh history.

## Upstream sync — 2026-08-08

Merged upstream `8101cd044911c7dc2a2adf7c7a9ba7962abf57b6` into the fork while preserving durable checkpoints, existing-worktree selection, split workspaces, and read-only subagent transcripts. The integration adopts upstream native agent/workflow observability as the lifecycle authority and keeps transcript events agent-scoped outside the parent timeline: native child message completions finalize their matching transcript, persisted child rows enable transcript access from the matching agent row, transcript headers use native lifecycle metadata, child rows stay out of web and mobile parent feeds, and bounded thread-detail reads retain subagent identity. Paginated clients persist the requested user-turn width so checkpoint navigation refreshes the complete loaded window. The latest upstream additions provide main-window desktop zoom controls, a consolidated mobile thread-settings sheet, and cross-environment provider transcript usage reporting; composite in-memory keys use printable source escapes so repository tools continue treating their TypeScript as text. Fork migrations remain `36`–`40`; upstream pinning and pagination migrations are assigned `41`–`43` to preserve deployed fork databases.

## Previous upstream sync — 2026-08-01

Merged upstream `0ad91b6e7fc1fcb6d5f4bc736d84c337e912bc62` into the fork without dropping checkpoint navigation, split workspaces, existing-worktree selection, preview recovery, provider usage, Claude Windows packaging, or stale-mutation retry/drafts. The integration adopts upstream title regeneration, branch-drift handling, sidebar search and shell loading, preview PiP/runtime identities, telemetry/compression, and VCS cache invalidation. Migration IDs `33`–`35` remain upstream-compatible; checkpoint migrations now occupy `36`–`38`, and idempotent migration `39` reconciles both previously deployed histories.

## Divergence Log

This is a current-state record only. Each entry describes a surviving difference between `HEAD` and the latest shared base, determined with `git merge-base HEAD upstream/main` (currently `8101cd044911c7dc2a2adf7c7a9ba7962abf57b6`). A feature adopted from upstream is not a divergence merely because it was involved in a merge.

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

Automation also retries dynamic click/type targets, re-resolves click targets after cursor movement, keeps snapshots coherent across DOM mutations, bounds guest viewport work, and quarantines an unresponsive host so later requests can fail over and recover without reconnecting the environment.

Browser development's single-origin Vite proxy behavior, including shared and Tailscale origins, is upstream behavior and is not a fork divergence. Explicit IPv4 loopback URLs remain only for the desktop renderer and local-preview automation, where they protect Windows local routing.

**Implementation evidence:** `apps/desktop/src/preview/Manager.ts`, `apps/web/src/components/preview/`, `apps/server/src/mcp/PreviewAutomationBroker.ts`, `apps/server/src/mcp/toolkits/preview/handlers.ts`, and `packages/contracts/src/previewAutomation.ts`.

**Recorded validation:** focused desktop preview, web readiness/viewport, broker, MCP, and dev-runner coverage (including stale-host failover and `LoadFailed`); `vp check` and `vp run typecheck`.

**Last updated:** 2026-07-27

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

Terminal provider events end the workspace mutation for their exact turn before local VCS status refresh, but the next provider turn remains behind a capture-finalization barrier until that full user/assistant/tool-call turn has been checkpointed and projected. Capture and mutation intervals are serialized instead of preempting one another, preventing normal provider turns from producing `workspace-mutated` checkpoints. Aborted turns and provider-turn handoff ownership retain the same exact-owner completion semantics. A stale lease with no active provider turn is recovered automatically; if ownership is ambiguous, the provider turn continues without checkpoint navigation instead of blocking the conversation. Failed mutation-blocked text messages expose a retry action that reuses the persisted user message when available or recreates an optimistic-only message without duplicating it in the UI.

Capture jobs that first lose the workspace-mutation race or fail can be re-enqueued for the same logical turn boundary. The durable row is reset to pending and remains the single job for its snapshot, while pending, running, and ready jobs are still deduplicated.

**Implementation evidence:** `apps/server/src/checkpointing/`, `apps/server/src/persistence/Migrations/{036_CheckpointDurableState,037_CheckpointLegacyMigration,038_CheckpointCaptureProviderMetadata,039_ReconcileCheckpointAndTitleHistory}.ts`, `apps/server/src/orchestration/`, `packages/contracts/src/orchestration.ts`, `packages/client-runtime/src/`, and checkpoint-aware web composer and chat components including `ThreadErrorBanner.tsx`.

**Recorded validation:** migration and durability regression matrices, sidecar characterization (including unborn repositories, submodules, and linked worktrees), orchestration integration including serialized full-turn capture, deterministic post-capture lease release, stale-lease recovery, non-blocking checkpoint degradation, and persisted-message retry, Windows isolation slices, full `vp test`, `vp check`, `vp run typecheck`, and `git diff --check`.

**Last updated:** 2026-08-01

### DL008 — Persistent multi-thread split workspaces

The fork supports up to four visible thread panes in an equal full-height grid, with focused-pane routing, a shared toolbar, one right panel, and controlled ownership of global keyboard, preview, and composer behavior. Panes can be opened or detached from the sidebar, safely reconcile draft promotion/archive/deletion, and animate layout changes without leaving stale portals or listeners.

Split membership is persisted as multiple ordered local groups with active state and stable group colors. Selecting any member restores its group; both sidebar versions preserve group tinting, support pane and thread drag placement, and show complete left/right drop intent. The group tint is textured with an inline desaturated SVG grain so the color-coded row reads as a surface rather than a flat slab. The grain is a masked pseudo-element rather than a second background layer, because background layers cannot carry their own mask and unmasked grain also covers the gradient's faded tail, flattening the row back into a uniform slab; the overlay shares the tint's fade axis and stops short of its extent so the texture is gone before the color is. Group hues carry a hue-dependent chroma: a flat chroma across the wheel does not read as a flat saturation, since yellow-green renders at full strength while red and blue are gamut-clipped, so chroma eases down around yellow-green. Rows supply only the hue and that chroma, leaving the stylesheet to compose per-theme lightness and strength — light mode takes a deeper, less translucent tint because the translucency that reads as a clear band on the near-black sidebar washes out against zinc-50. Sidebar V2 also names the other panes in each grouped thread's details tooltip. Right-panel ownership remains useful when focus moves to a pane with no surface of its own. Integration with Sidebar V2 keeps displayed panes visible when settled or snoozed shelves are collapsed and preserves split actions in its context menu.

**Implementation evidence:** `apps/web/src/splitViewStore.ts`, `apps/web/src/splitViewDrag.ts`, `apps/web/src/components/{SplitThreadWorkspace,SplitPaneDropHint,Sidebar,SidebarV2,RightPanelTabs,ChatView}.tsx`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/index.css`, `apps/web/src/hooks/useThreadActions.ts`, and the chat routes.

**Recorded validation:** split-store, sidebar, workspace, right-panel, and drag/drop tests; web typecheck; `vp check`; `git diff --check`; and Electron runtime verification of context menus, routing, pane layout, persistent groups, and right-panel attribution.

**Last updated:** 2026-07-30

### DL012 — Prompt preservation during draft promotion

The initial optimistic prompt remains visible while a draft route becomes its server-backed thread. Chat timeline state resets only when the scoped thread identity changes, so the projected `thread.message-sent` event replaces the prompt instead of briefly erasing it.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx`.

**Recorded validation:** `vp check`, `vp run typecheck`, and the repository `dev` startup smoke test.

**Last updated:** 2026-07-22

### DL013 — Codex availability through catalog and turn failures

Codex model and skill discovery is bounded, optional catalog enrichment after a healthy authenticated app-server session starts. Catalog failure cannot replace that healthy snapshot with a provider-status error.

App-server errors are classified by scope: non-retryable turn errors remain visible on the turn while the session stays available for a follow-up message; actual process or transport failure still marks the session unavailable.

A missing Codex rollout is treated as a recoverable stale resume cursor, so T3 falls back to a fresh provider thread instead of stopping a newly created thread.

**Implementation evidence:** `apps/server/src/provider/Layers/{CodexProvider,CodexSessionRuntime,CodexAdapter}.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, and `packages/contracts/src/providerRuntime.ts`.

**Recorded validation:** focused Codex adapter and provider-runtime ingestion tests, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-08-03

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
width. Claude output without a parent Task identifier remains in the main transcript.

Projection migration `040_ProjectionSubagentIds` adds durable correlation columns for messages and
activities. Upstream native `task.*` events remain the sole Codex lifecycle and Agents-panel status
authority; child message deltas use the same native agent/thread identity only to populate the
separate transcript. Child thread, turn, name, token, and plan chatter cannot mutate the parent.
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

**Last updated:** 2026-08-08

## Merge History

This is an append-only historical decision record. It provides context for integrations but never, by itself, establishes an ongoing fork divergence; use the current Divergence Log for that determination.

Don't forget to update the `base` tag after each merge to track the latest shared base with upstream/main.

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
