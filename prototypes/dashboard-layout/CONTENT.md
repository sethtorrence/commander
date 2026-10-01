# PROTOTYPE sample content: Dashboard and Section layout

Same fictional Thursday 1 October 2026, ~11:40, as the Daily Note prototype (`../daily-note-look/CONTENT.md` and `../daily-note-look/round-2/CONTENT-ROUND2.md` still apply: Titanus, his voice, his queue of four, presence, never interrupting). Fictional org: **Northwind**.

## Locked look (from the Daily Note decision)
Industrial technical-drawing brutalism exactly as `variants/_reference-daily-note.html`: exposed grid with rulers (A–H / 01–24), numbered blocks, part-number labels, Archivo (wide) + IBM Plex Mono, hard edges, no rounded corners or soft shadows. Signal colour INTERNATIONAL ORANGE (the author switched from phosphor green), used only for live things and Titanus. Bake these tokens in:
- dark (graphite sheet #1B1C1E): --org #FF5F00, --on-org #141414, --org-ink #FF5F00, soft rgba(255,95,0,.14), focus rgba(255,95,0,.06), sel rgba(255,95,0,.32)
- light (concrete sheet #E9E7E2): --org #E65600, --on-org #141414, --org-ink #B24200, soft rgba(230,86,0,.13), focus rgba(230,86,0,.075), sel rgba(230,86,0,.28)
If you embed the reference Daily Note, use ?signal=FF5F00&auto=1. Ignore any mention of phosphor green.
Keep all other theme tokens from the reference file.

## Calendar (today)
- 09:30–09:45 Eng standup (done)
- 13:00–13:30 1:1 with Priya (next, in 1h 20m)
- 16:00–16:45 Vendor call: Acme Payments
- Tomorrow: 10:00 Board prep with Marcus; 15:00 Interview: Staff engineer

## Todos (7 open)
- ENG-412 Fix webhook retry backoff · Linear · In Progress (6 days)
- ENG-418 Rotate Acme sandbox API keys · Linear · Todo
- ENG-421 Review rate-limiter PR · Linear · In Review
- Reply to Dana about the Q4 offsite dates · suggested by Titanus (from email)
- Give Priya Acme sandbox access · suggested by Titanus (from the Daily Note)
- Decide on the Acme Payments contract · manual · due Friday
- Buy a birthday gift for Sam · manual

## Email (3 Accounts: personal Gmail, Northwind Google Workspace, an Outlook.com account)
Buckets right now: Needs reply 3 · FYI 12 · Newsletters 28 · Receipts 4
Needs reply:
- Dana Whitfield · "Q4 offsite: which dates work?" · Northwind · 2h ago
- Acme Payments (Leo Park) · "Contract redlines, v3" · Northwind · 5h ago
- Mum · "Sunday lunch?" · personal · yesterday

## Linear (assigned to you, Northwind workspace)
In Progress: ENG-412 Fix webhook retry backoff (6 days)
In Review: ENG-421 Review rate-limiter PR
Todo: ENG-418 Rotate Acme sandbox API keys
Backlog: ENG-399 Retire legacy billing cron
Cycle 41 ends Tuesday: 62% complete.

## GitHub (org: northwind, watching 8 repos)
Since yesterday: 14 PRs merged across 6 repos, 5 opened, 2 releases (api v4.12.0, web 2026.10.01).
Waiting on you: 3 review requests (northwind/api #2213 "Rate limiter: sliding window", northwind/web #981 "Billing settings redesign", northwind/infra #340 "Bump Postgres to 17.6").
Your open PRs: northwind/api #2198 "Webhook retries with jitter" (CI failing).
Titanus's summary (his voice): "Quiet day yesterday. Most of the work was in api and web. The rate limiter is almost done and needs your review. Infra is waiting on you for the Postgres bump. Nothing is on fire."

## Daily Note (today)
The Daily Note from the Daily Note prototype; a Dashboard may show part of it or an entry point to it.
