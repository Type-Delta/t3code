# t3code Fork

This fork keeps the Windows reliability, durable checkpointing, and workspace capabilities that are still not supplied by the shared base.

Git repository cache keys use Node's native `realpath` so Windows long paths and their 8.3 aliases share one VCS snapshot and refresh history.

## Divergence Log

### DL001 — Claude Windows resolver and artifact safeguards

Windows Claude commands are resolved before the Agent SDK starts a session. The resolver follows npm launcher shims to the installed native executable or JavaScript entry point and preserves explicit executable paths. Provider snapshots and DevTools expose sanitized resolver diagnostics; startup provenance identifies installed web artifacts without exposing command output or environment values.

When a PATH-based provider executable disappears before startup, the backend resolves it again and retries once. Under AgentScope, a stale cached bare command can report exit 127 rather than ENOENT; that shell-level case remains documented as a known limitation because treating every 127 as missing could replay a real command failure. Claude waits for the SDK initialization handshake before reporting ready and caches a replacement path only after successful initialization. Codex, Cursor, Grok, local OpenCode, and Claude/Codex metadata commands apply the retry at process launch; Antigravity reacquires its PATH installation and harness together. Explicit executable paths and managed Antigravity installations never use this fallback. Failures after a process starts do not replay agent work.

Older failed Claude startups could persist a generated session ID before its transcript existed. If Claude explicitly rejects that resume ID and the cursor records zero turns with no assistant checkpoint or turn boundaries, the adapter recreates the session with the same ID once before accepting a turn. Missing sessions with recorded history remain errors.

Each Claude startup attempt owns a separate prompt queue. Closing a failed SDK query does not cancel its pending input read, so sharing a queue across retries could lose the replacement session's first prompt. Failed attempts now close their query and shut down their queue before recovery.

The current server bundle includes the SDK and uses the configured Claude installation. Upstream packaging removes unused SDK native optional dependencies; the older SDK patch and lockfile-free patch-pinning workaround are no longer active. Windows and WSL ship separate runtime archives, each with its own platform dependencies.

**Implementation evidence:** `packages/provider-core/src/server/executableRecovery.ts`, the Claude and Codex adapter runtimes, `packages/provider-acp/src/server/AcpSessionRuntime.ts`, `packages/provider-opencode/src/server/OpenCodeRuntime.ts`, `apps/server/src/provider/Drivers/{ClaudeExecutable,AntigravityDriver}.ts`, `apps/server/src/provider/ClaudeProvider.ts`, `packages/provider-core/src/server/snapshotProbe.ts`, `scripts/build-desktop-artifact.ts`, and `pnpm-workspace.yaml`.

**Recorded validation:** 352 focused tests passed across 11 affected suites on Windows, with 14 existing platform skips. Recovery tests cover synchronous and asynchronous Claude startup failures, replacement-path caching, one retry, explicit-path exclusions, real child-process launches, and Antigravity executable/harness reacquisition. The stale Cursor rollback assertion now checks the current navigation contract. Codex metadata tests were run without the inherited `T3CODE_CODEX_LAUNCH_ARGS` override. The OpenCode localhost output fixture timed out in combined runs and passed isolated reruns. `vp check`, `vp run typecheck`, and `git diff --check` passed. Earlier integrations verified initialization and packaging.

The empty-session follow-up initially verified initialization only. A later real-SDK probe reproduced the failed query stealing the replacement's first prompt; the fixed probe delivered that prompt to the replacement and received native `system/init`. All 159 Claude adapter tests passed, including prompt delivery after missing-session and stale-executable recovery.

The executable recovery primitive now lives in `packages/provider-core/src/server/executableRecovery.ts`, with all provider app-server, ACP, OpenCode, Claude/Codex text-generation, and Claude SDK launches retrying stale bare PATH resolutions once. The failed cached PATH entry is evicted before the retry, and Claude passes the configured bare command separately from its resolved SDK path so Windows recovery remains reachable. Claude also recreates a missing resume session only when its provider thread has no persisted turns; gateway model metadata now drives Claude model IDs and effort in both orchestration and text generation.

**Last updated:** 2026-10-15

### DL002 — Machine context beside the empty-state hero

The upstream draft hero remains the empty-state headline. The fork adds `On <machine-name>` as its supporting line and uses the same machine label in the existing non-draft empty state. The project already appears in the hero headline, so the supporting line identifies the environment instead of repeating the project name.

Projectless drafts retain upstream's scratch-project picker beside the machine context.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`, and `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`.

**Recorded validation:** `vp test apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-10-02

### DL004 — Preview navigation and automation hardening

The fork hardens desktop collaborative preview control. A debugger detach invalidates the cached Chrome DevTools Protocol attachment, URL-bearing `preview_open` waits for new and reused tab readiness, and a committed `LoadFailed` state is returned as an automation failure rather than a successful load.

Automation also retries dynamic click/type targets, re-resolves click targets after cursor movement, keeps snapshots coherent across DOM mutations, bounds guest viewport work, and quarantines an unresponsive host so later requests can fail over and recover without reconnecting the environment. Hung native control work now times out below the broker deadline and detaches only its cached debugger session, so the same tab can reattach instead of retaining a blocked control permit.

The broker acknowledges receipt from the live in-process server browser before starting page work. A slow navigation or snapshot can therefore time out without being mistaken for a disconnected host, while a stream that never acknowledges is still quarantined and failed over. Timeout cleanup also preserves hosts whose completion arrived after the deadline. The former web automation host and its unused client request consumer/readiness helpers were removed after upstream stopped mounting that host; desktop does not acknowledge broker requests.

Browser development's single-origin Vite proxy behavior, including shared and Tailscale origins, is upstream behavior and is not a fork divergence. Explicit IPv4 loopback URLs remain only for the desktop renderer and local-preview automation, where they protect Windows local routing.

**Implementation evidence:** `apps/desktop/src/preview/Manager.ts`, `apps/server/src/preview/ServerBrowser.ts`, `apps/server/src/mcp/PreviewAutomationBroker.ts`, `apps/server/src/mcp/toolkits/preview/handlers.ts`, and `packages/contracts/src/previewAutomation.ts`.

Upstream owns the pinned Electron debugger reference and bounded screenshot retries. Those fixes compose with the fork's stale-session detection and control deadlines; a screenshot that succeeds on retry keeps its debugger session. Upstream #17525 reattaches a tab as soon as Chromium drops its debugger; the fork keeps the lazy detach of a stale or hung session next to it, so both paths reach the same fresh attachment.

**Recorded validation:** focused desktop preview, web readiness/viewport, broker, MCP, and dev-runner coverage, including same-tab recovery from stalled CDP and capture work, stale-host failover, acknowledged slow-operation recovery, timeout cleanup races, and `LoadFailed`; `vp check` and `vp run typecheck`. An isolated Electron run reproduced a full-load timeout against a page with a never-ending image request, then confirmed same-tab evaluate and snapshot remained available. The 2026-09-01 merge-focused suites reran the affected desktop, server, and web preview recovery paths.

**Last updated:** 2026-10-20

### DL005 — Windows portability in CLI fixtures, Git, and tests

The server pins `node-pty` to the version targeted by its Windows terminal patch. Installer and
CLI archive staging resolve dependencies without the repository lockfile; a version range could
select a newer beta and fail installation because the version-specific patch is unused.

The shared fixture launcher dispatches by shebang: shell fixtures use Git for Windows `sh.exe` and Node fixtures use the current Node executable. These dispatch rules and the remaining platform-specific test expectations compose with upstream's broader Windows fixture portability fixes.

Git fixtures set repository-local `core.autocrlf=false` when exact LF content is part of an assertion, preserving the tested reset and restore behavior across Windows installations.

Git worktree comparison uses native realpaths and case-folding on Windows so Git for Windows path canonicalization cannot mistake the main checkout for another worktree.

Server-router and HTTP MCP fixtures use native HTTP clients with OS-assigned loopback ports. Windows can assign port `6566`, which Fetch blocks before connecting. Explicit compression checks retain Fetch and its automatic decompression. The fixtures retain real HTTP requests and their status, body, and session assertions.

**Implementation evidence:** `packages/shared/src/shell.ts`, `apps/server/src/git/GitManager.ts`, their remaining fork-specific fixture and canonical-path tests, `apps/server/src/mcp/McpHttpServer.test.ts`, `packages/tailscale/src/tailscale.test.ts`, and `oxlint-plugin-t3code/test/utils.ts`.

**Recorded validation:** targeted Cursor/Grok ACP, provider-runtime ingestion, checkpoint, Git PR-selector, desktop, relay, workspace, Tailscale, and oxlint suites on Windows; `vp check` and `vp run typecheck`.

**Last updated:** 2026-10-02

### DL006 — Durable sidecar checkpoints and recoverable navigation

V2 turn checkpoints live in a private bare-Git sidecar repository below the server's checkpoints directory, addressed by opaque `t3-sidecar:v1:` locators bound to the repository and worktree. Capture, restore, and diff never write refs, objects, or an index into the project repository. One sidecar repository serves a repository's linked worktrees, and capture, restore, and maintenance are serialized per sidecar. Capture records the project HEAD in the snapshot so upstream's pull, merge, and rebase filtering keeps working between sidecar boundaries. A scope id too long for a snapshot id is hashed.

Checkpoints captured between the 2026-10-08 redo and this re-port were written as `refs/t3/orchestration-v2/checkpoints/*` refs in the project repository. They still load, diff, and restore: each boundary lookup tries its sidecar snapshot first, then that in-repo ref. New boundaries always go to the sidecar. Upstream's checkpoint rollback locking and the per-workspace capture lock are unchanged.

A rollback leaves the forward checkpoints ready so the user can redo back to them. Upstream #21804 retires those stale checkpoints during rollback; the fork keeps redo, adapts upstream's rollback tests to expect them ready, and removes upstream's unused rollback `staleCheckpoints` query and `CheckpointService.deleteStaleRefs`. The lower `CheckpointStore.deleteCheckpointRefs` chain is kept to match upstream.

Upstream #14892 marks a checkpoint `missing` when its workspace folder is ignored by the repository. Sidecar captures enforce the same rule in `SidecarCheckpointRepository.ts`: an ignored workspace is rejected only when Git lists no tracked or re-included files in it (`CheckpointStore.test.ts` covers rejection, a force-tracked file, and a negated rule).

Sidecar capture runs Git with `-C` at the worktree root, so paths stay worktree-relative when the server's own working directory is inside the project, as when T3 Code develops itself. An uninitialized submodule, an empty folder at a tracked gitlink, is captured as the gitlink commit the project index records rather than failing the whole capture.

Legacy checkpoint tables remain for schema compatibility. V2 navigation uses upstream's checkpoint rollback with the fork's retained forward checkpoints for redo; no server code reads the former capture-job or navigation-journal tables.

Persistence keeps canonical upstream migrations `001`–`069` in `effect_sql_migrations` and fork migrations `001`–`015` in the independent `fork_sql_migrations` ledger. Startup takes a rollback copy before converting known historical fork rows by name, repairs missing upstream migrations below the recorded high-water mark, and runs the guarded fork migrations. Historical fork records at `059`–`067` can remain in the fork ledger without suppressing lower fork migrations.

The old ID-58 prompt-suggestion collision is repaired by canonical upstream migration `048_ProjectionThreadBranchPullRequest` and fork migration `009_ProjectionThreadMessageSuggestions`. This preserves both columns even when the original numeric ledger skipped the branch column. Startup also removes the legacy checkpoint table's foreign key to `projection_turns` before upstream `063_DropUnusedV1Projections` drops that table. Incoming upstream migrations `065`–`069` retain their canonical IDs, including webhook deduplication and message-search schema.

The isolated migration helper verifies known historical ledger aliases against their repaired schema before accepting them. Codex and Claude checkpoint navigation fork the saved native conversation at the selected provider-turn boundary instead of destructively truncating it. Captures retain the native source, and older checkpoints acquire it before their first navigation. Redo restores the original terminal run and root-node states as well as files and conversation context. Restoration events reach clients but do not repeat live completion handling, usage metrics, settlement, or automatic retries. A new message after undo abandons the previous forward branch.

Terminal provider events end the workspace mutation for their exact turn and settle the run before local VCS status refresh or checkpoint capture. Checkpoint capture runs as a follow-up effect and records the checkpoint when it succeeds, so a slow or unavailable VCS backend cannot leave the conversation showing as active. Capture and mutation intervals are serialized instead of preempting one another, preventing normal provider turns from producing `workspace-mutated` checkpoints. A capture waiting for active work releases the worktree gate, so provider turns in other threads can join the same mutation cohort and share its next stable checkpoint boundary; an already-running capture and checkpoint navigation remain exclusive. Aborted turns and provider-turn handoff ownership retain the same exact-owner completion semantics. A stale lease with no active provider turn is recovered automatically; if ownership is ambiguous, the provider turn continues without checkpoint navigation instead of blocking the conversation. Failed mutation-blocked text messages expose a retry action that reuses the persisted user message when available or recreates an optimistic-only message without duplicating it in the UI.

Durable completion retains the provider placeholder assistant-message identity, including interrupted turns. Workspace status refresh runs through a coalesced background worker after capture receipts, so slow Git inspection cannot delay turn completion.

Sidecar repositories inherit the workspace's `core.autocrlf` and `core.eol` settings so restoring a checkpoint preserves its line endings under Windows Git defaults. Empty nested workspaces remain present after checkpoint cleanup.

Batched allowlisted config reads preserve Git includes and global/local precedence. The sidecar skips unchanged writes and clears removed line-ending overrides only when present. This avoids repeated Windows process cleanup after normal missing-setting queries.

Capture jobs that first lose the workspace-mutation race or fail can be re-enqueued for the same logical turn boundary. The durable row is reset to pending and remains the single job for its snapshot, while pending, running, and ready jobs are still deduplicated.

Capture keeps one private index per worktree inside the sidecar repository and passes every tracked or unignored path to `git update-index`, so only files whose stat changed since the last capture are hashed again, as for the project's own index. Paths the workspace no longer has leave that index, and a tracked file that was deleted or replaced by a folder is captured as gone. The index starts over empty when `.gitattributes` or the sidecar's copied core settings change, after any failed Git command, and before sidecar gc, so each tree matches one built from an empty index. A second pass over the same index rehashes anything edited during capture and rejects the capture when the trees differ. Deleted and renamed files restore correctly without changing the user's Git index.

Standalone checkpoint slash commands dispatch locally even when a provider does not expose plan-mode controls. Client event reduction recomputes checkpoint navigation with the same helper as the server. A captured checkpoint, provider cursor change, or rollback updates undo/redo availability immediately. The client cache schema invalidates older snapshots whose navigation metadata never updated. Navigation menus react when availability changes, and matching failures release the pending state. Redo refreshes bounded transcript state for every observer, including clients opened while undone. Authoritative history-page distances preserve expanded and inherited history without searching indefinitely for discarded entries; late history responses cannot revive rolled-back rows.

**Implementation evidence:** `packages/shared/src/orchestrationV2CheckpointNavigation.ts`, `apps/server/src/checkpointing/{SidecarCheckpointRepository,CheckpointRepositoryIdentity,CheckpointStore}.ts`, `apps/server/src/orchestration-v2/CheckpointService.ts`, `apps/server/src/persistence/Migrations/{036_CheckpointDurableState,037_CheckpointLegacyMigration,038_CheckpointCaptureProviderMetadata,039_ReconcileCheckpointAndTitleHistory,046_ReconcileUpstream41History,053_ReconcileUpstream47History}.ts`, `apps/server/src/persistence/ForkMigrations.ts`, and their tests. `CheckpointStore.test.ts` holds the sidecar characterization suite, including a comparison of reused-index trees against empty-index `git add` trees across tracked, untracked, deleted, binary, symlinked, ignored, file-to-folder, mode, and attribute changes; `apps/server/src/orchestration-v2/CheckpointService.sidecar.test.ts` runs turns against real temporary repositories and asserts that `git for-each-ref refs/t3` stays empty, that restore works, and that an in-repo checkpoint from the redo period still restores.

**Recorded validation:** migration and durability regression matrices, sidecar characterization (including unborn repositories, submodules, and linked worktrees), orchestration integration including serialized full-turn capture, deterministic post-capture lease release, stale-lease recovery, non-blocking checkpoint degradation, and persisted-message retry, Windows isolation slices, upstream-ledger reconciliation through migration `047`, full `vp test`, `vp check`, `vp run typecheck`, and `git diff --check`. The 2026-09-01 merge-focused server tests also covered checkpoint projection and reactor behavior after upstream bounded activity hydration and provider event-lifecycle fixes were integrated. The deletion/rename regression and all 15 sidecar checkpoint tests passed on Windows with the user-index preservation assertion.

The 2026-10-02 config repair passed all 28 checkpoint-store tests, including exact restored bytes, conditional includes, repeated values, and removed overrides. A single-file capture benchmark measured 3.2–3.4 seconds against 4.6–4.8 seconds for the original fork implementation.

The 2026-10-16 reused capture index was measured on a copy of a 28k-file workspace: the first capture took 10.4 seconds and later ones 0.60 seconds, against 34–41 seconds per capture for the empty-index `git add` capture, which spent most of its time matching each path against every pathspec. Both methods produced identical trees for the same workspace.

The 2026-10-05 completion split passed the focused RunExecutionService, CheckpointCaptureService, CheckpointService, runtime-layer, recovery, projection, `vp check`, and `vp run typecheck` checks. Settled provider turns now remain settled when follow-up checkpoint capture is slow or unavailable.

The 2026-10-15 re-port restored the 16 sidecar characterization tests the redo dropped (32 checkpoint-store tests pass), plus sidecar authored-path filtering, long scope ids, and the V2 real-repository suite.

**Last updated:** 2026-10-25

### DL008 — Persistent multi-thread split workspaces

Sidebar pointer drags use the same thread-row component inside and outside the sidebar, rendered as a full-row `DragOverlay`; upstream's `ThreadContextDragGhost` is removed in its favour. The opaque overlay follows the pointer across panels while the hidden source row preserves its gap until release or cancellation. Split-pane drops suppress composer context-drop highlighting and dispatch, and pointer capture keeps release cleanup reliable across panel boundaries.

Collapsed Working, snoozed, and settled shelves keep all displayed split panes visible in the sidebar.

The fork supports up to ten visible thread panes in five columns and two rows. Panes fill columns at full height until a sixth pane opens the lower row. A full-height pane accepts a thread above or below it in its outer quarters; its middle half accepts left/right placement while fewer than five columns exist. A stacked column accepts only left/right placement while fewer than five columns exist. Left/right drop hints cover the full destination column, including both rows of a stacked column. Blocked drop areas show no hint. Split layouts retain focused-pane routing, a shared toolbar, one right panel, and controlled ownership of global keyboard, preview, and composer behavior. The right-panel toggle reflects the shared split layout and closes every open pane panel together, so changing focus cannot reopen a panel owned by another pane. Panes can be opened or detached from the sidebar, safely reconcile draft promotion/archive/deletion, and animate layout changes without leaving stale portals or listeners. Reconciliation never returns a deleted thread as the fallback when all panes disappear.

Both pointer drags and native legacy-sidebar drags can create the first split on either side of a thread or place a pane above or below an unstacked column, with the hint and insertion using the same pointer position. Detaching the focused pane through the legacy sidebar routes to the remaining pane. Thread context menus can detach one pane or dissolve the entire containing split group. Entering a thread route restores its saved group, including navigation from the command palette, notifications, citations, and browser history; preloading a route leaves the current layout alone.

Split membership is persisted as multiple ordered local groups with active state and stable group colors. Selecting any member restores its group; the current and legacy sidebars preserve group tinting, support pane and thread drag placement, and show complete left/right drop intent. The group tint is textured with an inline desaturated SVG grain so the color-coded row reads as a surface rather than a flat slab. The grain is a masked pseudo-element rather than a second background layer, because background layers cannot carry their own mask and unmasked grain also covers the gradient's faded tail, flattening the row back into a uniform slab; the overlay shares the tint's fade axis and stops short of its extent so the texture is gone before the color is. Group hues carry a hue-dependent chroma: a flat chroma across the wheel does not read as a flat saturation, since yellow-green renders at full strength while red and blue are gamut-clipped, so chroma eases down around yellow-green. Rows supply only the hue and that chroma, leaving the stylesheet to compose per-theme lightness and strength — light mode takes a deeper, less translucent tint because the translucency that reads as a clear band on the near-black sidebar washes out against zinc-50. The current sidebar also names the other panes in each grouped thread's details tooltip, keeps displayed panes visible when settled or snoozed shelves are collapsed, and preserves split actions in its context menu. Right-panel ownership remains useful when focus moves to a pane with no surface of its own.

**Implementation evidence:** `apps/web/src/{splitViewStore,splitViewDrag,splitViewNavigation}.ts`, `apps/web/src/components/{SplitThreadWorkspace,ThreadRouteView,SplitPaneDropHint,Sidebar,LegacySidebar,CommandPalette,RightPanelTabs,ChatView,chat/ChatComposer}.tsx`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/index.css`, `apps/web/src/hooks/useThreadActions.ts`, and the chat routes.

**Recorded validation:** 248 focused tests across split state, navigation, native drag events, route history, sidebar logic, workspace, right-panel, notification, and citation behavior; `vp check`; `vp run typecheck`; and `git diff --check`. The 2026-09-28 isolated paired-browser pass confirmed that pointer hints switch between left and right and a left drop places the dragged thread before the original. The Browser panel then lost its automation host, so the remaining live flows and screenshot capture could not be completed. Native legacy drops and route restoration were verified by automated tests. An unrelated existing command-palette sorting test still fails in unchanged code. Earlier integrated checks cover composer shortcut ownership and shared right-panel closing. The 2026-09-29 5x2 extension passed 211 focused tests, `vp check`, `vp run typecheck`, and an isolated paired-browser pass at 2560x1440 showing five full-height columns and a sixth pane below the first. The drop-area correction passed 214 focused tests; an isolated paired-browser pass confirmed top and bottom native drops, and confirmed that a filled column at five columns accepts no drop or hint while an unstacked column still offers the top hint. The 2026-09-29 standalone vertical-drop and group-detach update passed 220 focused tests, including top/bottom native and pointer targets, active/inactive group dissolution, and both sidebar menu paths; the isolated browser pass confirmed the new menu item, top and bottom first-split hints, and the resulting stacked two-pane layout.

The 2026-10-07 drag update passed 90 focused drag tests, `vp check`, `vp run typecheck`, and `git diff --check`. Remote user verification confirmed the full thread-row overlay follows the pointer and the source gap remains visible outside the sidebar.

Pinned and Active drag boundaries occupy normal layout rows, including an empty Pinned group. Sorting uses their measured heights so labels keep consistent spacing in Manual and Last input ordering.

**Last updated:** 2026-10-26

### DL009 — Global default for agent tool access

Agent MCP tool scope now has an environment-level default with Automatic, Project, and Global choices. Project settings display Default when no override is stored and resolve that choice through the global default; Automatic retains repository-aware behavior.

**Implementation evidence:** `packages/contracts/src/settings.ts`, `apps/server/src/mcp/McpToolScope.ts`, `apps/web/src/components/settings/IntegrationsSettings.tsx`, and `apps/web/src/components/settings/ProjectMcpToolScopeSettings.tsx`.

**Recorded validation:** focused MCP scope tests, `vp check`, and `vp run typecheck`.

### DL012 — Prompt preservation during draft promotion

The initial optimistic prompt remains visible while a draft route becomes its server-backed thread. Chat timeline state resets only when the scoped thread identity changes, so the projected `thread.message-sent` event replaces the prompt instead of briefly erasing it. Dispatch and first-message launch RPCs share a ten-second acknowledgement timeout; a lost WebSocket reply therefore enters the existing visible failure path and restores the durable composer draft instead of leaving a refresh-only optimistic message indefinitely. The acknowledgement covers receipt of the launch RPC, not completion of workspace setup. If an acknowledgement arrives after the ten-second timeout, the server still lands the message while the restored draft remains visible; manually resending that draft can therefore duplicate the message.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx` and `packages/client-runtime/src/operations/commands.ts`.

**Recorded validation:** `vp check`, `vp run typecheck`, and the repository `dev` startup smoke test.

**Last updated:** 2026-08-10

### DL013 — Codex availability through catalog and turn failures

Codex model and skill discovery is bounded, optional catalog enrichment after a healthy authenticated app-server session starts. Catalog failure cannot replace that healthy snapshot with a provider-status error.

App-server errors are classified by scope: retryable transport errors remain warnings, while a typed non-retryable turn error emits the terminal failed-turn lifecycle needed to release the thread for a follow-up message. A root Codex collaboration `wait` that remains open for 30 minutes is failed explicitly after bounded child-then-parent interruption; matching item or turn completion cancels that deadline. Actual process or transport failure still marks the session unavailable. Upstream terminal-state, hard-stop, tool-identity, and liveness fixes remain authoritative; in particular, a late collaboration `interacted` event can enrich an existing child without restarting one that already completed.

**Implementation evidence:** `apps/server/src/provider/CodexProvider.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `apps/server/src/orchestration-v2/ProviderEventIngestor.ts`, and `packages/contracts/src/providerRuntime.ts`.

**Recorded validation:** focused Codex adapter, collaboration-runtime, provider-runtime ingestion, mixed-tool lifecycle, and transfer-budget tests, `vp check`, and `vp run typecheck`. The 2026-09-01 merge-focused provider suites also covered bounded collaboration waits, turn-scoped failure recovery, and upstream child-model enrichment.

Catalog enrichment remains optional and bounded: skills/list stays at three seconds, while ChatGPT model discovery allows its three-second refresh poll to finish and then returns the cached first catalog. Healthy Codex account probes retain their snapshot when skills or model discovery is slow or fails. The V2 adapter has no surviving root collaboration wait lifecycle equivalent to the former 30-minute V1 watchdog, so that behavior is intentionally not reintroduced.

**Last updated:** 2026-10-15

### DL014 — Loadable checkpoint diffs with a legacy baseline fallback

Sidecar diffs (DL006) use upstream's NUL-delimited numstat format for file summaries and reject output overflow rather than publishing an incomplete file list. Full patch requests remain available for the diff viewer, including upstream's path-limited patches that leave out files a pull, merge, or rebase brought in.

A thread-start diff resolves the baseline as its sidecar snapshot, then as the in-repo ref an older thread recorded. When neither exists, as for an older thread that never captured a baseline, it compares against repository `HEAD` instead of failing. This is the surviving baseline fallback from former DL011; provider-derived summary fallback is not retained.

The client shows turn diff summaries only for `ready` checkpoints. Rows with a `missing`, `error`, or `stale` checkpoint have nothing to load, so they never show a diff card or DiffPanel entry.

**Implementation evidence:** `apps/server/src/checkpointing/{CheckpointDiffQuery,CheckpointStore,SidecarCheckpointRepository}.ts`, `apps/server/src/orchestration-v2/CheckpointService.ts`, and `apps/web/src/hooks/useTurnDiffSummaries.ts`, with their tests. `CheckpointStore.test.ts` covers the sidecar HEAD fallback and sidecar authored-path filtering. `CheckpointDiffQuery.test.ts` and `CheckpointScopeOwnership.test.ts` cover the baseline lookup, and `useTurnDiffSummaries.test.ts` covers hiding non-ready rows.

**Recorded validation:** focused checkpoint query, sidecar store, scope-ownership, and web-summary tests, plus the 140 replay fixtures. All passed on 2026-10-15.

**Last updated:** 2026-10-15

### DL015 — Case-safe composer subagent utility filename

The composer subagent utility module uses a distinct basename from the `ComposerSubagents.tsx` component so Windows case-insensitive resolution cannot merge the two modules during typecheck.

**Implementation evidence:** `apps/web/src/components/chat/composerSubagentUtils.ts`, `apps/web/src/components/chat/ComposerSubagents.tsx`, and `apps/web/src/components/chat/composerSubagents.test.ts`.

**Recorded validation:** mobile typecheck and repository typecheck on Windows.

**Last updated:** 2026-09-24

This is a current-state record only. Each entry describes a surviving difference between `HEAD` and the latest shared base, determined with `git merge-base HEAD upstream/main` (updated by the latest sync merge). A feature adopted from upstream is not a divergence merely because it was involved in a merge.

Keep stable IDs when updating this section; gaps are intentional. When upstream absorbs a difference, remove or rewrite the entry rather than preserving chronology here. Update its behavior, implementation evidence, and validation when the surviving difference changes.

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

A follow-up message sent to a T3-owned delegated child reopens the original delegated task instead
of creating a separate task per follow-up (upstream #17696). Frequent child failures, such as
provider capacity errors, would otherwise leave a trail of tasks. While the follow-up runs, the task
shows as running with no result and a pending completion delivery. Further follow-ups join that
reopened work, and the task publishes once, after the last of them settles. The task's runs carry
its id, so the result already delivered to the parent is never delivered again, recovery adds
nothing, and automatic monitor wakes on the child never reopen it. Upstream's
`DelegatedCompletionDelivery` follow-up cases keep their exactly-once checks, with their task
identity assertions rewritten for this reopen behavior; upstream's held-queue pause/resume case
passes unchanged.

The task reports the latest of its runs that actually started. A follow-up cancelled before it
started, or one waiting in a held queue (after Stop or a provider failure), does not count, so
cancelling a queued follow-up restores the earlier result without a second transfer or wake.
While a stopped queue holds a follow-up, the task shows idle with no result; resuming the queue
returns it to running, and it publishes the follow-up's result once (upstream #21487). Upstream's
`cancelTask` covers held follow-ups, so `task_cancel` uses it and a reopened task with nothing
running can still be cancelled. The delegation's first run is identified by the spawn transfer's target run. A user
follow-up also reopens a task the parent had cancelled, re-arming its completion wake.

Implementation evidence: orchestrationV2 contracts and server layers; ChatView, Sidebar,
ThreadRelationshipsControl, ComposerSubagents, V2LifecycleRow, V2ItemInspector, rightPanelStore,
and session-logic. Reopen edge cases: `DelegatedCompletionDelivery.test.ts` ("reopened tasks whose
follow-up never starts", including "pauses a reopened task behind a held follow-up") and `OrchestratorMcpService.test.ts` (held follow-up cancel).

Recorded validation: focused V2 projection, provider-adapter, lineage-control, timeline, sidebar,
and composer tests; vp check; vp run typecheck; and an isolated paired web-app smoke test that
loaded a V2 thread route, confirmed the Agents/right-transcript surface is absent, and confirmed the
composer rendered. The preview client's accessibility snapshot and click calls failed after the app
loaded, so child-route interaction and lineage-control behavior were covered by code/tests only; the
smoke evidence used DOM evaluation and server responses.

Last updated: 2026-10-20

### DL019 — Desktop backend continuity and owned process-tree cleanup

Closing the last desktop window leaves Electron's main process and local T3 backend running. A native OS tray or status item keeps the app discoverable, opens or activates the window, and shows a live count of threads with active foreground or background work. Launching the desktop app again activates or recreates the window against that existing backend, while explicit quit terminates the backend through the owned lifecycle and update and signal shutdown paths retain their normal cleanup semantics. Explicit quit now ignores activation while shutdown is underway and destroys renderer windows before backend cleanup, adopting upstream's cleanup ordering without changing the fork's last-window policy. This is intentionally process-local continuity rather than a detached provider daemon: an Electron main-process crash or OS-forced termination still ends the backend.

The desktop main process owns one shared bearer session per local backend for the window, tray polling, and parallel WSL connections. This preserves upstream's replacement of stale desktop sessions without allowing a tray refresh or another renderer to revoke the active window's login. Closing and reopening the window reuses the backend's shared session. The per-backend token cache sits on top of upstream's rotating desktop bootstrap secret and its retry of 502–504 and dropped connections during bootstrap.

Tray refresh waits for backend readiness before requesting a bearer session or thread counts. An early tray token exchange therefore cannot delay renderer authentication. Failed count requests retain the last known count and recover without replacing the shared session.

On Windows, the standalone service launcher terminates the known server PID and its descendants during stop, update, and fatal shutdown. This prevents launcher-owned provider processes from surviving as orphaned Codex writers without scanning or killing processes by name; direct-child signaling remains the fallback when process-tree termination fails.

**Implementation evidence:** desktop lifecycle and native tray/status-item modules and their focused tests under `apps/desktop/src/`, dedicated macOS template-image assets and packaging checks, `apps/server/src/orchestration-v2/http.ts`, `packages/contracts/src/environmentHttp.ts`, and `apps/server/src/serviceLauncher.ts`.

Updater-controlled exits retain upstream's synchronous window destruction before process shutdown. Closing the last UI window still keeps the fork's tray-backed backend available.

**Recorded validation:** focused desktop tray, lifecycle, running-count projection, packaging, and Windows process-tree integration tests; Windows notification-area runtime verification of the count, open, and graceful quit controls; `vp check`; `vp run typecheck`; and `git diff --check`. The 2026-09-01 merge-focused desktop and server suites reran tray continuity and running-count behavior with upstream activity-liveness fixes.

The 2026-09-05 authentication fix passed 48 focused tests, including a tray integration regression that fails with the original independent token exchange. An isolated Windows Electron run verified automatic login, continued authentication after tray polling, and closing and reopening the window against the same backend. A separate browser paired successfully with cookie authentication. `vp check` and `vp run typecheck` passed.

The 2026-10-02 readiness guard passed 12 focused tests. An isolated source startup exchanged its token after readiness and completed 16 count polls without errors. Renderer bearer acquisition took 0.21 ms. The final packaged startup completed 17 count polls without errors. The integration test also verifies recovery from a failed count request without another token exchange.

**Last updated:** 2026-10-20

### DL020 — Provider turns survive stalled checkpoint captures

A provider turn that completes is persisted `completed` immediately. Its checkpoint capture runs afterward as a follow-up effect, so a slow capture (5–10 s on Windows), a hung VCS call, or a failing checkpoint backend never delays the next message, never makes the thread look busy, and never blocks Stop. Upstream instead parks every completed turn at `waiting` until capture finishes. The fork keeps that `waiting` state only for a completed turn that still owns open run-owned background work (native subagents), so that work stays visible and `task_cancel`/Stop can end it. The checkpoint capture completes that run. Each capture attempt is bounded at two minutes, so a VCS call that hangs fails instead of holding the effect. After the last attempt fails, the effect worker completes the run without a checkpoint, retrying that write. If every write fails, the capture effect stays queued and tries again later, so a run can never stay `waiting` forever.

The effect outbox serializes each thread's effects, but checkpoint capture has its own lane. A pending or hung capture never queues the thread's next `provider-turn.start`, Stop, or other provider effects behind it. Capture and checkpoint rollback still wait for each other, and the workspace lock serializes their file work. A run's checkpoint baseline is the previous run's capture boundary, so while that capture is still running the next run skips its baseline instead of waiting on the workspace lock. The effect worker runs at most two captures at once, so captures on other threads always leave workers for turn starts, Stop, and other effects.

Because the run releases its provider thread at once, the next run (for example Muse's own report turn after a workflow) can claim the thread before the provider's late "background task ended" update reaches the finished run's stream. That update still removes the ended tasks from the stored roster without overwriting the newer run's snapshot, and the server ignores those tasks in later roster snapshots, so an adapter seeded with the older roster cannot bring them back. Upstream avoids this race only because its `waiting` window usually outlasts it.

Workspaces without a Git repository do no VCS work for checkpoints. VCS detection walks the real path from the cwd up to the filesystem root. When no `.git` entry (directory or worktree file) exists along it, filesystem stats answer without spawning `git`. Every detection caller benefits: checkpoints, status polling, review, and git workflows. The turn's baseline, capture, and diff then record `missing` checkpoints, and finalization skips only the VCS and pull-request refresh, so the file search index still follows the turn's edits. Upstream's detection spawns `git rev-parse` for every check because a negative answer is never cached.

**Implementation evidence:** `apps/server/src/orchestration-v2/{RunExecutionService,CheckpointCaptureService,RunFinalizationService,EffectWorker,EffectOutbox,EventSink}.ts`, `apps/server/src/vcs/VcsDriverRegistry.ts`, and their tests. `EffectWorker.test.ts` covers five cases. A hung capture still lets the next turn start and Stop run on the same thread, which fails without the capture lane. Four hung captures on other threads leave a worker for a turn start. The per-capture timeout lets the run settle. A run whose completion writes all fail keeps its capture queued. A capture and a rollback keep their order. `RunExecutionService.test.ts` starts a run while the real `CheckpointService` is still capturing the previous run's boundary. `VcsDriverRegistry.test.ts` resolves a repository and lists its files with `GIT_DIR` and `GIT_WORK_TREE` inherited from the server environment, which `VcsProcess` removes from Git commands unless an operation sets its own value. The late roster clear is covered by `RunExecutionService.test.ts` ("a late roster clear from a released run ends its tasks for good"), `FoundationPersistence.test.ts`, and the `muse_workflow` replay fixture, which fails without it. `apps/server/src/checkpointing/NonGitWorkspace.test.ts` runs a turn's checkpoint work against a real temporary non-Git folder and asserts that no child process is spawned, recorded at the process spawner. It fails without the stat pre-check, and also covers registry detection, symlinked workspaces, and linked worktrees whose `.git` is a file. Upstream's steering, background-stop, and Claude automatic-delivery suites keep every behavioral assertion. Only their "turn finalized" watchers accept `completed` as well as `waiting`. The replay and provider-switch harnesses wait for each completed run's checkpoint before treating a thread as idle.

**Recorded validation:** SteeringCompletion 13, BackgroundWorkStop 12, ClaudeAutomaticDelivery 3, TaskCancelNativeSubagent 1, EffectWorker, CheckpointCaptureService, CheckpointService, RunFinalizationService, RunExecutionService, recovery, and the replay (140/140 including `muse_workflow`)/provider-switch/fork/merge-back harnesses pass.

**Last updated:** 2026-10-16

### DL021 — Clickable Windows file links in thread Markdown

Thread Markdown preserves local Windows drive-letter destinations through URL sanitization and resolves the encoded backslash form emitted by the Markdown parser. These links open through the existing file chip behavior instead of rendering as inert anchors. Sanitization also preserves validated `t3-context` references in both link and image destinations so structured context records render as chips instead of inert Markdown. This coexists with upstream workspace images, spaced-folder command-click handling, contrast-aware annotation styling, and full-path link tooltips.

**Implementation evidence:** `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/chat/MarkdownFileLink.tsx`, `apps/web/src/components/ChatMarkdown.browser.test.tsx`, and `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`.

**Recorded validation:** focused Markdown link tests, ChatMarkdown and MessagesTimeline context-reference tests, an isolated paired web-client pass with a drive-letter link in both user and assistant messages, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-10-25

### DL023 – Scoped V2 MCP thread and project tools

The upstream singular V2 MCP toolkit remains authoritative. Provider callers resolve to project or
global scope per project setting: Git-backed projects default to project scope, non-Git projects
default to global scope, and every project can override the default. Project-scoped callers can
operate only inside their project; global callers may read, launch, send, and wait across projects,
with the upstream user-attached cross-project read exception preserved.

That boundary also covers every MCP resource selector: pull-request thread links and review-guide
checkouts, workflow stops, scheduled-task list/update/delete/run-now, and scratch launches. A shared
project authorization check is applied after resolving the target resource and before any read or
write that could expose or trigger work in another project; management keys retain their explicit
environment-wide semantics.

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

Claude's fork-specific model ID and effort normalization applies to gateway, custom, and bundled models with a manual override. Bundled models without overrides use the upstream catalog path, preserving current `xhigh` support (including the 5.5 and Fable 5.1 models); live model switches resolve the effective API ID and effort once and reuse that selection for the process, flags, and query identity.

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

Codex adapter setup retains the original shared/shadow-home configuration while adding gateway launch arguments. Resolving an already-substituted shadow home a second time would reject an otherwise valid provider instance.

CLI-managed Codex gateways can opt into native catalog discovery. T3 configures Codex with the
gateway's `model_catalog_url` and a command-backed bearer token reader, so Codex can use gateway
model metadata that its bundled catalog does not contain. x-api-key gateways keep their
environment-backed header when native discovery is enabled.

A separate, default-off **Image generation** option in Codex gateway settings and the
add-instance wizard advertises the gateway's Images API to Codex. It adds the static
`x-openai-actor-authorization` header to `t3_api_gateway`, which Codex requires before
offering its built-in `image_gen` tool for a custom provider. This option works independently
of catalog discovery and preserves the existing bearer or x-api-key credential configuration.

**Implementation evidence:** `packages/contracts/src/{model,server,settings}.ts`,
`apps/server/src/provider/{Drivers/ClaudeDriver.ts,ClaudeProvider.ts,GatewayModelCatalog.ts}`,
`apps/server/src/textGeneration/ClaudeTextGeneration.ts`,
`apps/web/src/components/settings/{AddProviderInstanceDialog,CompatibleApiGatewaySection,CustomModelMetadataDialog,ProviderInstanceCard,ProviderModelsSection,ProviderSettingsPanel}.tsx`,
and `apps/web/src/components/settings/providerModelDetails.ts`.

**Recorded validation:** focused gateway parsing and cache tests, Codex and Claude provider relay
tests, settings and server contract tests, provider-settings component tests, model-picker regression
tests for authoritative gateway rows, `vp check`, `vp run typecheck`, and integrated web verification
of gateway configuration, custom model metadata, and model-detail tooltips. The 2026-09-03
add-instance dialog scroll fix was verified in a browser at 1000x720 and 390x700 with the gateway
section expanded.

Claude adapter and text-generation launches now resolve each selected gateway model through the per-instance catalog, applying `[1m]` model IDs and normalized CLI effort before opening or spawning.

**Last updated:** 2026-10-25

### DL027 — Remote editor links select the server account

Remote open-in-editor targets advertise the operating-system account running the
server when it can be resolved. The web client includes that account inside the
VS Code Remote-SSH authority (`ssh-remote+user@host`), so Windows clients do not
fall back to their local username. Windows AD accounts use `USERDOMAIN\\username`
only when `USERDNSDOMAIN` confirms a domain and the name is not the local
computer/workgroup. Local accounts use the unqualified username. Systems that
cannot resolve an account omit the field and retain host-only behavior.
Desktop-managed SSH aliases remain authoritative and continue to omit the
advertised account. VS Code Remote-SSH links retain the fork's raw `@` separator inside the path authority, with upstream's `:1:1` file-position suffix. The username field is optional for compatibility with older
server configurations.

**Implementation evidence:** `packages/shared/src/HostProcess.ts`,
`packages/contracts/src/editor.ts`, `apps/server/src/environment/RemoteOpenTargets.ts`,
`apps/web/src/remoteOpen.ts`, `apps/web/src/components/chat/OpenInPicker.tsx`, and
`apps/desktop/src/electron/ElectronShell.test.ts`.

**Recorded validation:** focused contract, server target discovery, web remote-open,
and Electron shell tests.

**Last updated:** 2026-10-25

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

When Working is disabled, the web and desktop sidebar offers **Manual** ordering by default and **Last input** ordering in General settings. Manual preserves saved positions and sidebar drag actions. Last input ignores saved active-order keys and promotes threads on user-authored messages while retaining creation and un-settle lifecycle anchors. Delegated-agent messages and automatic wakes do not advance Last input ordering; older servers without a user-authored timestamp retain the user-role timestamp fallback. Switching modes preserves saved keys. While upstream Working is enabled, the Inbox uses return-priority order, placing threads that most recently returned for attention first. Disabling Working restores the saved Manual or Last input preference. Active-row manual reordering is unavailable while Working is enabled; pin actions, shelf moves, and dragging into splits remain available. Dragging a row into the conversation creates or extends a split in either mode, without a separate grip control. Initial split creation reuses the existing pane-drop overlay to show its right-side placement. The dragged row uses the same row appearance in a document-level drag overlay, preserving sidebar scroll position and avoiding clipping behind the conversation.

**Implementation evidence:** `packages/contracts/src/settings.ts`, `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/Sidebar.logic.ts`, and their focused tests.

**Recorded validation:** focused settings, sidebar sorting, pointer lifecycle, and split target tests; isolated browser checks for initial split creation, pane placement, manual reordering, Last input mode, and settings persistence; `vp check`; and `vp run typecheck`. The 2026-10-26 regression checks cover agent messages, threads without human input, subsequent user messages, and older-server fallback. An isolated browser pass confirmed human input ordering and persistence after reload.

**Last updated:** 2026-10-26

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
projects, create and message threads, read and wait on threads, and list models. The opt-in `pullRequests:review` scope adds pull-request review guide tools. Runtime permissions
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
`apps/server/src/mcp/toolkits/thread/handlers.ts`, `packages/contracts/src/managementApiKeys.ts`,
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
assistant message through the decider, projector, client reducer, and SQLite projection. Persistence keeps upstream migrations 1–69 in `effect_sql_migrations` and fork migrations 1–15 in the independent `fork_sql_migrations` ledger. The web composer shows it as ghost text once the thread is idle and the
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
`apps/server/src/orchestration-v2/Adapters/{CodexAdapterV2,ClaudeAdapterV2}.ts`,
`apps/server/src/provider/CodexDeveloperInstructions.ts`,
`apps/server/src/orchestration-v2/ProviderEventIngestor.ts`,
`apps/server/src/orchestration-v2/{Orchestrator,ProjectionStore}.ts`,
`apps/server/src/persistence/Migrations/062_ProjectionThreadMessageSuggestions.ts`,
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

Hub requests pause after management HTTP 401/403 until the URL or management key changes. Each ChatGPT account publishes its `id_token.chatgpt_account_id` as `workspaceId`, so one email signed into multiple workspaces remains distinct. Optional malformed quota fields and array entries no longer discard usable windows; Codex plan fallback accepts both field names and relative reset times. Upstream's subpath-safe hub URLs (#19336) apply, so a hub served under a path keeps it. Credit redemption sends only a stable `redeem_request_id`, preserves known outcomes, and reports unfamiliar successful responses as accepted before refreshing usage. T3 leaves cooldown clearing to CPA instead of resetting the entire account. Web, desktop, and mobile display the accepted result.

**Implementation evidence:** `apps/server/src/usage/cliproxyApi.ts`, its focused tests, `packages/contracts/src/providerUsageLimits.ts`, and the web/mobile usage components.

**Recorded validation:** 26 focused adapter and source-refresh tests, `vp check`, `vp run typecheck`, and `vp run lint:mobile`. Integrated web verification is blocked by `PreviewAutomationNoAvailableHostError`; native mobile verification is blocked by disabled device access.

**Last updated:** 2026-10-20

### DL038 — Precise transcript identity checks on Windows

Session scanning skips parsing completed history from matching file metadata only when the inode is present. Effect 4.0.5 reports inodes as bigints, which import sources store as exact decimal strings; legacy numeric inodes that are not safe integers never match because they may already have lost NTFS file ID precision. Windows can omit inode values, making a replacement file look unchanged. The scanner validates these completed files with a separate bounded budget so retries can import the next batch of new histories. Both budgets allow 100 transcripts, 4 GiB, and 100,000 records per scan. Replacements also consume the new-history budget. Completed files beyond the validation budget remain conservatively skipped; identical-metadata replacements there are not guaranteed to be discovered on retries.

**Implementation evidence:** `apps/server/src/project/AgentSessionScanner.ts`, its replacement identity tests, and bounded retry tests in `AgentSessionImporter.test.ts`. `packages/shared/src/nodeRuntime.ts` falls back to native bigint file IDs when Effect stats report a missing or zero inode; `nodeRuntime.test.ts` covers native, missing, and zero identities.

**Recorded validation:** 100 scanner/importer tests, including 201-history imports across three attempts with missing inodes and exact-string versus rounded legacy inodes. Server typecheck, scoped lint, and formatting passed.

**Last updated:** 2026-10-20

### DL039 — Graceful Codex shutdown before Windows tree termination

Codex app-server sessions and probes drain their protocol writer and close stdin before waiting up to three seconds for exit. Output readers stay open during cleanup; an unresponsive app-server still receives a forced termination. Transport failures use the same stdin-first shutdown.

On Windows, the service launcher requests shutdown over its existing IPC channel and allows five seconds for server cleanup before `taskkill /T /F`. Native desktop backends use stdin EOF to request server shutdown and allow four seconds before the process spawner forces termination, within the existing five-second desktop stop budget. Linux, macOS, and WSL retain their signal-based server shutdown. Older servers that do not recognize these requests still reach the forced fallback.

This is an experiment to reduce abrupt termination. It does not establish or fix the cause of the intermittent zero-handle Codex processes stuck in Windows termination.

**Implementation evidence:** `packages/effect-codex-app-server/src/{client,protocol}.ts`, `apps/server/src/{serviceLauncher,server}.ts`, `apps/server/src/process/ParentProcessShutdown.ts`, and `apps/desktop/src/backend/DesktopBackendManager.ts`.

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

A fork or rollback request may carry a saved native turn boundary (`nativeBoundaryRef` on the
adapter fork input). Codex and Claude fork exactly at a strong ref of their own driver and reject a
weak, foreign, or synthetic one instead of falling back to a guessed turn count. Checkpoint navigation uses the persisted provider-turn boundary through the existing fork API. No orchestrator path supplies the explicit `nativeBoundaryRef` override yet; V1 import records thread cursors only.

Implementation evidence: LegacyV1ThreadImporter, Core V2 cutover migration, provider-thread
projection, Codex and Claude V2 adapters (`resolveCodexForkBoundary`,
`resolveClaudeForkUpToMessageId`), and the legacy importer/cutover and Codex adapter tests.

Last updated: 2026-10-25

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

### DL044 — Claude turns tolerate partial gateway usage

Anthropic-compatible gateways can send assistant `usage` with only some token
counts (for example `{ input_tokens: 0 }`). The Claude V2 adapter treats each
count as optional, so live context usage stays schema-valid. Before this, the
`provider_turn.updated` event failed provider-event validation. Ingestion then
stopped and recorded a generic `Provider turn failed.` even though Claude had
returned a successful result.

**Implementation evidence:** `claudeProviderTurnTokenUsage` in
`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` and its
partial-usage one-shot regression test.

**Recorded validation:** the regression fails on `main` with a schema-invalid
`provider_turn.updated` and passes with the fix. A temporary orchestrator replay
of the recorded native log reproduced the failed run and completed it after the
fix. One unrelated Claude adapter roster test also fails on clean `main`.

**Last updated:** 2026-10-09

### DL045 — Markdown host images recover after files appear

Inline Markdown images backed by host files retry a bounded number of times after an initial asset
mint fails. Agents can stream a Markdown path before the file is finished writing; the asset query
otherwise caches the not-found response while opening the same path in the image viewer explicitly
refreshes it. Retries require the filesystem read permission and stop after the short backoff or a
successful signed URL. The retry identity uses the environment and resource value, so streaming renders do not restart the retry budget and a different resource receives its own budget.

**Implementation evidence:** `apps/web/src/components/chat/ChatMarkdownMedia.tsx` and
`apps/web/src/components/ChatMarkdown.assets.browser.test.tsx`.

**Recorded validation:** focused ChatMarkdown asset tests.

**Last updated:** 2026-10-25

### DL046 — Worktree submodules initialize local file URLs safely

New worktree setup now reports the submodule stage through the launch progress tracker, including
the command output that explains a failed checkout. T3 allows the `file` transport only on its
scoped `git submodule update --init` invocation, so local submodule URLs inherited by a worktree
can initialize without weakening the host or repository's default Git protocol policy. Repositories
without submodules and projects that disable initialization are marked as skipped; unreachable
submodules remain best-effort failures and do not prevent worktree creation.

**Implementation evidence:** `apps/server/src/orchestration-v2/ThreadLaunchService.ts`,
`apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, and the focused
Git driver regression test.

**Last updated:** 2026-10-16

### DL047 — Configurable automatic retry for matched failures

The fork adds an opt-in server setting for automatic retries. Users can define enabled or disabled
triggers with nested all/any/not conditions over error-message substrings, backend type, and model
substrings, plus a message to send for a matched failure. Failed workspace preparation retries
through the existing preparation path; failures after provider start send the configured message.
Repeated matched failures are bounded per thread and pause automatic retry for ten minutes, with a
composer notice while the pause is active. The notice can clear the pause and reset that thread's
retry guard immediately.

Retryable attempts remain pending for thread waiters, delegated-task observers, and notifications.
App-owned delegates retain their task identity through recovery. A successful retry reports the
completed result; when recovery stops, observers receive the last provider failure. The temporary
auto-retry pause is separate thread metadata and does not replace that error. Provider-native
subagents remain under their provider's control.

**Implementation evidence:** `packages/contracts/src/settings.ts`,
`apps/server/src/orchestration-v2/{AutoRetry,EventSink,Orchestrator,EffectWorker}.ts`,
`apps/web/src/components/settings/AutoRetrySettings.tsx`, and
`apps/web/src/components/chat/autoRetryDisabledBanner.ts`.

**Recorded validation:** focused matcher, settings, composer-banner, delegated-completion,
thread-wait, restart-recovery, MCP-result, and notification tests. An isolated web run verified
repeated startup failures reach the pause banner and manual resume starts recovery again.
Repository formatting, lint, and type checks passed.

**Last updated:** 2026-10-25

### DL048 — Pending prompts survive transcript paging

Pending user questions and approvals remain available to the composer when their original
transcript rows fall outside the recent history window. SQL snapshots retain their prompts
separately from the visible timeline, and wire paging preserves them until the request is
answered or dismissed. This keeps an older async question from leaving a thread marked Input
with no visible prompt to answer or dismiss.

**Recorded validation:** SQL and memory projection regressions, history paging tests, and an
isolated web verification using a copied long thread. Answering or dismissing remains the
existing request response flow.

**Last updated:** 2026-10-26

## Merge History

This is an append-only historical decision record. It provides context for integrations but never, by itself, establishes an ongoing fork divergence; use the current Divergence Log for that determination.

Don't forget to update the `base` tag after each merge to track the latest shared base with upstream/main.

### 2026-10-25 — Merge upstream/main through `b808f7fc6d`

**Merge commit:** this commit
**Parents:** `1c81d6473d7a35cf177ff56495bf22f6e0417b10` (fork) and `b808f7fc6de810aa72b7131acbd3f947c6321b9f` (upstream/main); 769 upstream commits since `6a049d0ea1`.

The sync preserves all 39 current divergence entries, including the global MCP scope default and the latest automatic-retry changes. DL009 now lives in the Divergence Log rather than below Merge History.

Decisions:

- Keep sidecar checkpoints, forward checkpoints for redo, immediate turn completion, exact-owner background-task cleanup, and the bounded independent capture lane. Compose upstream SQLite read routing, durable failure persistence, outcome recording, and cleanup with them.
- Keep pending automatic retries hidden from terminal waiters and completion notifications. Retain retry guard metadata in contracts and thread summaries alongside upstream guest sharing, idle compaction, feedback, compact snapshots, and model options. Keep usage-limit auto-resume enabled by default and its fork continuation prompt; adopt upstream's steer-by-default follow-ups.
- Keep reopening the original delegated task on user follow-ups, including held queues, cancellation and exactly-once completion delivery, alongside upstream child-stop handling.
- Keep management-key principals, scoped project/global MCP access, eight-target waits, provider/model send selection and self-send rejection. Preserve the reviewed management-key allowlist. Adapt the new CLI to multi-target wait responses. Project scope applies before full-text-search ranking and limits on both search APIs.
- Keep per-instance gateway catalogs, metadata precedence, opaque credentials, and stale-PATH launch recovery. Combine upstream Codex probe deadlines and service-tier enrichment with gateway metadata. ACP recovery registers and stops each launch attempt's scope; OpenCode retains shared server-scope ownership.
- Keep Claude's separate startup queues, initialization handshake, empty-session recovery, prompt-suggestion pinning, gateway model/effort normalization and partial usage tolerance. Adopt upstream scope cleanup, launch prompts, skill objects, query policy and compaction thresholds. Keep Codex compaction token counts alongside upstream completion timestamps and failure titles.
- Keep desktop tray-backed backend continuity, shared renderer/tray authentication, readiness gating, Windows stdin/process-tree shutdown, and explicit-quit cleanup. Keep preview receipt acknowledgement, deadlines, stale-session recovery and native-control cleanup alongside upstream screenshot and appearance changes.
- Keep Windows account/domain selection for remote editors and the raw `@` separator in VS Code Remote-SSH path authorities, composing upstream username normalization and the `:1:1` suffix. Desktop-managed SSH aliases remain authoritative.
- Keep the full-row sidebar drag overlay, ten-pane split groups, saved colors, focused-pane shortcuts/paste/composer ownership and one shared right panel. Port these into upstream's extracted sidebar, composer and chat modules. Keep Manual/Last input ordering when Working is disabled, with upstream Inbox ordering while enabled.
- Keep machine context, optimistic prompt preservation, existing-worktree selection, checkpoint slash commands, prompt suggestions, subagent navigation, automatic-retry controls and the project-selecting new-thread shortcut. Keep model-group-scoped search, including query retention during keyboard group changes. Keep Windows/context file links and bounded host-image recovery in upstream's extracted Markdown modules.
- Keep manual-only release triggers and the separate unsigned Windows/macOS workflows. Retain the patched node-pty pin, Windows test budgets, route-test exclusion and standalone Node-test exclusions.
- Keep canonical upstream migration IDs through 069 and independent fork IDs 1–15. Preserve name-based historical conversion, lower-gap repair and guarded fork schema changes. Historical fork collisions, including the missing branch column at old ID 58, upgrade without an additional repair migration. Repair stale migration fixtures to exercise the current canonical migrations rather than unrelated reused numbers.
- Retain meaningful fork characterization when upstream removes tests. Port those cases onto the new fixtures and disposable browser-render helpers. Accept deletion of superseded private-helper and fake-only tests; retain actual launcher, lifecycle, provider, checkpoint and scope behavior checks. Pre-merge canvas and settings-search failures reproduced unchanged; their stale expectations now match the retained behavior.

Integration repairs:

- Restored the project predicate in the retained search wrapper after upstream's full-text-search extraction.
- Fixed pre-existing checkpoint-client gaps found in live testing: navigation metadata now follows events, old cached metadata is invalidated, and slash commands no longer depend on plan-mode controls.
- Fixed pre-existing redo gaps found by independent review and a failing regression: preserved native conversation sources, restored transcript run/node states, and distinguished historical restoration from live completion side effects. Existing provider fork APIs remain the protocol boundary.
- Fixed pre-existing Codex shared/shadow-home double resolution while retaining gateway launch arguments.

Validation:

- Repository-wide `vp check` and `vp run typecheck` pass. Mobile native static checks pass, including SwiftLint, ktlint and detekt.
- The final full-suite run completed 1,612 files with 17,836 passing tests and nine skips. Its seven remaining failures were old native rollback recordings and an exact history-response expectation. Those test-only mismatches were corrected; all 83 tests in the four affected files pass on rerun. Earlier full-suite fixture and temporary-storage failures were also resolved, with all 558 tests in those 17 files passing together.
- Focused migration tests cover fresh, canonical upstream and deployed fork ledgers, numeric collisions, retained suggestion data, schema integrity and repeat startup. A read-only copy of real data applied upstream migrations 065–069, passed integrity and foreign-key checks, loaded saved threads, and restarted without additional migrations.
- Independent reviews checked every current divergence and then rechecked the checkpoint repairs. Focused client, provider, persistence and orchestration regressions cover pending navigation, failed-navigation retry, immutable native sources, inherited baselines, cold resume, abandoned branches, capture gaps, historical-event delivery and bounded history restoration.
- A paired production web client completed real Codex and Claude turns in selected existing worktrees. Undo and redo restored files and transcript rows in both the original client and a fresh observer. After restarting the isolated server, both providers retained their native session references and correctly recalled the restored conversation without reading files. A Claude fork from an older response also retained its inherited context after rewinding its first own turn and restarting; its discarded child instruction did not return. Sidecar captures left the project's `refs/t3` namespace empty.
- Integrated checks covered machine/worktree context, gateway catalogs, split creation/restoration/detachment, project-selecting shortcuts, ordering persistence, management-key creation/revocation and phone-width layout. The file-restore isolation guard and retry after refusal were verified.
- Web, server and desktop production builds pass. Linux AppImage and deb installers build, and an isolated Electron instance created its window and started its backend. Native mobile runtime verification and Windows/macOS installer execution were not performed. No deployment was performed.

### 2026-10-20 — Merge upstream/main through `6a049d0ea1`

**Merge commit:** this commit
**Parents:** `900a0ea28f` (fork) and `6a049d0ea1` (upstream/main); 1,223 upstream commits since `7d5a42912a`

Upstream added migrations 063–064 (063 drops unused V1 projections) and new lint rules requiring
`Effect.fn` for reusable generator wrappers and React Compiler-safe components; fork code was
converted to both.

Decisions:

- DL006 keeps redo: forward checkpoints stay ready after a rollback, overriding upstream #21804's
  stale-checkpoint retirement. Upstream's rollback tests were adapted.
- DL006 `checkpoint_legacy_migrations` is rebuilt without its foreign key to `projection_turns`
  before upstream 063 drops that table.
- DL018 keeps reopening the original task over upstream's fresh task per follow-up. Upstream's
  `cancelTask` is adopted because it covers held follow-ups. A reopened task held by a stopped queue
  now pauses and resumes, so upstream #21487's test passes unchanged.
- DL008 keeps the full-row `DragOverlay`; upstream's `ThreadContextDragGhost` was deleted.
- `ChatHeader` keeps upstream's rename blur guard.
- `DesktopLocalEnvironmentAuth` keeps upstream's rotating desktop secret and 502–504 retry under the
  fork's per-backend cache (DL019).
- CDP detach combines upstream #17525's proactive reattach with DL004's stale-session lazy detach.
- DL037 merges with upstream's subpath-safe hub URLs.
- DL018 and DL020 required editing seven upstream tests. DL032's `autoResumeLimitedThreads=true`
  default also required `SettingsPanels.restore.browser.test.tsx` to toggle the setting from its
  default rather than setting it to `true`.
- Retired DL016: upstream #16316 recognizes the same partial-clone remote annotations.
- Upstream #14892's ignored-workspace `missing` checkpoint did not reach sidecar captures, which
  published ready checkpoints with empty diffs. Sidecar capture now raises the same
  `VcsUnsupportedOperationError` when the workspace is ignored and Git lists no tracked or
  re-included files in it.
- Adopted upstream's thread transfer budget caps and `thread-transfer-v2` scenario id; the merged
  tree passes them.

**Validation:** `vp check` and `vp run typecheck` pass. Per-package suites match the pre-merge
fork except known pre-existing failures (persistence migration fixtures, ProviderRegistry probe
timeout, CodexDriver shared-home updater, CursorSdk, `chatCanvasLayout`/`settingsSearch`, desktop
artifact script). A copy of a real 3 GB fork database upgraded through 063–064 with a clean
`foreign_key_check`, and a fresh database migrates idempotently. Web dev smoke on seeded data
paired, loaded threads and settings, and completed a live Codex turn. The desktop build and the
Linux AppImage/deb installers build. Two independent reviews (Claude Opus 5.5, GPT-6 Astra) audited
every DL entry.

### 2026-10-16 — Merge upstream/main through `7d5a42912a`

**Merge commit:** this commit
**Parents:** `17a2cf6248` (fork) and `7d5a42912a` (upstream/main); 630 upstream commits since `079e4bccdc`

Upstream moved provider and source-control code into `packages/provider-*` and `packages/source-control-*`,
renamed `hostProcess.ts` to `HostProcess.ts`, dropped the per-driver `providers` settings map, and added
migrations 059–062. Fork features were ported onto those shapes. Name-based history conversion maps the
fork's old 59–67 ids, and a lower-gap repair runs any skipped upstream migration (such as 041 on remapped
`ThreadSummaryTimeline` histories) before the normal migrator.

Decisions:

- DL032 auto-resume stays on by default with the fork prompt. Model precedence is manual override, then
  gateway inventory, then upstream's catalog.
- Management keys gain an opt-in `pullRequests:review` scope for the review-guide tools (DL031).
- DL020 keeps the fork model: provider turns complete immediately, capture runs on its own bounded lane
  and never blocks the next send or Stop, and non-Git workspaces spawn no VCS work.
- DL018 keeps the fork model: a follow-up reopens the original delegated task instead of upstream
  #17696's separate task, with exactly-once delivery.
- The image retry from a `dev` stash joins as DL045.

Audits (Astra and Opus each reviewed every round) also restored fork features lost in the 2026-10-08 redo
and still missing on `dev`: sidecar checkpoints (DL006/DL014), DL042 fork boundaries, DL037 resilient
usage, DL023 project scope for every MCP tool, DL001 launch recovery on every provider, DL026 gateway
model resolution, DL004 broker acknowledgement, DL012 command acknowledgement, the DL017 worktree picker
and the DL002 machine label. Sidecar capture now reuses a per-worktree private index.

**Validation:** `vp check`, `vp run typecheck` and `vp run lint:mobile` pass. Server, contracts, shared and
client-runtime tests: 10,643 passed; the 13 remaining failures also fail on `dev` (old fork migration
fixtures, a Codex updater test and a provider probe timeout). Orchestration, checkpointing, VCS and MCP
pass 2,683/2,683 from the repo root, and the replay fixtures pass 140/140. A copy of a real database
migrated with 129/129 threads, passed `quick_check`, and booted a second time without migrating again.
In a browser against that copy, pairing, migrated threads, the draft worktree picker, gateway Claude
turns, settings, usage and management-key creation with the review scope work; MCP HTTP calls honour
that scope. Native mobile, desktop installers and Windows were not exercised.

Known follow-ups: Claude's DL034 prompt-suggestion pin briefly reports the provider thread as idle while
a turn starts; nothing yet supplies DL042's native boundary from the orchestrator.

### 2026-10-08 — Redo upstream merge after `cad0f83ed6`

**Merge commit:** local redo on `fix/redo-merge`; superseded and audited by the 2026-10-15 merge
**Parents:** `dba09c35aa` (fork) and `079e4bccdc` (upstream/main)

This merge supersedes `cad0f83ed6`. It ports the fork divergences onto upstream's flattened
server/provider APIs instead of dropping modules whose old `Services/` and `Layers/` paths moved.
It restores per-instance gateway catalogs and launch metadata, durable management-key HTTP/MCP
access, scoped MCP authorization, provider recovery, checkpoint/orchestration/VCS behavior,
preview automation, and the desktop/web/mobile contract changes. The two intentional removals from
the fork parent remain removed: zrok sharing (DL022) and subscription usage meters (DL003).

Persistence now keeps upstream's `effect_sql_migrations` ids and adds an independent
`fork_sql_migrations` ledger. A name-based conversion handles current and legacy fork histories,
the bad merge's 67/68/69 records, upstream V1/V2, and V2 preview records. Conversion writes a
`VACUUM INTO` rollback copy first, runs idempotent fork migrations after upstream migrations, and
keeps divergence as a warning instead of refusing startup. A read-only copy of the live database
retained 394 threads, passed `PRAGMA integrity_check`, and restarted cleanly on a second run.

**Validation:** migration fixtures, provider/gateway/compaction, Claude prompt pinning, MCP service
and HTTP suites, delegated completion, ACP teardown, and the Windows MCP integration pass. `vp check`
formatting passes with existing lint diagnostics, `vp run lint:mobile` passes, and scoped server
typecheck has no TypeScript errors. The unrestricted full suite still reports unrelated provider and
server-settings failures and was stopped during long Windows suites. Browser, native-device, remote,
real-provider, and installer verification remain unavailable in this environment. This redo is ready
for final review but must not replace `main` until those environment checks are completed.

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
