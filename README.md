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

### Data and the Item store

The Core's Item store is the only writer to Commander's database: one SQLite file (WAL, through Drizzle on better-sqlite3) at `commander.db` in Electron's `userData` folder (`~/.config/@commander/desktop` on Linux). A snapshot is taken daily into `snapshots/` next to it, keeping the last 7. The window reads and changes Items only through the typed Item store channel (`window.commander.itemStore(...)`).

- **Schema changes:** edit `apps/core/src/item-store/schema.ts`, run `pnpm --filter @commander/core db:generate`, and commit the generated SQL in `apps/core/drizzle/`. The Core applies pending migrations when it starts.
- **Native module:** better-sqlite3 ships Node-API prebuilt binaries (Linux, macOS and Windows on x64 and arm64), and Node-API binaries load in both Node (Vitest) and Electron (the Core), so there is no rebuild step. `pnpm-workspace.yaml` therefore declines its node-gyp fallback build; on any other platform, set `better-sqlite3: true` there and have a C++ toolchain installed.
- **Throwaway data:** pass `--user-data-dir=<folder>` to Electron to run against other data. The end-to-end tests launch every app with a fresh temporary folder, so they never touch your real database.
