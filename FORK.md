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

If changes were later introduced to any entry, the entry should be updated and includes a brief summary of the change.
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

**Last updated:** 2026-07-15
