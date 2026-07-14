# t3code Fork

This fork focuses on fixes and improvements needed for reliable Windows usage.

## Divergence Log

### DL001 — Fix Claude Code authentication and session startup on Windows

Claude Code installed through npm exposes a Windows command shim such as `claude.cmd`, while `@anthropic-ai/claude-agent-sdk` expects a direct native executable path. This caused both provider authentication checks and turn startup to fail with a native-binary error.

The fork patches `@anthropic-ai/claude-agent-sdk@0.3.170` to use its bundled native Windows `claude.exe` when the configured executable is a non-native command path. Explicit native `.exe` paths remain supported.

The server pins the SDK to `0.3.170`, and the desktop artifact builder also pins patched dependencies to the exact versions named by their patch entries when creating the lockfile-free staged production workspace. Without these safeguards, the SDK range can resolve a newer unpatched release (for example `0.3.195`) and pnpm either fails with `ERR_PNPM_UNUSED_PATCH` or produces an installer without the fork fix.

Provider authentication now uses `claude auth status` as the authoritative check and treats SDK initialization as metadata enrichment. This keeps an SDK initialization timeout from hiding a valid authenticated CLI session. Sanitized probe diagnostics are included in provider snapshots and printed in Chromium DevTools as `[t3code/claude-provider]`; raw command output and environment values are never forwarded. The web bundle also prints `[t3code/startup]` with its version, git commit, dirty state, and build timestamp so installed artifacts can be identified directly.

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

Last updated: 2026-07-14
