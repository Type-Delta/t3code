# t3code Fork

This fork focuses on fixes and improvements needed for reliable Windows usage.

## Divergence Log

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

Last updated: 2026-07-14
