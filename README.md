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

The Core's Item store is the only writer to Commander's database: one SQLite file (WAL, through Drizzle on better-sqlite3) at `commander.db` in Electron's `userData` folder (`~/.config/@commander/desktop` on Linux). A snapshot is taken daily into `snapshots/` next to it, keeping the last 7. The window reads and changes Items only through the typed Item store channel (`window.commander.itemStore(...)`). Projects live in the same database, written by the Item store too (`apps/core/src/item-store/projects.ts`); they are not Items, but filing an Item into one is an Item change, so it is in the activity log and can be undone.

- **Schema changes:** edit `apps/core/src/item-store/schema.ts`, run `pnpm --filter @commander/core db:generate`, and commit the generated SQL in `apps/core/drizzle/`. The Core applies pending migrations when it starts.
- **Native module:** better-sqlite3 ships Node-API prebuilt binaries (Linux, macOS and Windows on x64 and arm64), and Node-API binaries load in both Node (Vitest) and Electron (the Core), so there is no rebuild step. `pnpm-workspace.yaml` therefore declines its node-gyp fallback build; on any other platform, set `better-sqlite3: true` there and have a C++ toolchain installed.
- **Throwaway data:** pass `--user-data-dir=<folder>` to Electron to run against other data. The end-to-end tests launch every app with a fresh temporary folder, so they never touch your real database.

### Build config (app client IDs)

The repo is public, so Commander's app registrations never go in it. They come from a private, git-ignored `config/local.json`, read at build time (`pnpm dev`, `pnpm build`, `pnpm test:e2e`) and injected into the main process. Without it, the committed `config/example.json` is used, which has no client IDs. A malformed file fails the build with the reason.

```sh
cp config/example.json config/local.json   # then fill in the client IDs
```

```json
{
  "linear": {
    "clientId": "your Linear OAuth app's client ID",
    "redirectPort": 48613
  }
}
```

Restart `pnpm dev` after changing it.

### Connecting Linear

**Settings → Accounts** (`,`) lists Linear Accounts by workspace name. Each Linear workspace is its own Account, and you can connect several. Connecting the same workspace again updates its Account rather than adding a second.

- **Connect Linear** signs in through your browser: OAuth with PKCE (S256) and no client secret, asking for `read` and `write`. Commander listens on `http://localhost:<redirectPort>/callback` only while a sign-in is open. It is offered only when `config/local.json` has a Linear client ID.
- **Use an API key instead** takes a Linear personal API key (Linear → Settings → Security & access → Personal API keys). It works without any OAuth app.
- Tokens and API keys are stored only in the system keyring, through the secrets module. If no real keyring is available, Commander refuses to connect and says how to fix it. The window never receives a token. The Accounts themselves (workspace name, how they signed in, and whether they need reconnecting) are kept in `accounts.json` in the `userData` folder.
- Access tokens last 24 hours. The main process refreshes one when it is within 10 minutes of expiry, the first time the Core asks for it. If Linear refuses a refresh for good (the access was revoked, or a refresh was replayed too late), the Account shows **Reconnect**. Reconnecting signs in again and keeps the same Account.
- **Remove** deletes the Account's keyring entry and its Items. Your notes and Todos stay, and their Links to removed Items show them as gone.

**Registering Commander's Linear OAuth app (once, by the owner):** in Linear, open Settings → API → OAuth applications → New. Name it "Commander", set the callback URL to `http://localhost:48613/callback` (use your `redirectPort` if you changed it; Linear matches it exactly, port included), leave webhooks off, and create it. Copy the **client ID** into `config/local.json`. Commander doesn't need the client secret, so never copy it anywhere. Then run `pnpm dev`, choose **Connect Linear**, and approve. This also confirms that Linear accepts the fixed loopback port.

The end-to-end tests never contact Linear: they point sign-in at a fake Linear on this machine through `COMMANDER_TEST_LINEAR`, which only accepts loopback URLs.

### Ares's model (Z.ai)

Ares runs on GLM-5.3-Flash through Z.ai's OpenAI-compatible API, behind one model interface in `packages/models` (`complete({ tier, job, messages, schema?, stream? })`), so other providers can be added later without changing callers.

- **API key:** create a pay-as-you-go key at z.ai, paste it into **Settings → Ares** and press **Test**. The key is kept only in the keyring (through `apps/desktop/src/main/secrets.ts`); the Core asks the main process for it when it makes a call and keeps it in memory only. It is never written to the database, logs or the window.
- **Tiers:** Quick (thinking `low`) and Deep (thinking `high`), each with its own model, base URL and thinking level, plus per-job thinking overrides. Point a tier's base URL at any OpenAI-compatible server to use it instead.
- **Usage and the cap:** every call is logged in `commander.db` with its job, tier, model, tokens, latency and cost (never the prompt or reply), and **Settings → Usage** totals it. With a monthly cap set, 80% records one warning for the month; at the cap, Deep-tier calls go to the fallback model if one is set and otherwise fail as over cap, while Quick-tier calls carry on.
- **Tests never call Z.ai:** they run against a fake OpenAI-compatible server (`@commander/models/testing`).

## Moving around

Sections sit on numbered notebook tabs: `1`–`8` open Dashboard, Notes, Todos, Linear, Email, Calendar, GitHub and Ares, `,` opens Settings (theme, signal colour, start at login, accounts, security, diagnostics, Ares and usage), and `?` shows every keyboard shortcut. Single-letter keys never fire while you are typing in a field or editor.

In Todos, type a Todo in the **New Todo** field (`n` jumps there) and press Enter. `j`/`k` move the selection, `Enter` opens the selected Todo in the detail pane beside the list and `Esc` closes it, `x` ticks it (or unticks it), `Delete` deletes it, and `Ctrl+Z` undoes your last change there, one at a time. Ticked Todos move to the collapsed **Done** group at the bottom (`d` or a click on its header shows them). The detail pane lets you edit the title, and shows the Todo's origin, its Links in both directions (click one to go to the Item at the other end) and its activity log. The Todos tab shows how many Todos are open.

Every Todo belongs to a Project or is Unfiled, and shows it with its Badge (the Project's two-letter code on its accent colour, or a faint `—`). Create Projects in **Settings → Projects** (name, unique code, an accent from the palette of 8). `b` on the selected Todo (or a click on its Badge) opens the Badge picker: type a code or name and press Enter, or choose Unfiled; `Ctrl+Z` undoes it. The Project filter under the sheet header narrows the list: click it, or press `p` then `1`–`9` (the nth Project), `p` then `0` (Everything) or `p` then `u` (Unfiled). There is one filter for the whole app, remembered across restarts, and a Todo added while a Project is selected is filed there.

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
