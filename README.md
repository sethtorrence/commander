# Commander

A personal command center that runs entirely on your own machine. It brings Linear, email, calendar, GitHub, daily notes, and to-dos into one place, with a local AI Agent that sorts incoming work and surfaces what needs attention.

Status: building v1. The spec is the completed wayfinder map in this repo's issues (label `wayfinder:map`); work is tracked in milestones M0–M8. Domain language lives in [CONTEXT.md](./CONTEXT.md).

## Running Commander (development)

Requirements: Node 24+ and pnpm 12+. On Linux, a Secret Service keyring (e.g. gnome-keyring) for token storage.

```sh
pnpm install          # also downloads Electron's binary (allowed in pnpm-workspace.yaml)
pnpm dev              # starts Commander; on Linux it runs natively on Wayland
pnpm test             # unit tests (Vitest)
pnpm test:e2e         # builds the app and runs the end-to-end tests (Playwright)
pnpm lint             # Biome lint + format check
pnpm typecheck        # TypeScript across the workspace
```

Layout: `apps/desktop` (Electron main, preload, React renderer), `apps/core` (the Core: syncs Sources, holds the Items and runs the Agent, as an Electron `utilityProcess`), and `packages/{domain,ui,sources,models}`. The window and the core talk only through validated messages (`packages/domain`).
