# Gmail and Google Calendar access for a local desktop app

Research for ticket #2. Researched 2026-10-01 against Google's current documentation. Numbers in square brackets point to the [Sources](#sources) list. Where a page shows a "last updated" date, the Sources list gives it. Secondary sources (community posts, vendor price lists, blog posts) are marked **(secondary)**.

## Question

What does Google require for a desktop app that runs entirely on the User's machine to work as a full Gmail client (read, send, label, archive) and a full Google Calendar client? First for the author and a handful of testers, later for paying Users. In particular:

- Which OAuth scopes a full mail and calendar client needs, and which of them Google classes as restricted or sensitive.
- What verification and security assessment (CASA) those scopes trigger, and whether apps that keep data only on the User's device are treated differently.
- Testing-mode limits: how many test users, and when refresh tokens expire.
- The desktop OAuth flow (loopback redirect, PKCE), and whether a client secret can safely ship inside the app.
- Change detection without a server: Gmail history and push (Pub/Sub watch) vs polling; Calendar sync tokens and push channels.
- Quotas and rate limits that matter for 3–4 Accounts per User.
- IMAP/SMTP with OAuth (XOAUTH2) or app passwords as an alternative path, and what it costs (labels, threading, search).

## Short answer

- **Every way of reading Gmail is restricted.** A full client needs `gmail.modify`, a restricted scope. It covers read, send, drafts, label, archive, trash and search. Outside the `gmail.addons.*` scopes, which work only inside a Google Workspace Add-on and so are no use to a desktop app, the only scopes that are not restricted are `gmail.labels` (non-sensitive) and `gmail.send` (sensitive), and neither can read mail. IMAP, SMTP and POP all need `https://mail.google.com/`, which is also restricted, so IMAP is not a way around this [1][2][6]. **Calendar scopes are not on Google's restricted list.** Reading calendar events is Google's own example of a *sensitive* scope [2][4].
- **Author and testers (up to about 100 people the author knows personally):** no verification is needed. This falls under Google's "personal use" exception. Users see an "unverified app" warning, and the project has a lifetime cap of 100 users that can never be reset [5][6][11][12]. Do **not** leave the app in "Testing" status: tokens there expire 7 days after consent, so every tester would have to sign in again each week. Publishing the project "In production" without verification avoids the weekly expiry and keeps the same warning and the same 100-user cap [12][14].
- **Paying Users:** the app needs brand verification and restricted-scope verification. That means a homepage and privacy policy on a verified domain, a YouTube demo video, a permitted use case ("built-in and web email clients that allow users to compose, send, read, and process email via a user interface" is on the approved list), and Limited Use compliance. Google estimates about 6 weeks [5][6][7]. **Plan on an annual paid CASA security assessment.** Google's own pages disagree about whether an app with no server needs it. The restricted-scope verification guide says the assessment is triggered when restricted data is stored on, transmitted to, or reachable through a server [5]. But the Security Assessment help page says apps requesting restricted scopes "must undergo an annual security assessment", with no server condition [9], and the Workspace consent-screen guide lists "Security assessment" as a requirement of every restricted scope [63]. Two 2026 developer reports **(secondary)** say Google required CASA from apps that had no server at all [60][61]. Separately, Commander's hybrid mode (the User's own cloud AI key) would send mail content to a third-party server anyway. CASA is now done by an accredited lab at assurance level AL1 or AL2, chosen by Google, and must be redone every year [9][10]. One lab lists AL1 at $675–$855 **(secondary)** [62].
- **Desktop OAuth:** open the system browser, use a loopback redirect (`http://127.0.0.1:<port>`), and use PKCE with S256. Custom URI schemes and the copy/paste (OOB) flow are no longer supported for this use [15]. Google says a desktop app's client secret "is obviously not treated as a secret", and the current page marks `client_secret` as optional in the token exchange [14][15]. **But Google's OAuth policy says client credentials must never be committed to a public repository** [16]. Commander's repo is public, so the client ID and secret have to be injected at build time or supplied by the User.
- **Change detection without a server means polling.** For Gmail, Google itself says installed apps should use poll-based sync (`history.list`, 2 quota units per call), not push [19]. Gmail push goes through Cloud Pub/Sub and is built for a backend [19][20]. Calendar push channels need a public HTTPS webhook with a valid certificate, which a local app cannot provide, so Calendar is also polled, using `syncToken` [22][23].
- **Quotas changed on 2026-05-01, and projects created after that date get the new limits.** Gmail allows 6,000 units per minute per user (it was 15,000), and `messages.get` now costs 20 units (it was 5). The first full download of a mailbox is therefore roughly 10× slower than before: at most about 300 messages per minute per Account. Each project also has a daily "billing threshold" (Gmail 80M units, Calendar 1M requests). Google plans to start charging for use above it "later in 2026" [24][25][26][27]. All Users who share Commander's OAuth client share that project's quotas, and **Calendar polling is the tightest limit at scale** (see the worked numbers below).
- **IMAP/SMTP:** Gmail's IMAP extensions keep labels, thread IDs and full Gmail search, so those features are not lost [34]. The real costs are elsewhere. IMAP still needs the restricted `mail.google.com` scope, and the app must show it "fully uses" that scope [6][33]. OAuth-authenticated IMAP sessions drop after about an hour [32]. Gmail allows 15 connections per account at once [36], and Workspace accounts have a 2,500 MB/day IMAP download limit [35]. **App passwords** avoid OAuth and verification for mail only. They need 2-Step Verification, are unavailable on some accounts, and Google discourages them [37]. Calendar over CalDAV rejects password logins and requires OAuth [39].
- **Fallback option:** each User registers their own Google Cloud project (bring-your-own client). Each User is then the "personal use" developer of their own app. No verification or CASA is needed, and quotas are separate per User. The cost is setup effort for each User (see [Implications](#implications-for-the-decisions)).

## 1. OAuth scopes and their classification

### Gmail

| Capability Commander needs | Narrowest scope that allows it | Google's classification |
|---|---|---|
| Read messages and threads, search with Gmail query syntax, add/remove labels, archive (remove `INBOX`), trash, drafts, send | `gmail.modify` [45][46][47] | Restricted [1] |
| Create, rename and delete labels only (no message access) | `gmail.labels` [50][44] | Non-sensitive [1] |
| Send only | `gmail.send` [46] | Sensitive [1] |
| Server-side Gmail filters (max 1,000), vacation responder, editing Gmail-stored signatures | `gmail.settings.basic` [49][65][67] | Restricted [1] |
| Permanently delete, bypassing Trash | `https://mail.google.com/` only [48] | Restricted [1] |
| IMAP, SMTP or POP access | `https://mail.google.com/` ("includes any usage of IMAP, SMTP, and POP3 protocols") [2][33] | Restricted [2] |
| Headers and labels only, no bodies | `gmail.metadata` (cannot use the `q` search parameter) [1][47] | Restricted [1] |

Facts the decisions turn on:

- Google's Workspace policy treats as restricted "any Gmail API scope that permits an application to read, create, or modify message bodies (including attachments), metadata, or headers" [7]. **No reading scope is lighter than restricted.**
- `gmail.modify` is the practical "full client" scope. `https://mail.google.com/` is only justified "if your application needs to immediately and permanently delete threads and messages, bypassing the trash" [1][6].
- `messages.list` accepts `q`, which "supports the same query format as the Gmail search box", but not under `gmail.metadata` [47].
- Granular consent: the consent screen lets a user grant only some of the requested scopes. The app must read the `scope` field of the token response and turn off features whose scopes were refused [15][16].
- Google Workspace Accounts: admins can restrict a predefined list of "high-risk" Gmail scopes. The list includes `gmail.modify`, `gmail.send`, `gmail.readonly` and `mail.google.com` [41]. Separately, "unverified third-party apps that access Gmail data and have more than 100 users worldwide" are blocked for new installs in Workspace organizations unless an admin trusts them [42]. A User's work Accounts can therefore be blocked by their employer's admin regardless of what Commander does.

### Google Calendar

The Calendar scope page lists 20 scopes but no classification column [3]. What can be established from primary sources:

- No Calendar scope appears on Google's list of restricted scopes. That list covers Gmail, Drive, Fit, Chat, Data Portability, Photos Ambient and Google Health only [2].
- Google's verification guide gives "reading events stored in Google Calendar" as an example of a **sensitive** scope [4]. Sensitive scopes need app verification but no security assessment [63].
- The exact classification of each Calendar scope appears only on the Cloud Console Data Access page [5]. **Confirm there before submitting** (this could not be checked without a Console session).

Calendar scopes relevant to Commander [3][53][54]:

| Need | Scope(s) |
|---|---|
| Everything, including sharing (ACLs) and deleting calendars | `calendar` |
| Create, edit and RSVP to events on all calendars | `calendar.events` (`events.insert` also accepts `calendar.events.owned` and `calendar.app.created`) |
| List the user's calendars | `calendar.calendarlist.readonly` |
| Free/busy only | `calendar.freebusy` or `calendar.events.freebusy` |
| An app-owned secondary calendar (for example, Todo time blocks) | `calendar.app.created` ("Make secondary Google calendars, and see, create, change, and delete events on them") |

## 2. Verification, CASA, and whether on-device apps are treated differently

### Verification types and timelines

Google's FAQ lists three kinds of verification and their expected durations: brand verification, 2–3 business days; sensitive scope verification, 10 business days; restricted scope verification, 6 weeks, "plus a security assessment" [6]. For restricted scopes Google requires [5]:

- A verified domain (Google Search Console) and a public homepage that describes the app and links to a privacy policy on the same domain.
- Brand verification completed first.
- An unlisted YouTube demo video, in English. It must show the consent flow, the client ID in the browser's address bar, and every restricted scope in use.
- A permitted application type, plus a written explanation of why narrower scopes are not enough.
- Compliance with the Limited Use rules.

The approved Gmail uses include "built-in and web email clients that allow users to compose, send, read, and process email via a user interface", and productivity apps "providing generative AI summaries" [7]. Commander fits the first category.

### CASA (the security assessment)

- It is run under the App Defense Alliance's Cloud Application Security Assessment (CASA), which is based on OWASP ASVS. Apps are assigned **AL1 or AL2**, and "all applications must be revalidated every year" [9][10].
- Both AL1 and AL2 are "Lab Tested - Lab Verified", performed by an ADA-authorized lab. Google, not the developer, decides which level is required [10]. Google's FAQ still describes a free self-scan "Tier 2" option [6], but the current ADA page lists only lab-tested levels [10]. A 2026 report **(secondary)** says "the old free self-scan is gone" [61]. **Treat the FAQ's tier wording as out of date.**
- Google charges nothing. The developer pays the lab directly [6]. Indicative prices: TAC Security lists AL1 at $675 (Basic) or $855 (Premium), and AL2 at $5,400 **(secondary, vendor page, no date)** [62]. A July 2026 report quotes "~$540/year even at the cheapest lab" **(secondary)** [61].
- The reassessment is a full retest every year, and critical or high findings must be fixed before the Letter of Assessment is issued [6].

### Does keeping data on the device change anything?

- **Official text that ties CASA to servers:** "If you store or transmit restricted scope data on servers, then you need to complete a security assessment." Also: "Every app that requests access to Google users' restricted data and has the ability to access data from or through a third-party server must go through a security assessment." [5] In 2019 Google's developer blog advised architecting apps so that user data "is only ever stored client-side on the user's device" in order to avoid the assessment [59].
- **Official text that does not:** the Security Assessment help page says apps requesting "restricted scopes must undergo an annual security assessment" and draws no line between on-device and server apps [9]. The Workspace guide's scope table gives restricted scopes three requirements, "Basic app verification + Additional app verification + Security assessment", again with no server condition [63]. So Google's primary pages contradict each other, and the newer, broader wording matches what developers report.
- **Recent practice (secondary, consistent with the broader wording):**
  - In March 2026, a developer of a local-only iOS Gmail app reported being denied because "a security assessment was now mandatory". The community manager's reply was explicitly generated with Gemini, so it is not authoritative [60].
  - In July 2026, a developer of a serverless mobile Drive app received a request from Google's "Third Party Data Safety Team" for CASA AL1 and concluded that the requirement is "decided by the scope tier, not by trigger conditions" [61].
- **Commander-specific trigger:** the hybrid AI mode, where a User adds a cloud API key, would transmit restricted Gmail data to a third-party server. That fits the documented trigger and also counts as a "transfer" under Limited Use (see below) [5][8].
- **Verification itself is never waived by on-device storage.** The on-device argument only ever concerned the security assessment [5].

### Other obligations that apply to restricted scopes (relevant to the Agent)

- **Limited Use:** data may be used only for "user-facing features that are prominent in the requesting application's user interface". Transfers are allowed only for those features and "only with the user's consent". Humans may not read the data without the user's affirmative agreement, and use for advertising is banned [8].
- **AI and machine learning:** Google user data may be used only by a "personalized model". That explicitly "include[s] any models run exclusively on-device". The data may not "train or improve foundational or frontier models or be stored in conjunction with such models" [6][7]. Commander's local-first model fits this definition. A cloud-key mode would need a provider that does not train on or retain the data.
- **Required security measures** [7]:
  - Encrypt user data at rest, and keep OAuth access and refresh tokens "encrypted at rest".
  - Manage keys properly, for example in a hardware security module "or equivalent-strength key management system".
  - "Protecting against prompt injection techniques by either using Google Cloud Platform's Model Armor or other prompt injection protection." This requirement appears in the policy page last updated 2026-09-03. The date it was added could not be found, so **treat it as recent**.
- **Google APIs Terms of Service:**
  - Prohibits creating "permanent copies" of API content or keeping "cached copies longer than permitted by the cache header" unless "expressly permitted by the content owner" [43]. Gmail's own sync guide tells clients to "cache the results" [18], and "automatically backup email" is an approved use [7]. A local mail store therefore looks expected, but this is a judgment, not a stated rule.
  - The Terms also require letting Users export their data [43].

### Exceptions

You do not need verification for [5][11]:

- **Personal use:** "you are the only user of your app or ... used by only a few users, all of whom are known personally to you". The help center puts this at "fewer than 100 users".
- **Development, testing or staging projects.** The restricted-scope guide says this applies to projects kept in "Testing" publishing status [5].
- **Internal apps:** only members of the developer's own Google Workspace organization, with the user type set to Internal.

Personal-use and testing apps still show the unverified-app or tester warning and are still subject to the 100-user cap [5][12].

## 3. Testing-mode limits and refresh-token lifetime

| Setting | Who can authorize | Warning shown | Refresh token lifetime |
|---|---|---|---|
| External, **Testing** | Up to **100 test users**, listed by hand. Adding a user "consumes" quota [12] | Tester warning [12] | **7 days from consent.** The refresh token "will also expire" [12][14] |
| External, **In production, unverified** | Anyone, up to **100 new users over the project's lifetime**. The cap "cannot be reset or changed" [6][12] | "Unverified app" screen [12][13] | Normal (see the list below) |
| External, In production, verified | Anyone. No cap for approved scopes [12] | None | Normal |
| Internal | Only members of the developer's Workspace organization [12] | None | Normal |

Refresh tokens also stop working when [14]:

- The user revokes access.
- The token has not been used for 6 months.
- "The user changed passwords and the refresh token contains Gmail scopes."
- The account exceeds **100 refresh tokens per Google Account per OAuth client**. The oldest one is then invalidated "without warning". This matters if a User reinstalls often or signs in from several machines.
- An admin restricts the service.
- A time-limited grant expires.

Google's policy tells apps that need to learn about revocations to integrate with Cross-Account Protection. Otherwise the app has to handle a failed token refresh gracefully [16].

Housekeeping:

- Since the 2025-10-27 policy change, Google may delete OAuth clients that have been inactive for 6 months. Deleted clients can be restored for 30 days [16].
- A client secret is shown only once, at creation [17].
- Google requires separate Cloud projects for development and production [16].

## 4. The desktop OAuth flow and the client secret

- **Redirect:** use a loopback IP address, `http://127.0.0.1:<port>` or `http://[::1]:<port>`, with a listener on any free port. Google calls this "the recommended mechanism" for desktop apps [15].
  - The copy/paste out-of-band (OOB) flow "is no longer supported" [15].
  - Custom URI schemes are "no longer supported on Android and Chrome apps", and elsewhere the page says they "are no longer supported due to the risk of app impersonation" [15]. Loopback is the only option Google recommends for Linux, macOS and Windows desktop apps.
  - Creating a Desktop client needs no redirect registration [17].
- **Browser:** the request must open in the system browser. Sending it to "an embedded user-agent under the developer's control" (a webview) is forbidden by policy [16][15].
- **PKCE:** supported, with S256 recommended. The verifier is 43–128 characters [15].
- **Refresh tokens:** "always returned for installed applications" [15]. "Incremental authorization is not supported for installed apps" [15], so requesting the scopes in context means separate authorization requests.
- **DPoP (optional, appears new):** the token request can carry a DPoP proof, which binds the refresh token to a device key. Google recommends keeping that key in a TPM or other hardware-backed keystore [15]. The page was last updated 2026-09-14. The date DPoP was introduced is not stated.
- **Client secret:**
  - For installed apps the secret is embedded in the app, "the client secret is obviously not treated as a secret", and such apps "cannot keep secrets" [14][15].
  - Google's client guide now calls native apps public clients that "do not use client secrets" [17], and the token-exchange table marks `client_secret` as **Optional** [15]. Older Google Desktop clients required the secret, so **test this with a real Desktop client before relying on it.**
  - Shipping the secret inside the binary is acceptable. **Committing it to the public GitHub repo is not.** The policy says "You must never commit client credentials into publicly available code repositories" [16].
  - Anyone can copy a client ID out of a distributed app and use it. That would count against Commander's project quotas and could harm its verification standing (inferred from per-project quotas [24][26] and the policy that Google may suspend apps that let users break the rules [8]).

## 5. Change detection without a server

### Gmail

- **Sync model:** do one full sync with `messages.list` and batched `messages.get`, store the newest `historyId`, then call `history.list` with `startHistoryId`. That returns messages added or deleted and labels added or removed [18].
  - History "typically" lasts "at least one week and often longer", but "might be significantly shorter". If the history ID is too old the API returns 404, and the client must do a full sync again [18].
  - Since only one machine syncs and it can be off for days, Commander will sometimes hit this.
- **Push (`users.watch`):**
  - Notifications go to a Cloud Pub/Sub topic in the developer's project, with publish rights granted to `gmail-api-push@system.gserviceaccount.com`.
  - Each notification carries only the email address and a new `historyId`.
  - The watch must be renewed at least every 7 days (Google recommends daily).
  - The limit is one event per second per user, and notifications "might be delayed or dropped" [19].
  - Google says outright: "For notifications to user-owned devices (for example, installed apps, mobile devices, or browsers), the poll-based Synchronize clients with Gmail guide is still the recommended approach" [19].
  - A desktop app could in principle pull from a Pub/Sub subscription. But pulling requires `pubsub.subscriptions.consume` IAM permission on a subscription in Commander's Cloud project [20], so every copy of the app would need Google Cloud credentials for that project. That is not workable without a server. It only works if each User runs their own project. Pub/Sub's first 10 GiB per month is free [21].
- **IMAP IDLE** gives near-real-time updates without a server, but only with the restricted `mail.google.com` scope and with the costs described in section 7.
- **Recommendation:** poll `history.list` adaptively, for example every 15–60 s while Commander is in use and less often when idle. Each poll costs 2 units [24].

### Calendar

- **Sync model:** list events once and store `nextSyncToken`, then call `events.list?syncToken=...`. The results always include deleted events. If the server responds 410, wipe local data and sync fully again. Only a restricted set of query parameters may be combined with a sync token [22].
- **Push (`events.watch`):** the `address` "must use HTTPS", and notifications are sent only if "there's a valid SSL certificate installed". Self-signed certificates are invalid. Channels expire and "there's no automatic way to renew" them [23]. **A local app cannot receive these** without a public endpoint or tunnel, which would be a server under another name.
- Google's quota guide calls polling every calendar an "anti-pattern" that "will very quickly use up all your quota" [26]. Without a server it is still the only option. Keep it efficient: use sync tokens, poll only selected calendars, add random jitter of ±25% (Google's advice), and speed up polling while the Calendar Section is open [26].

## 6. Quotas and rate limits

### What changed in 2026

On **2026-05-01** Google introduced a "standardized tiering model" for Workspace APIs, starting with Gmail, Calendar and Drive [27][28]:

- Projects created on or after that date get the new quotas. Projects that used the API between November 2025 and April 2026 keep their old quotas for at least 60 days.
- "Later in 2026, following 90 days of notice", quota increases will require billing, and "API usage over standard daily thresholds will generate charges" [27].
- Prices have not been published.
- Timing check: the "at least 60 days" protection for older projects has run since 2026-06-30, so it can now end at any time. And if charges are to start "later in 2026" with 90 days' notice, notice would have to go out by about 2026-10-02. Neither the quota pages nor the tools-safety page (last updated 2026-09-03) show such a notice; it may come by email to project owners instead.

### Gmail API (projects created from 2026-05-01) [24]

| Limit | Value |
|---|---|
| Per minute per project | 1,200,000 units |
| Per minute per user per project | **6,000 units** (archived June 2025 page: 15,000 [25]) |
| Daily billing threshold per project | 80,000,000 units ("can't request an increase") |
| `history.list` | 2 |
| `messages.list` / `messages.modify` | 5 / 5 |
| `messages.get` / `messages.attachments.get` | **20** / 20 (`messages.get` was 5 [25]) |
| `threads.get` / `threads.modify` | 40 / 10 |
| `messages.batchModify` (up to 1,000 IDs [51]) | 50 |
| `messages.send` / `drafts.send` | 100 / 100 |
| `watch` | 100 |

Other limits:

- A batch request may hold at most 100 calls, and Google recommends no more than 50 [29].
- The Gmail API allows 500 recipients per message [24].
- Sending limits: consumer Gmail allows about 500 emails per day [30]. Workspace allows 2,000 per day per user (500 for trial accounts) [31].

### Calendar API (projects created from 2026-05-01) [26]

| Limit | Value |
|---|---|
| Per minute per project | 10,000 requests |
| Per minute per user per project | 600 requests |
| Daily billing threshold per project | 1,000,000 requests |

CalDAV shares the same quotas [39].

### Worked numbers for 3–4 Accounts per User

These are illustrative calculations from the figures above, not Google numbers. Per-user limits apply to each Account separately, because each Account is a separate Google user. Project-wide limits are shared by every User of Commander's OAuth client.

- **Gmail first sync:** 6,000 ÷ 20 gives at most about **300 `messages.get` per minute per Account**, or about 18,000 messages per hour. This is a ceiling. One open-source client reported in September 2026 that Gmail in practice throttles at 2–4 `messages.get` per second per user, below what the old published quota allowed **(secondary)** [68]. Under the 2025 limits it was 3,000 per minute [25]. A 50,000-message mailbox needs at least about 2.8 hours. Initial download has to be gradual (newest messages first, then backfill).
- **Gmail steady state, per Account per day**, assuming polling every 30 s, 300 new messages, 100 label changes and 10 sends:
  - 5,760 units for polling
  - 6,000 units for fetching new messages
  - 500 units for label changes
  - 1,000 units for sends

  That totals about 13k units per Account, or about 53k per User with 4 Accounts. The 80M daily threshold therefore covers about **1,500 active Users**. A new User's initial sync of 4 × 10,000 messages costs about 800k units, so **100 new Users on one day would use the whole 80M on their own.**
- **Calendar polling (4 Accounts × 3 calendars = 12 calendars per User):**
  - Polling every minute is 17,280 requests per day per User, so the 1M daily threshold covers about **57 Users**. The 10,000-per-minute project cap covers about 833.
  - Polling every 5 minutes is 3,456 per day, which covers about **289 Users**.
  - **Calendar is the binding constraint for a shared project.** The per-user limit (600 per minute) is never the problem.
- **For the author and testers, none of these limits matter.** They start to matter for paid distribution through one shared project.

## 7. IMAP/SMTP (XOAUTH2) and app passwords

### What IMAP keeps

Gmail's IMAP extensions (`X-GM-EXT-1`) provide [34]:

- `X-GM-LABELS` to read and write labels. Labels also appear as folders.
- `X-GM-THRID`, the same thread ID the Gmail API uses.
- `X-GM-MSGID`, a message ID that is stable across folders.
- `X-GM-RAW`, the full Gmail search syntax.
- Special-Use folder attributes (`\All`, `\Important`, and so on).

**Labels, threading and search are therefore not lost.**

### What IMAP costs

- **Verification:** the scope is still the restricted `https://mail.google.com/`. "To be approved, your app must show full utilization", and IMAP apps that don't need permanent delete "will need to migrate to the Gmail API" [6][33]. Using SMTP only to send violates the minimum-scope rule; the app should use `gmail.send` instead [6].
- **Sessions:** IMAP sessions authenticated with OAuth last "approximately the validity period of the access token used (usually 1 hour)", after which Gmail disconnects [32]. IDLE watches only one folder per connection.
- **Limits:** Gmail can be added "to up to 15 email clients at a time per account" [36], which in practice limits simultaneous IMAP connections, shared with any other mail apps the User runs. Workspace accounts are limited to 2,500 MB/day of IMAP downloads and 500 MB/day of uploads [35].
- **Resync:** Gmail's IMAP server advertises CONDSTORE but not QRESYNC, so a reconnecting client can fetch flag changes since a known mod-sequence but has to find expunged messages by comparing UID lists **(secondary: Thunderbird developer, Mozilla bug 1747311, about 2022)** [69]. Google's own IMAP pages do not list either extension [32][34].
- **Model mismatch:** labels-as-folders means the same message appears in several folders. Per-label "Show in IMAP" settings and "Folder Size Limits" can hide messages. Google says the admin-only `gmail.imap_admin` scope ignores these settings, which implies normal IMAP respects them [33].
- **No Calendar:** IMAP does not cover Calendar, so OAuth and a Google Cloud project are needed anyway.

### App passwords

- They are "a 16-digit passcode", only "with accounts that have 2-Step Verification turned on" [37].
- They are unavailable when 2-Step Verification uses only security keys, on some "work, school, or other organization" accounts, and with Advanced Protection [37].
- Google says they "aren't recommended and are unnecessary in most cases", and revokes them when the account password changes [37].
- Since 2025-03-14, normal passwords no longer work for IMAP, SMTP, POP or CalDAV. App passwords are the only remaining exception [38].
- IMAP is always on for personal Gmail accounts since January 2025 [36].
- App passwords **do not work for Calendar**. Google's CalDAV server returns 401 for Basic authentication and accepts only OAuth [39].
- The only Calendar option without OAuth is the read-only "Secret address in iCal format". Users copy it by hand, and organization admins can disable it [40].

### Verdict on the IMAP path

- **IMAP with OAuth** gains no verification advantage over the Gmail API. It adds connection management and loses `historyId`-style change tracking. It is only worth it if Commander wants one IMAP code path for Gmail and other providers.
- **App passwords** are a no-Google-Cloud fallback for testers' mail only. They are not a dependable basis for paying Users.

### Workspace MCP servers

Google's Workspace MCP servers are not a way around any of this. They are hosted by Google, use the same restricted Gmail scopes, and are still in developer preview: the Calendar MCP server since 2026-04-22, and a gradual rollout of the Workspace MCP server from 2026-05-01 [28][57][58].

## Implications for the decisions

### Cross-cutting: how Commander gets Google access

1. **v1 (author and testers):**
   - One Commander Cloud project with a Desktop OAuth client, user type External, published **In production, unverified**. This avoids the 7-day token expiry of Testing [12][14].
   - Scopes: `gmail.modify` plus `calendar.events` and `calendar.calendarlist.readonly`, or simply `calendar`.
   - Testers click through the unverified-app warning. The project can never have more than 100 users in total [6][12].
   - Keep the client ID and secret out of the repo [16].
2. **Paying Users** need one of these:
   - **(a)** Full restricted-scope verification plus annual CASA. This needs a domain, homepage, privacy policy and demo video, takes about 6 weeks or more, and costs a lab fee every year [5][6][9][62]. Plan for CASA even though Commander has no server [9][60][61][63].
   - **(b)** Bring-your-own Google Cloud project for each User. There is no verification, no CASA and no shared quotas, but setup is heavy (create a project, enable the APIs, configure consent, create a Desktop client, publish it). A guided setup wizard could reduce that.
   - **(c)** Ship Calendar first. Calendar scopes are not restricted, so they need only about 10 business days of sensitive-scope verification [2][4][6]. Gmail would stay on (b) until CASA is done.

   These options can be combined.
3. **Hybrid cloud AI is a policy decision, not only a technical one.** Sending Gmail content to a cloud model is a Limited Use "transfer" that needs the User's consent. It plausibly triggers CASA. The provider must not train on or store the data [5][6][8]. The on-device default fits Google's "personalized model" definition [6].

### #15 Email client: what's in v1

- **Unified vs per-Account inboxes:** both are feasible. Each Account has its own token and its own per-user quota [24]. Expect some Workspace Accounts to be blocked by their admins [41][42], so the UI needs a "this Account can't be connected" state.
- **Compose, reply, attachments, signatures, drafts:**
  - All are covered by `gmail.modify` [46][1].
  - Replies stay in the thread only if the `Subject` matches and `References` and `In-Reply-To` are set [52].
  - An attachment fetch costs 20 units [24].
  - Reading send-as aliases and their Gmail signatures (`sendAs.list`) works with `gmail.modify` [64].
  - Editing a signature stored in Gmail (`sendAs.update`) needs the restricted `gmail.settings.basic` [65]. Signatures kept only in Commander need no extra scope.
  - Creating aliases is available only to service accounts with domain-wide delegation [66].
- **Search:**
  - Server-side Gmail syntax through `q` is available [47].
  - Searching a local cache would work offline but covers only what has been downloaded. With the new limit of about 300 messages per minute per Account, a full local mirror of a large mailbox takes hours [24].
- **Snooze, send-later, undo-send:**
  - The Gmail API reference for `messages.send`, `drafts.send` and labels has **no scheduling parameter and no snooze label** [44][46]. This is an absence finding from the reference pages.
  - Commander would have to build all three itself.
  - With no server, **send-later and snooze-return only fire while the User's machine and Commander are running.**
  - Undo-send is just a local delay before calling `messages.send`.
  - Snooze could be shown in Gmail itself using a Commander label plus removing `INBOX`.
- **Offline use:**
  - A local cache fits Google's sync model [18].
  - Offline actions must be queued and replayed against `history.list`.
  - The app must be able to detect a history ID that has expired (404) and resync [18].
  - Tokens and the mail store must be encrypted at rest to meet restricted-scope rules [7].
- **Permanent delete ("delete forever"):** the only feature that needs `mail.google.com` [48]. Leave it out of v1 so the scope request stays at `gmail.modify`.

### #16 Email Buckets

- **Writing Buckets back as Gmail labels works.**
  - Creating labels needs only the non-sensitive `gmail.labels` scope, or `gmail.modify` [50].
  - Applying them uses `messages.modify` (5 units), `threads.modify` (10 units), or `batchModify` (50 units for up to 1,000 messages), all under `gmail.modify` [24][45][51].
  - The labels show up in Gmail on the web and on phones.
- **Corrections come back for free.** If the User moves a message between Bucket labels in Gmail, it appears in `history.list` as `labelAdded`/`labelRemoved` [18]. The Agent can use that as a learning signal.
- **Gmail's own categories are available.** `CATEGORY_PERSONAL`, `SOCIAL`, `PROMOTIONS`, `UPDATES` and `FORUMS` are system labels that can be read and applied [44]. They could seed a newsletters or FYI Bucket.
- **Sorting is delayed when the machine is off**, because the Agent runs only while Commander runs. Gmail's server-side filters run all the time but only on fixed criteria, need the restricted `gmail.settings.basic`, and are capped at 1,000 per account [49]. One option is to let Buckets with simple rules become Gmail filters and leave model-based Buckets to the Agent.
- **AI constraints:**
  - Bucket models must stay "personalized" and must not pool data across Users [6].
  - Prompt-injection protection is a required security measure for apps with restricted scopes [7].
  - Both matter for the Autonomy setting: an Agent that reads untrusted email and then acts needs those protections.

### #17 Calendar Section and AI event scheduler

- **Calendar is the lighter half.** Its scopes are not restricted, so it needs sensitive-scope verification and no CASA [2][4][6]. It could ship to paying Users before Gmail.
- **Calendars from several Accounts overlaid:** one token per Account. List each Account's calendars with `calendarList` (`calendar.calendarlist.readonly`) [3].
- **Invites and RSVPs:**
  - Create events with `events.insert` and `sendUpdates=all|externalOnly|none`. Google warns that `none` can cause events to be lost [53].
  - RSVP by setting the attendee's `responseStatus` [55].
  - Create a new Meet link per event with `conferenceData.createRequest`. Since February 2026 Google warns against reusing Meet codes [53][57].
  - Events that Gmail created (`fromGmail`) allow only limited edits [57].
- **Finding free time:** `freebusy.query` works with `calendar.freebusy`, `calendar.events.freebusy` or the read scopes. It can query all of the User's Accounts and any other calendars they can see [54].
- **Blocking time for Todos:** to stay out of the User's real calendars, create events on an app-owned secondary calendar using the narrow `calendar.app.created` scope. Otherwise use `calendar.events` on the primary calendar [3][53].
- **Sharing availability with other people:** the Calendar API v3 has only the Acl, CalendarList, Calendars, Channels, Colors, Events, Freebusy and Settings resources. **There is no API for appointment schedules or booking pages** [56]. Options:
  - Send proposed times by email.
  - Let the User set up a Google booking page by hand.
  - Build a hosted booking page, which needs a server and so falls outside v1.
- **Freshness vs quota:** with no push, changes made elsewhere appear only at the next poll. Shared-project quotas cap how often Commander can poll as the number of Users grows (about 57 Users at 1-minute polling, about 289 at 5-minute polling under the 1M/day threshold). Poll faster while the Calendar Section is open and slower in the background [26].

## Could not answer / open items

- **Whether Google would waive CASA for Commander's on-device design today.** One official page ties CASA to servers [5]; two others require it for all restricted scopes [9][63]. Two 2026 reports say on-device apps were required to do it anyway [60][61]. Only a real verification submission settles this.
- **The exact classification of each Calendar scope.** It appears only in the Cloud Console's Data Access page [5]. The public docs establish only that no Calendar scope is restricted [2] and that reading events is sensitive [4].
- **How much use above the daily thresholds will cost.** Google says only "later in 2026", with 90 days' notice [27].
- **An official CASA price.** Google publishes none [6]. The figures here come from a lab and a blog **(secondary)** [61][62].
- **Gmail's current IMAP CAPABILITY list.** Secondary sources say CONDSTORE yes, QRESYNC no [69]. Google does not document it; confirm with a live `CAPABILITY` command if the IMAP path is ever pursued.
- **The date the prompt-injection requirement [7] and DPoP support [15] were added.** Neither page dates them.

## Sources

Primary sources unless marked **(secondary)**.

1. Google, "Choose Gmail API scopes" (last updated 2026-09-10). https://developers.google.com/workspace/gmail/api/auth/scopes
2. Google Cloud Help, "Restricted scopes" list. https://support.google.com/cloud/answer/13464325
3. Google, "Choose Google Calendar API scopes" (last updated 2026-09-03). https://developers.google.com/workspace/calendar/api/auth
4. Google, "Sensitive scope verification". https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
5. Google, "Restricted scope verification" (last updated 2026-08-19). https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
6. Google Cloud Help, OAuth verification "Frequently Asked Questions". https://support.google.com/cloud/answer/13463817
7. Google, "Google Workspace user data and developer policy" (last updated 2026-09-03). https://developers.google.com/workspace/workspace-api-user-data-developer-policy
8. Google, "Google API Services User Data Policy" (last updated 2024-02-15). https://developers.google.com/terms/api-services-user-data-policy
9. Google Cloud Help, "Security Assessment". https://support.google.com/cloud/answer/13465431
10. App Defense Alliance, "CASA Assurance Levels" (overview page last updated 2026-06-27). https://appdefensealliance.dev/casa/casa-tiering (overview: https://appdefensealliance.dev/casa)
11. Google Cloud Help, "When is verification not needed". https://support.google.com/cloud/answer/13464323
12. Google Cloud Help, "Manage App Audience". https://support.google.com/cloud/answer/15549945
13. Google Cloud Help, "Unverified apps". https://support.google.com/cloud/answer/7454865
14. Google, "Using OAuth 2.0 to Access Google APIs" (refresh token expiration; last updated 2026-05-26). https://developers.google.com/identity/protocols/oauth2
15. Google, "OAuth 2.0 for iOS & Desktop Apps" (last updated 2026-09-14). https://developers.google.com/identity/protocols/oauth2/native-app
16. Google, "OAuth 2.0 Policies" (changelog: 2025-10-27, 2025-12-15, 2026-08-05). https://developers.google.com/identity/protocols/oauth2/policies
17. Google Cloud Help, "Manage OAuth Clients". https://support.google.com/cloud/answer/15549257
18. Google, "Synchronize clients with Gmail". https://developers.google.com/workspace/gmail/api/guides/sync
19. Google, "Configure push notifications with the Gmail API". https://developers.google.com/workspace/gmail/api/guides/push
20. Google Cloud, "Pub/Sub access control". https://cloud.google.com/pubsub/docs/access-control
21. Google Cloud, "Pub/Sub pricing". https://cloud.google.com/pubsub/pricing
22. Google, "Calendar: Synchronize resources efficiently". https://developers.google.com/workspace/calendar/api/guides/sync
23. Google, "Calendar: Push notifications". https://developers.google.com/workspace/calendar/api/guides/push
24. Google, "Gmail API usage limits" (last updated 2026-09-10). https://developers.google.com/workspace/gmail/api/reference/quota
25. Google, "Gmail API usage limits", Internet Archive snapshot of 2025-06-14 (pre-change values). https://web.archive.org/web/20250614024422/https://developers.google.com/workspace/gmail/api/reference/quota
26. Google, "Calendar API usage limits" (last updated 2026-09-11). https://developers.google.com/workspace/calendar/api/guides/quota
27. Google, "Google Workspace standardized model for agent tools and APIs" (last updated 2026-09-03). https://developers.google.com/workspace/tools-safety
28. Google Workspace Updates blog, "New: Agent tools and security updates for Google Workspace developers" (2026-05-01). https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html
29. Google, "Gmail API: Batching requests". https://developers.google.com/workspace/gmail/api/guides/batch
30. Gmail Help, "Limits for sending & getting mail". https://support.google.com/mail/answer/22839
31. Google Workspace Admin Help, "Gmail sending limits in Google Workspace". https://support.google.com/a/answer/166852
32. Google, "IMAP, POP, and SMTP". https://developers.google.com/workspace/gmail/imap/imap-smtp
33. Google, "OAuth 2.0 Mechanism (SASL XOAUTH2)". https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
34. Google, "Gmail IMAP Extensions". https://developers.google.com/workspace/gmail/imap/imap-extensions
35. Google Workspace Admin Help, "Gmail bandwidth limits". https://support.google.com/a/answer/1071518
36. Gmail Help, "Fix IMAP / email client problems" (15 connections; IMAP always on from Jan 2025). https://support.google.com/mail/answer/7126229
37. Google Account Help, "Sign in with app passwords". https://support.google.com/accounts/answer/185833
38. Google Workspace Admin Help, "Transition from less secure apps to OAuth" (cut-off 2025-03-14). https://support.google.com/a/answer/14114704
39. Google, "CalDAV API Developer's Guide" (last updated 2026-09-03). https://developers.google.com/workspace/calendar/caldav/v2/guide
40. Google Calendar Help, "Sync Google Calendar with other calendar apps" (Secret address in iCal format). https://support.google.com/calendar/answer/37648
41. Google Workspace Admin Help, "Control which apps access Google Workspace data". https://support.google.com/a/answer/7281227
42. Google Workspace Admin Help, "Authorize unverified third-party apps". https://support.google.com/a/answer/9352843
43. Google, "Google APIs Terms of Service" (last modified 2021-11-09). https://developers.google.com/terms
44. Google, "Gmail API: Manage labels". https://developers.google.com/workspace/gmail/api/guides/labels
45. Google, Gmail API `users.messages.modify`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify
46. Google, Gmail API `users.messages.send`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
47. Google, Gmail API `users.messages.list`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
48. Google, Gmail API `users.messages.delete`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/delete
49. Google, Gmail API `users.settings.filters.create`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/create
50. Google, Gmail API `users.labels.create`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/create
51. Google, Gmail API `users.messages.batchModify`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify
52. Google, "Gmail API: Create and send email messages". https://developers.google.com/workspace/gmail/api/guides/sending
53. Google, Calendar API `events.insert`. https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
54. Google, Calendar API `freebusy.query`. https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
55. Google, Calendar API Events resource. https://developers.google.com/workspace/calendar/api/v3/reference/events
56. Google, Calendar API v3 reference index (resource types). https://developers.google.com/workspace/calendar/api/v3/reference
57. Google, "Google Calendar API release notes". https://developers.google.com/workspace/calendar/release-notes
58. Google, "Configure the Google Workspace MCP servers" (Developer Preview). https://developers.google.com/workspace/guides/configure-mcp-servers
59. Google Developers Blog, "Get smart about preparing your app for OAuth verification" (2019-09-18). https://developers.googleblog.com/en/get-smart-about-preparing-your-app-for-oauth-verification/
60. **(secondary)** Google Cloud Community, "What happened to Local App Gmail API access?" (2026-03-24/25; the moderator's answer says it was generated with Gemini). https://security.googlecloudcommunity.com/google-security-operations-2/what-happened-to-local-app-gmail-api-access-7138
61. **(secondary)** yurudeep, "What I wish I'd known before touching an OAuth restricted scope — shelving a personal app over CASA's $540/year" (2026-07-17). https://yurudeep.com/posts/aicoding/2026/20260717/en/
62. **(secondary)** TAC Security, "Google CASA" pricing page (no date shown). https://tacsecurity.com/google-casa-cloud-application-security-assessment/
63. Google, "Configure the OAuth consent screen and choose scopes" (scope categories table). https://developers.google.com/workspace/guides/configure-oauth-consent
64. Google, Gmail API `users.settings.sendAs.list`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list
65. Google, Gmail API `users.settings.sendAs.update`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/update
66. Google, Gmail API `users.settings.sendAs.create`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/create
67. Google, Gmail API `users.settings.updateVacation`. https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings/updateVacation
68. **(secondary)** muitneliss/undercroft PR #85, "fix(google): pace Gmail at the rate it enforces" (merged 2026-09-21). https://github.com/muitneliss/undercroft/pull/85
69. **(secondary)** Mozilla Bugzilla, bug 1747311 "Add support for imap extension QRESYNC and improvements for CONDSTORE", comment 3. https://bugzilla.mozilla.org/show_bug.cgi?id=1747311

## Verification

Adversarial fact-check on 2026-10-01. Each load-bearing claim was re-read against the cited page as it stands today.

**Confirmed against primary sources:**

- Gmail quotas for projects created from 2026-05-01: 1,200,000 units/min per project, 6,000 per user, 80M/day threshold, and every per-method cost in the table (`messages.get` 20, `history.list` 2, `threads.get` 40, `messages.send` 100, and so on); 500 recipients; page updated 2026-09-10 [24]. The pre-change 15,000 units/min and 5-unit `messages.get` could not be re-fetched from the Internet Archive (blocked), but several 2026 secondary write-ups give the same old figures.
- Calendar quotas: 10,000/min per project, 600/min per user, 1M/day; "anti-pattern" polling quote; ±25% jitter; updated 2026-09-11 [26].
- The tools-safety page: 2026-05-01 change, "at least 60 days" for existing projects, billing "later in 2026" after 90 days' notice, no prices; updated 2026-09-03 [27]. The 2026-05-01 blog post confirms quotas for new projects only and the Workspace MCP public developer preview [28].
- Restricted list: seven Gmail scopes plus `mail.google.com` ("includes any usage of IMAP, SMTP, and POP3"); no Calendar scope [2]. Gmail scope classifications [1].
- Testing: 100 test users; authorizations and refresh tokens expire seven days after consent. Unverified production: 100 new users over the project's lifetime, "cannot be reset or changed" [12]. Refresh-token rules, including 100 tokens per account per client [14].
- Personal use "(fewer than 100 users)", with the unverified screen and the 100-user cap still applying [11].
- Verification durations (2–3 business days, 10 business days, 6 weeks plus assessment), "personalized models include any models run exclusively on-device", the IMAP and SMTP migration rules, and the "Tier 2" wording [6].
- AL1 and AL2 are both lab-tested, Google picks the level, and apps are revalidated yearly; ADA page updated 2026-06-27 [10].
- Native-app page (updated 2026-09-14): loopback recommended, OOB unsupported, PKCE 43–128 characters, `client_secret` Optional, DPoP optional with hardware-backed keys, no incremental authorization, and refresh tokens always returned [15]. Policies: never commit client credentials to public repositories, no embedded user-agents, separate projects per tier, 6-month inactive-client deletion, and a changelog with entries dated 2025-10-27, 2025-12-15 and 2026-08-05 [16].
- Gmail push and sync quotes [18][19]. Calendar push requires HTTPS with a valid certificate, and channels don't auto-renew [23]. Calendar sync returns 410, always includes deleted entries, and restricts query parameters [22].
- IMAP OAuth sessions last about 1 hour [32]; CalDAV accepts OAuth only, Basic gets a 401, and it shares the Calendar quota (updated 2026-09-03) [39]; the app-password facts [37]; less secure apps were turned off on 2025-03-14 with an app-password exception [38]; IMAP has been always on since January 2025 [36].
- The Workspace user-data policy: the restricted Gmail definition, approved uses including email clients and "generative AI summaries", and the security measures including the Model Armor / prompt-injection item (updated 2026-09-03, no changelog) [7]. "Reading events stored in Google Calendar" is given as a sensitive example [4].
- Calendar release notes: MCP developer preview on 2026-04-22 and the Meet-code reuse warning on 2026-02-17 [57]. The Workspace admin text on unverified Gmail apps with more than 100 users [42].
- Secondary sources: TAC Security lists AL1 at $675 (Basic) and $855 (Premium), and AL2 at $5,400 [62]. The yurudeep post (2026-07-17) is about a serverless Drive app, quotes "~$540/year" at TAC, and says the free self-scan is gone [61]. The community thread (2026-03-24/25) has a Gemini-sourced moderator reply [60]. The 2019 blog quote on client-side storage [59].
- Worked numbers recomputed: Gmail steady state about 13.3k units per Account per day, about 1,500 Users per 80M; Calendar 17,280 requests per User per day at 1-minute polling, giving about 57 Users, and 3,456 at 5-minute polling, giving about 289.

**Corrected in place:**

- The claim that `gmail.labels` and `gmail.send` are the only non-restricted Gmail scopes left out the `gmail.addons.*` scopes. Those are non-sensitive or sensitive but usable only inside Workspace Add-ons [1]. The conclusion is unchanged.
- **CASA on-device framing.** The file presented "Google's docs" as tying CASA to servers, with only secondary reports disagreeing. In fact two primary Google pages require an annual assessment for every restricted scope with no server condition: the Security Assessment help page [9] and the Workspace consent-screen guide [63]. The docs therefore contradict each other, and the "plan on CASA" recommendation now rests on primary sources too.
- The development and testing exemption is tied to "Testing" publishing status [5].
- The custom URI scheme wording now includes the broader "no longer supported due to the risk of app impersonation" sentence [15].
- The 15-connection IMAP limit is reworded to Google's actual phrasing, "15 email clients at a time per account" [36].
- Added a secondary report that Gmail's real throttle (2–4 `messages.get` per second per user) can sit below the published quota [68].
- Filled the CONDSTORE/QRESYNC gap: CONDSTORE is supported and QRESYNC is not (secondary) [69].
- Added a timing note on the 60-day grandfathering and 90-day billing notice.

**Could not confirm:**

- The 2025 Gmail quota values from the cited Internet Archive snapshot: the fetch was blocked, and only secondary agreement was found.
- When the prompt-injection requirement and DPoP were added: neither page dates them.
- The per-scope Calendar classifications: these are shown only in the Console.
- Whether Google has sent billing notice to project owners by email.
- Gmail's live IMAP CAPABILITY list: there is no Google documentation.
