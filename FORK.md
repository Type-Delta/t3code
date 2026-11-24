# t3code Fork

<!-- In-synced fork: maintained with the `syncfork` skill. -->

This fork keeps the Windows reliability, durable checkpointing, and workspace capabilities that are still not supplied by the shared base.

## Divergence Log

Each behavior where this fork differs from upstream has one entry here. If you change code in this repository, check if this log needs an update.

The rules:

- Update the entry that owns the behavior you changed, or add an entry with the next unused ID. One entry covers one behavior, not one commit.
- Describe the current behavior, why the fork needs it, and how it composes with upstream's related behavior. When the behavior changes, rewrite the entry. Do not append a changelog; git and the Merge History hold history.
- Under **Implementation evidence**, list the key source files and tests. Under **Recorded validation**, list the checks that proved the current behavior.
- Set **Last updated** to today's date on every entry you touch.
- Never reuse an ID. Retire an entry only with the user's explicit approval: delete it and name the retired ID in the next Merge History entry.
- When an ID conflicts from merges, renumber the IDs as needed.
- A change that does not alter how the fork differs from upstream (formatting, or an edit to this file) needs no entry.

### DL001 — Provider startup and artifact safeguards

Windows Claude commands are resolved before the Agent SDK starts a session. The resolver follows npm launcher shims to the installed native executable or JavaScript entry point and preserves explicit executable paths. Provider snapshots and DevTools expose sanitized resolver diagnostics; startup provenance identifies installed web artifacts without exposing command output or environment values.

When a PATH-based provider executable disappears before startup, the backend resolves it again and retries once. Under AgentScope, a stale cached bare command can report exit 127 rather than ENOENT; that shell-level case remains documented as a known limitation because treating every 127 as missing could replay a real command failure. Claude waits for the SDK initialization handshake before reporting ready and caches a replacement path only after successful initialization. Codex, Cursor, Grok, local OpenCode, and Claude/Codex metadata commands apply the retry at process launch; Antigravity reacquires its PATH installation and harness together. Explicit executable paths and managed Antigravity installations never use this fallback. Failures after a process starts do not replay agent work.

ACP startup crashes retain their exit code or signal and sanitized stderr, including when the runtime exits before initialization can write. Scope cleanup cannot replace a recorded failure with user cancellation; cancellation without a recorded failure stays cancelled. Managed-runtime installation therefore shows the actual startup diagnostic after an Antigravity abort.

Older failed Claude startups could persist a generated session ID before its transcript existed. If Claude explicitly rejects that resume ID and the cursor records zero turns with no assistant checkpoint or turn boundaries, the adapter recreates the session with the same ID once before accepting a turn. Missing sessions with recorded history remain errors.

Each Claude startup attempt owns a separate prompt queue. Closing a failed SDK query does not cancel its pending input read, so sharing a queue across retries could lose the replacement session's first prompt. Failed attempts now close their query and shut down their queue before recovery.

The current server bundle includes the SDK and uses the configured Claude installation. Upstream packaging removes unused SDK native optional dependencies; the older SDK patch and lockfile-free patch-pinning workaround are no longer active. Windows and WSL ship separate runtime archives, each with its own platform dependencies.

**Implementation evidence:** `packages/provider-core/src/server/executableRecovery.ts`, the Claude and Codex adapter runtimes, `packages/provider-acp/src/server/AcpSessionRuntime.ts`, `packages/effect-acp/src/protocol.ts` and its tests, `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts`, `packages/provider-opencode/src/server/OpenCodeRuntime.ts`, `apps/server/src/provider/Drivers/{ClaudeExecutable,AntigravityDriver}.ts`, `apps/server/src/provider/ClaudeProvider.ts`, `packages/provider-core/src/server/snapshotProbe.ts`, `scripts/build-desktop-artifact.ts`, and `pnpm-workspace.yaml`.

**Recorded validation:** 352 focused tests passed across 11 affected suites on Windows, with 14 existing platform skips. Recovery tests cover synchronous and asynchronous Claude startup failures, replacement-path caching, one retry, explicit-path exclusions, real child-process launches, and Antigravity executable/harness reacquisition. The stale Cursor rollback assertion now checks the current navigation contract. Codex metadata tests were run without the inherited `T3CODE_CODEX_LAUNCH_ARGS` override. The OpenCode localhost output fixture timed out in combined runs and passed isolated reruns. `vp check`, `vp run typecheck`, and `git diff --check` passed. Earlier integrations verified initialization and packaging.

ACP protocol, client, process-lifecycle, and managed-installer suites pass all 132 cases on Node 26. Startup-abort diagnostics, queued and future write failures, and explicit caller and installer cancellation are covered without changing the existing diagnostic grace period or installer assertions.

The empty-session follow-up initially verified initialization only. A later real-SDK probe reproduced the failed query stealing the replacement's first prompt; the fixed probe delivered that prompt to the replacement and received native `system/init`. All 159 Claude adapter tests passed, including prompt delivery after missing-session and stale-executable recovery.

The executable recovery primitive now lives in `packages/provider-core/src/server/executableRecovery.ts`, with all provider app-server, ACP, OpenCode, Claude/Codex text-generation, and Claude SDK launches retrying stale bare PATH resolutions once. The failed cached PATH entry is evicted before the retry, and Claude passes the configured bare command separately from its resolved SDK path so Windows recovery remains reachable. Claude also recreates a missing resume session only when its provider thread has no persisted turns; gateway model metadata now drives Claude model IDs and effort in both orchestration and text generation.

**Last updated:** 2026-11-12

### DL002 — Machine context beside the empty-state hero

The upstream draft hero remains the empty-state headline. The fork adds `On <machine-name>` as its supporting line and uses the same machine label in the existing non-draft empty state. The project already appears in the hero headline, so the supporting line identifies the environment instead of repeating the project name.

Projectless drafts retain upstream's scratch-project picker beside the machine context.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/DraftHeroHeadline.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`, and `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`.

**Recorded validation:** `vp test apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-11-07

### DL004 — Preview navigation and automation hardening

Windows server preview tabs use headless Chromium even when the desktop app is attached. This removes their dependency on Electron guest compositing when displays are off. The desktop shows these tabs through the existing preview stream. Windows must remain awake for agents and remote connections to run.

The fork hardens desktop collaborative preview control. A debugger detach invalidates the cached Chrome DevTools Protocol attachment, URL-bearing `preview_open` waits for new and reused tab readiness, and a committed `LoadFailed` state is returned as an automation failure rather than a successful load.

Automation also retries dynamic click/type targets, re-resolves click targets after cursor movement, keeps snapshots coherent across DOM mutations, bounds guest viewport work, and quarantines an unresponsive host so later requests can fail over and recover without reconnecting the environment. Hung native control work now times out below the broker deadline and detaches only its cached debugger session, so the same tab can reattach instead of retaining a blocked control permit.

The broker acknowledges receipt from the live in-process server browser before starting page work. A slow navigation or snapshot can therefore time out without being mistaken for a disconnected host, while a stream that never acknowledges is still quarantined and failed over. Timeout cleanup also preserves hosts whose completion arrived after the deadline. The former web automation host and its unused client request consumer/readiness helpers were removed after upstream stopped mounting that host; desktop does not acknowledge broker requests.

Browser development's single-origin Vite proxy behavior, including shared and Tailscale origins, is upstream behavior and is not a fork divergence. Explicit IPv4 loopback URLs remain only for the desktop renderer and local-preview automation, where they protect Windows local routing.

**Implementation evidence:** `apps/desktop/src/preview/Manager.ts`, `apps/server/src/preview/ServerBrowser.ts`, `apps/server/src/mcp/PreviewAutomationBroker.ts`, `apps/server/src/mcp/toolkits/preview/handlers.ts`, and `packages/contracts/src/previewAutomation.ts`.

Upstream owns the pinned Electron debugger reference and bounded screenshot retries. Those fixes compose with the fork's stale-session detection and control deadlines; a screenshot that succeeds on retry keeps its debugger session. Upstream #17525 reattaches a tab as soon as Chromium drops its debugger; the fork keeps the lazy detach of a stale or hung session next to it, so both paths reach the same fresh attachment.

**Recorded validation:** focused desktop preview, web readiness/viewport, broker, MCP, and dev-runner coverage, including same-tab recovery from stalled CDP and capture work, stale-host failover, acknowledged slow-operation recovery, timeout cleanup races, and `LoadFailed`; `vp check` and `vp run typecheck`. An isolated Electron run reproduced a full-load timeout against a page with a never-ending image request, then confirmed same-tab evaluate and snapshot remained available. The 2026-09-01 merge-focused suites reran the affected desktop, server, and web preview recovery paths. The 2026-11-16 Windows pass covered 123 server browser and context tests, real Chromium automation through the broker with an available desktop channel, and streamed page input in an isolated web client. Browser profile fixtures use host-native paths, and the desktop upload fixture connects directly to Chromium's announced WebSocket endpoint.

**Last updated:** 2026-11-16

### DL005 — Windows portability in CLI fixtures, Git, and tests

The server pins `node-pty` to the version targeted by its Windows terminal patch. Installer and
CLI archive staging resolve dependencies without the repository lockfile; a version range could
select a newer beta and fail installation because the version-specific patch is unused.

The shared fixture launcher dispatches by shebang: shell fixtures use Git for Windows `sh.exe` and Node fixtures use the current Node executable. These dispatch rules and the remaining platform-specific test expectations compose with upstream's broader Windows fixture portability fixes.

Git fixtures set repository-local `core.autocrlf=false` when exact LF content is part of an assertion, preserving the tested reset and restore behavior across Windows installations.

Git worktree comparison uses native realpaths and case-folding on Windows so Git for Windows path canonicalization cannot mistake the main checkout for another worktree. Git status cache keys use the same canonical path, so Windows long paths and their 8.3 aliases share one VCS snapshot and refresh history.

Server-router and HTTP MCP fixtures use native HTTP clients with OS-assigned loopback ports. Windows can assign port `6566`, which Fetch blocks before connecting. Explicit compression checks retain Fetch and its automatic decompression. The fixtures retain real HTTP requests and their status, body, and session assertions.

**Implementation evidence:** `packages/shared/src/shell.ts`, `apps/server/src/git/GitManager.ts`, their remaining fork-specific fixture and canonical-path tests, `apps/server/src/mcp/McpHttpServer.test.ts`, `packages/tailscale/src/tailscale.test.ts`, and `oxlint-plugin-t3code/test/utils.ts`.

**Recorded validation:** targeted Cursor/Grok ACP, provider-runtime ingestion, checkpoint, Git PR-selector, desktop, relay, workspace, Tailscale, and oxlint suites on Windows; `vp check` and `vp run typecheck`.

**Last updated:** 2026-10-30

### DL006 — Durable sidecar checkpoints and recoverable navigation

V2 turn checkpoints live in a private bare-Git sidecar repository below the server's checkpoints directory, addressed by opaque `t3-sidecar:v1:` locators bound to the repository and worktree. Capture, restore, and diff never write refs, objects, or an index into the project repository. One sidecar repository serves a repository's linked worktrees. Capture, restore, and diff are serialized per sidecar; background packing (DL050) takes that lock only to swap packs, and storage cleanup (DL051) removes snapshots no thread needs. Capture records project HEAD and its reflog position. When a turn changes branches, a synthetic turn-start tree in the sidecar preserves the authored diff without importing project history or writing project refs. Authored-path filtering distinguishes fetched commits from commits made in linked worktrees through their reflogs. A scope id too long for a snapshot id is hashed.

Checkpoints captured between the 2026-10-08 redo and this re-port were written as `refs/t3/orchestration-v2/checkpoints/*` refs in the project repository. They still load, diff, and restore: each boundary lookup tries its sidecar snapshot first, then that in-repo ref. New boundaries always go to the sidecar. Upstream's checkpoint rollback locking and the per-workspace capture lock are unchanged.

A rollback leaves the forward checkpoints ready so the user can redo back to them. Command intake accepts retained rolled-back runs while rejecting checkpoints from an abandoned forward branch. Restoring a checkpoint refreshes workspace entries and local VCS status for both undo and redo. Upstream #21804 retires those stale checkpoints during rollback; the fork keeps redo, adapts upstream's rollback tests to expect them ready, and removes upstream's unused rollback `staleCheckpoints` query and `CheckpointService.deleteStaleRefs`. The lower `CheckpointStore.deleteCheckpointRefs` chain is kept to match upstream.

Upstream #14892 marks a checkpoint `missing` when its workspace folder is ignored by the repository. Sidecar captures enforce the same rule in `SidecarCheckpointRepository.ts`: an ignored workspace is rejected only when Git lists no tracked or re-included files in it (`CheckpointStore.test.ts` covers rejection, a force-tracked file, and a negated rule).

Sidecar capture runs Git with `-C` at the worktree root, so paths stay worktree-relative when the server's own working directory is inside the project, as when T3 Code develops itself. An uninitialized submodule, an empty folder at a tracked gitlink, is captured as the gitlink commit the project index records rather than failing the whole capture.

Recreating a managed checkout preserves any leftover folder until rollback completes. Before files are restored, failures or interruptions put the original folder back; a later failure keeps it aside and reports its recovery path rather than deleting uncertain user data.

Legacy checkpoint tables remain for schema compatibility. V2 navigation uses upstream's checkpoint rollback with the fork's retained forward checkpoints for redo; no server code reads the former capture-job or navigation-journal tables.

Persistence keeps canonical upstream migrations `001`–`096` in `effect_sql_migrations` and fork migrations `001`–`016` in the independent `fork_sql_migrations` ledger. Rolling direct-pairing sessions remain fork migration `016`; upstream Connect device approvals use their canonical migrations `090`–`091`. Startup takes a rollback copy before converting known historical fork rows by name, repairs missing upstream migrations below the recorded high-water mark, and runs the guarded fork migrations. Historical fork records at `059`–`067` can remain in the fork ledger without suppressing lower fork migrations.

The old ID-58 prompt-suggestion collision is repaired by canonical upstream migration `048_ProjectionThreadBranchPullRequest` and fork migration `009_ProjectionThreadMessageSuggestions`. This preserves both columns even when the original numeric ledger skipped the branch column. Startup also removes the legacy checkpoint table's foreign key to `projection_turns` before upstream `063_DropUnusedV1Projections` drops that table. Incoming upstream migrations `065`–`069` retain their canonical IDs, including webhook deduplication and message-search schema.

Historical fork records are recognized by name. Repair of a V2 preview database moves only its two known preview rows and records `054` only when that slot is free; it leaves later or unfamiliar rows to the upstream migrator and the fork ledger, so a preview database that already holds newer upstream rows still starts. Upstream rejects such a ledger. Codex and Claude checkpoint navigation fork the saved native conversation at the selected provider-turn boundary instead of destructively truncating it. Captures retain the native source, and older checkpoints acquire it before their first navigation. Redo restores the original terminal run and root-node states as well as files and conversation context. Restoration events reach clients but do not repeat live completion handling, usage metrics, settlement, or automatic retries. A new message after undo abandons the previous forward branch.

Terminal provider events end the workspace mutation for their exact turn and settle the run before local VCS status refresh or checkpoint capture. Checkpoint capture runs as a follow-up effect and records the checkpoint when it succeeds, so a slow or unavailable VCS backend cannot leave the conversation showing as active. Capture and mutation intervals are serialized instead of preempting one another, preventing normal provider turns from producing `workspace-mutated` checkpoints. A capture waiting for active work releases the worktree gate, so provider turns in other threads can join the same mutation cohort and share its next stable checkpoint boundary; an already-running capture and checkpoint navigation remain exclusive. Aborted turns and provider-turn handoff ownership retain the same exact-owner completion semantics. A stale lease with no active provider turn is recovered automatically; if ownership is ambiguous, the provider turn continues without checkpoint navigation instead of blocking the conversation. Failed mutation-blocked text messages expose a retry action that reuses the persisted user message when available or recreates an optimistic-only message without duplicating it in the UI.

Durable completion retains the provider placeholder assistant-message identity, including interrupted turns. Workspace status refresh runs through a coalesced background worker after capture receipts, so slow Git inspection cannot delay turn completion.

Sidecar repositories inherit the workspace's `core.autocrlf` and `core.eol` settings so restoring a checkpoint preserves its line endings under Windows Git defaults. Empty nested workspaces remain present after checkpoint cleanup.

Batched allowlisted config reads preserve Git includes and global/local precedence. The sidecar skips unchanged writes and clears removed line-ending overrides only when present. This avoids repeated Windows process cleanup after normal missing-setting queries.

Capture jobs that first lose the workspace-mutation race or fail can be re-enqueued for the same logical turn boundary. The durable row is reset to pending and remains the single job for its snapshot, while pending, running, and ready jobs are still deduplicated.

Capture keeps one private index per worktree inside the sidecar repository and passes every tracked or unignored path to `git update-index`, so only files whose stat changed since the last capture are hashed again, as for the project's own index. Paths the workspace no longer has leave that index, and a tracked file that was deleted or replaced by a folder is captured as gone. The index starts over empty when `.gitattributes` or the sidecar's copied core settings change, after any failed Git command, and before sidecar gc, so each tree matches one built from an empty index. A second pass over the same index rehashes anything edited during capture and rejects the capture when the trees differ. Deleted and renamed files restore correctly without changing the user's Git index.

Standalone checkpoint slash commands dispatch locally even when a provider does not expose plan-mode controls. Client event reduction recomputes checkpoint navigation with the same helper as the server. A captured checkpoint, provider cursor change, or rollback updates undo/redo availability immediately. The client cache schema invalidates older snapshots whose navigation metadata never updated. Navigation menus react when availability changes, and matching failures release the pending state. Redo refreshes bounded transcript state for every observer, including clients opened while undone. Authoritative history-page distances preserve expanded and inherited history without searching indefinitely for discarded entries; late history responses cannot revive rolled-back rows.

**Implementation evidence:** `packages/shared/src/orchestrationV2CheckpointNavigation.ts`, `apps/server/src/checkpointing/{SidecarCheckpointRepository,CheckpointRepositoryIdentity,CheckpointStore}.ts`, `apps/server/src/orchestration-v2/CheckpointService.ts`, `apps/server/src/persistence/Migrations/{036_CheckpointDurableState,037_CheckpointLegacyMigration,038_CheckpointCaptureProviderMetadata}.ts`, `apps/server/src/persistence/ForkMigrations.ts` (whose history reconciliation is covered by `Migrations/{039_ReconcileCheckpointAndTitleHistory,046_ReconcileUpstream41History,053_ReconcileUpstream47History}.test.ts`), and their tests. `CheckpointStore.test.ts` holds the sidecar characterization suite, including a comparison of reused-index trees against empty-index `git add` trees across tracked, untracked, deleted, binary, symlinked, ignored, file-to-folder, mode, and attribute changes; `apps/server/src/orchestration-v2/CheckpointService.sidecar.test.ts` runs turns against real temporary repositories and asserts that `git for-each-ref refs/t3` stays empty, that restore works, and that an in-repo checkpoint from the redo period still restores.

**Recorded validation:** Sidecar branch-switch and imported-commit cases cover legacy, sidecar, and mixed boundaries without changing the project index or refs. All 89 rollback/safety cases pass, including preflight, provider-startup, restore, interruption, and compensation failures. A consistent copy of a real database upgrades to 96 upstream and 16 unchanged fork records, reruns with zero writes, and passes SQLite integrity and foreign-key checks. A paired production client completed a live Luna file change, undo, and redo; a second client observed both transitions.

Earlier validation: migration and durability regression matrices, sidecar characterization (including unborn repositories, submodules, and linked worktrees), orchestration integration including serialized full-turn capture, deterministic post-capture lease release, stale-lease recovery, non-blocking checkpoint degradation, and persisted-message retry, Windows isolation slices, upstream-ledger reconciliation through migration `047`, full `vp test`, `vp check`, `vp run typecheck`, and `git diff --check`. The 2026-09-01 merge-focused server tests also covered checkpoint projection and reactor behavior after upstream bounded activity hydration and provider event-lifecycle fixes were integrated. The deletion/rename regression and all 15 sidecar checkpoint tests passed on Windows with the user-index preservation assertion.

The 2026-10-02 config repair passed all 28 checkpoint-store tests, including exact restored bytes, conditional includes, repeated values, and removed overrides. A single-file capture benchmark measured 3.2–3.4 seconds against 4.6–4.8 seconds for the original fork implementation.

The 2026-10-16 reused capture index was measured on a copy of a 28k-file workspace: the first capture took 10.4 seconds and later ones 0.60 seconds, against 34–41 seconds per capture for the empty-index `git add` capture, which spent most of its time matching each path against every pathspec. Both methods produced identical trees for the same workspace.

The 2026-10-05 completion split passed the focused RunExecutionService, CheckpointCaptureService, CheckpointService, runtime-layer, recovery, projection, `vp check`, and `vp run typecheck` checks. Settled provider turns now remain settled when follow-up checkpoint capture is slow or unavailable.

The 2026-10-15 re-port restored the 16 sidecar characterization tests the redo dropped (32 checkpoint-store tests pass), plus sidecar authored-path filtering, long scope ids, and the V2 real-repository suite.

**Last updated:** 2026-11-16

### DL008 — Persistent multi-thread split workspaces

Sidebar pointer drags use the same thread-row component inside and outside the sidebar, rendered as a full-row `DragOverlay`. Upstream's label-based `ThreadContextDragGhost` remains for command-palette and sidebar-search drags. The opaque overlay follows the pointer across panels while the hidden source row preserves its gap until release or cancellation. Split-pane drops suppress composer context-drop highlighting and dispatch, and pointer capture keeps release cleanup reliable across panel boundaries.

Collapsed Working, snoozed, and settled shelves keep all displayed split panes visible in the sidebar.

The fork supports up to ten visible thread panes in five columns and two rows. Panes fill columns at full height until a sixth pane opens the lower row. A full-height pane accepts a thread above or below it in its outer quarters; its middle half accepts left/right placement while fewer than five columns exist. A stacked column accepts only left/right placement while fewer than five columns exist. Left/right drop hints cover the full destination column, including both rows of a stacked column. Blocked drop areas show no hint. Split layouts retain focused-pane routing, a shared toolbar, one right panel, and controlled ownership of global keyboard, preview, and composer behavior. The right-panel toggle reflects the shared split layout and closes every open pane panel together, so changing focus cannot reopen a panel owned by another pane. Panes can be opened or detached from the sidebar, safely reconcile draft promotion/archive/deletion, and animate layout changes without leaving stale portals or listeners. Reconciliation never returns a deleted thread as the fallback when all panes disappear.

Split view respects upstream's tag filter while recording. `resolveVisibleSplitPanes` skips hidden panes without changing the saved group. A hidden route thread falls back to `ThreadRouteView` for upstream's redirect; fewer than two visible panes also renders single view.

Both pointer drags and native sidebar drags can create the first split on either side of a thread or place a pane above or below an unstacked column, with the hint and insertion using the same pointer position. Detaching the focused pane through the sidebar routes to the remaining pane. Thread context menus can detach one pane or dissolve the entire containing split group. Entering a thread route restores its saved group, including navigation from the command palette, notifications, citations, and browser history; preloading a route leaves the current layout alone.

Split membership is persisted as multiple ordered local groups with active state and stable group colors. Selecting any member restores its group; the sidebar preserves group tinting, support pane and thread drag placement, and show complete left/right drop intent. The group tint is textured with an inline desaturated SVG grain so the color-coded row reads as a surface rather than a flat slab. The grain is a masked pseudo-element rather than a second background layer, because background layers cannot carry their own mask and unmasked grain also covers the gradient's faded tail, flattening the row back into a uniform slab; the overlay shares the tint's fade axis and stops short of its extent so the texture is gone before the color is. Group hues carry a hue-dependent chroma: a flat chroma across the wheel does not read as a flat saturation, since yellow-green renders at full strength while red and blue are gamut-clipped, so chroma eases down around yellow-green. Rows supply only the hue and that chroma, leaving the stylesheet to compose per-theme lightness and strength — light mode takes a deeper, less translucent tint because the translucency that reads as a clear band on the near-black sidebar washes out against zinc-50. The current sidebar also names the other panes in each grouped thread's details tooltip, keeps displayed panes visible when settled or snoozed shelves are collapsed, and preserves split actions in its context menu. Right-panel ownership remains useful when focus moves to a pane with no surface of its own.

Maximizing the shared right panel in a split collapses the whole pane column to zero width and makes the pane grid inert, so the panel fills the workspace. Panes stay mounted, so restoring keeps their order, sizes, focus, scroll, and drafts. Only the focused pane that owns the panel can maximize it (`isSplitRightPanelMaximized`), so moving focus to another pane restores the split, and closing the split's panel clears the flag. The header slot stays outside the inert grid so the titlebar restore control keeps receiving clicks. In single view the titlebar controls likewise render beside the chat column rather than inside it; upstream renders them inside, where the column's `inert` while maximized lets the panel tab bar take the restore click. The narrow-screen right-panel sheet has no in-panel maximize button (the fork removed it in 602682f97b); the sheet already covers the chat. Upstream side chats render an embedded ChatView that every pane-owner guard skips (`isActivePane && !embedded`), so a side chat never takes focus, shortcuts, menus, or preview actions from a pane. The right panel's owner pane is sticky (`resolveSplitRightPanelOwner`), so a side chat stays with its parent pane's thread when focus moves to a pane without a panel.

**Implementation evidence:** `apps/web/src/{splitViewStore,splitViewDrag,splitViewNavigation}.ts`, `apps/web/src/components/{SplitThreadWorkspace,ThreadRouteView,SplitPaneDropHint,Sidebar,CommandPalette,RightPanelTabs,ChatView,chat/ChatComposer}.tsx`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/SplitThreadWorkspace.test.tsx` (maximize ownership and "never renders a thread the tag filter hides"), `apps/web/src/components/SplitThreadWorkspace.browser.test.tsx`, `apps/web/src/routes/_chat.tsx`, `apps/web/src/index.css`, `apps/web/src/hooks/useThreadActions.ts`, and the chat routes.

**Recorded validation:** The integrated production client opens a two-pane group from the sidebar context menu, retains the group and both pane drafts after reload, and reports no runtime page errors.

Earlier validation: 248 focused tests across split state, navigation, native drag events, route history, sidebar logic, workspace, right-panel, notification, and citation behavior; `vp check`; `vp run typecheck`; and `git diff --check`. The 2026-09-28 isolated paired-browser pass confirmed that pointer hints switch between left and right and a left drop places the dragged thread before the original. The Browser panel then lost its automation host, so the remaining live flows and screenshot capture could not be completed. Native legacy drops and route restoration were verified by automated tests. An unrelated existing command-palette sorting test still fails in unchanged code. Earlier integrated checks cover composer shortcut ownership and shared right-panel closing. The 2026-09-29 5x2 extension passed 211 focused tests, `vp check`, `vp run typecheck`, and an isolated paired-browser pass at 2560x1440 showing five full-height columns and a sixth pane below the first. The drop-area correction passed 214 focused tests; an isolated paired-browser pass confirmed top and bottom native drops, and confirmed that a filled column at five columns accepts no drop or hint while an unstacked column still offers the top hint. The 2026-09-29 standalone vertical-drop and group-detach update passed 220 focused tests, including top/bottom native and pointer targets, active/inactive group dissolution, and both sidebar menu paths; the isolated browser pass confirmed the new menu item, top and bottom first-split hints, and the resulting stacked two-pane layout.

The 2026-10-07 drag update passed 90 focused drag tests, `vp check`, `vp run typecheck`, and `git diff --check`. Remote user verification confirmed the full thread-row overlay follows the pointer and the source gap remains visible outside the sidebar.

The 2026-11-01 split-maximize change passed `SplitThreadWorkspace.test.tsx`. In a seeded dev app driven by real mouse clicks in headless Chrome, maximize and restore worked in single view and in a two-pane split (button, keybinding, close while maximized, focus change), with the pane draft preserved.

Pinned and Active drag boundaries occupy normal layout rows, including an empty Pinned group. Sorting uses their measured heights so labels keep consistent spacing in Manual and Last input ordering.

**Last updated:** 2026-11-16

### DL013 — Codex availability through catalog and turn failures

Codex model and skill discovery shares the authenticated app-server probe's 20-second budget, ending 250 ms before its outer deadline. A discovery timeout keeps the account result with missing enrichment. ChatGPT model discovery waits up to three seconds for the startup catalog refresh, then uses the first catalog if no refresh arrives. Skills discovery has no separate three-second deadline. A skills/list or model-list RPC error reply is handled like a timeout: the probe logs a warning and keeps the account result, with no skills or a `warning` status saying Codex did not return its model catalog. App-server process or transport failure still fails the probe.

App-server errors are classified by scope: retryable transport errors remain warnings, while a typed non-retryable turn error emits the terminal failed-turn lifecycle needed to release the thread for a follow-up message. Actual process or transport failure still marks the session unavailable. The V2 adapter has no equivalent of the former 30-minute root collaboration-wait watchdog. Upstream terminal-state, hard-stop, tool-identity, and liveness behavior remains in place.

**Implementation evidence:** `apps/server/src/provider/CodexProvider.ts`, `apps/server/src/provider/CodexProvider.test.ts`, `apps/server/src/provider/CodexProvider.catalog.test.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `apps/server/src/orchestration-v2/ProviderEventIngestor.ts`, and `packages/contracts/src/providerRuntime.ts`.

**Recorded validation:** focused Codex provider, adapter, and provider-runtime ingestion suites; `vp check`; and `vp run typecheck`. The catalog suite injects `skills/list` and `model/list` RPC errors into a fake app-server, and a live check through a Codex shim showed the configured instance staying available when either RPC failed.

**Last updated:** 2026-11-07

### DL014 — Loadable checkpoint diffs with a legacy baseline fallback

Sidecar diffs (DL006) use upstream's NUL-delimited numstat format for file summaries and reject output overflow rather than publishing an incomplete file list. Full patch requests remain available for the diff viewer, including upstream's path-limited patches that leave out files a pull, merge, or rebase brought in.

A thread-start diff resolves the baseline as its sidecar snapshot, then as the in-repo ref an older thread recorded. When neither exists, as for an older thread that never captured a baseline, it compares against repository `HEAD` instead of failing. This is the surviving baseline fallback from former DL011; provider-derived summary fallback is not retained.

The client shows turn diff summaries only for `ready` checkpoints. Rows with a `missing`, `error`, or `stale` checkpoint have nothing to load, so they never show a diff card or DiffPanel entry.

**Implementation evidence:** `apps/server/src/checkpointing/{CheckpointDiffQuery,CheckpointStore,SidecarCheckpointRepository}.ts`, `apps/server/src/orchestration-v2/CheckpointService.ts`, and `apps/web/src/hooks/useTurnDiffSummaries.ts`, with their tests. `CheckpointStore.test.ts` covers the sidecar HEAD fallback and sidecar authored-path filtering. `CheckpointDiffQuery.test.ts` and `orchestration-v2/CheckpointScopeOwnership.test.ts` cover the baseline lookup, and `useTurnDiffSummaries.test.ts` covers hiding non-ready rows.

**Recorded validation:** focused checkpoint query, sidecar store, scope-ownership, and web-summary tests, plus the 140 replay fixtures. All passed on 2026-10-15.

**Last updated:** 2026-11-01

### DL015 — Case-safe composer subagent utility filename

The composer subagent utility module uses a distinct basename from the `ComposerSubagents.tsx` component so Windows case-insensitive resolution cannot merge the two modules during typecheck.

**Implementation evidence:** `apps/web/src/components/chat/composerSubagentUtils.ts`, `apps/web/src/components/chat/ComposerSubagents.tsx`, and `apps/web/src/components/chat/composerSubagents.test.ts`.

**Recorded validation:** mobile typecheck and repository typecheck on Windows.

**Last updated:** 2026-09-24

This is a current-state record only. Each entry describes a surviving difference between `HEAD` and the latest shared base, determined with `git merge-base HEAD upstream/main` (updated by the latest sync merge). A feature adopted from upstream is not a divergence merely because it was involved in a merge.

Keep stable IDs when updating this section; gaps are intentional. When upstream absorbs a difference, remove or rewrite the entry rather than preserving chronology here. Update its behavior, implementation evidence, and validation when the surviving difference changes.

### DL017 — Existing-worktree selection for new threads

The new-thread Workspace controls expose a neighboring Worktree selector in Current checkout mode. It defaults to Git's primary checkout and can pin the draft to any existing branched or detached worktree without switching branches or creating another checkout. When the thread materializes, that control becomes an immutable label using the same compact naming: `Main` for the primary checkout, the branch name for branched worktrees, and the seven-character HEAD hash plus `[detached]` for detached worktrees. Locked-thread label resolution uses a one-shot lookup rather than maintaining worktree polling; while that lookup is pending, or when the thread's worktree no longer exists, the label falls back to the thread's recorded branch, and to `[detached]` only for a thread without one. Upstream's next-message worktree recreation then restores the checkout under that branch. While a branched thread's worktree is missing, the web client still treats it as a Git thread (`resolveCheckoutGitState`): the details card and composer show the recorded branch with the branch picker disabled, and Git actions such as "Initialize Git", which upstream offers there and which would `git init` the removed path, stay hidden until the worktree is back. Git worktree discovery is environment-scoped, uses NUL-delimited porcelain output for path safety, and distinguishes the primary checkout independently of its branch name. The listing omits worktrees whose folder is gone, including locked ones Git does not mark prunable. The client fetches the list once per connection and only its own create and remove invalidate it, so opening the Worktree or Workspace menu refetches it while the last list stays visible; worktrees removed by the server, the CLI, or another device then drop out. The Previous worktree shortcut offers the most recent thread whose worktree is still in that list.

**Implementation evidence:** `packages/contracts/src/git.ts`, `packages/client-runtime/src/state/vcs.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/ws.ts`, `apps/web/src/state/queries.ts`, and `apps/web/src/components/{BranchToolbar,BranchToolbarWorktreeSelector,BranchToolbarBranchSelector,ChatView}.tsx` (ChatView passes the thread branch to the toolbar and `chat/ThreadDetailsPanel.tsx`), and `resolveCheckoutGitState` in `ChatView.logic.ts` with its `ChatView.logic.test.ts` case. Menu-open refresh: `BranchToolbarEnvModeSelector.tsx`, `vcs.test.ts`, and `resolvePreviousWorktreeSeed` cases in `BranchToolbar.logic.test.ts`.

**Recorded validation:** focused contract, Git driver, and BranchToolbar logic tests; `vp check`; `vp run typecheck`; and an isolated paired dev-app startup. The live preview rerun was blocked by the unavailable T3 preview host tracked in Papercut #36. On 2026-11-01 a seeded dev app showed the branch name instead of `[detached]` after a thread's worktree was removed outside the app, with no "Initialize Git" action and the branch picker disabled, and the next Claude Haiku message recreated the worktree on that branch. On 2026-11-18 a dev app kept listing `feature-b` in the Worktree menu after `git worktree remove` on the unchanged code; with the menu-open refresh, reopening the menu showed only `Main` and `feature-a`.

**Last updated:** 2026-11-18

### DL018 — Child-thread navigation and retained composer metadata

Orchestrator V2 models provider-native subagents as real child threads with durable lineage. The
parent projection records each child thread, parent/root identifiers, relationship, status, model,
reasoning effort, and result. Child activity remains isolated from the parent's message stream and
checkpoint state. Selecting a child uses the normal thread route; a child route exposes lineage
controls that return to its parent or open related children. The old Agents panel and right-panel
transcript view are removed.

The fork retains the composer Subagents dropdown and its status, provider/model, reasoning, and
branch metadata. The dropdown lives in the composer context strip, so on an active thread it shows
only when Settings → Appearance → Composer context is on (off by default). Upstream's Lineage item
in the thread-details card also lists child threads; the two coexist. The thread-details card stays at full
density while at least half of its natural height fits, scrolling the rest, so lineage actions such as the
Previous agents drawer stay reachable; upstream folds as soon as the full content no longer fits. The dropdown and timeline
links both navigate to the same child-thread routes, so the child transcript is a normal
conversation without a second panel or composer. Provider-native
child lifecycle events remain authoritative, while T3-owned child threads keep the V2 persistence,
notification, and recovery behavior.

A follow-up message sent to a local or linked-environment T3-owned delegated child reopens the original delegated task instead
of creating a separate task per follow-up (upstream #17696). Frequent child failures, such as
provider capacity errors, would otherwise leave a trail of tasks. While the follow-up runs, the task
shows as running with no result and a pending completion delivery. Further follow-ups join that
reopened work, and the task publishes once, after the last of them settles. The task's runs carry
its id, so the result already delivered to the parent is never delivered again, recovery adds
nothing, and automatic monitor wakes on the child never reopen it. Upstream's
`DelegatedCompletionDelivery` follow-up cases keep their exactly-once checks, with their task
identity assertions rewritten for this reopen behavior; upstream's held-queue pause/resume case
passes unchanged.

Remote completion reports are pinned to the child run they observed, so a late result cannot complete a newly reopened task. Settled-task events check the current task state before cancelling question wakes, preserving questions from a reopened follow-up. Owner and management sends find only an unambiguous authorized parent, and retain its mode and scope checks.

The task reports the latest of its runs that actually started. A follow-up cancelled before it
started, or one waiting in a held queue (after Stop or a provider failure), does not count, so
cancelling a queued follow-up restores the earlier result without a second transfer or wake.
While a stopped queue holds a follow-up, the task shows idle with no result; resuming the queue
returns it to running, and it publishes the follow-up's result once (upstream #21487). Upstream's
`cancelTask` covers held follow-ups, so `task_cancel` uses it and a reopened task with nothing
running can still be cancelled. The delegation's first run is identified by the spawn transfer's target run. A user
follow-up also reopens a task the parent had cancelled, re-arming its completion wake.

Successful delegated task completion waits for the child's own delegates and every nonempty background-work roster, including unawaited commands. Upstream's `backgroundWorkHoldsCompletion` only holds for `awaited: true`. The fork applies the roster check to both the first run and reopened follow-ups, and the delegated-child settlement listener finalizes the task when the roster empties. The task stays
running, and `task_status` reports `waiting_for_children`. While the task is reopened, the
delegated-completion and background-command wakes that settle that work also carry its task id,
so the task publishes the wake's result instead of the interim reply. A follow-up that fails, is
stopped, or is cancelled still settles at once. Upstream has the same gap for its per-follow-up tasks (pingdotgg/t3code#21837, partial fix
in #21877).

Parents remain waiting while a finished delegate's result is pending delivery, including failed,
interrupted, and cancelled results. The server exposes that delivery as unfinished background work
until the parent's continuation starts or the result is delivered, acknowledged, or dismissed.
This prevents a false completed status and completion alert between publishing the child's result
and resuming the parent. Shell snapshots, mobile activity publishing, shell trimming, and automatic
settlement share this hold; delegated-work thread waiters already account for unfinished delivery.

**Implementation evidence:** orchestrationV2 contracts and server layers; ChatView, Sidebar,
ThreadRelationshipsControl, ComposerSubagents, `threadDetailsCardLayout.ts` (density threshold and its test), V2LifecycleRow, V2ItemInspector, rightPanelStore,
and session-logic. Completion gating: `packages/provider-core/src/server/subagentProjection.ts`, the delegated-child settlement listener in `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts` and its terminal-delivery regression, `packages/shared/src/orchestrationV2PendingBackgroundWork.ts`, and `apps/server/src/orchestration-v2/SubagentProjection.test.ts`. Reopen edge cases: `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts` ("reopened tasks whose
follow-up never starts", including "pauses a reopened task behind a held follow-up", and "holds a
reopened task while … runs") and `OrchestratorMcpService.test.ts` (held follow-up cancel, and
the follow-up variant of terminal acknowledgement). Stale question cleanup: `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts` and `Orchestrator.control-reads.test.ts`.

**Recorded validation:** All 116 delegated-completion and control-read cases pass. The outcome table covers failed, interrupted, and cancelled reopened follow-ups with live descendants or background work, while successful follow-ups retain their completion hold. Original reviewer failure probes pass.

The terminal-delivery regression fails without the presentation hold and passes for all four
terminal outcomes, pending and claimed delivery, released delivery, and the parent's continuation.
All 201 focused projection, background-work, thread-wait, and delegated-completion tests pass.
An isolated web session with a controlled ACP replay provider exercised a real delegation and
parent continuation. The delegate finishing caused no completed state or sound; the parent's
final answer played one completion sound. `vp check` and `vp run typecheck` pass. Native mobile UI
was not exercised.

Earlier validation: focused V2 projection, provider-adapter, lineage-control, timeline, sidebar,
and composer tests; vp check; vp run typecheck; and an isolated paired web-app smoke test that
loaded a V2 thread route, confirmed the Agents/right-transcript surface is absent, and confirmed the
composer rendered. The preview client's accessibility snapshot and click calls failed after the app
loaded, so child-route interaction and lineage-control behavior were covered by code/tests only; the
smoke evidence used DOM evaluation and server responses.

**Last updated:** 2026-11-17

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

The effect outbox serializes each thread's effects, but checkpoint capture has its own lane. A pending or hung capture never queues the thread's next `provider-turn.start`, Stop, or other provider effects behind it. Capture and checkpoint rollback still wait for each other, and the workspace lock serializes their file work. A run's checkpoint baseline is the previous run's capture boundary, so while that capture is still running the next run skips its baseline instead of waiting on the workspace lock. The effect worker runs at most two captures at once. Capture and title-generation jobs also share a combined background limit that reserves a worker for turn starts, Stop, and other effects; a single-worker configuration still makes progress.

Because the run releases its provider thread at once, the next run (for example Muse's own report turn after a workflow) can claim the thread before the provider's late "background task ended" update reaches the finished run's stream. That update still removes the ended tasks from the stored roster without overwriting the newer run's snapshot, and the server ignores those tasks in later roster snapshots, so an adapter seeded with the older roster cannot bring them back. Upstream avoids this race only because its `waiting` window usually outlasts it.

Workspaces without a Git repository do no VCS work for checkpoints. VCS detection walks the real path from the cwd up to the filesystem root. When no `.git` entry (directory or worktree file) exists along it, filesystem stats answer without spawning `git`. Every detection caller benefits: checkpoints, status polling, review, and git workflows. The turn's baseline, capture, and diff then record `missing` checkpoints, and finalization skips only the VCS and pull-request refresh, so the file search index still follows the turn's edits. Upstream's detection spawns `git rev-parse` for every check because a negative answer is never cached.

**Implementation evidence:** `apps/server/src/orchestration-v2/{RunExecutionService,CheckpointCaptureService,RunFinalizationService,EffectWorker,EffectOutbox,EventSink}.ts`, `apps/server/src/vcs/VcsDriverRegistry.ts`, and their tests. `EffectWorker.test.ts` covers five cases. A hung capture still lets the next turn start and Stop run on the same thread, which fails without the capture lane. Four hung captures on other threads leave a worker for a turn start. The per-capture timeout lets the run settle. A run whose completion writes all fail keeps its capture queued. A capture and a rollback keep their order. `RunExecutionService.test.ts` starts a run while the real `CheckpointService` is still capturing the previous run's boundary. `VcsDriverRegistry.test.ts` resolves a repository and lists its files with `GIT_DIR` and `GIT_WORK_TREE` inherited from the server environment, which `VcsProcess` removes from Git commands unless an operation sets its own value. The late roster clear is covered by `RunExecutionService.test.ts` ("a late roster clear from a released run ends its tasks for good"), `FoundationPersistence.test.ts`, and the `muse_workflow` replay fixture, which fails without it. `apps/server/src/checkpointing/NonGitWorkspace.test.ts` runs a turn's checkpoint work against a real temporary non-Git folder and asserts that no child process is spawned, recorded at the process spawner. It fails without the stat pre-check, and also covers registry detection, symlinked workspaces, and linked worktrees whose `.git` is a file. Upstream's steering, background-stop, and Claude automatic-delivery suites keep every behavioral assertion. Only their "turn finalized" watchers accept `completed` as well as `waiting`. The replay and provider-switch harnesses wait for each completed run's checkpoint before treating a thread as idle.

**Recorded validation:** SteeringCompletion 13, BackgroundWorkStop 12, ClaudeAutomaticDelivery 3, TaskCancelNativeSubagent 1, EffectWorker, CheckpointCaptureService, CheckpointService, RunFinalizationService, RunExecutionService, recovery, and the replay (140/140 including `muse_workflow`)/provider-switch/fork/merge-back harnesses pass.

**Last updated:** 2026-11-12

### DL023 — V2 MCP thread controls

t3_thread_wait accepts up to eight targets. MCP waits use upstream's 30-second default and 45-second maximum, returning recoverable handles before transport deadlines; secret requests retain their separate lifetimes. t3_thread_send can select a provider instance and model, and rejects a provider caller that targets its own thread.
Management keys retain their explicit environment-wide permissions and reviewed tool allowlist. Strict MCP tool schemas advertise and reject unknown parameters.

**Implementation evidence:** `apps/server/src/mcp/OrchestratorMcpService.ts`, the thread toolkit,
`packages/contracts/src/orchestratorMcp.ts`, and the management API key contracts.

**Recorded validation:** The complete MCP toolkit and HTTP suites pass, including the retained strict-argument, authorization, multi-target, and thread-control behavior.

**Last updated:** 2026-11-16

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

Claude's fork-specific model ID and effort normalization applies to gateway, custom, and bundled models with a manual override. Bundled models without overrides use upstream's cwd-scoped Bedrock/Vertex routing and catalog path, preserving current `xhigh` support (including the 5.5 and Fable 5.1 models); live model switches resolve the effective API ID and effort once and reuse that selection for the process, flags, and query identity.

Models carry usable context, theoretical maximum context, maximum output, and metadata provenance.
Every visible model accepts manual display, context, output, and reasoning overrides; manual values
win over gateway and harness metadata. The Models information tooltip shows every known value
without inventing missing metadata.

The gateway controls remain part of upstream's split provider settings editor. Existing opaque
credentials survive settings refreshes, and the UI replaces or removes a stored key without
round-tripping its value through provider snapshots.

Saved provider changes take effect when an idle session is next used. The session manager compares
the current provider instance with the one that opened the session and replaces stale sessions while
preserving their native conversation IDs. This covers gateway keys, URLs, authentication, catalog
and image-generation options, and provider environment settings. Active turns and background work
keep their session until a later idle use. Disabled or removed instances cannot accept new turns
through an existing session.

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
`apps/server/src/orchestration-v2/{ProviderAdapterRegistry,ProviderSessionManager}.ts` and their tests,
`apps/server/src/textGeneration/ClaudeTextGeneration.ts`,
`apps/web/src/components/settings/{AddProviderInstanceDialog,CompatibleApiGatewaySection,CustomModelMetadataDialog,ProviderInstanceCard,ProviderModelsSection,ProviderSettingsPanel}.tsx`,
and `apps/web/src/components/settings/providerModelDetails.ts`.

**Recorded validation:** focused gateway parsing and cache tests, Codex and Claude provider relay
tests, settings and server contract tests, provider-settings component tests, model-picker regression
tests for authoritative gateway rows, `vp check`, `vp run typecheck`, and integrated web verification
of gateway configuration, custom model metadata, and model-detail tooltips. The 2026-09-03
add-instance dialog scroll fix was verified in a browser at 1000x720 and 390x700 with the gateway
section expanded.

Session-refresh verification passed 52 focused session-manager and adapter-registry tests, focused
lint, `vp check`, and `vp run typecheck`. An isolated paired web client ran three turns through the
real Codex CLI against a recording gateway. Replacing the key, changing the URL and authentication
mode, and enabling native catalog discovery and image generation updated the subsequent requests
and launch configuration without restarting T3 or changing the native conversation ID.

Claude adapter and text-generation launches now resolve each selected gateway model through the per-instance catalog, applying `[1m]` model IDs and normalized CLI effort before opening or spawning.

**Last updated:** 2026-11-16

### DL027 — Remote editor links select the server account

Upstream advertises the operating-system account running the server when it can be resolved. The fork retains a raw `@` separator in VS Code Remote-SSH authorities and resolves Windows domain accounts. The web client includes that account inside the
VS Code Remote-SSH authority (`ssh-remote+user@host`), so Windows clients do not
fall back to their local username. Windows AD accounts use `USERDOMAIN\\username`
only when `USERDNSDOMAIN` confirms a domain and the name is not the local
computer/workgroup. Local accounts use the unqualified username. Systems that
cannot resolve an account omit the field and retain host-only behavior.
Desktop-managed SSH aliases remain authoritative and continue to omit the
advertised account. Links retain upstream's `:1:1` file-position suffix. The username field is optional for compatibility with older
server configurations.

**Implementation evidence:** `packages/shared/src/HostProcess.ts`,
`packages/contracts/src/editor.ts`, `apps/server/src/environment/RemoteOpenTargets.ts`,
`apps/web/src/remoteOpen.test.ts`, and `packages/shared/src/HostProcess.test.ts`.

**Recorded validation:** focused contract, server target discovery, web remote-open,
and Electron shell tests.

**Last updated:** 2026-11-12

### DL028 — One manual fork desktop release for every updater platform

The fork publishes desktop builds only through the manual **Fork Release** workflow. One dispatch builds Windows x64 (unsigned NSIS), macOS arm64 and x64 (DL030), and Linux x64 (AppImage and `.deb`) on GitHub-hosted runners, then publishes a single GitHub Release in this repository with `latest.yml`, a merged `latest-mac.yml`, and `latest-linux.yml` (`nightly*.yml` for nightlies). The platform workflows are reusable build steps with no dispatch trigger of their own. electron-updater's GitHub provider picks the release before it reads the platform manifest, so a release missing any platform would break that platform's Update button; the publish job refuses to run unless every manifest exists. Windows still builds the Linux CLI archive the packaged WSL backend needs; that job installs or checks `patchelf`, which upstream's CLI archive build now requires, and builds the CLI executable with the Node version in `package.json`, as upstream does. Like upstream's release, the macOS x64 build makes sure Rosetta is installed before generating the x64 server compile cache on the Apple Silicon runner. Because the fork packages Windows on a Windows runner, electron-builder's `afterPack` also writes the prepared server compile cache that upstream's Linux-hosted Windows build skips, one file per server chunk loaded at startup (31 on 2026-11-23 `dev`, 36 with the gateway helper). With upstream's transcription DLLs, a native build reaches 100–105 files, so the fork raises `WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT` from 80 to 112.

Preflight accepts only `X.Y.Z` or `X.Y.Z-nightly.YYYYMMDD.N`, because the updater ignores other suffixes. It rejects a tag that already exists here or on upstream, and a stable version that is not newer than the latest stable tag. Fork versions follow upstream patch × 100 + fork build (`0.1.7` → `0.1.701`), so they never equal an upstream version. A blank version input derives the next build from `apps/desktop/package.json` (upstream's `0.1.7`, so `0.1.701` onward) and the fork's tags; a `.0` base starts at build 50 to stay clear of upstream's next patches. Unsigned NSIS updates install because electron-updater skips publisher verification when the build has no `publisherName`.

Published AppImages use upstream's versionless, channel-specific names so installed apps can update in place. The completeness check reads the AppImage filename from the Linux manifest and verifies its version against the selected release, alongside the required platform assets.

The macOS arm64 and Windows x64 jobs also build that platform's CLI archive before the desktop app, as upstream's release does, and the publish job attaches them with the Linux one and a `SHA256SUMS` written from the uploaded bytes. The install scripts and shared T3 Code updates (DL066) download these, so the publish job refuses to run without all three. There is no macOS x64 archive, as upstream. The workflow does not publish a `t3` npm package, and `t3 update` and remote server self-update still read upstream's releases; do not use them on fork servers.

**Implementation evidence:** `.github/workflows/fork-release.yml`, `fork-windows-release.yml`, `fork-macos-release.yml`, `fork-linux-release.yml`, and `WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT` in `scripts/build-desktop-artifact.ts`.

**Recorded validation:** The exact workflow manifest reader accepts stable and nightly versionless AppImages and rejects a mismatched release version. Production web, server, and desktop bundles and Linux AppImage/Debian installers build. The AppImage opens, migrates a fresh database to 96 upstream and 16 fork records, retains its backend after its window closes, and reopens at a selected project. Hosted release publication and a two-version update are not exercised by this sync.

Earlier validation: actionlint and `vp fmt --check` on the four workflows. Fork Release run 41066477319 built every platform on hosted runners and published `v0.1.301` with `latest.yml`, a `latest-mac.yml` listing arm64 and x64, and a `latest-linux.yml` listing the AppImage and `.deb`. A two-version update on each OS is not yet recorded.

**Last updated:** 2026-11-18

The manual **Fork E2E Artifacts** workflow builds test desktop installers (macOS arm64, self-signed like fork releases so the keychain treats them alike; Windows x64 NSIS) and macOS, Windows and Linux CLI archives from the dispatched ref, or from a pushed `e2e-X.Y.Z-gwtest.N` tag, because GitHub dispatches only workflows that exist on the default branch. It accepts only `X.Y.Z-gwtest.N`, builds without an updater repository so no update feed is packaged, checks that none is, and uploads one 14-day `fork-e2e-<version>` artifact with `SHA256SUMS`. It never creates a release or a draft, so no installed app, `t3 update` or install script can find these builds.

### DL029 — Selectable sidebar thread ordering

When Working is disabled (upstream enables it by default), the web and desktop sidebar offers **Manual** ordering by default and **Last input** ordering in General settings. Upstream's Labs project-folder (boring) sidebar has no Working shelf; the fork applies the same preference within each folder in place of upstream's fixed latest-send ordering. Manual preserves saved positions and sidebar drag actions. Active rows are reorderable only in Manual with Working off, on top of upstream's `resolveSidebarReorderableThreadKeys` eligibility. Last input ignores saved active-order keys and promotes threads on user-authored messages while retaining creation and un-settle lifecycle anchors. Delegated-agent messages and automatic wakes do not advance Last input ordering; older servers without a user-authored timestamp retain the user-role timestamp fallback. Switching modes preserves saved keys. While upstream Working is enabled, the Inbox uses return-priority order, placing threads that most recently returned for attention first. Disabling Working restores the saved Manual or Last input preference. Active-row manual reordering is unavailable while Working is enabled; pin actions, shelf moves, and dragging into splits remain available. Dragging a row into the conversation creates or extends a split in either mode, without a separate grip control. Initial split creation reuses the existing pane-drop overlay to show its right-side placement. The dragged row uses the same row appearance in a document-level drag overlay, preserving sidebar scroll position and avoiding clipping behind the conversation.

**Implementation evidence:** `packages/contracts/src/settings.ts`, `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/Sidebar.logic.ts`, and their focused tests.

**Recorded validation:** focused settings, sidebar sorting, pointer lifecycle, and split target tests; isolated browser checks for initial split creation, pane placement, manual reordering, Last input mode, and settings persistence; `vp check`; and `vp run typecheck`. The 2026-10-26 regression checks cover agent messages, threads without human input, subsequent user messages, and older-server fallback. An isolated browser pass confirmed human input ordering and persistence after reload.

**Last updated:** 2026-11-01

### DL030 — Self-signed macOS builds that can update in-app

Fork macOS builds are signed with one persistent self-signed certificate (`Type-Delta T3 Code Fork`) supplied through the `MACOS_CSC_LINK` and `MACOS_CSC_KEY_PASSWORD` repository secrets, without notarization or an Apple Developer account. Squirrel.Mac only installs an update whose signature satisfies the running app's designated requirement, which for this certificate is the bundle identifier plus the certificate hash. Signing every release with the same certificate keeps that requirement stable, so in-app updates work; unsigned or ad-hoc builds cannot update. Gatekeeper still blocks the first install until the user approves it under System Settings → Privacy & Security → Open Anyway. Rotating or losing the certificate breaks updates once and requires a manual reinstall.

`scripts/build-desktop-artifact.ts --self-signed` keeps the certificate variables that unsigned mode scrubs, selects the identity by name, forces code signing, disables notarization, and turns hardened runtime off because a certificate without a Team ID would fail library validation for Electron's own frameworks. It omits the passkey entitlements that require a provisioning profile; upstream's `--signed` path remains for Developer ID builds. The workflow trusts the certificate on the runner, because electron-builder's identity lookup ignores untrusted certificates, and fails the build unless the app's designated requirement contains a certificate hash.

**Implementation evidence:** `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`, and `.github/workflows/fork-macos-release.yml`.

**Recorded validation:** `vp test run scripts/build-desktop-artifact.test.ts` (50 tests), focused `vp check`, the scripts typecheck, and a Linux-side config generation showing the self-signed identity with notarization and hardened runtime off. Hosted builds for `v0.1.301` passed `codesign --verify --deep --strict` with `designated => identifier "com.t3tools.t3code" and certificate leaf = H"7098ba8c…"`. A two-version update on a Mac is not yet recorded.

**Last updated:** 2026-10-30

### DL031 — Durable management API keys for external MCP clients

Management-key HTTP requests use request-time authorization and relay endpoint resolution, including one credential renewal retry for an invalid credential. Insufficient-scope errors do not retry. Bearer and DPoP requests explicitly omit browser cookies so a stale session cookie cannot override the selected environment credential; cookie-authenticated requests continue to include cookies. Regression coverage checks the credential modes and reproduces the collision against the server. Web management-key request failures use `Schema.TaggedError`.

Sharing & access settings can select any known machine and create environment-wide management API keys
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
`apps/web/src/routes/_chat.settings.access.tsx`,
`packages/client-runtime/src/state/environmentHttpAuth.ts`,
`apps/server/src/auth/ManagementApiKeyService.ts`,
`apps/server/src/persistence/ManagementApiKeys.ts`,
`apps/server/src/persistence/Migrations/050_ManagementApiKeys.ts`,
`apps/server/src/persistence/ForkMigrations.ts`,
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

**Last updated:** 2026-11-07

### DL032 — Automatic resume after native provider usage limits

Auto-resume remains enabled by default for all threads and can be turned off under Settings →
Threads → Resume after usage limits. V2 persists the failed run's exact provider reset time
and recovery identity. A shared five-second scheduler checks durable failed-thread candidates; it
does not wait for a provider-specific timer. A candidate is dispatched only when its reset time has
passed, the thread is still eligible, and its persisted run/message identity is unchanged. The
scheduler's tick therefore adds at most five seconds of timing slack, while the provider reset time
controls the earliest continuation.

The fork retains its explicit continuation prompt, which asks the provider to resume only incomplete
work, inspect the current workspace and subagent state, repair partial operations, and avoid
repeating completed work or expanding scope. Recovery survives a server restart, as upstream now supports. An explicit thread restart, archive, settle, a newer turn, or a changed provider selection invalidates the saved recovery. The one-hour wait and scheduler behavior are
upstream V2 behavior; the default and prompt are the fork's surviving differences.

**Implementation evidence:** UsageLimitRecoveryWorker, Orchestrator, Scheduler, orchestrationV2/settings
contracts, serverSettings, and SettingsPanels.

**Recorded validation:** focused usage-limit parsing, scheduler, recovery-worker, V2 runtime, and
server-settings tests; vp check; vp run typecheck; and the isolated migration/startup smoke.

**Last updated:** 2026-11-07

### DL033 — Model search within the selected group

The shared web and desktop model picker searches only the selected provider instance or Favorites.
An All providers group searches across available instances. The group rail stays visible during
search, and switching groups preserves the query. Provider and continuation restrictions still apply.

**Implementation evidence:** `apps/web/src/components/chat/ModelPickerContent.tsx`,
`ModelPickerSidebar.tsx`, and `ModelPickerContent.test.ts`.

**Recorded validation:** No validation recorded. Covered by `ModelPickerContent.test.ts`.

**Last updated:** 2026-09-07

### DL034 — Client-controlled prompt suggestions with optional native Claude generation

Prompt suggestions remain client-local and off by default. Codex generates a tagged next-prompt
line inside its ordinary reply, without a separate sampling request. Claude uses its native SDK
suggestions by default when the master toggle is enabled; turning off **Claude native suggestions**
uses the same tagged-reply method as Codex. New turns request only one generation method. Custom
instructions apply to tagged generation. These controls live under Settings → Chat → Prompt
suggestion and travel with human-authored turn requests to local or remote environments.

Upstream's server-wide Labs switch and Codex sampling path are omitted. The fork adopts
upstream's empty-composer presentation, Tab hint, Escape dismissal, completed-run relevance,
steer handling, fine-pointer requirement, and suppression while awaiting input or after `/clear`.
Typing only hides a suggestion; clearing the composer restores it. Escape dismisses that run's
suggestion. Neither T3 delegates nor provider-native children generate or display suggestions.
Accidental inherited tags are stripped without publishing child suggestion metadata.

Explicit turn preferences apply on the next user message. Claude safely replaces an idle query
when the SDK native mode changes, preserving its native conversation. If enabling native
suggestions would interrupt background agents or commands, that thread keeps its current
suggestion mode and accepts the message. Native suggestions can be enabled once the background
work finishes. Tagged guidance travels
with each user turn because the SDK snapshots system prompts across resumes; it never depends
on replacing that recorded prompt. Missing preferences
use the saved query/native metadata for recovery; an older preference without `claudeNative`
keeps tagged generation. Native Claude suggestions use upstream's ephemeral stream; tagged
suggestions remain durable assistant-message metadata. Clients call the native suggestion RPC
only when the environment advertises support, retaining the tagged path for older servers.
An older conversation whose recorded system prompt already includes tagged guidance retains that
block until compaction or a fresh session; the current preference still controls published metadata.
Each viewing client independently controls visibility. Native mobile has no suggestion UI.

**Implementation evidence:** `packages/shared/src/promptSuggestion.ts`,
`packages/contracts/src/{settings,providerPolicy,environment,orchestrationV2}.ts`,
`apps/server/src/orchestration-v2/Adapters/{CodexAdapterV2,ClaudeAdapterV2}.ts`,
`apps/server/src/orchestration-v2/ProviderSessionManager.ts`,
`apps/web/src/promptSuggestion.logic.ts`, `apps/web/src/components/chat/usePromptSuggestion.ts`,
`apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/chat/useComposerSend.ts`,
`apps/web/src/components/settings/SettingsPanels.tsx`, and their focused tests.

**Recorded validation:** adapter regressions cover native/tagged exclusivity, explicit preferences,
recovery fallbacks, preserving disabled/tagged suggestions during background work, stale native
events, and delegate/child suppression. All 478 Claude adapter tests, `vp check`, and
`vp run typecheck` pass. An isolated live Claude session accepted a native-suggestion follow-up
while its background command stayed running, then received the command's completion notification;
the completed turns survived a server restart. Final sync validation is recorded in the current
Merge History entry.

**Last updated:** 2026-11-17

### DL036 — Ignore route tests during web route generation

The web router ignores `.test.ts` files in the routes directory so route tests do not produce missing-Route warnings during builds.

**Implementation evidence:** `apps/web/vite.config.ts`.

**Recorded validation:** web build, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-09-28

### DL037 — Forgiving CLIProxyAPI usage and redemption

Hub requests pause after management HTTP 401/403 until the URL or management key changes. Each ChatGPT account publishes its `id_token.chatgpt_account_id` as `workspaceId`, so one email signed into multiple workspaces remains distinct. Optional malformed quota fields and array entries no longer discard usable windows; Codex plan fallback accepts both field names and relative reset times. Upstream's subpath-safe hub URLs (#19336) apply, so a hub served under a path keeps it. Credit redemption sends only a stable `redeem_request_id`, preserves known outcomes, and reports unfamiliar successful responses as accepted before refreshing usage. T3 leaves cooldown clearing to CPA instead of resetting the entire account. Web, desktop, and mobile display the accepted result.

**Implementation evidence:** `apps/server/src/usage/cliproxyApi.ts`, its focused tests, `packages/contracts/src/providerUsageLimits.ts`, and the web/mobile usage components.

**Recorded validation:** 26 focused adapter and source-refresh tests, `vp check`, `vp run typecheck`, and `vp run lint:mobile`. Integrated web verification is blocked by `PreviewAutomationNoAvailableHostError`; native mobile verification is blocked by disabled device access.

**Last updated:** 2026-11-12

### DL038 — Precise transcript identity checks on Windows

Session scanning skips parsing completed history from matching file metadata only when the inode is present. Effect 4.0.5 reports inodes as bigints, which import sources store as exact decimal strings; legacy numeric inodes that are not safe integers never match because they may already have lost NTFS file ID precision. Windows can omit inode values, making a replacement file look unchanged. The scanner validates these completed files with a separate bounded budget so retries can import the next batch of new histories. Both budgets allow 100 transcripts and 4 GiB per scan, with 100,000 records per transcript and 10,000,000 records in aggregate. Replacements also consume the new-history budget. Completed files beyond the validation budget remain conservatively skipped; identical-metadata replacements there are not guaranteed to be discovered on retries.

Native-session validation composes with upstream compressed and rewound Codex rollouts through the same bounded transcript reader. Imports from a linked worktree validate against that worktree rather than the main checkout, so retries keep reaching sessions behind the scan budget.

**Implementation evidence:** `apps/server/src/project/AgentSessionScanner.ts`, its replacement identity tests, and bounded retry tests in `AgentSessionImporter.test.ts`. `packages/shared/src/nodeRuntime.ts` falls back to native bigint file IDs when Effect stats report a missing or zero inode; `nodeRuntime.test.ts` covers native, missing, and zero identities.

**Recorded validation:** The complete scanner, importer, scratch-folder, repository-identity, settings-contract, and tagged-version fixture run passes 226 cases. Linked-worktree imports preserve the 100/1 then 1/0 batch counts; compressed rewound transcripts validate and import. This sync ran on Linux.

Earlier validation: 100 scanner/importer tests, including 201-history imports across three attempts with missing inodes and exact-string versus rounded legacy inodes. Server typecheck, scoped lint, and formatting passed.

**Last updated:** 2026-11-16

### DL039 — Graceful Codex shutdown before Windows tree termination

Codex app-server sessions and probes drain their protocol writer and close stdin before waiting up to three seconds for exit. Output readers stay open during cleanup; an unresponsive app-server still receives a forced termination. Transport failures use the same stdin-first shutdown.

On Windows, the service launcher requests shutdown over its existing IPC channel and allows five seconds for server cleanup before `taskkill /T /F`. Native desktop backends use stdin EOF to request server shutdown and allow four seconds before the process spawner forces termination, within the existing five-second desktop stop budget. Linux, macOS, and WSL retain their signal-based server shutdown. Older servers that do not recognize these requests still reach the forced fallback.

This is an experiment to reduce abrupt termination. It does not establish or fix the cause of the intermittent zero-handle Codex processes stuck in Windows termination.

**Implementation evidence:** `packages/effect-codex-app-server/src/{client,protocol}.ts`, `apps/server/src/{serviceLauncher,server}.ts`, `apps/server/src/process/ParentProcessShutdown.ts`, and `apps/desktop/src/backend/DesktopBackendManager.ts`.

**Recorded validation:** Focused client, protocol, launcher, parent shutdown, Codex runtime/probe, and desktop lifecycle tests passed. Three isolated installed-Codex initialization/EOF cycles exited with code 0. One full server shutdown through launcher IPC and two through desktop stdin EOF exited with code 0 in 2.7–2.8 seconds. `vp check` and `vp run typecheck` passed.

**Last updated:** 2026-11-12

### DL041 — Project-selecting local thread shortcut

The configured Chat: New Local shortcut opens the command palette's "New thread in..." project picker instead of immediately creating a draft in the active project. The same shortcut enters that picker when the command palette already has focus, while the active-project quick-create remains available as a separate palette action.

**Implementation evidence:** `startNewLocal` in `apps/web/src/shortcuts/chatRouteCommands.ts`, `apps/web/src/shortcuts/chatRouteCommands.test.ts` (boring sidebar, `chat.newLocal` opens the picker), `apps/web/src/components/CommandPalette.tsx`, and `apps/web/src/components/CommandPalette.logic.ts`.

**Recorded validation:** focused command-palette and keybinding tests; controlled-browser verification from the main app and an already-focused palette; `vp check`; `vp run typecheck`; and `git diff --check`.

**Last updated:** 2026-11-07

### DL042 — Native conversation adoption during V2 cutover

V2 imports valid saved Codex and Claude native conversation cursors into a durable provider-thread
projection. Legacy threads with a matching provider runtime cursor now retain a strong native thread
reference, so the first V2 turn resumes the provider conversation instead of sending the migrated
transcript as a new conversation. Unknown providers, malformed cursors, and instance mismatches keep
the safe context-handoff path.

A fork or rollback request may carry a saved native turn boundary (`nativeBoundaryRef` on the
adapter fork input). Codex and Claude fork exactly at a strong ref of their own driver and reject a
weak, foreign, or synthetic one instead of falling back to a guessed turn count. Checkpoint navigation uses the persisted provider-turn boundary through the existing fork API. Claude thread-start rollback supplies the saved native baseline through `nativeBoundaryRef` when one exists; without one, it starts a fresh native thread. V1 import records thread cursors only.

**Implementation evidence:** `apps/server/src/orchestration-v2/CheckpointRollbackService.ts` and its tests, LegacyV1ThreadImporter, Core V2 cutover migration, provider-thread
projection, Codex and Claude V2 adapters (`resolveCodexForkBoundary`,
`resolveClaudeForkUpToMessageId`), and the legacy importer/cutover and Codex adapter tests.

**Recorded validation:** No validation recorded. Covered by `LegacyV1ThreadImporter.test.ts`, `LegacyV1Cutover.integration.test.ts`, and the Codex adapter tests.

**Last updated:** 2026-11-07

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
successful signed URL. The retry identity uses the environment and resource value, so streaming renders do not restart the retry budget and a different resource receives its own budget. Chat images use upstream's thread workspace mutation id, or `null` when no edits exist, and reuse the cached URL across mounts. Only file previews opt into `refreshUnrevisioned` to refresh a cached URL or failure when reopened without a revision. `ChatMarkdownMedia` recognizes an explicit `null` workspace-mutation prop as a file preview; an absent prop uses the thread's id.

**Implementation evidence:** `apps/web/src/components/chat/ChatMarkdownMedia.tsx`,
`apps/web/src/assets/assetUrls.ts`, `apps/web/src/components/files/FilePreviewPanel.tsx`, `packages/client-runtime/src/state/assets.ts`, `packages/client-runtime/src/state/assets.test.ts`, and `apps/web/src/components/ChatMarkdown.assets.browser.test.tsx`.

**Recorded validation:** focused ChatMarkdown asset tests and client-runtime asset tests, including "re-mints an unrevisioned read on every mount only when asked".

**Last updated:** 2026-11-07

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

**Recorded validation:** No validation recorded. Covered by `apps/server/src/vcs/GitVcsDriver.test.ts`.

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
auto-retry pause is separate thread metadata and does not replace that error. Failed matched-retry
continuations honor this stop decision even before prompt acceptance; server-restart continuation
recovery keeps its own backoff. Provider-native subagents remain under their provider's control.

**Implementation evidence:** `packages/contracts/src/settings.ts`,
`apps/server/src/orchestration-v2/{AutoRetry,EventSink,Orchestrator,EffectWorker}.ts`,
`apps/web/src/components/settings/AutoRetrySettings.tsx`, and
`apps/web/src/components/chat/autoRetryDisabledBanner.ts`.

**Recorded validation:** focused matcher, settings, composer-banner, delegated-completion,
thread-wait, restart-recovery, MCP-result, and notification tests. An isolated web run verified
repeated startup failures reach the pause banner and manual resume starts recovery again.
Repository formatting, lint, and type checks passed.

**Last updated:** 2026-11-01

### DL050 — Compact sidecar checkpoints and Online Snapshots

Sidecar checkpoint stores no longer grow from copied history. Diffs and restores read project objects through a per-command `GIT_ALTERNATE_OBJECT_DIRECTORIES` instead of fetching project revisions into the sidecar. With no refs to negotiate against, the old fetch re-copied the full project history on every fallback diff.

After a capture, a background pass packs the store with `pack-objects` once it holds 1,000 loose objects or 8 packs. Packing never runs during capture, restore, or diff. Only the swap that deletes superseded packs and loose objects takes the repository lock, and packing keeps every object except evicted blobs, including unreachable ones.

Online Snapshots (`ServerSettings.onlineSnapshots`, default on, under **Settings → Maintenance → Snapshots** on web and mobile) lets that pass evict blobs that the project's primary remote already has. A blob counts as on the remote when it is reachable from a remote-tracking ref whose tip matches `ls-remote`, walked without replace refs, after a canary fetch succeeds. Every remote that eviction used is recorded in `t3-online.json` before anything is deleted. Capture writes trees with `--missing-ok`, so the per-worktree index keeps working after eviction.

Before undo, redo, or a diff reads content, missing blobs are recovered from matching workspace files or fetched by oid from the recorded remotes. That happens before the worktree or the provider conversation changes, and the blobs stay pinned until the restore finishes. Fetches into the sidecar carry the credential, HTTP, and SSH-command settings the project sees but the sidecar does not, such as project-local config or a global `includeIf "gitdir:"`, so they authenticate the way the project's own `ls-remote` does. A failure surfaces a classified message (network, auth, timeout, repository unavailable, not on the remote, no remote), is not retried by the effect worker, and leaves the checkpoint usable, so a retry works once the user fixes the problem. Web `/undo` and `/redo` now show rollback failures that arrive after the navigate command is accepted. Turning the setting off makes later passes download evicted blobs again.

**Implementation evidence:** `apps/server/src/checkpointing/{SidecarCheckpointRepository,SidecarOnlineObjects,CheckpointStore,CheckpointDiffQuery,Errors}.ts`, `apps/server/src/orchestration-v2/{CheckpointService,CheckpointRollbackService,EffectWorker}.ts`, `apps/web/src/components/chat/useTimelineRewind.ts`, `apps/web/src/components/ChatView.logic.ts`, the settings rows in `StorageSettings.tsx` and `SettingsServerControlsRouteScreen.tsx`, and `SidecarOnlineSnapshots.test.ts`.

**Recorded validation:**

- **Focused tests:** checkpoint, rollback, effect-worker, and web navigation-failure suites.
- **Live run:** an isolated dev server with a temporary private GitHub repository and a blobless clone, driven through the web UI with real Haiku turns.
  - The first capture evicted the 1,207-file baseline.
  - Undo with no Git credentials and with an unreachable network both showed classified messages and left the worktree and conversation untouched.
  - After recovery, undo downloaded the evicted version into the sidecar only; redo and turn diffs worked.

**Last updated:** 2026-10-30

### DL051 — Snapshot retention in storage cleanup

The fork stores checkpoint snapshots in sidecars. The hourly storage cleanup, and **Delete now**, remove snapshots that no thread needs. Upstream's cleanup of legacy refs in project repositories is not enabled; those refs remain untouched. `storageCleanup.snapshotsAfterDays` sets the idle limit (default 15 days, `null` keeps idle threads' snapshots). It sits under **Settings → Maintenance → Snapshots** on web and mobile.

Snapshot retention uses `threadIdle`, without the worktree requirement in `storageCleanupThreadIdle`, so idle current-checkout threads also lose expired snapshots. Web and mobile settings honor the managed policy lock for `storageCleanup.snapshotsAfterDays`. A snapshot is kept when its checkpoint belongs to a thread that is not deleted and is either busy or active within the limit. Because forks and subagents read their ancestors' checkpoints, every checkpoint of a kept thread's fork and parent ancestry is kept too, even if that ancestor is deleted or idle. If a projection read fails, that sweep skips snapshot cleanup.

Captures reach projections only after their run, so the sweep computes one cutoff. Nothing captured after it is deleted: the cutoff is the earlier of 24 hours ago and the start of any run that is active or finished within the last 24 hours. Git commit times have one-second resolution, so the cutoff is rounded down to the second minus one.

Per sidecar store, `SidecarCheckpointRepository.retain` deletes the unused snapshot refs under the repository lock. It then does one of two things:

- **Store has no snapshots left:** the store is detached into `checkpoints/tmp/retained-*` and deleted, and a failed deletion is retried on later sweeps. A store that already had no snapshots and is older than the cutoff goes the same way.
- **Otherwise:** the store is pruned. The reachable pack is built outside the repository lock. It keeps everything reachable from refs, every object a persisted capture index names, and every hydration pin, and it skips blobs Online Snapshots evicted. The lock is taken only for the swap, which aborts if refs, capture indexes, or pins changed. A pending marker makes an aborted or failed prune retry. Any capture-index listing error other than a missing directory aborts the prune.

Undo, redo, and diffs of a removed snapshot fail with `CheckpointSnapshotUnavailableError`, which tells the user that cleanup removed it and where to change the limit. The effect worker does not retry it, and the conversation and worktree are unchanged. The cleanup report adds a `snapshots` entry only when it removed something or failed. Clients older than this contract cannot decode that entry, so they cannot show a report that has one.

Legacy checkpoint refs inside project repositories are never touched.

**Implementation evidence:** `apps/server/src/storageCleanup.ts`, `apps/server/src/checkpointing/{SidecarCheckpointRepository,CheckpointStore,CheckpointDiffQuery,Errors}.ts`, `apps/server/src/orchestration-v2/{CheckpointRollbackService,EffectWorker}.ts`, `apps/server/src/ws.ts`, `packages/contracts/src/settings.ts`, `apps/web/src/components/settings/{StorageSettings.tsx,settingsSearch.ts}`, and `apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx`.

**Recorded validation:**

- **Focused tests:** `storageCleanup.test.ts` and `SidecarOnlineSnapshots.test.ts` cover the following, among other cases:
  - deleted, idle, and kept threads;
  - fork ancestry;
  - long-run protection;
  - a capture landing during a prune;
  - capture-index and eviction safety;
  - failed deletion retries;
  - typed unavailable errors.
- **Copied-data run:** an isolated dev server on a copy of a real database (202 threads) and its 3.9 GB of sidecar stores.
  - The startup sweep reduced the stores to 311 MB.
  - Every checkpoint of a thread active in the last 15 days kept its snapshot, and its turn diff still rendered.
  - An expired thread's diff showed the removal message.

**Last updated:** 2026-11-16

### DL052 — Windows desktop keeps the default profile's safe-storage key

On Windows, the first V2 desktop launch seeds `%APPDATA%\t3code-v2\Local State` from the default `t3code` profile and falls back to `T3 Code (Alpha)` only when that is missing. Upstream tries `T3 Code (Alpha)` first. V1 switched `userData` only after Electron had loaded the `t3code` profile's key, so that key encrypted existing desktop secrets such as `connection-catalog.json`. On machines with both profiles, upstream's order copies an unused key: the renderer cannot decrypt its connection catalog, never connects to the local backend, and shows no threads and a disconnected settings page. The rest of upstream's migration, which copies only the key preferences and never the locked databases, is unchanged.

**Implementation evidence:** `apps/desktop/src/app/DesktopUserData.ts` and `DesktopUserData.test.ts` ("prefers the default t3code key when both V1 profiles have one").

**Recorded validation:** No validation recorded beyond that test. The decision is recorded in the 2026-10-16 Merge History entry.

**Last updated:** 2026-10-30

### DL053 — Triage and bug reports target the fork

`t3 triage`, in-app triage, the triage playbook, and the startup-error **Report a bug** link use this repository instead of upstream: the source clone, release tag lookup, issue search and filing, and playbook refresh all go to `Type-Delta/t3code`. Upstream's prompt told the triage agent to replace a differing local playbook with upstream's, which would discard fork edits. Desktop startup recovery opens this repository's releases for the same reason. One shared constant holds the repository so upstream files change by an import. The `npx t3 triage` fallback still runs upstream's published CLI because the fork publishes no npm package.

**Implementation evidence:** `packages/shared/src/forkRepository.ts`, `apps/server/src/triage/{TriageService,triagePrompt}.ts`, `.github/triage/PLAYBOOK.md`, `apps/web/src/lib/bootError.ts`, `apps/desktop/src/app/DesktopStartupRecovery.ts`, and `apps/server/src/triage/TriageService.test.ts`.

**Recorded validation:** 24 focused tests across the triage, boot-error and startup-recovery suites; focused `vp check`; typecheck of the server and shared packages; `vp run build:desktop`.

**Last updated:** 2026-10-30

### DL054 — Full access denies Claude and Codex approval checks instead of waiting

In Full access, Claude Code still forwards its own safety checks under `bypassPermissions`, mostly dangerous `rm` targets: globs, variables, `$(...)`, or the current directory and its parents. Upstream (#21806) sends every forwarded ask to a person. A thread nobody watches, including a delegated child whose parent cannot approve for it, then blocks until someone clicks. The fork denies these immediately with Claude's reason and rewrite hints, so the agent rewrites the command and keeps working.

The SDK drops the CLI's reason type, so the denial matches the safety-check shape instead: a `Bash` ask that upstream labels `provider_check`, with `suppressAlwaysAllowRule` set and `defaultToNo` unset. User `permissions.ask` rules (`ask_rule`), ordinary asks after a silent CLI bypass downgrade, MCP tools that require user interaction, and display-bearing hook asks still reach a person. Tracked upstream in pingdotgg/t3code#26418 and #26294.

Codex keeps its native granular Full access policy. It disables sandbox escalation and explicit-rule, skill, and permission approval prompts, but Codex can still forward dangerous-command reviews that grant no additional permissions. T3 immediately declines current and legacy command/file approval requests and grants nothing for permission requests. Modern Codex replies cannot carry feedback, so Full access turns include recovery guidance in application context, retained after compaction; legacy replies also carry it in their rejection. Codex's forced-`rm` check matches `-f` or `--force`, including combined flags such as `-rf`, even with a literal absolute target. The guidance therefore distinguishes removing unnecessary force after inspecting a narrowly authorized target, using already granted permissions instead of requesting escalation, and respecting explicit policy denials without disguising the operation in a script or another execution channel. Explicit user cancellation still takes precedence. Supervised approvals and MCP browser/app access retain their existing behavior.

**Native policy evidence:** Codex 0.169's [dangerous-command classifier](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/shell-command/src/command_safety/is_dangerous_command.rs) and the dangerous-command approval exception in [exec policy](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/exec_policy.rs). Claude's literal-path rewrite alone does not remove Codex's forced-`rm` match.

**Implementation evidence:** `claudeFullAccessSafetyCheckDenial` and `canUseToolEffect` in `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`; the safety-check case in `ClaudeAdapterV2.test.ts` ("asks before restricted Full access tools and follows policy across turns").

**Codex implementation evidence:** `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, its forwarded-approval replay case and supervised approval cases, and `apps/server/src/provider/CodexDeveloperInstructions.ts`. `evals/mcp-tool-use/cases/permissions.ndjson` covers non-force command rewriting after automatic denial, unnecessary escalation, explicit policy denial, and user cancellation.

**Recorded validation:** The safety-check case fails on the unfixed adapter (an approval request is raised), the MCP-confirmation case fails without the `Bash`/`defaultToNo` guard, and both pass with the fix; all 255 `ClaudeAdapterV2.test.ts` tests pass. In a real dev-server run, a Full access Claude Haiku thread asked to run `rm -rf -- $(find …)` got the denial with Claude's reason ("statically-unresolvable target: command substitution output"), recorded no runtime request, and finished by removing the literal paths. The Codex forwarded-approval replay raises a pending request before the fix and completes without any runtime request afterward. The first guidance eval only checked Claude-style literal-path rewriting and incorrectly accepted a command that retained `-f`; it did not establish compatibility with Codex's classifier. The corrected forced-`rm` case fails 3/3 on that text and passes 3/3 with Codex-specific guidance; unnecessary escalation, explicit policy denial, and user cancellation controls also pass 3/3 each. In a real Codex 0.169 Luna adapter turn, `rm -rf --` on an inspected disposable directory reached T3 and was declined; `rm -r --` on the same target then succeeded and the agent verified removal, with zero manual runtime requests.

**Last updated:** 2026-11-17

### DL055 — File restore blocks only on active threads in an overlapping Git checkout

Undo, redo, and "Revert files too" restore files only when no other active thread shares the restoring thread's Git checkout: the same checkout, a checkout nested inside it, or one that contains it. Checkouts are compared by Git root, so a plain non-Git folder such as a home-rooted project never blocks, and current-checkout threads are no longer refused just for lacking their own worktree. Listed threads block until they are settled or archived. Subagents, side chats, and settled or archived threads block only while doing work: a run in progress, pending background tasks, or a non-multiplexed provider session running a turn. A failed or missing Git lookup inside the checkout blocks instead of being skipped. The refusal names the blocking thread.

Upstream refuses file restore for every current-checkout thread and for any non-deleted thread whose raw paths overlap, archived ones included, so a fork with a home-rooted project and many idle delegates could never restore files. The final check and the restore run under a checkout lease (`workspaceLease.ts` gained checkout and shared modes); project-root turn starts take a shared lease on the project root and worktree turn starts keep their exclusive one, so no turn, Git branch change, or pull (including the startup auto-pull) can start in an overlapping checkout between the check and the restore. Lease paths are canonicalized through realPath, with a missing path resolved through its nearest existing ancestor, so a symlinked alias of the same checkout cannot slip past. Settled or archived listed threads that changed files in that checkout (file-change or command items, not just a checkpoint scope) stay as they are and receive one `Files in this workspace were restored to an earlier checkpoint by another thread` notice after their latest timeline item, refreshed in place on later restores and prepared before the file restore and written in the same event write as the rollback; any failure after the files are restored is final, so a notice can never re-run a restore. Shared-workspace refusals are final rather than retried.

**Implementation evidence:** `apps/server/src/orchestration-v2/{CheckpointRestoreSafety,CheckpointRollbackService,EffectWorker,Orchestrator,ProviderTurnStartService,runtimeLayer}.ts`, `apps/server/src/workspace/workspaceLease.ts`, `apps/server/src/git/GitWorkflowService.ts` (leased pull), `apps/server/src/serverRuntimeStartup.ts`, `docs/user/composer.md`, and the tests `CheckpointRestoreSafety.test.ts` (Git-root scenario table), `CheckpointRollbackService.test.ts` (race held inside the lease, notice placement and dedupe), `workspaceLease.test.ts`, `ProviderTurnStartService.test.ts` (including a symlink-alias start), `GitManager.test.ts` (pull waits for the restore lease), and `serverRuntimeStartup.autoPull.test.ts`.

**Recorded validation:** each new case fails on the previous guard or lease and passes now; the focused server suites (459 and 319 tests across the checkpoint, rollback, turn-start, lease, Git workflow, and startup files) pass. In a seeded dev app with Claude Haiku turns, a current-checkout thread undid and redid its file next to the home-rooted project, an unsettled thread in the same repo blocked the undo, naming it in the refusal, and after settling it the undo succeeded and the settled thread showed one notice below its conversation that did not stack across further redo and undo. "Revert files too" restored files the same way.

**Last updated:** 2026-11-01

### DL057 — Official T3 Connect link with a running fork

Fork release builds include the public T3 Connect identifiers from `.env.example`, including in the Windows WSL runtime. A running backend checks for changes to the CLI's desired link and reconciles them through the existing guarded relay path. This lets the official npm `t3 connect link` authorize the same T3 home without restarting the fork. Runtime configuration still overrides build values.

**Implementation evidence:** fork release workflows, `apps/server/src/server.ts`, and `apps/server/src/cloud/managedTunnelStartup.ts` and its tests.

**Recorded validation:** focused cloud tests cover repeated link intent, interrupting registration, unlink during provisioning, and preserving a newer web link. An isolated release-configured backend attempted reconciliation for both initial and repeated managed-link intent; the isolated official npm CLI interoperability check recorded in the investigation verified the shared state format. `vp check` and `vp run typecheck` passed. Real OAuth and official mobile access were not verified in this task.

**Last updated:** 2026-11-06

### DL058 — Minimap end state stays local to its controls

The timeline minimap owns its exact-end state. The timeline's existing scroll and metrics handler updates that state through a child function ref, so an end-state change does not rerender the whole conversation. Upstream keeps the state in the conversation component, adding an unnecessary render when an assistant starts streaming. Minimap navigation and its end-of-conversation disabled state are unchanged.

**Implementation evidence:** `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/components/chat/TimelineMinimap.tsx`, the existing timeline and minimap tests, and `apps/web/test/appScenarios.renders.tsx`.

**Recorded validation:** the unchanged streaming scenario returns to three conversation renders, matching the premerge measurement; 186 focused timeline, minimap, anchoring, and restore cases pass. An isolated paired client completed two free Replay turns, scrolled away from the end, navigated with Next, returned to the end, and resized to fit the whole conversation. End controls stayed correct with no page errors. The complete render suite now passes all 17 scenarios, including 30 MarkdownParagraph renders during streaming. The same-environment premerge run measured 59.

**Last updated:** 2026-11-16

### DL059 — Direct pairings renew with regular use

Directly paired browser, desktop, and mobile clients keep their existing signed credential while the server renews access after authenticated activity. Renewable sessions expire after 14 days without activity; HTTP requests and incoming authorized WebSocket RPCs count, while server broadcasts do not. This supports official clients that cannot replace their stored token through a new refresh flow. Browser responses refresh a year-long credential cookie; the server's inactivity deadline remains authoritative even when the browser retains the credential longer. Renewal persists each advancing deadline so restarts cannot shorten the inactivity window, and the atomic update returns its deadline without another read.

The fork migration identifies unexpired legacy pairing candidates without reviving expired or revoked grants. Signature verification confirms eligibility before adoption, and adoption preserves a later existing expiry. T3 Connect, MCP and peer links, desktop bootstrap credentials, and explicitly time-limited sessions retain their fixed expiry rules. Revocation still ends existing connections.

**Implementation evidence:** `apps/server/src/auth/SessionStore.ts`, `EnvironmentAuth.ts`, `http.ts`, `RpcAuthorization.ts`, `apps/server/src/ws.ts`, and the auth-session persistence and fork migration tests.

**Recorded validation:** 113 focused authentication and migration tests pass, covering renewal beyond the signed expiry, restart persistence, legacy adoption, inactivity, short-lived WebSocket tickets, retained-cookie rejection, and revocation. The query refinement passes another 49 focused tests. An isolated running server and paired Chrome client verified browser access, unchanged mobile-style token exchange, bearer reuse, incoming WebSocket RPC renewal, and revocation closing an open socket with no browser errors. A pre-upgrade database fixture migrated through the fork ledger, adopted the same unexpired credential through real HTTP, rejected expired and revoked credentials, and passed SQLite integrity checks. Local HTTP probes checked the renewal cost. `vp check` and `vp run typecheck` pass. Compatibility was verified at the protocol level; the official iOS binary was not exercised.

**Last updated:** 2026-11-13

### DL060 — Stable sidebar drag callbacks

Sortable sidebar rows keep their sensor callback identities while drag context or navigation changes. Upstream recreates the listener map and rerenders unrelated rows; the fork forwards events to the latest committed listeners through stable wrappers. Listener names and wrappers change together in React state, so a suspended render cannot leave re-enabled dragging without its handlers. Current transforms, disabled state, external drag previews, and Manual ordering remain authoritative.

**Implementation evidence:** `apps/web/src/components/sidebar/SidebarThreadRow.tsx`, `apps/web/src/hooks/useStableCallback.ts`, the sidebar drag, pointer, and render-isolation browser suites, and `apps/web/test/appScenarios.renders.tsx`.

**Recorded validation:** all 17 render scenarios pass without wider budgets. Thread switching renders two sidebar rows per window, and opening a thread from a draft renders one. The suspended-render guard reproducer retains matching state on retry. The actual production client reorders threads through pointer input with Manual ordering and Working off, and preserves the order after reload. Sidebar drag and pointer browser checks pass.

**Last updated:** 2026-11-16

### DL061 — Windows installer grants Electron sandbox read access

The Windows installer grants `ALL APPLICATION PACKAGES` inheritable Read & Execute access to its installation directory. An inherited package-specific AppContainer entry can otherwise deny Electron's restricted sandbox token access to `icudtl.dat`, causing a native startup crash before the app is ready. The grant preserves existing permissions and applies on installs and updates without changing parent folders or disabling the sandbox. If the grant fails, installation stops with a folder-permissions diagnostic and a nonzero exit code.

Upstream Electron reports this condition but leaves permission repair to installers. The fork supplies the repair in its existing NSIS install hook while electron-builder's equivalent change remains unmerged.

**Implementation evidence:** `apps/desktop/resources/installer.nsh`; fork issue #7.

**Recorded validation:** a compiled NSIS fixture using the real install hook failed before the repair and passed afterward. The fixture checks inherited read access without write access, unchanged parent permissions, preserved NSIS register/stack state, and repeat installation. Electron 44.10.1 rendered with `process.sandboxed === true` after the hook ran. A failed grant aborted silent installation with exit code 2. All 13 focused Windows desktop-packaging tests, `vp check`, and `vp run typecheck` passed.

**Last updated:** 2026-11-16

### DL062 — Failed Claude wake responses allow provider switching

An idle Claude response that ends in an API failure no longer counts as running background work merely because its frames remain buffered behind a held continuation. This lets users switch providers after a usage limit when their delegated jobs have finished and the parent run has stopped. Live tasks, a later response still streaming, and successful buffered responses awaiting delivery retain the existing guard.

**Implementation evidence:** `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` and its adapter tests.

**Recorded validation:** a replay of the observed parent-failure/idle-failure sequence failed against the unchanged adapter and passed with the fix. All 478 applicable adapter tests and two focused provider-switch integration cases passed, including protection for live commands, later wakes, successful buffered responses, and empty lifecycle results after failure. One existing native-fork test also fails against the unchanged adapter on Windows because its fixture compares `/workspace` with `C:\workspace`; the adapter rerun excluded it and retained the suite's existing skip. `vp check`, `vp run typecheck`, and `git diff --check` passed. The generic ACP scenario runner cannot reproduce Claude-specific idle frames or usage-limit-stopped runs.

**Last updated:** 2026-11-17

### DL063 — Composer context window ring

Web and desktop retain the original composer context window ring removed by the upstream Labs cleanup in `521ac7c218`. Enable **Context window indicator (legacy)** under **Settings → Labs → Legacy**. The setting defaults to off. The ring uses the thread's reported usage and offers compaction for supported providers. The upstream Thread Details context window setting is independent.

**Implementation evidence:** `apps/web/src/components/chat/ContextWindowMeter.tsx`, `apps/web/src/components/chat/ComposerFooterControls.tsx`, `apps/web/src/components/settings/LabsSettingsPanel.tsx`, `packages/contracts/src/settings.ts`, and the ring, settings search, and desktop settings tests.

**Recorded validation:** 153 focused tests, `vp check`, and `vp run typecheck` passed. A paired web client and an isolated Electron client each showed 40% usage from a replayed ACP turn, retained the Labs opt-in across reload, and hid the ring after opt-out.

**Last updated:** 2026-11-18

### DL064 — Storage usage breakdown

**Settings → Maintenance → Storage usage** shows how much disk T3 Code uses on each connected environment as an iOS-style bar of the whole volume with an inline legend whose entries show their size and description on hover or tap: database (all SQLite files and sidecars), worktrees, Git snapshots (the sidecar checkpoint repositories), logs, attachments, and other (the rest of the state folder, caches, and scratch projects), then everything else on the volume, with free space as the empty track. Tiny parts keep a minimum width so they stay visible. When the volume size is unknown, the bar falls back to T3 Code's own total. Worktrees cover the configured folder and the default one, so checkouts left behind after a location change still count. Reserved T3 folders are never counted twice. Snapshot refs inside project repositories are not counted because their objects are shared with project history.

`server.getStorageUsage` measures on demand, when the section mounts or on Refresh, because a large worktrees folder takes seconds to scan. POSIX hosts use `du`, which counts hard links once (pnpm installs hard-link most files) and reports allocated size. Windows walks the tree with bounded concurrency. Concurrent requests share one in-flight measurement. A failed scan is an error, not a low total. Servers advertise `storageUsage`; clients hide the section on servers without it.

**Implementation evidence:** `apps/server/src/persistence/StorageUsage.ts` and its test, `packages/contracts/src/{settings,rpc,environment}.ts`, `apps/server/src/{ws.ts,auth/RpcAuthorization.ts,environment/ServerEnvironment.ts}`, `packages/client-runtime/src/state/server.ts`, and `apps/web/src/components/settings/{StorageUsageSection.tsx,StorageUsageSection.logic.ts,StorageSettings.tsx}` with `StorageUsageSection.logic.test.ts`.

**Recorded validation:** focused StorageUsage, GitVcsDriverCore, client-runtime vcs, BranchToolbar logic, and StorageUsageSection logic tests (423 passing); `vp check`; `vp run typecheck`. On 2026-11-18 a seeded dev app whose worktrees setting pointed at a real ~18 GB, 1.7M-file worktrees folder measured 19.8 GB in about 23 seconds, kept the previous result while refreshing, and rendered in light and dark themes and at 375 px with tap-opened legend details. The disk bar then showed 19.1 GB of T3 Code data and 181 GB of everything else on a 477 GB volume with 277 GB free.

**Last updated:** 2026-11-18

### DL065 — Multi-user gateway on one port

Linux (systemd), macOS (launchd) and Windows (Task Scheduler). `t3 gateway run` serves every enrolled OS user on one port. Each user keeps a stock `t3 serve` backend (started through `t3 gateway run-backend`, which finds its port in the gateway config by the caller's account, passes it to `serve` as `--host 127.0.0.1 --port`, and keeps the startup pairing link out of the service log), run as that user on a loopback port with their own T3 home, so threads, settings, secrets and T3 Connect stay separate. The gateway serves the web client from its own install and proxies only server routes (`/api`, `/oauth`, `/.well-known`, `/ws`, `/mcp`, and every request that is not a GET or HEAD). It picks the backend by a `?u=<user>` tag (ignored on cross-site requests except top-level `/pair` links opened from mail or chat), then the `t3gw_user` cookie, then the single user with a live pending pairing. Official mobile apps cannot carry a tag, but their native HTTP and WebSocket stacks keep the cookie, so the pending pairing only has to route their first request. `t3 gateway pair` mints a code on the caller's own backend and drops a marker in that user's pairing folder, which `t3 gateway add` creates and only that user and administrators can write. The gateway honors a marker for at most an hour. On Linux and macOS it also checks the marker file's owner uid; on Windows the folder ACL is the attestation, and a marker reached through a link is ignored. A marker routes only a bodiless `GET` of the environment descriptor and the web client page, never a request carrying credentials, and the gateway refuses to guess when two users are pairing or a folder cannot be fully read. Each marker records the SHA-256 of its code. Codes are normalized the way the server accepts them (hyphens, spaces, case) before hashing. When exactly one user's markers hold the hash of a code sent to `POST /oauth/token` or `POST /api/auth/browser-session`, the exchange goes to that user; a request routed to a different user is refused unspent with 409 so a rescan reaches the right backend, and a successful exchange pins the route for a year. A hash held by several users (a copied marker) or a pairing folder that cannot be fully read also gets 409; only a complete scan with no match routes by tag or cookie.

Each user's backend cookies are renamed `<name>__<user>`, and only the routed user's cookies are forwarded, so one browser can hold several users' sessions. Clients send bearer-authenticated requests with `credentials: "omit"`, and Android's React Native networking then drops cookies, so the gateway rewrites each Bearer `access_token` that `POST /oauth/token` issues to `t3gw~<user>~<token>`. It asks that exchange for an uncompressed body so it can do this. A request carrying such a token routes to that user ahead of tag, cookie and marker, and its backend receives the original token. DPoP tokens are left as issued because their proofs hash the exact token. A token that already looks tagged is tagged again, so a backend cannot mint one that routes elsewhere. WebSocket tickets are not tagged and still route by cookie, which is one reason a phone holds one account per gateway. Before any request byte is written, the gateway checks that the accepting end of each new backend connection belongs to the enrolled account (uid, or SID on Windows), failing closed when it cannot tell. Linux reads `/proc/net/tcp`; a connection the backend has not accepted yet reads as uid 0 there, so it takes the uid of the port's listener instead. On macOS, `netstat` returns no rows to a process whose responsible binary lacks an Apple Team ID, which includes ad-hoc and self-signed fork builds, so a socket-activated launchd helper (`com.t3tools.t3code.sockets`, reachable only by the gateway's `_t3code` account) runs `netstat` and `ps` for it. Windows reads `netstat -ano`, asks `tasklist` which account runs that PID now, and caches only account name to SID, so a PID reused by another account is never trusted. Every user's backend shares one browser origin, so every proxied response that is not an inert type (JSON, plain text, CSS, scripts, media, fonts, PDF) gets a sandbox CSP without `allow-same-origin`, and responses that could act on the whole origin (`Clear-Site-Data`, `Service-Worker-Allowed`) are stripped. When a user is removed or re-registered, their open connections are closed. The design assumes users on the host trust each other: any service on another port of the same host receives the gateway's cookies, and one browser profile is one person, since users routed in the same profile share its storage. Guest links, webhooks and outside MCP agents keep using each user's T3 Connect address; MCP's own token endpoint (`/oauth/mcp/token`) is not tagged. TLS and IPv6 clients are not handled.

All OS-specific work (accounts, ownership and ACL checks, services, socket owners, links) sits behind one adapter interface, `apps/server/src/gateway/platform/GatewayPlatform.ts`; routing, config, pairing, runtime staging and pruning are shared. `t3 gateway install`, run as an administrator from an extracted CLI archive, copies that runtime to a versioned folder under the install root, switches `current` atomically, links `t3` onto the PATH, waits for the gateway to listen, restarts the enrolled backends, and keeps the previous runtime. A failed or interrupted update restores the previous runtime and service definitions. Privileged commands run system tools with a fixed `PATH`. Install refuses service definitions or an install root it did not create, install sources other accounts can modify, and config or pairing path overrides. Uninstall removes the services, launcher and runtime, and keeps the config, pairing folders, the gateway account and every user's T3 home. Pruning old runtimes is best-effort.

- Linux: `/opt/t3code`, `/etc/t3code/gateway.json`, `/var/lib/t3code/pairing`; a `t3code` system account runs `t3code-gateway.service`, and backends run from the `t3code@.service` template as the enrolled user from their home directory (`t3 serve` merges the login shell's PATH before providers start).
- macOS: `/usr/local/t3code`, `/usr/local/bin/t3`, `/Library/Application Support/T3Code`; a hidden `_t3code` role account runs the gateway LaunchDaemon, each backend is its own LaunchDaemon with `UserName`, and logs go to `/Library/Logs/T3Code`.
- Windows: `%ProgramFiles%\T3Code` (directory junctions, a `bin\t3.exe` launcher on the machine PATH) and `%ProgramData%\T3Code`. The gateway task runs as SYSTEM, the only account that can read other users' process owners. Backend tasks run as the user with S4U logon, which Windows only lets an administrator register with that user's password, so `t3 gateway add` asks for it once over stdin, never stores it, and grants "Log on as a batch job". Task Scheduler's RestartOnFailure ignores a process that exits with an error, so tasks repeat every minute instead (a no-op while running). Updates restart existing backend tasks and name any user whose task needs `add` again. Install adds a firewall rule for private and domain networks and warns on a Public network. The upstream selection lock treats only EEXIST/ENOTEMPTY as contention, while Windows returns EPERM, so the gateway carries its own copy for Windows (`gatewayLock.ts`).

Setup and limits for users are in [docs/user/multi-user-gateway.md](docs/user/multi-user-gateway.md).

Upstream composition: the only upstream edit is registering `gatewayCommand` in `apps/server/src/binCli.ts`. Backends run the unmodified `serve` command, and pairing reuses the stock `pair` command.

**Implementation evidence:** `apps/server/src/gateway/{GatewayConfig,GatewayServer,GatewayRouting,GatewayPending,GatewayConfigLoader,gatewayCliAdmin,gatewayPairing,gatewayInstall,gatewayLock}.ts`, `apps/server/src/gateway/platform/{GatewayPlatform,linux,linuxProc,darwin,win32,testing}.ts` and their tests, `docs/user/multi-user-gateway.md`, `apps/server/src/cli/gateway.ts`, `apps/server/src/binCli.ts`.

**Recorded validation:** the gateway suite passes on Linux and macOS (177 tests) and on Windows (126, with POSIX-only cases skipped). It covers the routing table, cookie rewrite, `/proc/net/tcp{,6}` parsing, pending-marker ownership, config reload, install and uninstall plans with root operations stubbed, rendered units, and real-socket tests of fake backends covering tag, cookie and pairing-code routing, header-stripping order, WebSocket upgrades, wrong-uid 503s, CSP, malformed statuses, client hang-ups, and closing a removed user's WebSocket, plus per-adapter parsers, service definitions, rollback and owner checks; server typecheck; `vp check` on the changed files; `systemd-analyze verify` on the rendered units. On 2026-11-20 a throwaway gateway with the same routing paired the official iOS app (`T3Code/248`) and a browser to two separate backends on one port. All 19 phone requests after pairing, including reconnects after a force-quit and a cellular switch, carried the routing cookie. Also on 2026-11-20, a root install from a locally built Linux CLI archive enrolled two throwaway Linux users under systemd. Browsers paired to each backend through port 3773, and a Claude Haiku turn ran as the enrolled user. Re-running the install updated the runtime and restarted every unit. Before the accept-queue fix, 7 of 400 concurrent requests failed with a uid-0 503; after it, 1,800 of 1,800 succeeded. On 2026-11-21 an Android emulator running a dev client built from this fork, with unchanged mobile code, paired through the same install. Before tokens were tagged, its bearer requests reached the gateway without cookies and got 421, which left the app read-only. After the fix, with the pairing user's marker deleted and another user's code live, the app was force-quit and relaunched and still sent a Claude turn to the right backend. Later on 2026-11-21 the official iOS app (`T3Code/248`) paired through the current gateway source, which tags issued tokens, to one of two backends. It took a Bearer session, showed that backend's projects and ran a Claude Haiku turn from the phone. The other backend recorded no session and no messages. Also on 2026-11-21, a macOS 27.2 (arm64) host was installed from a locally built archive: the old desktop app was removed after a backup and its user's data migrated in place, a second user was enrolled, an update rotated the runtime, and Firefox on another machine paired both users through port 3773, each seeing only their own projects and completing a Claude Haiku turn, confirmed in each user's database. A Windows Server 2025 VM did the same for two standard users, then passed an update, a killed backend coming back within a minute, two reboots with nobody signed in, and uninstall followed by reinstall.

**Last updated:** 2026-11-21

### DL066 — Users join, leave and update the shared T3 Code themselves

The multi-user gateway (DL065) needed an administrator for every enrolment and every update. A privileged helper now lets any local user join or leave and move the shared runtime forward, and the desktop app uses the shared backend instead of starting its own.

The helper speaks JSON over HTTP on `127.0.0.1:3774` (`packages/contracts/src/gatewayHelper.ts`). It names the caller by the OS account that owns the connecting socket, using each adapter's existing connection-owner lookup with the ports swapped, then requires a matching enrollable account. Every request must carry `x-t3-gateway-helper: 1` and the exact loopback `Host`; `OPTIONS` gets a 404 without CORS headers, so a web page cannot drive it. Each response closes its connection: a kept-alive connection would keep reaching the helper process that answered it, which still reports the runtime from before an update. `selfService` in the gateway config gates join, leave and update; `gateway install` sets it to true when absent.

- Linux runs the helper per connection from a root `t3code-gateway-helper.socket` (`Accept=yes`), with its output in the journal because the reply shares the socket, and enrolls only uids from 1000 up; macOS from an inetd-style root LaunchDaemon with no `RunAtLoad`. Windows serves it from the SYSTEM gateway process.
- Windows cannot register an S4U backend task without the user's password, even as SYSTEM (checked on Windows Server 2025), so joining there takes the user's own password once. The password goes to the helper over loopback, is used only for the task registration and is never stored or logged. Every gateway task is registered with an explicit security descriptor giving Administrators and SYSTEM full control (and the backend's user read access); without it a task the SYSTEM helper registers is SYSTEM-only, and an administrator's next install failed to restart it (found on the Windows VM).
- `POST /v1/update` accepts only a newer `X.Y.Z` or `X.Y.Z-prerelease` version; the version becomes part of a file name, so build metadata and path characters are refused. It downloads that version's CLI archive and `SHA256SUMS` from `updates.baseUrl` (default: this fork's GitHub releases), verifies the checksum, extracts into an admin-only staging folder under the install root, and starts the staged `t3 gateway install` as a detached job (`systemd-run`, a one-shot LaunchDaemon, a SYSTEM task) so restarting the gateway and helper cannot kill it. A `running` state older than 30 minutes no longer blocks a new update.
- `scripts/install.sh` and `install.ps1` install from this fork's releases, since upstream's archives have no gateway, and refuse Linux and Windows arm64, for which the fork publishes no archive. `docs/user/install.md` gives their raw GitHub URLs instead of `t3.codes`, which serves upstream's, and says to rerun them to update, since `t3 update` follows upstream. Run as root or elevated, they ask once whether to install for everyone and then do a gateway install; `T3CODE_INSTALL_MODE=gateway|user` answers without asking.
- Every finished install clears the update claim. The helper moves its claim to "installing" only if it still holds it after the download, and the detached install refuses to run without it, so a late job cannot replace a newer runtime. The detached install marks the claim failed on any failure, from its first check on, and clears it on success, in both cases only while the claim is still its own version's, so members' apps stop waiting without losing a newer member's update. It keeps another member's staging folder until it is 30 minutes old; an administrator's install removes them all. Asking for the update already running joins it rather than failing. Under the install lock it also refuses to replace an active runtime whose build reports a version (`t3 --version`, through the platform's `runtimeVersion`) that is not older than its own, since a helper process that predates a newer install judged "newer" against itself; runtime folder names can carry a build suffix, so they are not compared.
- Any local account can listen on `127.0.0.1:3774` where no gateway holds it, so the desktop asks the helper nothing unless an administrator's install exists (`current` under the install root, owned by root on Linux and macOS; under Program Files on Windows, `packages/shared/src/gatewayHost.ts`). On Windows the port is also free while the gateway restarts. The gateway therefore makes an RSA key pair at start, publishes the public key in its admin-only, world-readable helper folder, and accepts the join password only encrypted to it, so a squatter gets ciphertext. A refused first join is rolled back under the config lock, pairing folder included, so the member is not left enrolled without a backend. Leave stops the backend under the config lock before removing the enrollment, so a failed stop can be retried. A join without a password on Windows is refused rather than left waiting on the gateway's console. Joining is not offered when startup would not attach (development build, local environment off, or WSL-only). While attached, Settings hides the network-access rows the gateway owns but keeps the WSL backend row. The Windows gateway keeps routing if it cannot bind the helper port.
- The desktop mints tokens with the shared runtime's own `t3 pair`, not its bundled CLI, which could need a database migration that the older shared server blocks (after a failed update, or with `selfService: false`). A token goes only to a backend whose port matches the server holding the T3 home's ownership lock, checked before `t3 pair` runs. It passes no `--scope`, so a runtime older than the app keeps its own standard scopes. The helper stages an update within `GATEWAY_HELPER_STAGE_TIMEOUT_MS` and the desktop's update request waits a minute longer. The desktop counts an update as done only once its claim clears, which the install does after restarting the backends, not when the runtime first reports the new version; the helper therefore keeps showing a fresh claim for its own version, and that claim still holds the update slot, so a newer request cannot replace the detached job mid-activation. The claim file is replaced by rename, so a status read never sees it half-written. An app that starts while someone else's update is settling waits for it before pairing.

The packaged desktop app asks the helper for status before taking the T3 home. When the account is enrolled it updates the shared runtime first if the app is newer, then attaches: a backend instance with the shared backend's loopback endpoint and no child process, authenticated by one-time tokens it mints with the shared runtime's `t3 pair` against the same T3 home. In-app server updates are off while attached. Settings → Connections shows the shared runtime with Join and Leave (both relaunch the app), and the app offers joining once; leaving also dismisses that offer.

On macOS, a new self-signed fork build asked for keychain access to the "T3 Code Safe Storage" item an earlier build created, even when signed with the same certificate, and blocked startup until someone answered. This predates the gateway; it affects any update between self-signed builds.

**Implementation evidence:** `apps/server/src/gateway/gatewayHelper.ts` and its test, `apps/server/src/gateway/platform/{GatewayPlatform,linux,darwin,win32}.ts` (`accountName`, `helperHost`, `joinNeedsPassword`, `runDetached`), `apps/server/src/gateway/{GatewayConfig,GatewayServer,gatewayCliAdmin,gatewayInstall}.ts`, `apps/server/src/cli/gateway.ts`, `packages/contracts/src/gatewayHelper.ts`, `apps/desktop/src/backend/{DesktopGateway,DesktopBackendManager,DesktopBackendPool,DesktopLocalEnvironmentAuth}.ts`, `apps/desktop/src/app/DesktopApp.ts`, `apps/web/src/components/settings/SharedRuntimeSetting.tsx`, `scripts/install.{sh,ps1}`, `.github/workflows/fork-e2e-artifacts.yml`.

**Recorded validation:** the gateway suite passes on Linux (190), macOS (191) and Windows (137, POSIX-only cases skipped); helper tests drive a real loopback connection against a real archive and were checked to fail without password scrubbing, staging cleanup, the account check, the bare `OPTIONS` 404, the one-update guard and the per-connection close. On 2026-11-24, test builds from the e2e workflow were installed on a macOS 27 host and a Windows Server 2025 VM. On each, the admin install script set up or updated the gateway, a never-enrolled account joined and left through the helper (on Windows a wrong password was refused), a desktop app found its account enrolled and attached with no backend of its own, Leave and Join in Settings relaunched it into local and shared mode without re-offering to join, a newer desktop build moved the shared runtime forward before attaching (a few seconds on macOS, under a minute on Windows) while the other member's backend came back on the new runtime, and a Claude Haiku turn ran from the attached app.

**Last updated:** 2026-11-24

## Sync Checklist

Project-specific checks every upstream sync runs, in addition to the full test suite, lint, typecheck, builds, and a smoke test of upstream and fork features.

- Apply new upstream migrations to a read-only snapshot of the live database (`~/.t3/userdata/statev2.sqlite`). Check that a rerun is a no-op, the upstream ledger matches the migration manifest, the fork ledger (`fork_sql_migrations`) keeps every fork migration, and `foreign_key_check` and `quick_check` pass.
- Run `vp run lint:mobile` when the merge touches native mobile code.
- Run `vp run report:renders` with reports enabled, comparing any budget failure against the premerge source with the same measurement environment. Set `T3CODE_RENDER_REPORT_DIR` for a full test run that includes render projects. Missing report output must not mask render regressions.
- Build the desktop and web production bundles, then build an installer (`vp run dist:desktop:win` on Windows) and launch it with isolated state. Confirm the window opens, the backend starts, and a fresh database migrates.
- If provider auth is set up, run live turns with the cheapest models (Haiku for Claude, Luna for Codex) on a paired web client with seeded real data. Include an undo and redo of a file change (DL006).
- Move the `base` tag to the merge commit and force-push it to `origin`.

## Merge History

This is an append-only decision record, newest first, with one entry per upstream sync. It explains past integrations but does not by itself establish a current divergence; use the Divergence Log for that. Sync with upstream only when the user explicitly asks. Do not edit past entries.

### 2026-11-16 — Merge upstream/main through `6b7027b1f4`

**Merge commit:** this commit
**Parents:** `090175e4dd33d6a2aeb8269fcd81aec70864f571` (fork) and `6b7027b1f43eebc4c7edf5304236a0775b2d8928` (upstream/main); 1,481 upstream commits since `32882540fb`.

All 44 existing divergence entries are retained. DL060 records stable sidebar drag callbacks, bringing the current total to 45. No entries are retired.

User decisions:

- Adopt upstream's 30-second default and 45-second maximum MCP waits, retaining eight targets, recoverable handles, model selection, and management permissions. Secret-request lifetimes remain separate.
- Preserve legacy checkpoint refs in project repositories; do not enable upstream's deleted-thread ref pruning.
- Continue the client integration with DeepSeek V4.1 Flash after the configured Claude provider could not start.

Other decisions:

- Keep sidecars, redo and native conversation forks, original local and remote delegated-task handles, independent migration ledgers, gateway catalogs, client-controlled suggestions, split workspaces, Manual ordering, and tray-backed desktop continuity.
- Keep canonical upstream migrations through 096 and fork migrations through 016, including rolling direct-pairing sessions alongside Connect proof-key approval and revocation.
- Take compatible upstream changes without replaying completed work or broadening management-key permissions. Sidecar submodules retain their existing content-preservation behavior; incoming legacy submodule restoration is not claimed for sidecar snapshots.

Integration repairs:

- Port branch-switch synthetic baselines and fetched-commit filtering into sidecar capture and diff queries without writing project refs or the project index. Preserve bounded captures, redo intake, overlap leases, and retention pins.
- Keep leftover managed-worktree files recoverable through the whole rollback. Failures before file restoration put the original folder back; later failures preserve the aside and report its recovery path.
- Retain current delegated-task identity across follow-ups and descendant wakes. Successful tasks await their background work; failed, interrupted, and cancelled follow-ups settle promptly. Stale release and remote-completion guards remain.
- Bound child-control reads and pending-question SQL lookups without relaxing their performance assertions. Normalize older single-target wait replies while advertising the normalized object schema accepted by MCP SDK clients.
- Compose gateway/manual metadata with upstream Claude model routing, startup prompt queues, native suggestions, Codex compaction usage, ACP diagnostics, and graceful process shutdown. Reader defects retain transport classification and their original cause.
- Validate imported native sessions against the selected linked worktree and read compressed or rewound Codex rollouts through the bounded parser. Adapt Git, identity-cache, merge-method, handoff, and management fixtures to the actual contracts.
- Fix sparse redo-history page ordering with linear work. Retain omitted side-chat shells while their panes are mounted, renew HTML preview URLs after atomic replacements, and remove the duplicate question-draft subscription. Stable sidebar listeners preserve sensor behavior and render budgets, including suspended renders.
- Validate channel-specific AppImage names from the Linux manifest and require its version to match the release. Keep the manual cross-platform release and signing policies. Update the measured context budget without cutting model-facing text to fit it.

Validation:

- The final full run completes all 2,244 files: 2,242 pass and two fail, with 30,256 passing cases, one failing case, and 20 skips. Only the premerge mobile settings `__DEV__` collection error and bundled-development `@t3tools/shared` resolution failure remain. There are no new failed files or cases. The cold-cache browser run completes without optimizer reloads or unhandled errors.
- Source fingerprints captured shortly after launch and after the full run match; no tracked edits were made during the run. The initial capture does not independently cover the short interval before it.
- `vp check` passes with zero errors and 11 warnings; `vp run typecheck` passes all 41 tasks; `vp run lint:mobile` passes. The complete render report passes 17/17 scenarios. Current Knip findings exactly match the untouched premerge tree: 59 unused exports and five duplicate exports, with dependency/file checks passing. The pre-commit hook passes formatting and lint, then rejects that reproduced Knip debt; the merge uses a one-time hook bypass after the direct checks.
- Focused repairs pass 536 cases across 16 complete backend, protocol, contract, scanner, and fixture suites; the client regression set passes 165 browser cases. Rollback/safety and delegation/control-read coverage, original reviewer probes, MCP SDK registration, history ordering, and pointer/drag cases pass. Independent reviews identified the lifecycle, schema, and concurrency defects; their original reproductions and the focused post-repair checks pass.
- `check:changed` completes against the 579-file fork delta. Patch validation, formatting, lint, dependency/file Knip checks, GraphQL, all 41 typechecks, and React Compiler checks for 97 files pass. Tests pass 7,497 cases with 13 skips across 321 files; the sole failed file is the reproduced mobile `__DEV__` collection error. Knip export findings match premerge exactly. The first attempt reached the command’s 900-second test-stage limit; the completed run uses a 3,600-second command limit without changing any test timeout.
- A consistent copy of real data applies migrations 083–096, retains all 16 fork records unchanged, reruns with zero writes, and passes SQLite integrity and foreign-key checks.
- Production web, server, and desktop bundles build. Linux AppImage and Debian packages build, and the AppImage opens with isolated state and a freshly migrated database. Closing its window retains the backend, and reopening a selected project works; the first cold CLI activation timed out despite eventually opening the window, while the repeated request succeeded.
- A paired seeded production client completes real Codex Luna turns, file undo/redo observed by a second client, side-chat tab focus, atomic external HTML renewal, model search, split and draft persistence, and Manual pointer reordering with reload persistence. A 390-pixel viewport has no horizontal overflow. External MCP SDK access accepts all 42 advertised tools; scoped reads work, read-only scope restrictions remain, and both temporary management keys reject reuse after revocation. No page errors occur.
- Native mobile runtime, Windows/macOS installers and updater hops, official Connect OAuth, and a live credential-bound Online Snapshots remote are not exercised in this sync. The MCP eval dry run passes; a paid eval cannot start with the available proxy configuration. Claude live verification is unavailable through the configured provider. These are not reported as passing checks.

### 2026-11-12 — Merge upstream/main through `32882540fb`

**Merge commit:** this commit
**Parents:** `44fddf2586d434245d80921c2766e69ede733738` (fork) and `32882540fb1296bd1870253f3fe32bc8369f8a17` (upstream/main); 763 upstream commits since `006d7e38f0`.

The sync retains 42 existing divergence entries and adds DL058, for 43 current entries. DL012 is retired by explicit user decision.

User decisions:

- Retire DL012 and take upstream's longer reconnect wait and retries with the same command ID, including upstream's first-message acknowledgement behavior.
- Keep the fork's prompt suggestions, adopt upstream's presentation and appropriate safeguards, and add optional native Claude generation. Native Claude is selected by default beneath the unchanged default-off master toggle. Typing hides a suggestion and clearing restores it; Escape dismisses it. Delegates and provider-native children never offer suggestions.
- Run council review after integration and verification.

Other decisions:

- Keep every other active fork behavior, including original delegated-task identities for local and linked-environment follow-ups, sidecar checkpoints, and redo.
- Take upstream's removal of web plan-mode controls while preserving fork `/undo` and `/redo` commands, and take upstream's seven-day automatic settlement default.
- Preserve the new Claude SDK's system-prompt snapshots. Tagged Claude guidance travels with each user turn because a resumed SDK session ignores replacement system append text. Native suggestions use the SDK option; Codex never uses upstream's extra sampler.
- Keep canonical upstream migrations through 082 and the independent fork ledger through 015.

Integration repairs:

- A retained rolled-back run can redo through command intake; checkpoints from an abandoned forward branch remain rejected. A real-provider undo/redo check caught the upstream guard before this repair.
- Capture and title-generation effects share a background limit so they cannot jointly occupy every worker. The fork's capture lane and separate limits remain.
- Remote follow-ups reuse their original task. Completion reports carry the observed remote run and cannot settle a newer follow-up. Settled-task question cleanup checks current task state before cancelling a reopened follow-up's wake. Owner and management callers resolve only an unambiguous authorized parent. Their mode ceiling travels with dispatch for the check under the parent lock. A mode refusal preserves the delivered send result; genuine recording failures stay explicit. The existing whole-thread Stop wire behavior remains.
- Fork-only pending migrations and history repairs take database ownership, while a fully current database retains upstream's lock-free CLI startup.
- Gateway model IDs and effort normalization apply to live Claude model changes as well as startup. Optional Codex discovery failures remain nonfatal.
- ACP pipe failures retain the actual process-exit diagnostic when a runtime crashes before initialization. Runtime cleanup preserves that recorded failure while explicit caller cancellation remains cancellation.
- Desktop preview retains bounded recovery and upstream's richer navigation errors. Its injected-runtime extractor follows Playwright's named module instead of an unstable numbered variable, keeping the size guard. Preload coverage runs in the desktop DOM project.
- Preview IPC, shutdown protocols, scanner budgets, forgiving quota parsing, redemption identity, and fork release settings compose with their upstream changes.
- Draft sends retain their undo/redo parser import after plan-mode removal. Sidebar Manual reordering still works within project folders, and search and command-palette drags keep visible titles.
- Native suggestion subscriptions are capability-gated for older servers. Shared browser fixtures publish replacement configuration and thread-list snapshots, preventing previous tests' provider catalogs from leaking into later cases.
- The notification test router implements upstream's route-resolution subscription, retaining all 25 alert, navigation, retry, and subagent assertions. The route-view fixture supplies the newly imported thread-family mount API.
- The telemetry policy fixture transforms its runtime graph before per-case reimports; each case still initializes fresh policy before its first span.
- Delegation integration fixtures follow the retained task identity and immediate foreground completion. Their fake adapter selects its completion gate before announcing it is running, and SQL acknowledgement checks read the task before another tool acknowledges it.
- Pending questions drive the history-window join through the runtime-request index, preventing the retained-question branch from scanning old thread history. The original SQL VM-step limits remain unchanged.
- Removed the unused upstream per-follow-up selector; delegation uses the fork's shared current-run helper.
- Minimap end state stays in the minimap child, restoring the premerge three-render streaming budget without changing navigation. The palette fixture fixes its default-project context and uses the existing initial highlight before Enter; asynchronous discovery can no longer insert a shortcut before its keyboard target. Every original focus and highlight assertion remains.

Validation:

- Repository-wide `vp check` passes with zero errors and nine warnings; `vp run typecheck` passes all 41 tasks, and native mobile lint reports zero violations.
- The premerge full run recorded 2,028 passing and seven failing files. The integrated run recorded 1,892 passing and 13 failing files, with 26,125 passing, 23 failing, and 12 skipped cases; it spanned repairs and left 225 browser/render files unrun after browser-launch errors. Every new failed unit file was repaired and retested in its complete owning suite. These are recorded runs, not a clean final-source all-suite pass.
- Supplemental runs exercised all 223 browser files. After fixture repairs, all 1,132 browser cases pass, including the original 40-file palette batch at 100/100. A monolithic browser run lost its Vite connection after 73 passing files; the remaining files completed in bounded batches. Chromium closed gracefully, so a browser crash was not established.
- Render scenarios pass 13/15. Controlled unchanged-premerge measurements reproduce the remaining MarkdownParagraph count of 59 versus 30 and four sidebar-row renders per switch versus upstream's new budget of two. The new conversation render regression was fixed from four back to three; no budget was widened. The other remaining full-run failures are the pre-existing bundled-development module-resolution and mobile `__DEV__` collection failures. The upstream Android test successor passes 6/6.
- Both council reviewers are satisfied after six rounds. The final focused minimap review found no actionable findings; the ACP, SQL, question-cleanup, mode-ceiling, refusal-response, and guidance corrections raised in earlier rounds are repaired.
- The focused integration checks pass, including all 414 updated Claude adapter cases, the native rollback/fork cases, 99 desktop compatibility cases, 138 contract cases, and 13 combined client interaction cases. No assertion was weakened to hide a merge failure.
- The final MCP toolkit suite passes all four cases, steering completion all 54, Claude automatic delivery all six, native/background task cancellation all eight, control reads all 28, and the SQL projection suite all 57 on the specified Node runtime. The pending-request join uses 20,368 VM steps both before and after old-history removal, within the original performance bounds.
- All 132 ACP protocol, client, runtime, and managed-installer cases pass, including the unchanged Antigravity startup-crash diagnostic and explicit cancellation checks.
- The unused-export comparison has no new findings. The merged tree has 59 unused exports and five duplicate exports, compared with 61 and five before the merge; this pre-existing debt still prevents a clean Knip export check.
- The pre-commit hook was bypassed for this merge because its Knip stage fails on that reproduced baseline debt; formatting, lint, typechecks, and the focused verification were run directly.
- `check:changed` completed against the 560-file fork delta. Patch validation, formatting, lint, dependency/file Knip checks, GraphQL generation, all 41 typechecks, and React Compiler checks for 95 files pass. Its test stage passes 6,476 cases with five skips across 306 passing files; the sole failed file is the pre-existing mobile `__DEV__` collection error. The only nonzero stages are that baseline collection failure and the baseline Knip export debt. An initial palette fixture failure was corrected and verified by this complete 307-file rerun.
- A read-only live-database snapshot applied upstream migrations 081–082, preserved all 15 fork records, reran with zero writes, and passed foreign-key and integrity checks.
- A paired client completed a live Codex Luna file change. Undo removed the file and conversation; redo restored both on the same thread, with the Changes count following. Firefox verified real ghost text, hiding while typing, restoration after clearing, Escape dismissal, and Tab acceptance.
- Production web, server, and desktop bundles built. The Linux AppImage and Debian installer built; the AppImage opened, migrated isolated state, and showed the seeded thread using a test-local basic key store under Xvfb.
- Live Haiku turns complete in both Claude modes. A resumed-session SDK probe exposed ignored replacement system append text; after moving tagged guidance to each user turn, the same live thread produced a sanitized saved suggestion. The native SDK did not return an optional prediction during the live native-mode turns; event delivery and native ghost-text precedence are covered by automated tests.
- Native mobile runtime verification is unavailable on this host; mobile static lint passes. Windows and macOS installers are not exercised. The model-eval runner cannot start without its expected proxy configuration. No deployment or branch push is performed.

### 2026-11-07 — Merge upstream/main through `006d7e38f0`

**Merge commit:** this commit
**Parents:** `48d668698d07ea5e5ecfb69d55243e3d64e217d3` (fork) and `006d7e38f0485431c314a1afcc39fa823f379092` (upstream/main); 807 upstream commits since `955e2bfbb5`.

The sync keeps 43 divergence entries. One was retired by explicit decision: DL056.

User decisions:

- Retire DL056. Upstream reverted #26195 (`34701646e3`), so the Working shelf keeps running threads through any disconnect. The fork's 20-second hold and its `useEnvironmentsHeldFor` hook are gone.

Other decisions:

- Keep DL037's redemption request; upstream did not change that path.
- Adopt upstream's removal of the `migrate-dev-db` migration-slot warning (#24665), which was upstream code. The fork still prunes its checkpoint sidecar tables and `auto_resume_jobs`.
- Adopt upstream's 100,000-record cap per transcript in session scanning, beside the fork's byte and transcript budgets.
- Fork code follows upstream's Effect 4.1.2 upgrade: `effect/Crypto` users moved to `SecureRandom` and `Digest`, including management API keys (DL031).
- Upstream's new `chat.newLocal` shortcut row expects the fork's project picker (DL041).
- The agent-context budget records the measured values. The fork adds the same 224 Codex and 819 MCP bytes over upstream as before the sync.
- Keep canonical upstream migration IDs through 080 and fork IDs 1–15.

Integration repairs:

- Split view never renders a thread hidden by upstream's tag filter. Its check had compared `:`-joined keys against upstream's `\u0000`-joined hidden keys (DL008).
- Prompt suggestion ghost text reads the last message from the thread's turn items, because upstream's timeline entries no longer include assistant messages (DL034). Its settings description fits upstream's 200-character lint.
- Chat images cache like upstream again; only file previews refresh an unrevisioned URL. Upstream's `??` had also stopped file previews from refreshing (DL045).
- Delegated task completion again waits for unawaited background commands (DL018).
- Snapshot retention expires idle current-checkout threads again, and web and mobile honor upstream's managed policy lock (DL051).
- DL020, DL032 and DL008 regression tests follow upstream's fixtures and keep the fork's assertions.
- Removed a Claude effort helper the merge left unused, and updated the fork release workflow's version example to `0.1.7`.

Validation:

- Repository-wide `vp check` (0 errors, the same 6 warnings as pre-merge `dev`) and `vp run typecheck` pass. `vp run lint:mobile` passes.
- Every package suite ran after the merge and was compared with a pre-merge baseline. No new deterministic failure remains. Pre-existing failures: mobile `SettingsServerControlsRouteScreen` (`__DEV__`), server `UsageService` removed-directory case, and web `bundledDev`. Full-run failures that pass alone also pass on pre-merge `dev`.
- A read-only snapshot of the live database applied upstream migrations 077–080 in 1.4 seconds, reran idempotently, matched the migration manifest, kept fork ledger 1–15, and passed `foreign_key_check` and `quick_check`.
- Independent client (Claude Opus 5.5) and server (GPT 6.1 Sol) audits checked every divergence entry; their findings were fixed above.
- A paired web client on seeded real data loaded long history and completed live Codex Luna turns. It verified `/clear`, ordering, the Chat: New Local picker, group-scoped model search, and the Maintenance, provider, gateway, Secrets and Threads settings. In a Luna thread in its own worktree, undo and redo removed and restored its file, with the Changes count following. Prompt-suggestion ghost text showed and Tab accepted it. Tagging a split thread with hiding on collapsed the split to the visible thread and redirected its URL; turning hiding off restored the split.
- Desktop and web production builds pass. The Linux AppImage built, launched under Xvfb with isolated state, created its window, started its backend, and migrated a fresh database to canonical 80 and fork 15.
- Not covered: live Claude turns through the Claude CPA gateway fail with `400 messages[4].name ... named conversation participants`. A minimal SDK script outside T3 reproduces it on both the merged (0.3.316) and pre-merge (0.3.276) SDK, so it is not from this merge. DL013's optional Codex discovery errors still fail the provider probe, as before the merge. Native mobile runtime and Windows/macOS installers were not exercised. No deployment was performed.

### 2026-11-01 — Merge upstream/main through `955e2bfbb5`

**Merge commit:** this commit
**Parents:** `5e37d504809f4d901c4a735588a967f0d37977f9` (fork) and `955e2bfbb5c092c54ad795c8d379fec99702a6b5` (upstream/main); 754 upstream commits since `40d335a7ba`.

The sync keeps 41 divergence entries. Two were retired by explicit decision: DL021 and DL048.

User decisions:

- Retire DL048. Upstream #22291 (`08a40a9d6e`) keeps pending questions and approvals in SQL snapshots, bounded and wire paging, and memory paging, matching by node and request ID. The fork's separate hydration query is gone; its regression cases still pass against upstream's path.
- Retire DL021. Upstream already ships drive-letter and `t3-context` Markdown links; the file-link marker is upstream's `chat-markdown-file-link` class again.
- Keep the DL029 ordering preference inside boring-sidebar project folders instead of upstream's fixed latest-send order (`80fcb7f58f`).
- Keep upstream's new automatic mobile workflows (`mobile-eas-preview-fork.yml`, `mobile-fingerprint-label.yml`) as shipped. DL035 still keeps `release.yml` and `mobile-android-apk.yml` manual-only.

Other decisions:

- Fork split panes compose with upstream side chats: pane-owner guards skip embedded side chats, and the right panel's owner pane stays sticky. The fork's chat header and right-panel portals carry upstream's find-in-thread and side-chat actions.
- Accept upstream's removal of `composerCollapseOnScroll` and of the collapsed-composer controls in the branch toolbar. Upstream's per-row provider logo and instance badge replace the model picker's mixed-provider labels.
- Accept upstream's preservation of unknown project-override keys, so a retired key now round-trips instead of being dropped.
- Keep canonical upstream migration IDs through 076 and fork IDs 1–15.
- Delete `packages/contracts/src/orchestration.ts`, which upstream removed earlier and nothing imports; the previous sync left it behind.

Integration repairs:

- Upstream's pre-prompt restart recovery no longer schedules a continuation for a matched automatic-retry chain after DL047 stops or pauses it. Genuine restart continuations keep upstream's backoff.
- `run_scheduled_task_now` again checks that the task exists before running it, as upstream does.
- The Chat: New shortcut again opens the project picker when no current or open project can take the thread.
- The desktop running-thread count uses upstream's subscriber shell snapshot.
- The fork Windows release installs and checks `patchelf` for upstream's WSL CLI archive.
- Fork test fixtures follow upstream's side-chat `lineage`, filesystem-first Git detection, `lan` server flag, and immediate turn completion. Upstream's thread-details density test uses a taller fixture because DL018 keeps full density while half the card fits.

Validation:

- Repository-wide `vp check` and `vp run typecheck` pass. `vp run lint:mobile` passes.
- The full server suite passed 469 files (6,326 tests, eight skipped). Desktop, client-runtime, contracts, shared, provider, source-control, relay, and scripts suites pass. Mobile's one failing file and web's `bundledDev`, `MessagesTimeline`, and `AttachmentFilePreview` failures also fail on pre-merge `dev`. Remaining web full-run failures were load timeouts that pass in isolation.
- A read-only snapshot of the live database applied upstream migrations 073–076, reran idempotently, matched the migration manifest, kept fork ledger 1–15, and passed `foreign_key_check` and `quick_check`.
- Independent client (Claude Opus 5.5) and server (GPT 6.1 Sol) audits checked every divergence entry; their findings were fixed above.
- A paired web client on seeded real data loaded long history and completed live Claude Haiku and Codex Luna turns, an upstream side chat, a side chat inside a two-pane split, DL029 manual and Last input ordering in project folders, the Chat: New shortcut, group-scoped model search, and the Online Snapshots, provider, gateway, and Secrets settings. A Claude Haiku thread in its own worktree undid and redid its file change, with the file and the Changes count following each step. File restore on a current-checkout thread is refused, as on pre-merge `dev`.
- Desktop and web production builds pass. Linux AppImage and deb installers build. The AppImage, launched under Xvfb with isolated state, created its window, started its backend, and migrated a fresh database to canonical 76 and fork 15. Native mobile runtime and Windows/macOS installers were not exercised. No deployment was performed.
- `knip:check` now passes its file stage; its export stage reports the same 61 unused exports as pre-merge `dev`.

### 2026-10-28 — Merge upstream/main through `40d335a7ba`

**Merge commit:** this commit
**Parents:** `2f1d2d0bbf13717fab719f6ffff9724c1ab6d065` (fork) and `40d335a7ba8ed0e6158a400188b5ed174e6ed19b` (upstream/main); 559 upstream commits since `b808f7fc6d`.

The sync keeps 38 divergence entries. Three were retired by explicit decision: DL009, DL040 and DL049.

User decisions:

- Adopt upstream's Working shelf default (on). DL029 ordering applies while Working is off and inside upstream's Labs project folders, which have no Working shelf.
- Remove the fork's project/global MCP tool scope and its environment default (DL009 retired). Every provider caller now follows upstream's cross-project and linked-environment rules. DL023 keeps eight-target waits, provider/model send selection, self-send rejection and the management-key allowlist, rewritten for upstream's consolidated action tools (#25423).
- Adopt upstream's diff refresh model (DL040 retired). The one-second poll is gone; upstream already authorizes previews against registered project roots.
- Adopt upstream's chat header (DL049 retired). Git actions, project scripts and Open-in controls live in the thread-details card. This also restores upstream's operate-scope guard on header rename.

Other decisions:

- Accept upstream's deletion of LegacySidebar; the fork's split, highlighting, detach and ordering behavior already lives in Sidebar.
- Accept upstream's removal of the legacy `ProviderRuntimeEvent` contract and its test; DL044 lives in the V2 Claude adapter. Accept removal of thread-update PR-link actions; the standalone link/unlink tools remain.
- Drop the fork's dead GitActionsControl PR callback wiring and the integration-only `upstreamBranch` publish result, both removed upstream in #26238.
- Restore `@formkit/auto-animate` (split panes) and the `@modelcontextprotocol/sdk` dev dependency (MCP schema validation test), which upstream dropped.
- Keep canonical upstream migration IDs through 072 and fork IDs 1–15.

Integration repairs:

- Forwarded multi-target waits keep settled results across chunks and retry only unfinished targets, pinned to their runs.
- Codex app-server clients notify both the internal termination deferred and a caller-supplied `onTermination`.
- Split panes go inert and pause route reconciliation under the modal Settings and Usage pages. A draft promoted by upstream's store keeps its split mounted.
- The model picker's All group shows provider labels and sizes its popup with that group.
- The shared review atom no longer polls while hidden. Checkpoint undo and redo refresh workspace entries and local VCS status.
- A sidebar re-render no longer replaces the list ref and cancels an active row drag.
- Strict MCP tool schemas advertise rejection of unknown parameters, matching Effect's runtime behavior.

Validation:

- Repository-wide `vp check` and `vp run typecheck` pass. Mobile native static checks pass.
- The full server suite passed 452 files (5,467 tests, seven skipped). After the final fixes, the web suite passed 452 files (5,013 tests) and the server orchestration suites 113 files (1,905 tests). One earlier web run hit timing-dependent telemetry failures in an upstream-identical test that passes in isolation.
- A read-only snapshot of the 3 GB live database applied upstream migrations 070–072, reran idempotently, matched the migration manifest, kept fork ledger 1–15, and passed `foreign_key_check` and `quick_check`.
- Independent client (Claude Opus 5.5) and server (GPT 6.1 Sol) audits checked every divergence entry; their findings were fixed above.
- A paired web client on seeded real data completed live Codex and Claude turns. A Claude thread in a selected existing worktree undid and redid its file change, with the Changes count following each step. Settings pages, model search, header layout at desktop, panel and phone widths, sidebar drag into a two-pane split, and Settings over a split were checked.
- Desktop and web production builds pass. Linux AppImage and deb installers build. The AppImage, launched under Xvfb with isolated state, created its window, started its backend, and migrated a fresh database. Native mobile runtime and Windows/macOS installers were not exercised. No deployment was performed.
- `knip:check` already failed on pre-merge `dev`; the merged tree passes its file stage and reports unused exports.

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
