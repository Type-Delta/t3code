# t3code Fork

This fork keeps the Windows reliability, durable checkpointing, and workspace capabilities that are still not supplied by the shared base.

## Divergence Log

This is a current-state record only. Each entry describes a surviving difference between `HEAD` and the latest shared base, determined with `git merge-base HEAD upstream/main` (currently `23b55022175e69938514934f65c5a607d38f1e47`, tracked with `base` tag). A feature adopted from upstream is not a divergence merely because it was involved in a merge.

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

Fork migrations `033`–`036` establish this durable checkpoint state (`033_CheckpointDurableState`, `034_CheckpointLegacyMigration`, `035_CheckpointCaptureProviderMetadata`, and `036_CheckpointNavigationMode`). The merged schema then applies upstream lifecycle migrations `037_ProjectionThreadsSettled` and `038_ProjectionThreadsSnoozed`; their ordering is preserved for existing installations, but the upstream lifecycle feature is not itself logged as a fork divergence.

Terminal provider events release the mutation lease for their exact turn before local VCS status refresh or post-turn capture. Aborted turns and provider-turn handoff ownership retain the same exact-owner completion semantics.

**Implementation evidence:** `apps/server/src/checkpointing/`, `apps/server/src/persistence/Migrations/{033_CheckpointDurableState,034_CheckpointLegacyMigration,035_CheckpointCaptureProviderMetadata,036_CheckpointNavigationMode}.ts`, `apps/server/src/orchestration/`, `packages/contracts/src/orchestration.ts`, `packages/client-runtime/src/`, and checkpoint-aware web composer and chat components.

**Recorded validation:** migration and durability regression matrices, sidecar characterization (including unborn repositories, submodules, and linked worktrees), orchestration integration including deterministic blocked-status-refresh terminal lease release, Windows isolation slices, full `vp test`, `vp check`, `vp run typecheck`, and `git diff --check`.

**Last updated:** 2026-07-27

### DL008 — Persistent multi-thread split workspaces

The fork supports up to four visible thread panes in an equal full-height grid, with focused-pane routing, a shared toolbar, one right panel, and controlled ownership of global keyboard, preview, and composer behavior. Panes can be opened or detached from the sidebar, safely reconcile draft promotion/archive/deletion, and animate layout changes without leaving stale portals or listeners.

Split membership is persisted as multiple ordered local groups with active state and stable group colors. Selecting any member restores its group; the sidebar preserves group tinting, supports pane and thread drag placement, and shows complete left/right drop intent. Right-panel ownership remains useful when focus moves to a pane with no surface of its own. Integration with Sidebar V2 keeps displayed panes visible when settled or snoozed shelves are collapsed and preserves split actions in its context menu.

**Implementation evidence:** `apps/web/src/splitViewStore.ts`, `apps/web/src/splitViewDrag.ts`, `apps/web/src/components/{SplitThreadWorkspace,SplitPaneDropHint,Sidebar,SidebarV2,RightPanelTabs,ChatView}.tsx`, `apps/web/src/hooks/useThreadActions.ts`, and the chat routes.

**Recorded validation:** split-store, sidebar, workspace, right-panel, and drag/drop tests; web typecheck; `vp check`; `git diff --check`; and Electron runtime verification of context menus, routing, pane layout, persistent groups, and right-panel attribution.

**Last updated:** 2026-07-27

### DL012 — Prompt preservation during draft promotion

The initial optimistic prompt remains visible while a draft route becomes its server-backed thread. Chat timeline state resets only when the scoped thread identity changes, so the projected `thread.message-sent` event replaces the prompt instead of briefly erasing it.

**Implementation evidence:** `apps/web/src/components/ChatView.tsx`.

**Recorded validation:** `vp check`, `vp run typecheck`, and the repository `dev` startup smoke test.

**Last updated:** 2026-07-22

### DL013 — Codex availability through catalog and turn failures

Codex model and skill discovery is bounded, optional catalog enrichment after a healthy authenticated app-server session starts. Catalog failure cannot replace that healthy snapshot with a provider-status error.

App-server errors are classified by scope: non-retryable turn errors remain visible on the turn while the session stays available for a follow-up message; actual process or transport failure still marks the session unavailable.

**Implementation evidence:** `apps/server/src/provider/Layers/{CodexProvider,CodexSessionRuntime,CodexAdapter}.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, and `packages/contracts/src/providerRuntime.ts`.

**Recorded validation:** focused Codex adapter and provider-runtime ingestion tests, `vp check`, and `vp run typecheck`.

**Last updated:** 2026-07-22

### DL014 — Loadable checkpoint diffs with a legacy baseline fallback

Turn diff summaries are published only for successfully captured, loadable sidecar checkpoints. Provider-reported `file_change` items are not synthesized into checkpoint references, and the client hides legacy non-ready rows that cannot load a diff.

Diff queries use the active checkpoint timeline generation and the stable pre-turn sidecar identity. For an older thread with no captured baseline, the remaining compatibility fallback compares against repository `HEAD`. This absorbs only the surviving baseline-fallback behavior from former DL011; provider-derived summary fallback is not retained.

**Implementation evidence:** `apps/server/src/checkpointing/{CheckpointIds,CheckpointDiffQuery,CheckpointStore}.ts`, `apps/server/src/orchestration/Layers/{CheckpointReactor,ProjectionSnapshotQuery}.ts`, `apps/server/src/git/Utils.ts`, and `apps/web/src/hooks/useTurnDiffSummaries.ts` with their tests.

**Recorded validation:** focused checkpoint query, nested-worktree, projection, and web-summary tests; multi-turn orchestration diff integration; `vp check`; and `vp run typecheck`.

**Last updated:** 2026-07-27

## Merge History

This is an append-only historical decision record. It provides context for integrations but never, by itself, establishes an ongoing fork divergence; use the current Divergence Log for that determination.

Don't forget to update the `base` tag after each merge to track the latest shared base with upstream/main.

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
