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

## Tray and summoning

Commander is meant to stay running. Closing the window hides it to the tray and the Core keeps working. Click the tray icon or use its menu (**Open Commander**, **Quit Commander**) to get it back; **Quit** is the only way to stop it. On Hyprland the tray needs a StatusNotifierItem host in your bar, such as waybar's `tray` module or DankMaterialShell. Launching Commander again while it is running just brings the running window forward.

### A key to summon Commander (Hyprland)

Electron's global shortcuts don't reach Hyprland, so bind a key in Hyprland to the `commander-show` helper instead. It sends `SIGUSR1` to the running app (found through its pid file, `$XDG_RUNTIME_DIR/commander.pid`), then focuses the window with Hyprland's dispatcher. That brings Commander forward from any workspace, or back from the tray, in about 20–35 ms.

Put the helper on your `PATH` once (or use its full path in the bind):

```sh
ln -s "$PWD/apps/desktop/bin/commander-show" ~/.local/bin/commander-show
```

Lua config (`~/.config/hypr/hyprland.lua`):

```lua
hl.bind("CTRL + SHIFT + space", hl.dsp.exec_cmd("commander-show"))
```

Text config (`~/.config/hypr/hyprland.conf`):

```ini
bind = CTRL SHIFT, space, exec, commander-show
```

The helper works out which kind of config you run (from `hyprctl -j status`) and uses the matching focus dispatcher: `hl.dsp.focus({ window = "class:^(commander)$" })` on Lua, `focuswindow class:^(commander)$` on text. Commander's window class (Wayland app_id) is `commander`, if you want window rules for it. `commander-show` exits with status 1 and says so if Commander isn't running.

### Start at login

Off by default. Turning it on writes an XDG autostart entry, `~/.config/autostart/commander.desktop`, which starts Commander hidden in the tray (`--hidden`); turning it off deletes the entry. Hyprland doesn't run XDG autostart entries by itself: they run if your session starts `xdg-desktop-autostart.target` (uwsm does) or runs something like `dex -a`. Otherwise start Commander from your config's start-up commands instead (`exec-once` in a text config).
