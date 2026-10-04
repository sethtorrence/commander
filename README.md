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
- **Search index:** global search keeps an SQLite FTS5 index in the same file (`search_words`, with `search_docs` beside it), written by the Item store in the same transaction as each change, so it is never behind. Deleted Items and tombstones are left out of it. It is derived data owned by the search module (`apps/core/src/search/`), not part of the Drizzle schema: it is built from the Items when missing (or when the module's index version changes), which takes about 4 s for 50,000 Items.
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
- Each sync also fetches what the detail pane's pickers offer (each team's workflow states, members, labels, cycles not yet over and Linear projects), kept per Account in `commander.db`.

### Two-way sync

Changes you make to a Linear issue in Commander (state, assignee, priority, due date, estimate, cycle, Linear project, labels, and new comments) show at once and reach Linear in the background, as you (your token). Descriptions stay read-only, with **Edit in Linear**.

- **One write path.** Every change to a Source Item's synced fields is an Item store action (`edit-fields`, or an undo), recorded in the activity log as yours and queued for the Source in the same transaction (`outgoing_changes` in `commander.db`), field by field and with the time you made it. Anything that changes Items through the Item store reaches Linear the same way: Todos backed by Linear issues and Ares's accepted suggestions included.
- **Sending.** The sync engine sends each Account's queued changes one issue at a time, never alongside that Account's sync, then syncs the Account again. Only changed fields are sent, labels as add/remove deltas, and comments with an id Commander made, so a retried post is never posted twice. A sync while a change is on its way keeps your value on top.
- **Offline and restarts.** Changes wait while the machine is offline or asleep, survive a restart, and go once Commander is back online.
- **Failures.** A change that can't reach Linear retries after 10, 20, 40 and 80 seconds (always waiting as long as Linear's rate limit asks); after the fifth failure, or at once if Linear refuses the change itself, the issue shows **Couldn’t sync** with **Retry**. The change stays as you made it until it gets through or you undo it. A refused sign-in shows **Reconnect** and the changes wait for it.
- **Conflicts: the newer change wins, per field.** Before sending, Commander reads the issue's history in Linear: if someone changed that field after you did, your change is dropped, Linear's value shows, and the issue says "Changed in Linear by Priya Patel at 14:02" (in its activity log too). Changes to different fields are always both kept.
- **Undo** (`Ctrl+Z` in the Section) restores the old value in Commander and queues it for Linear, under the same rule; undoing a comment deletes it in Linear.

The end-to-end tests check all of this against the fake Linear, which records issue history and accepts the writes. With `COMMANDER_TEST_HOOKS=1` they can also take Commander offline: `COMMANDER_TEST_OFFLINE=1` starts it offline, and a main-process hook switches it back.

### Ares's model (Z.ai)

Ares runs on GLM-5.3-Flash through Z.ai's OpenAI-compatible API, behind one model interface in `packages/models` (`complete({ tier, job, messages, schema?, stream? })`), so other providers can be added later without changing callers.

- **API key:** create a pay-as-you-go key at z.ai, paste it into **Settings → Ares** and press **Test**. The key is kept only in the keyring (through `apps/desktop/src/main/secrets.ts`); the Core asks the main process for it when it makes a call and keeps it in memory only. It is never written to the database, logs or the window.
- **Tiers:** Quick (thinking `low`) and Deep (thinking `high`), each with its own model, base URL and thinking level, plus per-job thinking overrides. Point a tier's base URL at any OpenAI-compatible server to use it instead.
- **Usage and the cap:** every call is logged in `commander.db` with its job, tier, model, tokens, latency and cost (never the prompt or reply), and **Settings → Usage** totals it. With a monthly cap set, 80% records one warning for the month; at the cap, Deep-tier calls go to the fallback model if one is set and otherwise fail as over cap, while Quick-tier calls carry on.
- **Tests never call Z.ai:** they run against a fake OpenAI-compatible server (`@commander/models/testing`).

### What Ares may do on his own (Autonomy)

Every Ares action goes through one gate in the Core (`apps/core/src/autonomy/gate.ts`). His jobs register their actions and hand it **proposals**; it checks the **Settings → Autonomy** grid (a level per Action kind, with Section and per-action overrides) and either drops the proposal (Off), keeps it as a suggestion on its Item for you to accept (Ask), or carries it out through the Item store as Ares (Auto, or Auto when sure at 80% confidence or more). Act for you and Delete never go above Ask, whatever is saved, and Delete is Off until you turn it on. A proposal's steps must fit its kind: any delete step makes it Delete, and Organise may file an outside Item but not change it at its Source; a proposal that doesn't fit is refused. Anything suggested because of another Item always asks, and accepting it never starts a next step by itself.

**Ares's activity page** (the Ares tab, or click the Ares module in the header) lists everything he did or suggested, newest first, with his reason and what caused it. Accept or dismiss suggestions there (Organise and Tidy your Sources all at once, Act for you and Delete one at a time), and **Undo** anything he did.

The end-to-end tests can stand in for his jobs: with `COMMANDER_TEST_HOOKS=1` the main process exposes a hook, reachable only from the main process and never from the window, that registers actions and proposes.

### Ares's jobs

A job runner in the Core (`apps/core/src/agent/`) runs Ares's jobs on their triggers: a pause in your typing, a Source sync, Items arriving, the machine idle (catch-up work), or on request. Each job declares its name, tier, Action kind and action (registered with the gate at every start), its triggers, and how it gathers its input. A run makes one model call under the job's name, so it shows on the Usage page, and hands what comes back to the gate as proposals; Ares never writes to the database himself.

- **Quick jobs** make one call with no tools, and the reply must fit the job's fixed schema (zod). A reply that doesn't, even after one retry, is discarded and logged, never acted on. The material a job works on goes into the prompt as clearly delimited data (`apps/core/src/agent/prompt.ts`, the one place prompt-injection defences harden).
- **The queue** runs a job triggered twice before it starts once, runs at most two jobs at once and never two runs of the same job. A failed or over-cap call is logged and runs again on the next trigger; after repeated failures automatic triggers wait (1, 2, 4… minutes, at most an hour). A missing key or the cap never adds to that wait.
- **What each job has looked at** is kept in `commander.db` (each Item with a fingerprint of how it was, and how far through the activity log it got), so nothing is sent or suggested twice, and it carries on where it left off after a restart.
- **Settings → Ares → Jobs** lists each job with how its last run went, a switch (off, it never runs) and **Run now**. A job whose action the Autonomy settings have Off doesn't run either. The Ares module in the header shows **Working** while a job runs and **Idle** otherwise.

**Suggest Todos** (Quick, thinking `low`) is the first. About 20 seconds after you stop typing in a Daily Note it looks at the Blocks you changed since its last run, and when the machine has been idle for 5 minutes it catches up on today's note. It sends each written Block that isn't a Todo yet (with the Blocks above it as context) and asks for `{"todos":[{"blockId","title","confidence"}]}`, where `blockId` is the short reference the prompt gave the Block (`B1`, `B2`…); any other reference is dropped. Each Todo is a proposal on its Block (Organise / "Suggest Todos"): at Auto when sure, a confident one is added at once (origin Ares, a made-from Link to the Block, the Block's Project filed as inherited), and the Block shows its checkbox; otherwise it waits as a card in the margin beside the Block, with **Add** and **Dismiss**. A dismissed suggestion, or an Ares Todo you undo, isn't offered again for the same Block text. In Todos an Ares Todo shows "Ares · 3 Oct", its made-from Link opens the Block, and renaming it leaves the Block's text alone (and editing the Block leaves its title alone).

The end-to-end tests shorten the pause after typing with `COMMANDER_TEST_ARES_PAUSE_MS` (honoured only with `COMMANDER_TEST_HOOKS=1`).

## Moving around

Sections sit on numbered notebook tabs: `1`–`8` open Dashboard, Notes, Todos, Linear, Email, Calendar, GitHub and Ares, `,` opens Settings (theme, signal colour, start at login, accounts, security, diagnostics, Ares, usage and autonomy), and `?` shows every keyboard shortcut. Single-letter keys never fire while you are typing in a field or editor.

`Ctrl+K` opens the palette from anywhere, even while typing in a note. It finds as you type, over everything Commander holds on this machine: Todos, Daily Notes and their Blocks, Linear issues (by identifier such as `ENG-418`, title, description or comments) and Projects, grouped by kind with their Badges. It also jumps to a Section, a Project's page or today's Daily Note, and runs commands (New Todo, Switch theme, Open Settings, Sync Linear now). `↑`/`↓` move, `Enter` opens the Item where it lives (a Todo in its detail pane, a Block in Notes with the caret in it, an issue in the Linear detail pane) and `Esc` closes. Narrow a search with chips typed among the words, or picked from the filter row: `#LT` (a Project, or `#unfiled`), `in:notes`, `in:todos` or `in:linear`, `@Acme` (an Account) and `after:2026-09-01` / `before:2026-10-01` (when it last changed; `today` and `yesterday` work too). `/` opens the palette on the open Section and the Project filter. Every word must match, and the last one matches as you type it; an exact identifier or title comes first. When a Linear Account is connected and few things match, the last row opens Linear's own search for that workspace in your browser. Search is local and never waits on Ares.

In Todos, type a Todo in the **New Todo** field (`n` jumps there) and press Enter. `j`/`k` move the selection, `Enter` opens the selected Todo in the detail pane beside the list and `Esc` closes it, `x` ticks it (or unticks it), `Delete` deletes it, and `Ctrl+Z` undoes your last change there, one at a time. Ticked Todos move to the collapsed **Done** group at the bottom (`d` or a click on its header shows them). The detail pane lets you edit the title, and shows the Todo's origin, its Links in both directions (click one to go to the Item at the other end) and its activity log. The Todos tab shows how many Todos are open.

**Linear Todos.** Every Linear issue assigned to you, in every connected workspace, whose state is unstarted or started (Todo, In Progress, In Review and each team's equivalents), or Backlog or Triage while it is in its team's current cycle, is also a Todo, shown as **Linear · ENG-418**. After each sync Commander keeps exactly one Todo per such issue, and each sync also re-reads the issues behind open Linear Todos in one batched query, since a reassignment may not show among what Linear reports as changed. `x` moves the issue to its team's default completed state (its first completed state, usually Done), unticking moves it back to the state it was in before, and `Ctrl+Z` undoes either; the change reaches Linear like any other edit. **Set Linear state…** (`s`, the detail pane or the palette) moves it to any state of its team, and the detail pane opens the issue in the Linear Section. The Todo follows its issue's title and Project, and `b` on it files the issue. When the issue is reassigned, cancelled, deleted or moved out of those states, its Todo goes, with an activity entry saying why ("ENG-418 was reassigned to Priya Patel"), and comes back if the issue does; an issue completed in Linear ticks its Todo. A Linear Todo you delete yourself stays deleted. Removing the Account leaves its Linear Todos as plain Todos, with their Links showing the issues as gone. On the Dashboard, `x` on a Linear row ticks its Todo.

Every Todo belongs to a Project or is Unfiled, and shows it with its Badge (the Project's two-letter code on its accent colour, or a faint `—`). Create Projects in **Settings → Projects** (name, unique code, an accent from the palette of 8). `b` on the selected Todo (or a click on its Badge) opens the Badge picker: type a code or name and press Enter, or choose Unfiled; `Ctrl+Z` undoes it. The Project filter under the sheet header narrows the list: click it, or press `p` then `1`–`9` (the nth Project), `p` then `0` (Everything) or `p` then `u` (Unfiled). There is one filter for the whole app, remembered across restarts, and a Todo added while a Project is selected is filed there.

Each Project has a **Project page**, opened as a temporary tab after the numbered ones: `p` then `o` (the Project selected in the filter), the `↗` beside a Project in the filter bar (or a double-click on it), or **Page ↗** in Settings → Projects. `Esc` or the tab's × closes it and goes back to where you were. It shows the Project's per-Section counts (open Todos, Notes Blocks), its open Todos (`j`/`k`, `x`, `b` and `Ctrl+Z` work as in Todos), and how its Items were filed (by a Rule, by you, from their source, by Ares). Its side column lists the Project's Blocks in the Daily Notes by day (click one to open Notes at it, highlighted) and manages the Project:

- **Name, code and accent:** rename and recode it (codes stay unique; a taken one is refused), and pick an accent from the palette of 8 or any colour. A custom colour is deepened per theme until it reaches 3:1 on the sheet, like the signal colour, and a colour close to international orange gets a warning, since orange is kept for live things and Ares.
- **Archive:** the Project leaves the filter bar and the Badge picker, and its Items keep their Badges. Settings → Projects lists archived Projects with **Unarchive**, which puts it back at the end of the order.
- **Merge:** choose the other Project and which one to keep. Every Item moves into the kept one, keeping how it was filed, with an activity entry each; the other disappears and its code is free again.

Drag a row in Settings → Projects (or use its arrows) to put the Projects in order; the order drives the filter bar and the `p` number keys. Every Project change shows a toast with **Undo**; undoing a merge puts both Projects and every Item back as they were.

Notes is one stream of Daily Notes: today on top, earlier days below as you scroll, and the week strip in the header to jump to a day (`‹` `›` step a week). Every line is a Block: `Enter` makes one, `Tab`/`Shift+Tab` indent and outdent, clicking a bullet or `Ctrl+.` folds its children, `Alt+Shift+↑`/`↓` move a Block with its children, `Backspace` on an empty Block removes it, and `Ctrl+Z`/`Ctrl+Shift+Z` undo and redo. Blocks are Items, saved as you go: typing after a short pause (and anything pending when Commander quits), everything else at once.

Each new day starts from the **daily template**: Morning, Meetings, Todos, Ideas and Evening until you change it in **Settings → Notes**, which edits it in the same outliner (nesting and folds included). It applies only when a day's Daily Note is first made as today, when Notes first opens or when the date passes midnight while Commander runs (a day made ahead of time by a `[[day]]` link still gets it then, if nothing was written in it); a blank past day opened from the week strip starts empty. The day gets copies, new Blocks with their own ids, so editing the template changes only days made afterwards. The template is a setting kept in `commander.db` (not Items), and the copies are logged as the User's, "From the daily template". A `#LT` in a template Block files each day's copy (and the Blocks under it) under LT.

`[] ` (or `[ ] `) at the start of a Block, or `Ctrl+Enter`, makes it a Todo: the Block gets a checkbox and a **Todo** tag, and the Todo (origin Daily Note, with a made-from Link to the Block) is in the Todos Section at once, shown as "Daily Note · 3 Oct". They are one Todo: the Block's text is its title (editing either changes the other), and clicking the checkbox, `Ctrl+Enter` in the Block or `x` in Todos ticks it; ticked ones stay in the note, struck through. `Backspace` right after the checkbox makes it a plain Block again and deletes the Todo, deleting the Block deletes its Todo, and deleting the Todo in Todos leaves the Block's text; each can be undone. `Enter` in a Todo makes the next Block a Todo too (on an empty one it makes it plain). The Todo's made-from Link opens Notes at the Block, highlighted, and the Block's Todo tag opens the Todo. Each Section shows changes made in the other: after every change the Core tells the window which Items changed (an `items-changed` message), and a Section showing them reads them again.

Blocks belong to Projects. `#` followed by letters in a Block offers the active Projects by code and name (`↑`/`↓`, `Enter` or `Tab` puts the code in, `Esc` closes), and a known code written out, `#LT` or `#lt`, files the Block under that Project as yours; it is drawn as the Badge in the text, and an unknown code stays plain text. Taking the code out returns the Block to inheriting. A Block without a Project of its own takes its parent's, all the way up, and a top-level one with none is Unfiled; indenting, outdenting or moving a Block re-inherits from its new parent. A Block with its own Project shows its Badge in the margin in place of its number, with the Project's accent as a bar on the margin rule; the Blocks under it carry the bar faintly. Click the Badge (or point at a Block's number and click) for the Badge picker, since `b` is a typing key in a Block: choosing a Project files it, and a `#` code in its text changes to match; choosing **Follow its parent** (or Unfiled, at the top) takes its own Project away. Each change is one step for `Ctrl+Z`, re-filing the Blocks below included. The Core keeps every Block's Project on its Item (filed as inherited when it comes from above), so the Project filter and queries see it. A Todo made from a Block takes the Block's Project and follows it when the Block's (or a Block above it) changes, until you file the Todo yourself with `b` in Todos; from then on it stays where you put it.

The Project filter sits over the Notes stream and is the same one as everywhere else (`p` then a key, when the caret isn't in a Block; `Esc` leaves the Block). With a Project selected, each day shows that Project's Blocks with the Blocks above them dimmed as context, and a day with none of them collapses to one line (click it to see the day in full). Blocks you write in while the filter is on stay shown until it changes. Its counts are Daily Notes with at least one written Block in each Project (or Unfiled), not Blocks.

`[[` in a Block links it to a day or a Project. The picker offers days (a date such as `2026-10-09`, `9 Oct` or `Oct 9`, or `today`, `yesterday`, `tomorrow` or a weekday for the most recent one) and Projects by name or code, archived ones included; `↑`/`↓` choose, `Enter` or a click links it, and `Esc` closes it. The link shows as a chip ("Fri 2 Oct", or the Project's Badge and name): clicking a day chip scrolls the stream to that day (a day with nothing written opens blank, a day ahead too), and clicking a Project chip opens its Project page. `Backspace` just after a chip (or `Delete` just before it) removes it whole; `Ctrl+Z` brings it back. Each day's sheet ends with **Mentioned in**, the Blocks on other days that link to it, and the Project page lists the Blocks that link to its Project the same way; click one to go to its Block. Under the hood the Block's text keeps a token where the chip is (`[[2026-10-09]]` for a day, `[[project:<id>]]` for a Project, so renaming or recoding the Project never breaks it), and the Item store keeps one **refers to** Link per token in step with the text on every write (ADR 0002): linking to a day that has no Daily Note yet makes its empty Daily Note, a Link to a Project is in the same Link table with a target type, and a Link to a Project that was merged away counts for the Project it was merged into.

Linear shows every issue Commander holds from every connected workspace. It opens on **Assigned to me** (the issues assigned to you in each workspace, as the Linear user you signed in as), with **All tickets** one click away; the choice is remembered. Under the Project filter, the **Team**, **Linear project**, **Assignee**, **State** and **Cycle** filters narrow the list together (each choice shows how many open issues it would leave; **Current cycle** is a shortcut), and the list is grouped by workflow state: started, unstarted, backlog and triage, with closed issues (from the last 30 days) in the collapsed **Closed** group. `j`/`k` move, `Enter` opens the issue in the detail pane (its fields, its description and comments rendered from Markdown, its Links both ways and its activity log) and `Esc` closes it; `b` files it under a Project. In the detail pane, pickers change the state (the team's workflow states), assignee, priority, Linear project, cycle and labels, the due date and estimate are edited in place, and the comment box posts with `Ctrl+Enter` (see Two-way sync); `Ctrl+Z` undoes your changes there, one at a time. The description is read-only: **Open in Linear** and **Edit in Linear** open the issue in your browser, as do links in descriptions and comments, and images in them show as links, so nothing remote is ever loaded. Opening the Section syncs every Linear Account at once, and a status line says when they last synced (or what went wrong). The Linear tab counts the open issues assigned to you.

Blocks take light Markdown, stored as typed and shown rendered (the marks show faintly while you edit a Block): `# `, `## ` or `### ` at the start makes a heading (`#LT` with no space stays text), `**bold**` or `Ctrl+B`, `*italic*` or `Ctrl+I`, `` `code` `` or `Ctrl+E`, and `[text](url)` links; a bare URL becomes a link, and pasting a URL onto selected text links it. A click on a link opens it in your browser (`Ctrl+click` while editing that Block), through the same main-process check as every link in the window: only `http(s)` and `mailto` links leave. Pasting or dropping a PNG, JPEG, GIF or WebP image (up to 20 MB) saves it to `attachments/` next to `commander.db`, named by its SHA-256, and puts it in a Block of its own: `Backspace` removes it and `Ctrl+Z` brings it back. The window loads images only through `attachment://local/<name>`, served by the main process from that folder alone. The daily snapshot copies the images it uses into `snapshots/attachments/`; an image no live Block uses is deleted once no kept snapshot uses it either (and it was pasted over a day ago).

**Settings → Notes → Markdown copy folder** keeps a read-only Markdown copy of the Daily Notes, one `YYYY-MM-DD.md` per day, for Obsidian, grep and backups; `commander.db` stays the source of truth. It is off until you choose a folder with the system folder picker (Commander's own data folder and the whole disk are refused), and it can be changed or turned off. Choosing or changing the folder writes every day with something written in it; after that the Core rewrites a day's file about 2 seconds after its Blocks or Todos change, writing beside the file and renaming it into place, and only when its text changed. Top-level heading Blocks become headings with their Blocks as a tab-indented list beneath, other Blocks become list items, Todos are `- [ ]` / `- [x]`, a Block's own Project is `#LT` (inherited ones aren't repeated), `[[` links are `[[YYYY-MM-DD]]` and `[[Project name]]`, and images are copied into `attachments/` there and embedded as `![](attachments/<file>)`. Commander writes only those files, never reads anything back, and never deletes or touches anything else in the folder, so it can sit inside an Obsidian vault; edits made to the files are overwritten on the next write, as each file's first line says. If the folder can't be written (gone, or no permission), Settings → Notes says why and Commander keeps trying every 15 seconds; editing never waits on it.

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
