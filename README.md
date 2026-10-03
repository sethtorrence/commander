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

The Core's Item store is the only writer to Commander's database: one SQLite file (WAL, through Drizzle on better-sqlite3) at `commander.db` in Electron's `userData` folder (`~/.config/@commander/desktop` on Linux). A snapshot is taken daily into `snapshots/` next to it, keeping the last 7. The window reads and changes Items only through the typed Item store channel (`window.commander.itemStore(...)`). Projects live in the same database, written by the Item store too (`apps/core/src/item-store/projects.ts`); they are not Items, so changes to them (create, rename, recolour, reorder, archive, merge) go to their own Project log (`project_changes`), which powers their undo. Filing an Item into a Project is an Item change, so it is in the activity log and can be undone; a merge refiles every Item of one Project into another with an activity entry each.

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

The end-to-end tests never contact Linear: they point sign-in and sync at a fake Linear on this machine through `COMMANDER_TEST_LINEAR`, which only accepts loopback URLs.

### Syncing

The Core's sync engine keeps each Account current. A newly connected Linear Account syncs at once: every issue you can see that is open, plus those completed or cancelled in the last 30 days, arrive as `linear-issue` Items. After that Commander asks Linear only for what changed (issues and comments updated since the last sync), every **15 minutes** by default; each Account can be set to 30 or 60 in Settings → Accounts, which also shows its last sync, how many issues it holds, the next sync, any problem in plain words, and **Sync now**.

- Each Account syncs on its own, so a slow or failing one never holds up another. Syncing pauses while the machine sleeps or is offline and catches up once afterwards.
- After a failure Commander waits 1, 2, 4… minutes (at most an hour) before trying again, and always waits as long as Linear's rate limit asks.
- Issues archived or deleted in Linear stay in Commander as tombstones, so Links to them survive. Your filing, Links and notes are never touched by a sync.
- If Linear refuses an Account's sign-in (an API key revoked in Linear, say), the Account shows **Reconnect** and only its syncing pauses.
- Where each Account's sync stands (its cursor, last sync and back-off, never a token) is kept in `commander.db`, with a short history of sync runs and the query complexity Linear reported for each.

### Ares's model (Z.ai)

Ares runs on GLM-5.3-Flash through Z.ai's OpenAI-compatible API, behind one model interface in `packages/models` (`complete({ tier, job, messages, schema?, stream? })`), so other providers can be added later without changing callers.

- **API key:** create a pay-as-you-go key at z.ai, paste it into **Settings → Ares** and press **Test**. The key is kept only in the keyring (through `apps/desktop/src/main/secrets.ts`); the Core asks the main process for it when it makes a call and keeps it in memory only. It is never written to the database, logs or the window.
- **Tiers:** Quick (thinking `low`) and Deep (thinking `high`), each with its own model, base URL and thinking level, plus per-job thinking overrides. Point a tier's base URL at any OpenAI-compatible server to use it instead.
- **Usage and the cap:** every call is logged in `commander.db` with its job, tier, model, tokens, latency and cost (never the prompt or reply), and **Settings → Usage** totals it. With a monthly cap set, 80% records one warning for the month; at the cap, Deep-tier calls go to the fallback model if one is set and otherwise fail as over cap, while Quick-tier calls carry on.
- **Tests never call Z.ai:** they run against a fake OpenAI-compatible server (`@commander/models/testing`).

### What Ares may do on his own (Autonomy)

Every Ares action goes through one gate in the Core (`apps/core/src/autonomy/gate.ts`). His jobs register their actions and hand it **proposals**; it checks the **Settings → Autonomy** grid (a level per Action kind, with Section and per-action overrides) and either drops the proposal (Off), keeps it as a suggestion on its Item for you to accept (Ask), or carries it out through the Item store as Ares (Auto, or Auto when sure at 80% confidence or more). Act for you and Delete never go above Ask, whatever is saved, and Delete is Off until you turn it on. A proposal's steps must fit its kind: any delete step makes it Delete, and Organise may file an outside Item but not change it at its Source; a proposal that doesn't fit is refused. Anything suggested because of another Item always asks, and accepting it never starts a next step by itself.

**Ares's activity page** (the Ares tab, or click the Ares module in the header) lists everything he did or suggested, newest first, with his reason and what caused it. Accept or dismiss suggestions there (Organise and Tidy your Sources all at once, Act for you and Delete one at a time), and **Undo** anything he did.

Until his jobs arrive, the end-to-end tests stand in for them: with `COMMANDER_TEST_HOOKS=1` the main process exposes a hook, reachable only from the main process and never from the window, that registers actions and proposes.

## Moving around

Sections sit on numbered notebook tabs: `1`–`8` open Dashboard, Notes, Todos, Linear, Email, Calendar, GitHub and Ares, `,` opens Settings (theme, signal colour, start at login, accounts, security, diagnostics, Ares, usage and autonomy), and `?` shows every keyboard shortcut. Single-letter keys never fire while you are typing in a field or editor.

In Todos, type a Todo in the **New Todo** field (`n` jumps there) and press Enter. `j`/`k` move the selection, `Enter` opens the selected Todo in the detail pane beside the list and `Esc` closes it, `x` ticks it (or unticks it), `Delete` deletes it, and `Ctrl+Z` undoes your last change there, one at a time. Ticked Todos move to the collapsed **Done** group at the bottom (`d` or a click on its header shows them). The detail pane lets you edit the title, and shows the Todo's origin, its Links in both directions (click one to go to the Item at the other end) and its activity log. The Todos tab shows how many Todos are open.

Every Todo belongs to a Project or is Unfiled, and shows it with its Badge (the Project's two-letter code on its accent colour, or a faint `—`). Create Projects in **Settings → Projects** (name, unique code, an accent from the palette of 8). `b` on the selected Todo (or a click on its Badge) opens the Badge picker: type a code or name and press Enter, or choose Unfiled; `Ctrl+Z` undoes it. The Project filter under the sheet header narrows the list: click it, or press `p` then `1`–`9` (the nth Project), `p` then `0` (Everything) or `p` then `u` (Unfiled). There is one filter for the whole app, remembered across restarts, and a Todo added while a Project is selected is filed there.

Each Project has a **Project page**, opened as a temporary tab after the numbered ones: `p` then `o` (the Project selected in the filter), the `↗` beside a Project in the filter bar (or a double-click on it), or **Page ↗** in Settings → Projects. `Esc` or the tab's × closes it and goes back to where you were. It shows the Project's per-Section counts (open Todos, Notes Blocks), its open Todos (`j`/`k`, `x`, `b` and `Ctrl+Z` work as in Todos), and how its Items were filed (by a Rule, by you, from their source, by Ares). Its side column manages the Project:

- **Name, code and accent:** rename and recode it (codes stay unique; a taken one is refused), and pick an accent from the palette of 8 or any colour. A custom colour is deepened per theme until it reaches 3:1 on the sheet, like the signal colour, and a colour close to international orange gets a warning, since orange is kept for live things and Ares.
- **Archive:** the Project leaves the filter bar and the Badge picker, and its Items keep their Badges. Settings → Projects lists archived Projects with **Unarchive**, which puts it back at the end of the order.
- **Merge:** choose the other Project and which one to keep. Every Item moves into the kept one, keeping how it was filed, with an activity entry each; the other disappears and its code is free again.

Drag a row in Settings → Projects (or use its arrows) to put the Projects in order; the order drives the filter bar and the `p` number keys. Every Project change shows a toast with **Undo**; undoing a merge puts both Projects and every Item back as they were.

Notes is one stream of Daily Notes: today on top, earlier days below as you scroll, and the week strip in the header to jump to a day (`‹` `›` step a week). Every line is a Block: `Enter` makes one, `Tab`/`Shift+Tab` indent and outdent, clicking a bullet or `Ctrl+.` folds its children, `Alt+Shift+↑`/`↓` move a Block with its children, `Backspace` on an empty Block removes it, and `Ctrl+Z`/`Ctrl+Shift+Z` undo and redo. Blocks are Items, saved as you go: typing after a short pause (and anything pending when Commander quits), everything else at once.

Each new day starts from the **daily template**: Morning, Meetings, Todos, Ideas and Evening until you change it in **Settings → Notes**, which edits it in the same outliner (nesting and folds included). It applies only when a day's Daily Note is first made as today, when Notes first opens or when the date passes midnight while Commander runs; a blank past day opened from the week strip starts empty. The day gets copies, new Blocks with their own ids, so editing the template changes only days made afterwards. The template is a setting kept in `commander.db` (not Items), and the copies are logged as the User's, "From the daily template".

`[] ` (or `[ ] `) at the start of a Block, or `Ctrl+Enter`, makes it a Todo: the Block gets a checkbox and a **Todo** tag, and the Todo (origin Daily Note, with a made-from Link to the Block) is in the Todos Section at once, shown as "Daily Note · 3 Oct". They are one Todo: the Block's text is its title (editing either changes the other), and clicking the checkbox, `Ctrl+Enter` in the Block or `x` in Todos ticks it; ticked ones stay in the note, struck through. `Backspace` right after the checkbox makes it a plain Block again and deletes the Todo, deleting the Block deletes its Todo, and deleting the Todo in Todos leaves the Block's text; each can be undone. `Enter` in a Todo makes the next Block a Todo too (on an empty one it makes it plain). The Todo's made-from Link opens Notes at the Block, highlighted, and the Block's Todo tag opens the Todo. Each Section shows changes made in the other: after every change the Core tells the window which Items changed (an `items-changed` message), and a Section showing them reads them again.

Linear shows every issue Commander holds from every connected workspace. It opens on **Assigned to me** (the issues assigned to you in each workspace, as the Linear user you signed in as), with **All tickets** one click away; the choice is remembered. Under the Project filter, the **Team**, **Linear project**, **Assignee**, **State** and **Cycle** filters narrow the list together (each choice shows how many open issues it would leave; **Current cycle** is a shortcut), and the list is grouped by workflow state: started, unstarted, backlog and triage, with closed issues (from the last 30 days) in the collapsed **Closed** group. `j`/`k` move, `Enter` opens the issue in the detail pane (its fields, its description and comments rendered read-only from Markdown, its Links both ways and its activity log) and `Esc` closes it; `b` files it under a Project and `Ctrl+Z` undoes that. Editing happens in Linear for now: **Open in Linear** and **Edit in Linear** open the issue in your browser, as do links in descriptions and comments, and images in them show as links, so nothing remote is ever loaded. Opening the Section syncs every Linear Account at once, and a status line says when they last synced (or what went wrong). The Linear tab counts the open issues assigned to you.

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
