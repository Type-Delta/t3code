# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

Web and desktop share one application-UI design language; the React Native app follows native iOS and Android conventions for navigation, controls, and gestures. Desktop wraps the web client in Electron and adds shell and IPC affordances, so it is not a separate design language.

## Register

product

## Users

Developers use T3 Code while directing coding agents across local and connected environments. They need to start, monitor, and resume agent work without losing the project, thread, or environment context.

Work is frequently driven remotely: a user starts a turn at the desk, checks it from a phone, and returns to the desktop. Many users run forks of the codebase and drive T3 Code development from inside T3 Code itself.

## Product Purpose

T3 Code is a focused web, desktop, and mobile GUI for coding agents. It makes long-running agent work legible and controllable, including thread management, project context, tool activity, files, diffs, and terminals.

Success is a user who can leave a turn running, come back on any surface, and immediately understand what the agent did, what it changed, and what needs their decision.

## Positioning

T3 Code is a bring-your-own-subscription GUI: it wraps the provider CLIs a user already pays for rather than reselling model access. A Node WebSocket server owns the environment — filesystem, provider credentials, and state — and any client can attach to it, so the same running work is reachable locally, over a LAN or Tailscale, or through the T3 Connect tunnel.

The product is open at the core: roadmap, reasoning, and all code are public, and forks are a supported, expected way to use it.

## Operating Context

- **Environment** — one running T3 server plus the machine, filesystem, provider credentials, and state it owns. **Project** — an environment-local workspace record rooted at a directory. **Thread** — the durable conversation and work history for a project. **Turn** — one user-to-agent cycle, including follow-up work such as checkpointing.
- Users work across multiple environments and multiple devices at once, including phone-to-desktop handoff mid-turn.
- Connection modes are materially different: local, remote/relay, and tunnel. Features must be decided for each.
- Every turn ends with a checkpoint written to a hidden git ref, so diffing and restoring are core to the usage loop, not an add-on.
- Sessions are long-running and often left unattended. Reconnects, restarts, partial streams, and interrupted turns are normal states, not error paths.

## Capabilities and Constraints

- Surfaces: web (both the public `app.t3.codes` client and the locally hosted `npx t3` client), desktop (Electron, which can also act as the host server), and mobile (React Native, iOS and Android, App Store and Google Play).
- Providers: Codex, Claude Code, Cursor, Grok, and OpenCode, each behind its own adapter. Provider-shaped features need a decision per adapter, even when that decision is "not supported here".
- Anything crossing the wire is typed in `packages/contracts`; client logic shared by web and mobile lives in `packages/client-runtime`.
- Performance is a product constraint, not a nice-to-have: oversized WebSocket payloads, continuously repainting animations, and hard-to-render lists are treated as regressions. Users on high-refresh displays notice dropped frames, lying spinners, and stale labels.
- Every way in needs its way out and its way to see it — snooze needs unsnooze, close needs reopen. One-way doors are bugs.
- A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding; a feature is not shipped until each relevant entry point is decided.
- Fork-specific constraints that future work must preserve (see [FORK.md](../FORK.md) for current state): Windows reliability including the Claude resolver and long-path/8.3 handling, durable checkpoints and checkpoint navigation, split workspaces, existing-worktree selection, and read-only subagent transcripts.

## Brand Commitments

Name: T3 Code. The web client is served at `app.t3.codes`; the local host command is `npx t3`. T3 Connect is the tunnel solution.

### Brand Personality

Calm, precise, capable, no bullshit. The interface should feel like dependable developer tooling: compact when work is active, clear when attention is needed, and never ornamental at the expense of information.

### Anti-references

- A marketing-dashboard look with oversized metrics, decorative cards, or dense visual chrome.
- Opaque agent activity that hides failures, restarts, or partial progress.
- Novel controls that make familiar developer-tool actions harder to discover.

## Evidence on Hand

- Product and contributor documentation in `docs/`, split by audience: `docs/user/` (shipped-product voice), `docs/internals/` (architecture, plus the glossary at `docs/internals/glossary.md`), and `docs/operations/` (runbooks).
- Fork divergence record with implementation evidence and recorded validation per entry: `FORK.md`.
- Brand icon assets and their export script: `apps/web/public/`, `scripts/export-brand-icons.ts`.
- Marketing site source: `apps/marketing/`.
- Upstream states a user base of over 100,000. Treat any user count, customer name, testimonial, benchmark, or pricing claim as unverified here — do not invent or restate one without a confirmed source.

## Product Principles

1. Preserve operational context: project, environment, and thread identity should be apparent at the moment an action is taken.
2. Make live work inspectable: progress, failures, and recoverable state should be legible without interrupting flow.
3. Favor familiar, keyboard-friendly developer-tool patterns.
4. Keep the visual system quiet so task state and user content remain primary.
5. Behave predictably across reconnects, restarts, partial streams, and every connection mode.

## Accessibility & Inclusion

Maintain WCAG 2.1 AA contrast and keyboard access for all interactive controls. Respect reduced-motion preferences and communicate state with text or icons as well as color. On mobile, honor the platform's own accessibility affordances (Dynamic Type, TalkBack/VoiceOver, and native gesture expectations) rather than reimplementing them.
