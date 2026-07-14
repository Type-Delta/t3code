# T3 Code Design System

## Design Intent

T3 Code is a compact, task-first developer tool. The existing interface prioritizes conversation, execution state, and project context over decorative framing. New work should inherit this restrained application-ui register.

## Foundations

- **Typography:** DM Sans is the interface family, with system-sans fallbacks. JetBrains Mono / system monospace is reserved for source, terminal, paths, and technical data.
- **Scale:** Use the established compact scale: 12px supporting metadata, 14px body and controls, and 16–20px for local headings. Prefer medium and semibold weights to large type jumps.
- **Color:** Use the existing semantic CSS variables (`--background`, `--foreground`, `--muted-foreground`, `--border`, `--primary`, and semantic status colors). The primary accent is blue; neutral surfaces carry nearly all layout structure.
- **Theme:** The app supports light and dark themes through shared semantic tokens. Never introduce hard-coded light-only or dark-only colors when a token exists.
- **Shape:** The base radius is 10px. Controls and compact surfaces generally use the existing small and medium radii, with full rounding only for intentionally pill-shaped controls.

## Layout & Density

- Preserve the app shell: fixed workspace chrome, flexible main content, and compact toolbars.
- Keep chat content centered and readable; the timeline uses a `max-w-3xl` column.
- Prefer flex layouts for single-row control groups and preserve the existing responsive container-query patterns.
- Use spacing to group related controls, not cards or decorative separators.

## Components & Interaction

- Build on existing UI primitives (`Button`, `Tooltip`, `Menu`, `Group`, `Empty`) and their established focus, disabled, and theme behavior.
- Text actions should look like links only when they trigger navigation or a direct, understandable action. Include a visible focus treatment and an accessible name that states the result.
- Keep transitions short (about 150–200ms) and limited to state feedback. Preserve `motion-reduce` fallbacks.
- Empty states should explain the current context and the next action in concise language.

## New-Thread Empty State

The new-thread timeline uses a two-line hierarchy: a contextual title and a muted instructional subtitle. When a project is active, the project name is an inline text action that opens the project in the preferred editor; without a project, the title identifies the current machine/environment. This context is informational first and should remain visually lighter than active conversation content.
