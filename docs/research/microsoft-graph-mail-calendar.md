# Outlook mail and calendar through Microsoft Graph

Research for ticket #3. Feeds #15 (Email client: what's in v1), #16 (Email Buckets) and #17 (Calendar Section and AI event scheduler).

Researched 2026-10-01. Every claim links to its source in [Sources](#sources). Where a source is secondary (community Q&A, a Message Center mirror, a blog, a community sample), the text says so. "Not found" means I looked in Microsoft's docs and found nothing; it does not prove the thing doesn't exist.

## Question

What does Microsoft require for a desktop app that runs entirely on the User's machine to be a full mail and calendar client for both personal (outlook.com) and work or school Microsoft accounts?

Sub-questions from the ticket:

1. App registration for personal and multi-tenant accounts, publisher verification, and admin consent inside work tenants.
2. Microsoft Graph scopes for a full mail and calendar client.
3. The desktop auth flow (MSAL public client, loopback or broker) and token lifetimes.
4. Change detection without a server: delta queries vs change notifications (which need a public endpoint).
5. How Gmail-style labels map onto Outlook folders and categories, for Buckets.
6. Throttling limits.
7. IMAP/SMTP with OAuth as an alternative path.

## Short answer

- **Graph is the only full path.** It covers mail and calendar for both personal and work Accounts. IMAP/POP have no calendar ([S64]). Exchange Online starts switching EWS off for tenants in October 2026, so from today EWS is not an option ([S69]).
- **Registration is easy.** Commander needs one app registration: a public client (no secret), with the audience "Any Entra ID tenant + Personal Microsoft accounts" and a `http://localhost` loopback redirect ([S2], [S16], [S17]). It must live in an Entra tenant, because registering with only a personal account was stopped in June 2024 ([S4]). The client ID is not a secret, so it can sit in the public repo.
- **Personal (outlook.com) Accounts work out of the box.** The User consents to their own mailbox and calendar. Every scope Commander needs is marked "available for consent in personal Microsoft accounts" ([S1]).
- **Work/school Accounts are the hard constraint.** Since October–November 2025, Microsoft's managed default consent policy stops users from consenting to third-party apps that ask for `Mail.ReadWrite`, `Calendars.ReadWrite`, `MailboxSettings.ReadWrite` or `IMAP.AccessAsUser.All` ([S7], [S11]).
  - That policy is the default for new tenants ([S7]). In July–August 2025 it was switched on in all tenants that hadn't already chosen a stricter or custom consent setting ([S10]).
  - Only a short Microsoft-curated list of mail apps is exempt: Apple Mail, Spark, eM Client, Thunderbird and two Android mail apps ([S7]).
  - Publisher verification does not lift this. It also needs a verified Microsoft AI Cloud Partner Program business account and a custom domain ([S5]).
  - **Plan on a tenant admin granting consent once per work tenant.** Tenants whose admin won't grant it are out of reach.
- **Auth uses the system browser.** MSAL Node `acquireTokenInteractive` opens the browser and catches the reply on a loopback redirect, using auth code + PKCE ([S18]). On the author's Arch machine there is no usable broker: MSAL Node's broker is Windows-only, and Microsoft's Linux broker supports only Ubuntu/RHEL with MSAL .NET/Python ([S21], [S23]).
  - Access tokens last 60–90 minutes, or up to 28 hours with CAE ([S24], [S26]).
  - Refresh tokens last 90 days and are replaced with a fresh one on every use ([S25]).
  - The cache can be stored encrypted through libsecret ([S22]).
- **Change detection: poll delta queries.** Delta works per mail folder and per calendar view ([S30], [S31]).
  - Push (change notifications) needs one of three things: a public HTTPS webhook, Azure Event Hubs, or Azure Event Grid ([S35], [S36], [S37]). The last two need an Azure subscription. Any of them amounts to running a server.
  - A brand-new Web Push delivery channel (August 2026) might allow push without a server, but it is unproven for a desktop app ([S38], [S41]).
  - IMAP IDLE gives near-real-time Inbox signals ([S64]), but it needs separate consent and on outlook.com the User has to turn IMAP on ([S68]).
- **Labels become categories (or folders).** An Outlook message sits in exactly one folder but can carry many categories ([S44], [S45]). Categories are the closest match to Gmail labels and to Buckets: many per message, colored, and they don't move mail. Folders suit "file it away". Use immutable IDs so moves don't change message IDs ([S42]).
- **Throttling is generous for one User.** Limits are 10,000 requests per 10 minutes, 4 concurrent requests, and 150 MB of uploads per 5 minutes, all per app per mailbox ([S51]). A batch holds at most 20 requests ([S53]). On 429, honor `Retry-After` ([S52]).
- **IMAP/SMTP with OAuth works for both Account types, but it is not a real alternative.** It has no calendar and no categories (secondary sources: [S74]), and no CONDSTORE/QRESYNC (observed, see below). IMAP is off by default on outlook.com ([S68]), Microsoft recommends tenants turn SMTP AUTH off ([S65]), and the IMAP scope is gated behind admin consent just like Graph's ([S7]).

## 1. App registration, publisher verification, admin consent

### Registering the app

- **A tenant is required.** "Starting June 2024, all applications must be registered in a directory." A personal Microsoft account can no longer own an app registration outside a tenant. Existing ones keep working ([S4]).
  - An individual gets a tenant by signing up for Azure. The quickstart lists "An Azure account that has an active subscription" as a prerequisite and says you can use the Default Directory ([S2]).
  - The Microsoft 365 Developer Program sandbox is mostly closed to individuals. Eligibility is limited to Visual Studio Pro/Enterprise subscribers, certain partners, and Premier/Unified support customers ([S75]).
- **Audience.** Choose **"Any Entra ID Tenant + Personal Microsoft accounts"** (`signInAudience = AzureADandPersonalMicrosoftAccount`) ([S2], [S3]). Limits for this audience that matter here ([S3], [S17]):
  - At most 30 permissions per resource (for example, Microsoft Graph).
  - No query strings in redirect URIs.
  - No wildcard redirect URIs.
- **Platform and redirect.** Add the "Mobile and desktop applications" platform with redirect `http://localhost` (system-browser apps) ([S16]).
  - Entra ignores the port when matching localhost redirects, so the app can listen on any ephemeral port ([S17]).
  - Microsoft prefers `127.0.0.1` over `localhost`, but an `http://127.0.0.1` redirect can only be added by editing the manifest (`replyUrlsWithType`), not in the portal ([S17]).
  - IPv6 loopback (`[::1]`) isn't supported ([S17]).
- **Public client.** A desktop app is a public client and has no secret ([S16]). The "Allow public client flows" switch is only needed for device code and similar no-redirect flows ([S16]).
- **Users can usually register apps.** By default every member of an Entra tenant can register applications, but admins can turn that off ([S14]). This matters only for the "each User brings their own registration" option below.

### Consent for personal (outlook.com) Accounts

- Each mail/calendar scope Commander needs is listed as "available for consent in personal Microsoft accounts" ([S1]). The exceptions are `Mail.ReadWrite.Shared` and `Mail.Send.Shared`, which are "only valid for work or school accounts" ([S1]).
- An unverified app shows "Unverified" instead of a publisher name on the consent prompt ([S15]).
- I found no Microsoft document saying personal-account consent is blocked for unverified apps. Tenant consent policies don't apply to personal accounts, since there is no tenant admin. **Still worth a quick prototype sign-in to confirm.**

### Consent for work/school Accounts (the hard constraint)

**On the defaults.** Every delegated mail/calendar scope Commander needs is marked `AdminConsentRequired: No` in the permissions reference ([S1]). But each tenant's consent policy decides whether a user may actually grant it, and the defaults changed in 2025–2026:

| Date | Change | Source |
|---|---|---|
| Nov 2020 (still in force) | Risk-based step-up consent. In tenants where user consent is enabled, users can't consent to most multi-tenant apps registered after 8 Nov 2020 that aren't publisher-verified and ask for more than basic sign-in. The request "steps up" to admin consent (`AADSTS90094`). On by default. | [S5], [S8] |
| Jul–Aug 2025 (MC1097272) | The Microsoft-managed policy ("Let Microsoft manage your consent settings") becomes the default. It applies to all tenants except those that had already blocked user consent, chosen the previously recommended settings, or set custom settings. At first it blocked only Files/Sites. | [S10] (Message Center mirror, secondary) |
| End Oct–Nov 2025 (MC1163922) | The managed policy also blocks user consent for Exchange and Teams content: Mail.Read/ReadWrite/ReadBasic (and their Shared forms), MailboxItem.Read, the Calendars.* scopes, Chat, OnlineMeetings, MailboxFolder.*, MailboxSettings.*. For the Exchange Online resource it blocks EAS/EWS/IMAP/POP `AccessAsUser.All`. | [S7], [S11], [S13] (Q&A, secondary) |
| Jun–Jul 2026 (MC1304287) | Eight more scopes are blocked: Contacts.ReadWrite, Contacts.Read.Shared, Contacts.ReadWrite.Shared, People.Read, and the Tasks.* scopes. | [S7], [S12] (Message Center mirror, secondary) |

- **What the managed policy says now:** "End users can consent for any user consentable delegated permissions EXCEPT" the list above. It is "also the default for a new tenant" ([S7]).
- **Not in the blocked list:** `Mail.Send`, `User.Read`, `offline_access`, `Contacts.Read`, `SMTP.Send` ([S7]).
- **Existing consents keep working.** The change only blocks new consents ([S11], [S12]).
- **Allowlisted mail apps.** A companion policy, `microsoft-user-default-allow-consent-apps`, is enabled by default. It lets users consent to the mail scopes for a fixed list of mail clients only ([S7]):
  - Apple Mail
  - Spark
  - eM Client
  - Android-Samsung
  - Android-Mail
  - Thunderbird

  I found no documented way to apply to join that list.
- **Publisher verification doesn't solve it.**
  - It requires a Microsoft AI Cloud Partner Program account that has passed Partner Center verification and is the "partner global account" for the developer's organization ([S5]).
  - The app must be registered with a work account, in a tenant tied to that partner account ([S5]).
  - The publisher domain must be DNS-verified and can't be `*.onmicrosoft.com` ([S5]).
  - Verification is free ([S5]).
  - What it buys:
    - It avoids the risk-based step-up.
    - It qualifies the app for the `microsoft-user-default-low` policy, but only for permissions the admin has classified as "low impact" ([S6]).
    - It does **not** exempt the app from the Microsoft-managed exclusions above ([S7]).
- **Admin consent is the realistic path.**
  - A tenant admin grants consent once for the whole tenant.
  - Or, if the tenant has turned on the admin consent workflow, the user files a request from the consent prompt and a designated reviewer approves it ([S9]).
  - "Applications that require users to be assigned to the application must have their permissions consented by an administrator" regardless of policy ([S6]).
- **Bring-your-own registration (open question).** Each User could register their own single-tenant app inside their work tenant, if "Users can register applications" is still on ([S14]).
  - `microsoft-user-default-low` explicitly allows apps "registered in your tenant" ([S6]).
  - The Microsoft-managed policy page and the Message Center notices talk about "third-party apps" ([S7], [S11]), but **I found no statement on whether a same-tenant (first-party) app is exempt** from the mail/calendar exclusions. This needs a test in a real tenant.
- **Other tenant controls that can block Commander regardless of consent:**
  - Conditional Access that requires a compliant or Entra-joined device. Microsoft's Linux device-compliance path runs through the Linux broker on Ubuntu/RHEL only ([S23]).
  - Sign-in frequency policies, which force periodic interactive sign-in ([S24]).

### Decision-relevant takeaway

| Account type | Who consents | Works for any User? |
|---|---|---|
| Personal (outlook.com, hotmail, live) | The User | Yes |
| Work/school, tenant on Microsoft-managed default (default since 2025) | Tenant admin (or admin consent workflow) | Only if the admin agrees |
| Work/school, tenant with legacy "allow user consent for apps" or custom policy | User, unless risk-based step-up triggers (unverified app → admin) | Mostly no, while Commander is unverified ([S8]) |
| Work/school, user consent disabled | Tenant admin | Only if the admin agrees |

## 2. Graph scopes for a full mail and calendar client

All delegated. "AdminConsentRequired" is the Graph default ([S1]); the last column shows whether the Microsoft-managed tenant policy still blocks user consent ([S7]).

| Scope | What it buys | Personal accounts ([S1]) | Blocked by managed policy ([S7]) |
|---|---|---|---|
| `openid`, `profile`, `offline_access` | Sign-in; `offline_access` gives refresh tokens | Yes | No |
| `User.Read` | Signed-in user's profile | Yes | No |
| `Mail.ReadWrite` | Read, create, update, delete, move messages and folders. **Does not include sending.** | Yes | **Yes** |
| `Mail.Send` | Send mail; a copy goes to Sent Items even without `Mail.ReadWrite` | Yes | No |
| `MailboxSettings.ReadWrite` | Category master list, inbox rules, mailbox settings ([S46], [S78]) | Yes | **Yes** |
| `Calendars.ReadWrite` | Full calendar create/read/update/delete, RSVP | Yes | **Yes** |
| `Contacts.Read` / `People.Read` | Recipient autocomplete | Yes | `Contacts.Read`: no; `People.Read`: **yes** (since Jun–Jul 2026) |
| `Mail.ReadWrite.Shared`, `Mail.Send.Shared`, `Calendars.ReadWrite.Shared` | Shared and delegated mailboxes/calendars | `Mail.*.Shared`: "only valid for work or school accounts" | **Yes** |
| `https://outlook.office.com/IMAP.AccessAsUser.All`, `.../SMTP.Send` | IMAP/SMTP path only ([S63]) | Yes | IMAP: **yes**; SMTP: no |

**Minimum for a full client:** `offline_access User.Read Mail.ReadWrite Mail.Send MailboxSettings.ReadWrite Calendars.ReadWrite`. Add `Contacts.Read` or `People.Read` for autocomplete.

**Request the `Mail.*.Shared` scopes only for work Accounts.** It is undocumented what happens when a scope that is invalid for personal accounts is requested during a personal sign-in, so it should be tested.

Graph mail only reaches cloud (Exchange Online) mailboxes. It cannot reach in-place archive mailboxes ([S43]).

## 3. Desktop auth flow and token lifetimes

### Flow

- **MSAL Node** (`@azure/msal-node`) `PublicClientApplication.acquireTokenInteractive()` "handles both legs of the authorization code flow". You supply an `openBrowser(url)` callback, and the library runs the loopback listener and PKCE ([S18]).
  - Current version: 7.0.0, published 2026-09-23, requiring Node >= 20 ([S20]). Node 24 is fine.
  - The README's version table only goes up to 4.x and is stale ([S19]).
  - Microsoft's desktop-registration page still lists MSAL Node for Electron as "Public preview" ([S16]).
- **Electron custom-scheme redirect.** Microsoft suggests `msal{ClientId}://auth` for Electron apps ([S16]). The loopback `http://localhost` works for any desktop shell.
- **Without MSAL.** The protocol is plain OAuth 2.0 auth code + PKCE against the v2.0 endpoint ([S28]). A Rust or Python shell can implement it directly.
- **Broker (WAM-style single sign-on):**
  - The MSAL Node broker plugin is "currently only supported on Windows" ([S21]).
  - "Microsoft single sign-on for Linux" (the `microsoft-identity-broker` package) supports Ubuntu 24.04/26.04 and RHEL 9/10 only, Entra (work) accounts only, and SSO for MSAL .NET and MSAL Python apps ([S23]).
  - **So on Arch/Hyprland: system browser + loopback, no broker.**
- **Token cache.** `@azure/msal-node-extensions` persists the cache using DPAPI on Windows, Keychain on macOS, and libsecret ("Secret Service") on Linux ([S22]).
  - On Linux it can fall back to plaintext (`usePlaintextFileOnLinux`, default `false`) ([S22]).
  - On Windows and Linux the cache is readable by every app running as that user ([S22]).
  - Hyprland has no Secret Service provider out of the box. The User needs gnome-keyring, KWallet or similar running. This is an inference from the libsecret dependency.
- **Multiple Accounts.** Refresh tokens are "bound to a combination of user and client, but aren't tied to a resource or tenant" ([S25]). So one cache holds 3–4+ Accounts, and one refresh token can mint both Graph and `outlook.office.com` (IMAP) tokens.

### Lifetimes

| Token | Lifetime | Source |
|---|---|---|
| Access token (default) | Random 60–90 min (avg 75) | [S24] |
| Access token, CAE-capable client | "Long lived, up to 28 hours"; revoked by critical events instead of expiry. The app must handle 401 claims challenges. MSAL refreshes it proactively. | [S26], [S27] |
| Refresh token | 90 days (24 h for SPAs). Replaced with a fresh one on every use. Revoked on password change, admin action, and similar. | [S25] |
| Sign-in frequency (Conditional Access) | Tenant-defined. Forces interactive re-auth regardless of the above. | [S24] |

**Practical effect:** a Commander that runs regularly keeps renewing its refresh tokens and rarely prompts. It must still handle `invalid_grant` or `interaction_required` gracefully by showing a per-Account "reconnect" state.

## 4. Change detection without a server

### Delta queries (pull): the baseline

- **Messages.** Delta is "a per-folder operation. To track the changes of the messages in a folder hierarchy, you need to track each folder individually." ([S30])
  - Endpoint: `GET /me/mailFolders/{id}/messages/delta`.
  - Supports `$select`, `$top`, `$expand`.
  - `$filter` is limited to `receivedDateTime ge|gt` (and then returns at most 5,000 messages).
  - `$orderby` is limited to `receivedDateTime desc`.
  - No `$search`.
  - Optional `changeType=created|updated|deleted`.
  - Page size via `Prefer: odata.maxpagesize` ([S30]).
- **Folders.** `mailFolder: delta` tracks folders added, changed or removed ([S34]).
- **Events.**
  - v1.0 documents `GET /me/calendarView/delta?startDateTime=…&endDateTime=…`, a fixed date window on the **primary** calendar ([S32]).
  - The concept page says that to track several calendars "you need to track each calendar individually" ([S31]).
  - Per-calendar `…/calendars/{id}/calendarView/delta`, and an unbounded `…/events/delta` with no end date, are documented **only in beta (preview)** ([S31], [S33]).
  - `$select` is not supported for calendarView delta ([S31]).
- **Both account types are supported** ([S32], [S34], plus the permission tables of message delta).
- **Token lifetime.** For Outlook entities, delta-token lifetime "isn't fixed; it's dependent on the size of the internal delta token cache". Expired tokens return a 40X with `syncStateNotFound` ([S29]).
  - `410 Gone` means "restart with a full synchronization" ([S29]).
  - Commander must always be able to fall back to a full resync of a folder.
- **Replays and deletes.**
  - The same item can appear more than once in one delta round ([S29]).
  - Deletes come back as `@removed` with reason `changed` (recoverable) or `deleted` ([S29]).
- **Immutable IDs.** Send `Prefer: IdType="ImmutableId"` on every request, delta included. A message's ID then survives moves between folders. Without it, "their IDs change … if the item is moved" ([S42]).
- **Budget.** At 10,000 requests per 10 minutes per mailbox ([S51]), polling 30 folders plus 3 calendars every 60 s costs about 330 requests per 10 minutes. Microsoft does say continuous polling makes throttling more likely and recommends change tracking and notifications ([S52]). Delta is that change tracking.

### Change notifications (push): need an endpoint Commander doesn't have

- **Delivery channels:** webhooks, Azure Event Hubs, Azure Event Grid ([S35]).
- **Webhooks** need "a publicly accessible, HTTPS-secured endpoint" ([S36]).
  - It must answer within 3 seconds or notifications get delayed, then dropped, and "dropped notifications can't be recovered" ([S36]).
  - A laptop behind NAT can't meet this without a tunnel or relay, which is a server by another name.
- **Event Hubs** avoid a public URL: "The Event Hubs SDK relays the notifications to your application" ([S37]). But they need:
  - a provisioned event hub
  - Key Vault or an RBAC grant to the "Microsoft Graph Change Tracking" service principal
  - an Azure subscription in a tenant ([S37])

  A desktop app could read them over an outbound connection. But either every User runs Azure resources, or Commander runs a shared one, which is a server.
- **Outlook subscription limits:**
  - Resources: messages (whole mailbox or one folder), events (whole mailbox), contacts.
  - Personal accounts are supported.
  - At most 1,000 active subscriptions per mailbox across all apps ([S39]).
  - Maximum lifetime 10,080 minutes (under 7 days), or 1,440 minutes when resource data is included ([S38]).
- **Web Push delivery (new, August 2026, not validated).** Graph added "support for delivering change notifications to Web Push endpoints (RFC 8291)" and a `getVapidPublicKey` function ([S41]). Both are in v1.0 ([S40]).
  - The subscription's `notificationUrl` must be a known Web Push service origin (Apple, FCM, Mozilla autopush).
  - The subscription carries the browser's `p256dh` and `auth` keys ([S38]).
  - In principle this pushes to a client with no Commander server. In practice Commander would need a working browser-style push subscription and a way to receive it while running. Microsoft documents it in browser `PushManager` terms ([S38]), and I found no guide for desktop or native receivers.
  - **Worth a prototype before relying on it.** It is new and thinly documented.
- **IMAP IDLE (see §7).** "If the IMAP4 client supports the IMAP4 IDLE command, email transfers to and from the Exchange Online mailbox might occur in nearly real time" ([S64]). It could serve as a wake-up signal that triggers a Graph delta pull of the Inbox. It costs:
  - an extra consent (`IMAP.AccessAsUser.All`, admin-gated in managed tenants) ([S7])
  - IMAP being enabled (off by default on outlook.com) ([S68])
  - one connection per watched folder

**Recommendation:** delta polling with adaptive cadence, for example:

- every 30–60 s for the Inbox and calendars while Commander is in focus
- every few minutes for other folders and in the background
- an immediate pull after the User acts

Treat push (Web Push or IMAP IDLE) as an optional later optimization.

## 5. Gmail-style labels and Outlook folders and categories (for Buckets)

**How Outlook organizes mail:**

- **Folders.** Each message has one `parentFolderId` ([S44]).
  - Folders nest. There is a limit of 10,000 direct children per folder ([S50]).
  - Moving a message changes its regular ID; immutable IDs avoid that ([S42]).
- **Categories.** `message.categories` is a string collection, so a message can carry many ([S44]).
  - Categories come from the user's **master category list** (`outlookCategory`: `displayName` + `color`), which is shared across messages, events, contacts, tasks and group posts ([S45], [S43]).
  - `displayName` is unique and **can't be changed after creation** ([S45]).
  - There are 25 preset colors ([S45]).
  - Managing the master list needs `MailboxSettings.ReadWrite`, on both personal and work accounts ([S46]).
  - Rendering of the preset colors depends on the client ([S45]).
- **Focused / Other.** Each message has `inferenceClassification`. Apps can update it, and "these corrections also train the message classification system". Per-sender overrides can be set ([S49]).
- **Flags and importance.** `flag` (`followupFlag`) and `importance` are message properties ([S44]).
- **Inbox rules.** Rules run server-side, so they apply even when Commander is off ([S47]).
  - Actions include `assignCategories`, `moveToFolder`, `markImportance`, `forwardTo`, `stopProcessingRules`.
  - The per-mailbox rule quota in Exchange Online is 256 KB ([S50]).
- **Search folders.** `mailSearchFolder` is a virtual folder of messages matching criteria ([S48]). Exchange deletes it after 45 days without use, or when a per-source-folder limit is exceeded.
- **Custom data.** Open extensions are recommended. Extended (MAPI) properties are only for MAPI properties Graph doesn't expose ([S73]). Open extensions have their own throttle: 455 requests per 10 s per app per tenant ([S51]).

**Mapping Gmail concepts onto Outlook:**

| Gmail concept | Closest Outlook equivalent | Notes |
|---|---|---|
| User label (many per message) | **Category** | Many-to-many, colored, doesn't move mail, shows in Outlook clients. Names can't be renamed in place ([S45]). |
| Label used as "move out of Inbox" | **Folder** move (for example, Archive) | One folder per message. Use immutable IDs ([S42]). |
| Inbox / archive | Inbox folder / Archive folder | — |
| Gmail categories tabs (Primary, Promotions…) | Focused / Other (two values only) | Writable, and it trains Microsoft's model ([S49]) |
| Gmail filters | Inbox rules | Server-side, quota-limited ([S47], [S50]) |

**How changes show up in sync:**

- A category change made in Outlook (web, desktop, phone) appears as an `updated` message in that folder's delta ([S30]). The Agent can use this as a correction signal.
- A folder move appears as a removal in one folder's delta and an add in another. Immutable IDs let Commander reconcile them as the same message ([S42]).

## 6. Throttling limits

| Limit | Value | Scope | Source |
|---|---|---|---|
| Outlook API requests | 10,000 per 10 min | per app ID × mailbox | [S51] |
| Outlook concurrency | 4 concurrent requests | per app ID × mailbox | [S51] |
| Outlook uploads (PATCH/POST/PUT) | 150 MB per 5 min | per app ID × mailbox | [S51] |
| Graph global | 130,000 requests per 10 s | per app across all tenants | [S51] |
| JSON batch | 20 requests per batch. Each counts individually. Outlook runs up to 4 at a time, or sequentially with `dependsOn`. | per batch | [S51], [S53] |
| Open/schema extensions | 455 requests per 10 s | per app per tenant | [S51] |
| Change-notification subscriptions | 1,000 active | per mailbox, all apps | [S39] |
| `$search` on messages | 1,000 results max | per request | [S55] |
| Attachments | < 3 MB in one POST; 3–150 MB via upload session | per item | [S54] |
| Exchange Online sending | 10,000 recipients/day; 30 messages/min; up to 1,000 recipients per message (customizable) | per user | [S50] |
| Exchange Online message size | Default 35 MB send / 36 MB receive. Admins can raise it to 150 MB (112 MB once a message leaves Microsoft). | per org / per mailbox | [S50] |
| Outlook.com sending (Microsoft 365 subscribers) | 5,000 recipients/day; 500 per message; 1,000 "non-relationship" recipients/day. Lower for non-subscribers and new accounts. 25 MB attachment limit. | per user | [S70] |

- **On 429:** wait for `Retry-After`; if it is missing, back off exponentially ([S52]).
- **`sendMail` returns 202 Accepted.** That doesn't mean the message was delivered. Delivery is subject to Exchange limits ([S76]).
- **Limits are per app × mailbox.** The same Account open in Commander on two machines shares one 4-request concurrency budget, because it is the same client ID ([S51]).

## 7. IMAP/SMTP with OAuth as an alternative path

**What works:**

- OAuth2 for IMAP, POP and SMTP is "available for both Microsoft 365 … and Outlook.com users" ([S63]).
  - Scopes: `https://outlook.office.com/IMAP.AccessAsUser.All`, `…/POP.AccessAsUser.All`, `…/SMTP.Send` (+ `offline_access`).
  - Auth uses SASL `XOAUTH2` ([S63]).
- **Servers** ([S64], [S68]):
  - IMAP: `outlook.office365.com:993` (TLS), for both Exchange Online and outlook.com.
  - SMTP for outlook.com: `smtp-mail.outlook.com:587` (STARTTLS).
- **Observed today** (2026-10-01, pre-auth `CAPABILITY` against `outlook.office365.com:993`):

  ```
  * CAPABILITY IMAP4 IMAP4rev1 AUTH=XOAUTH2 LOGINDISABLED SASL-IR UIDPLUS MOVE ID UNSELECT CHILDREN IDLE NAMESPACE LITERAL+
  ```

  IDLE, MOVE and UIDPLUS are present. CONDSTORE/QRESYNC are **not**, so incremental flag sync means re-fetching flags. Basic `LOGIN` is disabled. This is my own direct observation, not a document; post-auth capabilities could differ.
- **Basic auth is gone.**
  - Outlook.com dropped it for third-party apps on 16 Sep 2024 ([S67]).
  - Exchange Online SMTP AUTH Basic auth retirement was rescheduled on 27 Jan 2026 ([S66]). This doesn't matter if Commander uses OAuth.

**Why it isn't a real alternative:**

- **No calendar or contacts.** POP/IMAP "don't offer rich email, calendaring, and contact management" ([S64]).
- **No categories.**
  - Secondary sources only: Outlook categories don't sync over IMAP, and Exchange (2016) advertises no custom keywords in `PERMANENTFLAGS` ([S74]). I found no Microsoft doc either way.
  - So Buckets couldn't be written back as categories over IMAP.
- **Off by default in places.**
  - Outlook.com: "POP & IMAP access is disabled by default". The User must enable it in Outlook.com settings ([S68]).
  - Exchange Online: IMAP is on by default per user, but admins can disable it ([S64]).
  - Microsoft "highly recommend[s] that you disable SMTP AUTH" org-wide ([S65]), and with security defaults on, SMTP AUTH is already off ([S65]).
- **Same consent wall.** `IMAP.AccessAsUser.All` is in the Microsoft-managed exclusion list ([S7]).
- **Latency.** Each Exchange Online IMAP access goes through a proxy hop that adds "a delay of several seconds" ([S64]).
- **Connection limits** for Exchange Online IMAP aren't published. Microsoft Q&A answers say the numbers aren't public; I found no primary doc.

**Verdict:** use Graph for everything. IMAP is useful at most as an optional IDLE wake-up signal (§4), and even that carries consent and enablement costs.

## Implications for the decisions

### #15 Email client: what's in v1

- **Account support is uneven, and v1 should say so.**
  - Personal outlook.com Accounts: self-serve.
  - Work Accounts: need the tenant admin's consent (§1). The connect flow should detect `AADSTS90094` / "admin approval required" and explain what to ask the admin for. If the tenant has an admin consent workflow, it should offer that route ([S8], [S9]).
- **Unified vs per-Account inbox.** Graph has no constraint here. It is a local-store choice. Each Account syncs independently with its own throttle budget ([S51]).
- **Compose.**
  - `sendMail` (JSON or MIME), or create a draft and then send ([S76]).
  - Reply, reply-all and forward are supported, both directly and as drafts (`createReply`, `createReplyAll`, `createForward`) ([S77]).
  - Attachments: up to 150 MB via upload sessions on Exchange ([S54]); Outlook.com caps attachments at 25 MB ([S70]).
- **Signatures.** I found no Graph API for Outlook's own signatures. Plan for Commander-local signatures.
- **Search.**
  - Server `$search` returns at most 1,000 results and doesn't work with delta ([S55], [S30]).
  - In-place archive mailboxes aren't reachable ([S43]).
  - A local full-text index over the synced store gives the better search UX. Server search can be a fallback for mail outside the synced window.
- **Snooze.** I found no Graph snooze for mail. Implement it locally: for example, move to a Commander folder or category plus a local timer. That needs Commander running when the snooze ends.
- **Send-later.**
  - Option A: a local queue, which needs Commander running at send time.
  - Option B: set MAPI `PidTagDeferredSendTime` (`SystemTime 0x3FEF`) as a single-value extended property on the message, so Exchange holds it ([S71], [S73]). The Graph usage is shown only in a Microsoft PnP community sample ([S72], secondary).
  - **Prototype B before promising server-side send-later on both Account types.**
- **Undo-send.** Graph has no undo. Hold the message locally for N seconds before calling send.
- **Offline use.** Delta-synced local store + immutable IDs ([S30], [S42]). MIME export (`$value`) is available for full fidelity ([S43]).
- **Shared mailboxes.** Work-only (`*.Shared` scopes), and also admin-gated ([S1], [S7]). Candidate for "later".

### #16 Email Buckets

- **Write back as categories by default.** Categories are many-to-many like Buckets, don't move mail, keep Triage in the Inbox, appear in every Outlook client, and come back through delta when the User changes them elsewhere. That gives the Agent its correction signal ([S44], [S45], [S30]).
  - Creating master-list entries (with colors) needs `MailboxSettings.ReadWrite` ([S46]). In managed work tenants this scope is gated alongside `Mail.ReadWrite` anyway ([S7]), so it adds no new consent hurdle.
- **Bucket renames are not free.** Category names can't be renamed ([S45]). Renaming a Bucket means: create a new category, re-tag the messages, delete the old category. Avoid renames or make them a background job.
- **Color budget.** 25 preset colors, and the actual color depends on the client ([S45]).
- **Folders, if Users want filing.** One per message ([S44]). Use immutable IDs ([S42]). A move shows up as remove+add across two folder deltas ([S30]).
- **Focused/Other.** A free two-value signal. Commander could read it, or write corrections back, which also trains Microsoft's classifier ([S49]). Decide whether that side effect is wanted.
- **Server-side inbox rules** can apply simple categories or moves while Commander is off ([S47]). This is limited by the 256 KB rule quota ([S50]). The Agent's sorting itself stays local.
- **Gmail parity.** Gmail labels and Outlook categories line up well enough to give Buckets one model across Sources. Moving mail out of the Inbox maps to "archive" on both.

### #17 Calendar Section and AI event scheduler

- **Overlaying calendars from several Accounts works.**
  - List each Account's calendars and sync each with `calendarView` (and its delta) over a rolling window ([S31]).
  - v1.0 documents calendarView delta only for the primary calendar. Per-calendar and unbounded event delta are beta/preview ([S32], [S33]). Plan for a rolling window, plus a periodic full re-read of other calendars if per-calendar delta proves unreliable in v1.0.
- **Invites and RSVPs** work on both account types: accept, decline, and tentatively accept (with `proposedNewTime` when the organizer allows it) ([S60], [S61]).
- **Creating and editing events** is full create/read/update/delete ([S59]).
  - Use `transactionId` for idempotent creates. This matters for Agent retries ([S59]).
  - Online meetings: set `onlineMeetingProvider`, but check the calendar's `allowedOnlineMeetingProviders` first; Teams applies to work calendars ([S59], [S56]).
- **AI scheduler, the hard constraint.** `findMeetingTimes` and `getSchedule` (free/busy) are **work/school only**. Personal accounts are "Not supported" ([S57], [S58], [S56]). So:
  - **Find free time:** compute locally from the User's own synced calendars across all Accounts. That works for every Account type and is probably better anyway, since the User's availability spans Accounts.
  - **Other people's free/busy:** only for colleagues inside a work tenant, via `getSchedule`/`findMeetingTimes`, and only with an admin-consented Calendars scope.
  - **Block time for Todos:** create events (with `showAs` busy and a Commander category). No special API needed.
  - **Propose events from email and notes:** create events or draft invites from Agent output. There is a server-side precedent: Outlook can add events from emails automatically ([S56]).
  - **Share availability:** Graph can share a calendar with a person through `calendarPermission` ([S62]). A "send my free slots" feature without a server has to be generated locally, for example as text or ICS in an email.
- **Consent.** `Calendars.ReadWrite` is admin-gated in managed work tenants, just like mail ([S7]). So in those tenants the Calendar Section needs the same admin approval as Email.

## Open questions (need a prototype or a real tenant)

1. Does the Microsoft-managed consent policy exempt an app the User registers in their own work tenant? Not documented ([S7]).
2. Does a personal-account sign-in to an unverified multi-tenant app with these scopes succeed without friction? No document says it is blocked ([S15]).
3. Can a desktop app receive Graph Web Push notifications in practice (August 2026 feature)? ([S38], [S40], [S41])
4. Is per-calendar `calendarView/delta` reliable on v1.0 for non-primary calendars? Only beta documents it ([S33]).
5. Does server-side send-later via `PidTagDeferredSendTime` work through Graph on both outlook.com and Exchange Online? Only a community sample shows it ([S72]).
6. What does a personal sign-in do when the request includes a `Mail.*.Shared` scope? ([S1])
7. Exchange Online IMAP connection limits and post-auth capabilities. Not published; only observed pre-auth.

## Sources

Dates are the page's `ms.date` / last `updated_at` as served on 2026-10-01, where available.

- [S1] Microsoft Graph permissions reference (ms.date 2026-09-14). https://learn.microsoft.com/en-us/graph/permissions-reference
- [S2] Register an application in Microsoft Entra ID (ms.date 2026-05-14). https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
- [S3] Validation differences by supported account types (ms.date 2026-09-25). https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation
- [S4] What's new for authentication: "Applications must be registered in a directory", June 2024. https://learn.microsoft.com/en-us/entra/identity-platform/reference-breaking-changes
- [S5] Publisher verification overview (updated 2026-06-15). https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
- [S6] Configure how users consent to applications (updated 2026-08-04). https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent
- [S7] Manage app consent policies: Microsoft-managed policy and mail client policy (ms.date 2026-01-22, updated 2026-08-28). https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies
- [S8] Configure risk-based step-up consent (ms.date 2025-05-21). https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-risk-based-step-up-consent
- [S9] Configure the admin consent workflow. https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-admin-consent-workflow
- [S10] MC1097272 "Microsoft 365 Upcoming Secure by Default Settings Changes", published 2025-06-17. Secondary mirror of Microsoft 365 Message Center. https://mc.merill.net/message/MC1097272
- [S11] MC1163922 "Upcoming Secure by Default Settings Changes for Exchange and Teams APIs", published 2025-10-02. Secondary mirror of Message Center. https://mc.merill.net/message/MC1163922
- [S12] MC1304287 "Microsoft Exchange Online: Upcoming secure-by-default changes for Exchange APIs", published 2026-05-08. Secondary mirror of Message Center. https://mc.merill.net/message/MC1304287
- [S13] Microsoft Q&A, "Clarification on MC1163922": scope list relayed from the product team. Secondary (community Q&A). https://learn.microsoft.com/en-us/answers/questions/5572742/clarification-on-mc1163922
- [S14] Delegate app registration permissions: "By default … all users can register applications". https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/delegate-app-roles
- [S15] Application consent experience. https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience
- [S16] Desktop app that calls web APIs: app registration. https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration
- [S17] Redirect URI best practices and limitations: localhost exceptions. https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- [S18] MSAL Node request docs: `acquireTokenInteractive`. https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/request.md
- [S19] MSAL Node README: Node version support. https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/README.md
- [S20] `@azure/msal-node` on npm: 7.0.0, modified 2026-09-23, `engines.node >= 20`. https://www.npmjs.com/package/@azure/msal-node
- [S21] MSAL Node brokering: "currently only supported on Windows". https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/brokering.md
- [S22] `@azure/msal-node-extensions` README: cache persistence (libsecret on Linux). https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/extensions/msal-node-extensions/README.md
- [S23] What is Microsoft single sign-on for Linux (ms.date 2026-02-03). https://learn.microsoft.com/en-us/entra/identity/devices/sso-linux
- [S24] Access tokens: token lifetime. https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens
- [S25] Refresh tokens (ms.date 2025-11-05). https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- [S26] How to use CAE-enabled APIs in your applications. https://learn.microsoft.com/en-us/entra/identity-platform/app-resilience-continuous-access-evaluation
- [S27] Continuous access evaluation: token lifetime. https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation
- [S28] OAuth 2.0 authorization code flow (Microsoft identity platform). https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- [S29] Delta query overview: token duration, 410 Gone, replays. https://learn.microsoft.com/en-us/graph/delta-query-overview
- [S30] Get incremental changes to messages in a folder. https://learn.microsoft.com/en-us/graph/delta-query-messages
- [S31] Get incremental changes to events in a calendar view. https://learn.microsoft.com/en-us/graph/delta-query-events
- [S32] event: delta (v1.0). https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0
- [S33] event: delta (beta): per-calendar and unbounded events delta. https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-beta
- [S34] mailFolder: delta. https://learn.microsoft.com/en-us/graph/api/mailfolder-delta
- [S35] Change notifications overview: delivery channels. https://learn.microsoft.com/en-us/graph/change-notifications-overview
- [S36] Receive change notifications through webhooks. https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- [S37] Receive change notifications through Azure Event Hubs. https://learn.microsoft.com/en-us/graph/change-notifications-delivery-event-hubs
- [S38] subscription resource type: Web Push properties, subscription lifetimes (updated 2026-09-17). https://learn.microsoft.com/en-us/graph/api/resources/subscription
- [S39] Outlook change notifications overview: resources, 1,000 per mailbox. https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview
- [S40] subscription: getVapidPublicKey (v1.0, ms.date 2026-08-21). https://learn.microsoft.com/en-us/graph/api/subscription-getvapidpublickey?view=graph-rest-1.0
- [S41] What's new in Microsoft Graph: August 2026 Web Push delivery. https://learn.microsoft.com/en-us/graph/whats-new-overview
- [S42] Obtain immutable identifiers for Outlook resources. https://learn.microsoft.com/en-us/graph/outlook-immutable-id
- [S43] Outlook mail API overview: categories, rules, MIME, archive mailboxes not supported. https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview
- [S44] message resource type. https://learn.microsoft.com/en-us/graph/api/resources/message
- [S45] outlookCategory resource type. https://learn.microsoft.com/en-us/graph/api/resources/outlookcategory
- [S46] Create outlookCategory: permissions. https://learn.microsoft.com/en-us/graph/api/outlookuser-post-mastercategories
- [S47] messageRuleActions resource type. https://learn.microsoft.com/en-us/graph/api/resources/messageruleactions
- [S48] mailSearchFolder resource type: 45-day expiry. https://learn.microsoft.com/en-us/graph/api/resources/mailsearchfolder
- [S49] Focused Inbox (inferenceClassification). https://learn.microsoft.com/en-us/graph/api/resources/manage-focused-inbox
- [S50] Exchange Online limits: folder, rule, sending, message size (ms.date 2026-04-07). https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits
- [S51] Microsoft Graph service-specific throttling limits: Outlook service limits (updated 2026-09-17). https://learn.microsoft.com/en-us/graph/throttling-limits
- [S52] Microsoft Graph throttling guidance. https://learn.microsoft.com/en-us/graph/throttling
- [S53] Combine multiple requests in one HTTP call (JSON batching). https://learn.microsoft.com/en-us/graph/json-batching
- [S54] Attach large files to Outlook messages or events. https://learn.microsoft.com/en-us/graph/outlook-large-attachments
- [S55] Use the $search query parameter: messages. https://learn.microsoft.com/en-us/graph/search-query-parameter
- [S56] Outlook calendar API overview: work/school-only features marked. https://learn.microsoft.com/en-us/graph/outlook-calendar-concept-overview
- [S57] user: findMeetingTimes: personal accounts not supported. https://learn.microsoft.com/en-us/graph/api/user-findmeetingtimes
- [S58] calendar: getSchedule: personal accounts not supported. https://learn.microsoft.com/en-us/graph/api/calendar-getschedule
- [S59] event resource type: `transactionId`, `onlineMeetingProvider`, `allowNewTimeProposals`. https://learn.microsoft.com/en-us/graph/api/resources/event
- [S60] event: tentativelyAccept, `proposedNewTime`. https://learn.microsoft.com/en-us/graph/api/event-tentativelyaccept
- [S61] event: accept. https://learn.microsoft.com/en-us/graph/api/event-accept
- [S62] Create calendarPermission. https://learn.microsoft.com/en-us/graph/api/calendar-post-calendarpermissions
- [S63] Authenticate an IMAP, POP or SMTP connection using OAuth (updated 2025-10-17). https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
- [S64] POP3 and IMAP4 in Exchange Online: IDLE, no calendaring, proxy delay. https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4
- [S65] Enable or disable SMTP AUTH in Exchange Online. https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission
- [S66] Exchange Team blog, "Exchange Online to retire Basic auth for Client Submission (SMTP AUTH)", 2024-04-15, update note 2026-01-27. https://techcommunity.microsoft.com/blog/exchange/exchange-online-to-retire-basic-auth-for-client-submission-smtp-auth/4114750
- [S67] Microsoft Support, "Modern Authentication Methods now needed to continue syncing Outlook Email in non-Microsoft email apps" (Basic auth off 2024-09-16). https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d
- [S68] Microsoft Support, "POP, IMAP, and SMTP settings for Outlook.com". https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040
- [S69] Exchange Team blog, "Introducing EWSAllowedAppIDs: Preparing for the Final Phase of EWS Retirement", 2026-06-19, updated through 2026-09-22. https://techcommunity.microsoft.com/blog/exchange/introducing-ewsallowedappids-preparing-for-the-final-phase-of-ews-retirement/4529471
- [S70] Microsoft Support, "Sending limits in Outlook.com". https://support.microsoft.com/en-us/office/sending-limits-in-outlook-com-279ee200-594c-40f0-9ec8-bb6af7735c2e
- [S71] PidTagDeferredSendTime canonical property (MAPI). https://learn.microsoft.com/en-us/office/client-developer/outlook/mapi/pidtagdeferredsendtime-canonical-property
- [S72] Microsoft 365 PnP script sample, "Send a delayed message". Secondary (community sample). https://pnp.github.io/script-samples/graph-delay-message-delivery/README.html
- [S73] Outlook extended properties overview. https://learn.microsoft.com/en-us/graph/api/resources/extended-properties-overview
- [S74] Slipstick Systems, "Outlook Categories, Flags, and IMAP Accounts". Secondary (third-party). https://www.slipstick.com/outlook/outlook-categories-flags-and-imap-accounts/
- [S75] Microsoft 365 Developer Program FAQ: eligibility (ms.date 2026-09-04). https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq
- [S76] user: sendMail. https://learn.microsoft.com/en-us/graph/api/user-sendmail
- [S77] message: createReply. https://learn.microsoft.com/en-us/graph/api/message-createreply
- [S78] Create messageRule: permissions (MailboxSettings.ReadWrite). https://learn.microsoft.com/en-us/graph/api/mailfolder-post-messagerules
- Direct observation: `printf 'a1 CAPABILITY\r\n' | openssl s_client -quiet -connect outlook.office365.com:993` on 2026-10-01 (pre-auth capability list quoted in §7).

[S1]: https://learn.microsoft.com/en-us/graph/permissions-reference
[S2]: https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
[S3]: https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation
[S4]: https://learn.microsoft.com/en-us/entra/identity-platform/reference-breaking-changes
[S5]: https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
[S6]: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent
[S7]: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies
[S8]: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-risk-based-step-up-consent
[S9]: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-admin-consent-workflow
[S10]: https://mc.merill.net/message/MC1097272
[S11]: https://mc.merill.net/message/MC1163922
[S12]: https://mc.merill.net/message/MC1304287
[S13]: https://learn.microsoft.com/en-us/answers/questions/5572742/clarification-on-mc1163922
[S14]: https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/delegate-app-roles
[S15]: https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience
[S16]: https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration
[S17]: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
[S18]: https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/request.md
[S19]: https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/README.md
[S20]: https://www.npmjs.com/package/@azure/msal-node
[S21]: https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/brokering.md
[S22]: https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/extensions/msal-node-extensions/README.md
[S23]: https://learn.microsoft.com/en-us/entra/identity/devices/sso-linux
[S24]: https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens
[S25]: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
[S26]: https://learn.microsoft.com/en-us/entra/identity-platform/app-resilience-continuous-access-evaluation
[S27]: https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation
[S28]: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
[S29]: https://learn.microsoft.com/en-us/graph/delta-query-overview
[S30]: https://learn.microsoft.com/en-us/graph/delta-query-messages
[S31]: https://learn.microsoft.com/en-us/graph/delta-query-events
[S32]: https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0
[S33]: https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-beta
[S34]: https://learn.microsoft.com/en-us/graph/api/mailfolder-delta
[S35]: https://learn.microsoft.com/en-us/graph/change-notifications-overview
[S36]: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
[S37]: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-event-hubs
[S38]: https://learn.microsoft.com/en-us/graph/api/resources/subscription
[S39]: https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview
[S40]: https://learn.microsoft.com/en-us/graph/api/subscription-getvapidpublickey?view=graph-rest-1.0
[S41]: https://learn.microsoft.com/en-us/graph/whats-new-overview
[S42]: https://learn.microsoft.com/en-us/graph/outlook-immutable-id
[S43]: https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview
[S44]: https://learn.microsoft.com/en-us/graph/api/resources/message
[S45]: https://learn.microsoft.com/en-us/graph/api/resources/outlookcategory
[S46]: https://learn.microsoft.com/en-us/graph/api/outlookuser-post-mastercategories
[S47]: https://learn.microsoft.com/en-us/graph/api/resources/messageruleactions
[S48]: https://learn.microsoft.com/en-us/graph/api/resources/mailsearchfolder
[S49]: https://learn.microsoft.com/en-us/graph/api/resources/manage-focused-inbox
[S50]: https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits
[S51]: https://learn.microsoft.com/en-us/graph/throttling-limits
[S52]: https://learn.microsoft.com/en-us/graph/throttling
[S53]: https://learn.microsoft.com/en-us/graph/json-batching
[S54]: https://learn.microsoft.com/en-us/graph/outlook-large-attachments
[S55]: https://learn.microsoft.com/en-us/graph/search-query-parameter
[S56]: https://learn.microsoft.com/en-us/graph/outlook-calendar-concept-overview
[S57]: https://learn.microsoft.com/en-us/graph/api/user-findmeetingtimes
[S58]: https://learn.microsoft.com/en-us/graph/api/calendar-getschedule
[S59]: https://learn.microsoft.com/en-us/graph/api/resources/event
[S60]: https://learn.microsoft.com/en-us/graph/api/event-tentativelyaccept
[S61]: https://learn.microsoft.com/en-us/graph/api/event-accept
[S62]: https://learn.microsoft.com/en-us/graph/api/calendar-post-calendarpermissions
[S63]: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
[S64]: https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4
[S65]: https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission
[S66]: https://techcommunity.microsoft.com/blog/exchange/exchange-online-to-retire-basic-auth-for-client-submission-smtp-auth/4114750
[S67]: https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d
[S68]: https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040
[S69]: https://techcommunity.microsoft.com/blog/exchange/introducing-ewsallowedappids-preparing-for-the-final-phase-of-ews-retirement/4529471
[S70]: https://support.microsoft.com/en-us/office/sending-limits-in-outlook-com-279ee200-594c-40f0-9ec8-bb6af7735c2e
[S71]: https://learn.microsoft.com/en-us/office/client-developer/outlook/mapi/pidtagdeferredsendtime-canonical-property
[S72]: https://pnp.github.io/script-samples/graph-delay-message-delivery/README.html
[S73]: https://learn.microsoft.com/en-us/graph/api/resources/extended-properties-overview
[S74]: https://www.slipstick.com/outlook/outlook-categories-flags-and-imap-accounts/
[S75]: https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq
[S76]: https://learn.microsoft.com/en-us/graph/api/user-sendmail
[S77]: https://learn.microsoft.com/en-us/graph/api/message-createreply
[S78]: https://learn.microsoft.com/en-us/graph/api/mailfolder-post-messagerules
