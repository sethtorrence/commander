# Building blocks for a full email client

Research for wayfinder ticket #8. It feeds #12 (Tech stack and local database) and #15 (Email client: what's in v1).
All sources were fetched on 2026-10-01 unless a date says otherwise. Repo activity and release dates come from the GitHub, crates.io and npm APIs on that day.

## Question

What existing pieces can Commander build a full email client on, and what does each part (sync, storage, search, rendering, compose) demand? Specifically:

- Open-source mail sync engines and libraries usable from a desktop app (e.g. the Mailspring sync engine, EmailEngine, JMAP clients, IMAP libraries in Rust or Node), with licences and maintenance status.
- Local storage and full-text search over years of mail for 3–4 Accounts: size estimates, SQLite FTS5 vs Tantivy and similar.
- Threading across Gmail (native threads) and Outlook (conversations).
- Safe HTML email rendering: sanitizing, blocking remote images and trackers.
- Compose without a server: rich text, attachments, signatures, send-later, undo-send.
- How existing clients (Thunderbird, Mailspring, Mimestream and others) structure this, as prior art.

## Short answer

- **Commander will need its own sync engine. No existing one fits.**
  - **Mailspring-Sync** is the only maintained, embeddable open-source desktop sync engine I found. It speaks IMAP and CalDAV/CardDAV only, not the Gmail API or Microsoft Graph. It is GPL-3.0, and one person has written almost all of it.
  - **EmailEngine** is a commercial server that needs Redis.
  - **JMAP**: neither Gmail nor Outlook offers it.
  - **EWS** (Exchange Web Services) is being switched off in Exchange Online from **today, October 2026**.
  - The workable approach is a thin sync layer for each Source, built on the providers' own APIs: Gmail API `history.list` and Graph per-folder `delta`. MIME parsing and building can come from mature MIT or Apache libraries, in either Node or Rust.
- **Sync without a server means polling.**
  - Gmail push needs a Google Cloud Pub/Sub topic. Graph push needs a public HTTPS endpoint or Azure.
  - Only IMAP IDLE gives push to a client-held connection with no server. It could serve as a "something changed" doorbell next to API polling.
  - The doorbell has a price. Gmail IMAP needs the full-access `https://mail.google.com/` scope, which is broader than `gmail.modify`. Outlook IMAP needs a second token with `IMAP.AccessAsUser.All` for `outlook.office.com`, on top of the Graph token.
- **Initial sync is limited by quota.**
  - The Gmail API allows 6,000 quota units per user per minute, and `messages.get` costs 20. That is about 300 messages a minute, or about 18,000 an hour.
  - So the first sync must show the newest mail first and backfill the rest.
- **SQLite FTS5 is enough for search. Tantivy is faster but means a second store to keep consistent.**
  - On 255,170 unique Enron messages (694 MB raw), FTS5 built a 275 MB index. Ranked queries took 6–38 ms, and newest-first queries took ≤0.1 ms.
  - Tantivy built a 194 MB index, and its queries took 0.1–2.4 ms. That is about 4× faster on the phrase query and at least 7× faster on every term or boolean query.
  - FTS5 does single-word prefix search (`enron*`) out of the box. Tantivy's default query parser does not: it quietly treats `enron*` as the plain word `enron` (checked during verification).
  - Plan to store metadata, plain text and the index for all mail; HTML for recent mail; and attachments only when opened. That is a few GB per heavy Account.
- **Threading: use Gmail's `threadId` as it is. For Outlook, build threads yourself.**
  - Exchange's `conversationId` appears to come from the subject and the proprietary `Thread-Index` header. Microsoft's own documents don't fully agree on this (see §3). It splits when the subject changes, and reportedly when an outside sender replies without `Thread-Index`. It is also per mailbox, and Graph has no thread API for user mailboxes.
  - Commander should thread Outlook mail from RFC 5322 `Message-ID`, `In-Reply-To` and `References`, using `conversationId` only as a hint.
- **Safe HTML takes several layers. A sanitizer alone is not enough.**
  - DOMPurify itself says it will not reliably stop remote resource loads (tracking pixels) or CSS-based exfiltration.
  - The layers are: sanitize, rewrite or block every remote URL, render in an `<iframe sandbox>` without `allow-scripts` under a strict CSP, and block the network at the app level as a backstop.
  - Without a server there is no image proxy, so "load images" will reveal the User's IP address.
- **Compose works without a server, with two gaps.**
  1. The Gmail API has **no scheduled send** (discovery revision 20260928). Send-later for Gmail therefore needs a Commander process running at send time. For Outlook, deferral can be handed to Exchange through the MAPI property `PidTagDeferredSendTime`. An archived Microsoft EWS article shows Exchange and Office 365 honouring that property. Through Graph it is still not a documented feature, so it needs testing.
  2. **Outlook signatures can't be read through Graph**, so Commander should own signatures.
  - Undo-send is just a local hold queue, which is how Gmail's own 5–30 s undo works.

## 1. Sync engines and libraries

### 1.1 What the providers speak (this decides everything else)

| Path | Gmail | Outlook (Microsoft 365 / Outlook.com) |
| --- | --- | --- |
| Native REST API | Gmail API. Full sync is `messages.list` plus batched `messages.get`. Incremental sync is `history.list?startHistoryId=…`. History is "typically available for at least one week"; older IDs return 404 and need a full resync ([Gmail sync guide](https://developers.google.com/workspace/gmail/api/guides/sync), updated 2026-09-15). | Microsoft Graph. `delta` works **per folder**, so each folder is tracked separately. It supports `$select`, and deletions come back as `@removed`. There is no `$search` in delta ([Graph delta for messages](https://learn.microsoft.com/en-us/graph/delta-query-messages)). Delta supports `$orderby=receivedDateTime desc` and `$filter=receivedDateTime ge {date}`, but a filtered delta returns at most 5,000 messages. Delta tokens for Outlook entities expire when an internal cache fills, with no fixed lifetime. Expiry shows up as a 40X error such as `syncStateNotFound`, or as `410 Gone`, which means a full resync ([delta overview](https://learn.microsoft.com/en-us/graph/delta-query-overview)). |
| IMAP | Works with OAuth (XOAUTH2/OAUTHBEARER), but only with the full-access scope `https://mail.google.com/` ([Gmail XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol), updated 2026-09-15). Google says that on **14 March 2025** "Access to less secure apps will be turned off for all Google Accounts", so password-only IMAP no longer works ([Google Workspace](https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth)). Gmail extensions `X-GM-THRID`, `X-GM-MSGID`, `X-GM-LABELS` and `X-GM-RAW` expose threads, labels and Gmail search ([Gmail IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions)). IMAP download is capped at **2,500 MB/day** per user ([Gmail bandwidth limits](https://knowledge.workspace.google.com/admin/gmail/gmail-bandwidth-limits?hl=en), updated 2026-09-30). That page covers Workspace editions; it doesn't say whether consumer Gmail has the same cap. | OAuth IMAP, POP and SMTP work for both Microsoft 365 and Outlook.com through the `IMAP.AccessAsUser.All` scope ([Microsoft IMAP OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)). Basic auth for Outlook.com personal accounts ended 16 Sept 2024 ([Microsoft support](https://support.microsoft.com/en-us/support/known-issues/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-ap)). |
| JMAP (RFC 8620/8621) | Not offered. The jmap.io server list names Apache James, Stalwart, Cyrus and others, but not Google ([jmap.io software](https://jmap.io/software/index.html)). | Not offered (same list, no Microsoft). |
| EWS | n/a | **Being retired.** It starts being disabled globally in **October 2026** and will be fully disabled in **April 2027** ([Microsoft Learn](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online), updated 2026-09-04). Don't build on it. |
| Push without a server | `users.watch` publishes to a **Cloud Pub/Sub topic**, and the watch must be renewed every 7 days. Pull subscriptions avoid a public endpoint ([Gmail push](https://developers.google.com/workspace/gmail/api/guides/push), updated 2026-09-15). My inference: they still need a Google Cloud project and Pub/Sub subscriber credentials on every User's machine. IMAP `IDLE` is advertised and needs no server, but it needs the full `https://mail.google.com/` scope (see the IMAP row). | Graph change notifications go only to a **publicly accessible HTTPS** webhook, Azure Event Hubs or Event Grid ([Graph webhooks](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)). IMAP `IDLE` is advertised. It needs a separate `https://outlook.office.com/IMAP.AccessAsUser.All` token, and a Microsoft 365 tenant admin can turn IMAP off. |
| Rate limits | 6,000 quota units per minute per user per project, and 1,200,000 per minute per project. Costs: `messages.get` 20, `threads.get` 40, `history.list` 2, `messages.send` 100. **New:** there is an 80M-unit daily threshold per project, and charges above it are "planned … later in 2026" with 90 days' notice ([Gmail quota](https://developers.google.com/workspace/gmail/api/reference/quota), updated 2026-09-10). Batches are capped at 100 calls, and Google recommends ≤50 ([batch guide](https://developers.google.com/workspace/gmail/api/guides/batch)). | Per app per mailbox: 10,000 requests per 10 minutes, **4 concurrent requests**, and 150 MB of uploads per 5 minutes ([Outlook throttling](https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/includes/throttling-outlook.md)). `$top` on message lists goes up to 1,000, but big pages risk HTTP 504 ([list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages)). |

**IMAP capabilities, probed directly.** On 2026-10-01 I sent `CAPABILITY` before login to both servers. `imap.gmail.com` returned `IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 … AUTH=XOAUTH2 … AUTH=OAUTHBEARER`. `outlook.office365.com` returned `IMAP4 IMAP4rev1 AUTH=XOAUTH2 LOGINDISABLED SASL-IR UIDPLUS MOVE ID UNSELECT CHILDREN IDLE NAMESPACE LITERAL+`. Outlook advertised no CONDSTORE/QRESYNC, so cheap incremental flag sync over IMAP is unlikely there. The list can change after login, so check again once authenticated.

**What this means for initial sync.** At 20 units per `messages.get`, one Gmail Account syncs at most ~300 messages a minute (~18,000 an hour). A 100,000-message mailbox would take about 5.5 hours at full speed. `threads.get` (40 units) is cheaper per message once threads average more than 2 messages. Gmail over IMAP has no unit quota but is capped at 2,500 MB/day. Graph allows ~10,000 requests per 10 minutes with up to 1,000 items per list page, so request count is not the limit there; payload size and the 4-concurrent-request cap are. In every case, show mail newest-first and backfill in the background. On Outlook this can be a plain `messages` list sorted by `receivedDateTime desc` (or a delta with that `$orderby`) for the first screen, followed by a full per-folder delta.

**Laptop-closed problem.** Gmail history IDs older than about a week can 404, and Graph delta tokens can expire without warning. Commander will often have been off for a while, so a full re-sync path (re-list IDs and diff against local state) is required, not optional.

### 1.2 Whole sync engines

| Engine | What it is | Licence | Maintenance (2026-10-01) | Fit for Commander |
| --- | --- | --- | --- | --- |
| **Mailspring-Sync** ([repo](https://github.com/Foundry376/Mailspring-Sync)) | A C++11 engine on MailCore2/libetpan and SQLite. One process per Account talks over newline-delimited JSON on stdin/stdout: it takes tasks in and emits changed objects out. It covers IMAP/SMTP, CalDAV/CardDAV and Google Contacts. | GPL-3.0 | Very active: last push 2026-09-30, with many fixes that day. One author wrote 625 of ~670 commits. No tagged releases; it ships inside Mailspring 1.25.0 (2026-09-19). | **Poor.** It has no Gmail API or Graph support. Gmail is synced as IMAP All Mail, Spam and Trash plus `X-GM-LABELS`. It stores bodies only for the last ~3 months and keeps model JSON in a `data` column, which the author says he "may have chosen" differently ([README](https://github.com/Foundry376/Mailspring-Sync)). It expects a Mailspring identity, though an identity of `null` is accepted ([main.cpp](https://github.com/Foundry376/Mailspring-Sync/blob/master/MailSync/main.cpp)). GPL obligations come with shipping the binary (see 1.4). |
| **EmailEngine** ([site](https://emailengine.app/)) | A headless Node server that turns IMAP, Gmail API and Graph into a REST API with webhooks. It keeps only metadata in Redis and fetches content on demand. | v1 was AGPL-3.0. **v2 is a commercial licence**: a 14-day trial, after which it "ceases to operate until a valid License Key is provided" ([licence](https://github.com/postalsys/emailengine/blob/master/LICENSE_EMAILENGINE.txt)). It costs $1,450 / €1,200 a year ([site](https://emailengine.app/)). | Active (v2.81.2, 2026-09-27). | **No.** It is a server that needs Redis. The licence is "non-transferable", with keys reusable only "within the purchasing organization", so it can't be shipped to other Users inside Commander. It also does not keep a local mail store. |
| **Thunderbird** | A full client (C++/JS/Rust). Not embeddable. | MPL-2.0 | Active. | Prior art only (see §6). |
| **Inbox Zero** ([repo](https://github.com/elie222/inbox-zero)) | An AI email assistant as a web app (Next.js, Postgres, Redis). | AGPL-3.0 **plus extra terms** that bar commercial monetization without permission and require an enterprise licence at 5+ users ([LICENSE](https://github.com/elie222/inbox-zero/blob/main/LICENSE)). | Active. | Design reference only. Its code can't be reused if Commander may be monetized. |
| **Zero / Mail0** ([repo](https://github.com/Mail-0/Zero)) | A self-hosted web email app (Next.js, Postgres). | MIT | Last commit on the default branch is 2025-08-31, so it looks dormant. | Reference only. |

### 1.3 Libraries (building your own engine)

**Node / TypeScript**

| Library | Purpose | Licence | Latest | Notes |
| --- | --- | --- | --- | --- |
| [ImapFlow](https://github.com/postalsys/imapflow) | IMAP client | MIT | 2.2.0 (2026-10-01) | Async API. Handles IDLE, CONDSTORE/QRESYNC, COMPRESS and Gmail extensions; ships TypeScript types; needs Node 20+. One maintainer wrote ~611 commits; the next human contributor has 7. |
| [mailparser](https://github.com/nodemailer/mailparser) | MIME parse (Node streams) | MIT | 3.9.33 (2026-10-01) | Same maintainer. |
| [postal-mime](https://github.com/postalsys/postal-mime) | MIME parse (browser and serverless) | MIT-0 | 4.0.2 (2026-09-30) | Runs in a renderer or worker. |
| [Nodemailer](https://github.com/nodemailer/nodemailer) | MIME build (MailComposer) and SMTP | MIT-0 | 10.0.13 (2026-09-30) | Its MailComposer builds the raw RFC 5322 that Gmail `messages.send` needs. |
| [googleapis](https://www.npmjs.com/package/googleapis) | Gmail REST client | Apache-2.0 | 182.0.0 (2026-09-24) | Plain `fetch` works too. |
| `@microsoft/microsoft-graph-client` | Graph client (old) | MIT | 3.0.7 (**2023-09-19**) | Stale. |
| [`@microsoft/msgraph-sdk`](https://github.com/microsoftgraph/msgraph-sdk-typescript) | Graph client (new, Kiota-based) | MIT | **1.0.0-preview.90** (2026-09-16) | Still in preview. Calling REST directly is simpler and stable. |
| [jmap-jam](https://www.npmjs.com/package/jmap-jam) | JMAP client | MIT | 0.13.8 (2026-09-24) | Only useful for Fastmail or Stalwart-type Accounts later. |

**Rust**

| Crate | Purpose | Licence | Latest | Notes |
| --- | --- | --- | --- | --- |
| [async-imap](https://github.com/chatmail/async-imap) | IMAP client (async) | MIT OR Apache-2.0 | 0.12.0 (2026-09-30) | Maintained by the chatmail (Delta Chat) team; ~854k recent downloads. |
| [imap](https://github.com/jonhoo/rust-imap) | IMAP client (sync) | MIT OR Apache-2.0 | 2.4.1 (2025-02-08) | Older and blocking. |
| [imap-codec](https://github.com/duesee/imap-codec) / [imap-next](https://github.com/duesee/imap-next) | IMAP codec and state machine | MIT OR Apache-2.0 | 1.0.0 (2026-07-19), 2.0.0-alpha.9 / 0.3.4 | Low-level building blocks. |
| [email-lib](https://github.com/pimalaya/core) (Pimalaya, behind the `himalaya` CLI) | IMAP, Maildir, Notmuch and SMTP backends | MIT | 0.27.0 (2026-02-19) | CLI-oriented. |
| [mail-parser](https://github.com/stalwartlabs/mail-parser) | MIME parse | Apache-2.0 OR MIT | 0.11.9 (2026-09-09) | From Stalwart; ~1.6M recent downloads. |
| [mail-builder](https://github.com/stalwartlabs/mail-builder) | MIME build | Apache-2.0 OR MIT | 1.0.0 (2026-09-12) | |
| [lettre](https://github.com/lettre/lettre) / [mail-send](https://crates.io/crates/mail-send) | SMTP send | MIT / Apache-2.0 OR MIT | 0.11.23 (2026-08-03) / 0.6.2 | Only needed if sending over SMTP instead of the APIs. |
| [jmap-client](https://github.com/stalwartlabs/jmap-client) | JMAP | Apache-2.0 OR MIT | 0.4.3 (2026-09-28) | Same caveat as jmap-jam. |

There is no official Microsoft Graph or Gmail SDK for Rust. The REST surface Commander needs is small: list, get, delta and history, modify, send, drafts and attachments.

### 1.4 Licence constraints (because monetization must stay possible)

- **GPL-3.0 (Mailspring-Sync).** The FSF says "Pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs". It also warns that communication "intimate enough, exchanging complex internal data structures" can make the parts one combined work ([GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)). Shipping mailsync beside a closed Commander would at least carry GPL source obligations for mailsync, and the JSON-model coupling leaves some legal doubt.
- **AGPL plus extra terms (Inbox Zero)** and **commercial (EmailEngine v2)** rule out reusing their code.
- **Xapian** (used by notmuch and mu) is GPL v2+ ([xapian.org](https://xapian.org/)).
- **Meilisearch** is "MIT AND BUSL-1.1": its enterprise parts are under the BSL ([LICENSE](https://github.com/meilisearch/meilisearch/blob/main/LICENSE)).
- Every block Commander needs has an MIT, Apache-2.0 or MPL-2.0 option: ImapFlow, postal-mime, Nodemailer, async-imap, mail-parser, mail-builder, Tantivy, SQLite (public domain), DOMPurify (MPL-2.0 OR Apache-2.0), ammonia, TipTap core and Lexical.

## 2. Local storage and full-text search

### 2.1 How big can it get?

The providers' quotas set the upper limit if Commander mirrored everything, attachments included:

- **Gmail:** 15 GB per Google Account, shared with Drive and Photos ([Google One help](https://support.google.com/googleone/answer/9312312?hl=en)).
- **Outlook.com:** 15 GB of mail free, 100 GB with a Microsoft 365 consumer subscription ([Microsoft support](https://support.microsoft.com/en-us/outlook/storage-limits-in-outlook-com)).
- **Exchange Online:** user mailboxes are 100 GB on Business Basic, Standard and Premium and on E3/E5, and 50 GB on E1. Online archives go up to 1.5 TB ([Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits), dated 2026-04-07).

So 3–4 Accounts could in theory be 50–400 GB with attachments. Mirroring everything is the wrong default. Mailspring stores bodies only for the last three months and headers for older mail ([Mailspring-Sync README](https://github.com/Foundry376/Mailspring-Sync)). EmailEngine stores only metadata ([emailengine.app](https://emailengine.app/)).

**Measured: real mail text and its index.** I used the public Enron corpus ([CMU](https://www.cs.cmu.edu/~enron/), 2015-05-07 release): 517,401 files, reduced to **255,170 unique messages** by hashing From, Date, Subject and body. These are plain-text messages from 1999–2002 with attachments stripped.

| Item | Size |
| --- | --- |
| Raw RFC 822 of unique messages | 694 MB (avg ≈ 2.7 KB/message) |
| Extracted text (subject + from + to/cc + body) | 528 M characters |
| SQLite content table holding that text | 627 MB |
| FTS5 index (`porter unicode61`, `detail=full`) | 275 MB (~44% of the content table) |
| Tantivy index (`en_stem`, positions, nothing stored but the id) | 194 MB |

SQLite's documentation reports a similar result: "In one test that indexed a large set of emails (1636 MiB on disk), the FTS index was 743 MiB on disk with detail=full, 340 MiB with detail=column and 134 MiB with detail=none" ([FTS5 docs](https://sqlite.org/fts5.html)).

**Sizing model for Commander.** The per-message figures below are assumptions to be replaced with real counts.

- **Always local:** metadata, plain text and the FTS index. Enron suggests roughly 2.5–4 KB of text and about 1–2 KB of index per message, plus about 1 KB of metadata. Modern mail carries more text, so budget about 5–10 KB per message. For 4 Accounts × 100k messages that is about **2–4 GB**.
- **Cached for a window:** sanitized HTML. Marketing HTML is often ten times the size of its text; I found no primary source for a typical size. A recent window such as 3–12 months, plus anything the User opens, keeps this small.
- **On demand only:** attachments and raw MIME.
- **Measure the author's real numbers** before #15 sets the windows. Gmail `users.getProfile` returns `messagesTotal` and `threadsTotal`, and each message has a `sizeEstimate` ([Gmail discovery](https://gmail.googleapis.com/$discovery/rest?version=v1)). Graph `mailFolder` has `totalItemCount` ([mailFolder](https://learn.microsoft.com/en-us/graph/api/resources/mailfolder)).

### 2.2 SQLite FTS5 vs Tantivy (measured)

**Setup.** Same corpus, same machine (AMD Ryzen AI MAX+ 395, 32 threads, files on tmpfs, so disk I/O is excluded and caches are warm). Each query ran 5 times and the mean is reported. Versions: SQLite 3.53.4 (through Python 3.14.7) and Tantivy 0.26.2 (Rust 1.98.1, release build, 512 MB writer heap). FTS5 used an external-content table (`content='msg'`). Hit counts matched across engines (for example, "power" got 28,915 hits in FTS5 and 28,920 in Tantivy), so tokenization was comparable.

| Configuration | Build | Index size | Ranked top-50 query | Notes |
| --- | --- | --- | --- | --- |
| FTS5 `porter unicode61`, `detail=full` | 20.0 s + 2.4 s `optimize` (single thread) | **275 MB** | "power" 30 ms; `"gas prices"` 9 ms; `california AND energy` 14 ms; "skilling" 6 ms; `meeting NOT lunch` 38 ms; `enron*` (243k hits) 307 ms | Newest-first (`ORDER BY rowid DESC LIMIT 50`): ≤0.1 ms, and 28 ms for `enron*`. Mail search usually sorts by date, which is FTS5's fast path. |
| FTS5 `detail=column` | 14.1 s + 1.6 s | 126 MB | 439–1,444 ms; `enron*` 4,520 ms | **No phrase queries** (error "phrase queries are not supported (detail!=full)"). bm25 ranking is slow. Not recommended. |
| FTS5 `trigram` | 104.9 s + 12.6 s | **1,657 MB** | 20–78 ms; "nron" 368 ms | Substring matching ([FTS5 trigram](https://sqlite.org/fts5.html)), at 6× the size of the porter index. Worth it only for a substring search field such as addresses. |
| Tantivy 0.26.2 `en_stem`, positions | 4.0 s (multithreaded) + 3.7 s merge to 1 segment | **194 MB** | 0.09–0.8 ms for terms and booleans; phrase 2.4 ms; `enron*` 1.2 ms (**not a prefix query**, see the correction below) | About 4× faster on the phrase query, at least 7× faster on every term and boolean query (each FTS5 query took ≥6 ms, each Tantivy one ≤0.8 ms), and ~30% smaller. Per-query ratios weren't recorded. |

**Correction (verification, 2026-10-01).** An earlier version of this table claimed Tantivy was up to 250× faster, based on `enron*` (FTS5 307 ms against Tantivy 1.2 ms). That comparison is invalid. Tantivy 0.26.2's `QueryParser` has no single-term wildcard. It hands `enron*` to the `en_stem` tokenizer, which drops the `*` and produces a plain `TermQuery("enron")`. I confirmed this by running Tantivy 0.26.2: `enron*` parsed to `TermQuery(... "enron")` and did not match "enronoline". The phrase-prefix form `"enron"*` fails with `PhrasePrefixRequiresAtLeastTwoTerms`. A one-word prefix search in Tantivy needs a `RegexQuery` (`allow_regexes()` plus `field:/enron.*/`) or a hand-built query, and that timing was not measured. FTS5 does real prefix queries natively. They can be sped up with `prefix=` indexes, as Geary does with `prefix="2,4,6,8,10"` ([version-030.sql](https://github.com/GNOME/geary/blob/main/sql/version-030.sql)).

**Caveat on "newest-first".** The ≤0.1 ms figure is for `ORDER BY rowid DESC`, and the saved `fts5bench.py` script doesn't include it, so it came from an ad-hoc run. It is fast only because FTS5 can walk its doclists in rowid order. In the benchmark, rowid order was filesystem-walk order, not date order. For Commander to use this fast path, rowids must rise with message date. A newest-first backfill, which inserts old mail last, breaks that unless rowids are assigned on purpose, for example from the timestamp. Otherwise a date-sorted search falls back to sorting every hit.

**Trade-offs.**

- **Use FTS5 by default.**
  - It lives in the same SQLite file and transaction as the mail rows. External-content tables keep text in one place, but "it is the responsibility of the user to ensure" the index and content table stay consistent, typically with triggers ([FTS5 §4.4.3–4.4.4](https://sqlite.org/fts5.html)).
  - Contentless-delete tables (since 3.43.0) let the FTS index exist without a second copy of the text.
  - BM25, `highlight()` and `snippet()` are built in.
  - It is available from both runtimes. Node 24's built-in `node:sqlite` ships with `ENABLE_FTS5`, which I checked locally on v24.20.0. `node:sqlite` is "Stability 1.2 – Release candidate" as of v25.7.0 ([Node docs](https://nodejs.org/api/sqlite.html)). `better-sqlite3` 13.0.3 (MIT, 2026-08-05) is the mature alternative.
- **Tantivy is the faster option.**
  - Features: BM25, phrase queries, stemmers for 17 languages, multithreaded indexing, mmap, and a startup time under 10 ms ([README](https://github.com/quickwit-oss/tantivy)). MIT, latest release 0.26.2 (2026-09-08), active.
  - Costs:
    - It is a second store, a directory of segment files, outside SQLite's transactions, so Commander must re-index after crashes or mismatches.
    - Only one `IndexWriter` can hold the index at a time.
    - It is Rust-native, so a Node stack would need a napi addon or a sidecar.
    - Merges and garbage collection need care. In my run the directory was 594 MB until stale segments were garbage-collected.
    - The default `QueryParser` has no one-word prefix or wildcard search, which type-ahead mail search needs. It has to be built from `RegexQuery` or `PhrasePrefixQuery`.
- **The others don't fit well.**
  - Xapian (notmuch and mu) is GPL.
  - Meilisearch is a server process with BUSL parts.
  - For the Agent's semantic search, `sqlite-vec` (Apache-2.0) sits in the same SQLite file but is "pre-v1, so expect breaking changes" (v0.1.9, 2026-03-31, [README](https://github.com/asg017/sqlite-vec)). LanceDB (Apache-2.0, 0.39.0) is the embedded alternative.
- **Server-side search as a fallback.** Gmail's `q` / `X-GM-RAW` and Graph `$search` can reach mail that was never cached locally.

### 2.3 What other clients use

| Client | Storage | Search |
| --- | --- | --- |
| Mailspring | SQLite. JSON blob plus indexed columns ([README](https://github.com/Foundry376/Mailspring-Sync)) | FTS5 `ThreadSearch`, **one row per thread** (`porter unicode61`). Body text is appended to the thread's row ([constants.h](https://github.com/Foundry376/Mailspring-Sync/blob/master/MailSync/constants.h), [MailProcessor.cpp](https://github.com/Foundry376/Mailspring-Sync/blob/master/MailSync/MailProcessor.cpp)) |
| Geary (GNOME) | SQLite | Moved from FTS3/4 to **FTS5** in schema version 030 ([sql/version-030.sql](https://github.com/GNOME/geary/blob/main/sql/version-030.sql)) |
| Thunderbird (today) | Raw messages in mbox (default) or maildir, plus one Mork `.msf` summary per folder ([folder storage](https://source-docs.thunderbird.net/en/latest/backend/folder_storage.html)) | Gloda: SQLite **FTS3** with the `mozporter` tokenizer ([GlodaDatastore.sys.mjs](https://searchfox.org/comm-central/source/mailnews/db/gloda/modules/GlodaDatastore.sys.mjs)) |
| Thunderbird (Panorama, in progress) | "a single SQLite database with all your messages", which enables a Gmail-style conversation view. Not before the 2026 ESR ([blog, 2025-10-06](https://blog.thunderbird.net/2025/10/video-conversation-view/)). Nightly only, no user-facing parts yet ([Panorama docs](https://source-docs.thunderbird.net/en/latest/panorama/index.html)) | How to do full-text search is listed as an open question |
| notmuch, mu | Maildir on disk | Xapian ([mu README](https://github.com/djcb/mu)) |

## 3. Threading across Gmail and Outlook

**Gmail has real threads.** Every message carries a `threadId` (API) or `X-GM-THRID` (IMAP), "in the same manner as in the Gmail web interface" ([IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions)). For a reply to land in a thread, Gmail requires three things: the `threadId` set on the message or draft, RFC 2822-compliant `References` and `In-Reply-To` headers, and a matching `Subject` ([Gmail threads guide](https://developers.google.com/workspace/gmail/api/guides/threads), updated 2026-09-10). Thread-level reads (`threads.get`) and writes (`threads.modify`) exist ([quota table](https://developers.google.com/workspace/gmail/api/reference/quota)).

**Outlook conversations are weaker:**

- **How `conversationId` is computed.** It comes from `PidTagConversationIndex` (the `Thread-Index` header) when conversation tracking is on. Otherwise it is an **MD5 of the upper-cased conversation topic**, which is the normalized subject ([MS-PST Conversation ID algorithm](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-pst/a19c8e83-bb3b-4061-b027-aa2e82061283)). That algorithm is specified for **PST files**; Microsoft doesn't document it as what Exchange Online returns through Graph. Microsoft's sources also disagree. The EWS article says "Exchange defines conversations based on the **Message-ID** value of the first email message in a thread", with replies referencing it in `References`/`In-Reply-To` ([EWS conversations](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-work-with-conversations-by-using-ews-in-exchange)). The Q&A answer below says Exchange "does not reliably fall back to RFC headers". Treat the real behaviour as unknown until it is tested against real mailboxes.
- **Subject changes split it.** "If the subject of the email thread changes, Exchange applies a new **ConversationTopic** value and new **ConversationIndex** values to the new conversation" ([EWS conversations](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-work-with-conversations-by-using-ews-in-exchange)).
- **Outside replies can split it too.** A Microsoft Q&A answer from a "Microsoft External Staff & Moderator" (2026-05-07; community forum, not reference docs) says replies from Gmail or Yahoo, which carry no `Thread-Index`, can get a **new `conversationId`** even with correct `In-Reply-To`/`References`. It also says `conversationId` is **mailbox-scoped**, and recommends matching `In-Reply-To`/`References` against stored `internetMessageId`s ([Q&A](https://learn.microsoft.com/en-us/answers/questions/5883983/microsoft-graph-webhook-conversationid-changes-whe)).
- **No thread API for user mail.** Graph exposes `conversationId`, `conversationIndex`, `internetMessageId`, `internetMessageHeaders` (only with `$select`) and `uniqueBody` on `message` ([message resource](https://learn.microsoft.com/en-us/graph/api/resources/message)). The Graph `conversation` resource covers **group** mailboxes only (Entra groups subservice, [conversation](https://learn.microsoft.com/en-us/graph/api/resources/conversation)). So "archive this thread" on Outlook means one call per message, which can be batched.

**Generic algorithms.** JWZ threading (the Netscape algorithm, [jwz.org](https://www.jwz.org/doc/threading.html)) and IMAP `THREAD=REFERENCES` / `ORDEREDSUBJECT` ([RFC 5256](https://www.rfc-editor.org/rfc/rfc5256)) build threads from `Message-ID`, `In-Reply-To` and `References` ([RFC 5322 §3.6.4](https://www.rfc-editor.org/rfc/rfc5322)). Mailspring does exactly this: it uses Gmail's thread ID when there is one, and otherwise looks up a `ThreadReference` table keyed on header Message-IDs, checking up to 50 references ([MailProcessor.cpp](https://github.com/Foundry376/Mailspring-Sync/blob/master/MailSync/MailProcessor.cpp)).

**Recommended model.**

- One Commander `Thread` entity per Account.
- Gmail: thread = Gmail `threadId`. Using it as is means thread actions write back correctly.
- Outlook: thread = Commander-computed from RFC 5322 headers (a JWZ-style reference table), with `conversationId` as a merge hint. Thread actions fan out to member messages.
- Replies on both providers set `In-Reply-To`/`References`. On Gmail they also set `threadId`, and on Outlook they keep the subject.
- Threads stay within one Account. A cross-Account "same conversation" view (for example, the User is on both sides) can be a later link on `Message-ID`.

## 4. Safe HTML email rendering

**Threat model.** Incoming HTML can do three things. It can run script, which is XSS into the app and in a desktop shell can mean code execution. It can load remote resources, which reveal the User's IP, location and client, and that the address is active. And it can use CSS to leak data. Thunderbird blocks remote content by default "so that the sender does not get any information about you" ([Thunderbird support](https://support.mozilla.org/en-US/kb/remote-content-in-messages)). I read this page through a search-result extract, because it failed to load directly. Gmail goes further: "Senders can't use image loading to get information about your computer or location", and Gmail checks images for known harmful software ([Gmail help](https://support.google.com/mail/answer/145919?hl=en)). That help page, as fetched on 2026-10-01, doesn't describe the mechanism. Whatever it is runs on Google's servers, and Commander can't copy it without one.

**What a sanitizer does and does not do.** DOMPurify (MPL-2.0 OR Apache-2.0, v3.4.16, 2026-09-23) is a strong XSS sanitizer, but its threat model says: "DOMPurify will **NOT** reliably stop HTML that requests external resources (tracking pixels, prefetch, etc.)". It also says it "is not a CSS sanitizer" and does not stop "CSS-based data exfiltration", and it keeps `<style>` and `style` by default ([threat model](https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model)). Running it outside a browser needs jsdom, and old jsdom versions have known XSS bugs ([README](https://github.com/cure53/DOMPurify)). The browser **HTML Sanitizer API** (`Element.setHTML`) shipped in Chrome 146 and Firefox 148 but not Safari/WebKit ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API), [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/Element.json)). MDN marks it "Limited availability", not Baseline. BCD also notes that `<base>` was not removed from a configuration's allow-list before Chrome 153, and still isn't in Firefox, so it must be forbidden explicitly. That matters if the shell uses WebKitGTK (ticket #7). On the Rust side, [ammonia](https://github.com/rust-ammonia/ammonia) (MIT OR Apache-2.0, 4.2.0) sanitizes to an allow-list, and Cloudflare's [lol_html](https://crates.io/crates/lol_html) (BSD-3-Clause, 3.0.1) can stream-rewrite URLs.

**Layered recipe:**

1. **Parse and sanitize** to an allow-list: no `script`, `iframe`, `object`, `embed`, `form`, `meta refresh`, `base` or event handlers.
2. **Rewrite every URL-bearing spot**: `src`, `srcset`, `background`, `poster`, CSS `url()` in `<style>` and `style=`, `<link>` and `@import`. Turn `cid:` into local blob or data URLs for inline parts. Swap remote images for placeholders until the User allows them, per message or per sender. Treat 1×1 and hidden images as trackers.
3. **Render in `<iframe sandbox srcdoc>` without `allow-scripts`.** An empty `sandbox` "applies all restrictions". Without `allow-same-origin`, the frame gets an opaque origin ([MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)). This also keeps the email's CSS out of the app UI. Mailspring does this with `sandbox="allow-forms allow-same-origin"` plus HTML sanitizing ([email-frame.tsx](https://github.com/Foundry376/Mailspring/blob/master/app/internal_packages/message-list/lib/email-frame.tsx)).
4. **Apply a strict CSP** to the frame: `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`. Relax `img-src` only when the User allows images. Electron lists "Define a Content Security Policy" as checklist item 7, and also says to limit navigation and new windows and not to pass untrusted content to `shell.openExternal` ([Electron security](https://www.electronjs.org/docs/latest/tutorial/security)).
5. **Add a network backstop** in the shell: block every request from the message view that isn't on an allow-list, so a sanitizer bypass still can't phone home.
6. **Handle links:** open them in the system browser only, after showing the real destination.

**Without a server there is no image proxy.** When a User clicks "load images", their own IP address is exposed. That should be the explicit, informed choice. Mailspring's default of `autoloadImages: true` ([config-schema.ts](https://github.com/Foundry376/Mailspring/blob/master/app/src/config-schema.ts)) is the counter-example to avoid.

## 5. Compose without a server

| Need | Gmail | Outlook (Graph) | Building blocks |
| --- | --- | --- | --- |
| Rich text | n/a (client-side) | n/a | [TipTap](https://github.com/ueberdosis/tiptap): MIT core on ProseMirror, but its "Pro Extensions need a valid subscription", so stick to the core. [Lexical](https://github.com/facebook/lexical): MIT, Meta. Email-safe output usually means inlined CSS ([juice](https://www.npmjs.com/package/juice), MIT) and a `text/plain` alternative ([html-to-text](https://www.npmjs.com/package/html-to-text), MIT). |
| Build and send | `messages.send` / `drafts.send` take raw RFC 5322. Max upload **36,700,160 bytes (35 MB)** for send and drafts; `messages.insert`/`import` allow 150 MB ([discovery doc](https://gmail.googleapis.com/$discovery/rest?version=v1)). The resumable upload protocol is available ([uploads](https://developers.google.com/workspace/gmail/api/guides/uploads)). Gmail's user-facing attachment limit is **25 MB**; above it Gmail turns attachments into Drive links ([Gmail help](https://support.google.com/mail/answer/6584?hl=en)). | `sendMail` takes JSON or base64 MIME, with `saveToSentItems` defaulting to true ([sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail)). Microsoft notes that Outlook "does not save messages in MIME format", so MIME from `$value` is regenerated ([MIME doc](https://learn.microsoft.com/en-us/graph/outlook-get-mime-message)). Creating or updating **non-draft** messages from MIME is still a parity gap, targeted for Q4 2026 ([EWS deprecation roadmap](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online)). | Nodemailer MailComposer or mail-builder for MIME. Parse your own sent copy back with postal-mime or mail-parser. |
| Attachments | Inside the raw MIME. Base64 inflates the 35 MB cap by about a third. | Under 3 MB: POST on `attachments`. 3–150 MB: **upload session** in ranges of 4 MB or less ([large attachments](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)). Exchange Online's **default** maximum message size is **35 MB to send and 36 MB to receive**. Admins can raise it to as much as 150 MB, and messages leaving Microsoft's datacentres are capped at 112 MB because of encoding overhead ([limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits), updated 2026-09-09). So in practice, plan for about 35 MB, as with Gmail. There is also a 150 MB per 5 minutes upload throttle. | Local attachment cache keyed by content hash. |
| Drafts sync | `drafts.create`/`update` (needs `gmail.compose` or `gmail.modify`) | Create the message in Drafts, `PATCH`, then `send` | Autosave locally first, then push on a debounce. |
| Signatures | Readable: `users.settings.sendAs[].signature` ("included in messages composed with this alias in the Gmail web UI"), via `gmail.modify` or `gmail.readonly` ([discovery doc](https://gmail.googleapis.com/$discovery/rest?version=v1)) | **Not available.** `mailboxSettings` has no signature field ([mailboxSettings](https://learn.microsoft.com/en-us/graph/api/resources/mailboxsettings)); Microsoft Q&A answers confirm Graph has no signature API ([Q&A](https://learn.microsoft.com/en-us/answers/questions/1315401/get-email-signature-saved-to-an-outlook-account-vi)). The **beta** `userConfiguration` API reads folder-associated configuration items ([userConfiguration get, beta](https://learn.microsoft.com/en-us/graph/api/userconfiguration-get?view=graph-rest-beta)). In principle that could reach where OWA stores settings, but no source documents it for signatures, and beta APIs aren't supported in production. | Commander-owned signatures per Account and alias. Import Gmail's once. |
| Send-later | **No API support.** The Gmail v1 discovery document (revision 20260928) has no scheduling parameter or method. Commander must hold the message and send it at the chosen time, so a Commander process has to be running then. | `PidTagDeferredSendTime` (0x3FEF, `PT_SYSTIME`), "a time when a client would like to defer sending a message" ([MAPI doc](https://learn.microsoft.com/en-us/office/client-developer/outlook/mapi/pidtagdeferredsendtime-canonical-property)). It can be set through Graph `singleValueExtendedProperties` (`"SystemTime 0x3FEF"`), as shown in a Microsoft 365 PnP community sample ([PnP sample](https://pnp.github.io/script-samples/graph-delay-message-delivery/README.html)). The sample itself says "The mail API in the Microsoft Graph doesn't expose any properties to defer sending a message." There is official, but archived, evidence that Exchange honours the property server-side. Microsoft's EWS Managed API article "Delay sending an email message" sets `PR_DEFERRED_SEND_TIME` and says the message "will be available in the caller's Outbox folder" until it is sent. It applies to Office 365 and Exchange Online as well as on-premises Exchange ([EWS article, 2013, archived](https://learn.microsoft.com/en-us/previous-versions/office/developer/exchange-server-2010/jj220496(v=exchg.80))). **Through Graph this is still undocumented, so test it on both Microsoft 365 and Outlook.com before relying on it.** | Durable local outbox table plus a scheduler in the background Agent process. |
| Undo-send | Gmail's own undo is a 5/10/20/30 s cancellation window before sending ([Gmail help](https://support.google.com/mail/answer/2819488?hl=en)). | Same approach. | Local hold queue: write to the outbox, wait N seconds, then call send. Mimestream does this as "⌘Z to undo send and reopen the draft" ([mimestream.com](https://mimestream.com/)). |
| Sent copy | The `SENT` label is "applied automatically to messages that are sent with `drafts.send` or `messages.send`" ([Gmail labels guide](https://developers.google.com/workspace/gmail/api/guides/labels)). | `saveToSentItems` (default true). | If SMTP is ever used, don't add a duplicate Sent copy. Mailspring only just fixed this: "Stop leaving duplicate Sent copies on servers that file their own (#150)", 2026-09-30 ([commits](https://github.com/Foundry376/Mailspring-Sync/commits/master)). |

**Scopes.** On Gmail, `gmail.modify` covers sync, send, drafts and reading signatures. It is a **restricted** scope: it needs restricted-scope verification, and a security assessment "if you store restricted scope data on servers (or transmit)" ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), updated 2026-09-10). A local-only Commander may avoid the assessment but not the verification. Ticket #2 owns the details.

## 6. Prior art: how existing clients are built

- **Mailspring** (GPL-3.0, Electron UI plus the C++ mailsync above).
  - One sync process per Account, so auth or connection failures can "simply terminate the process".
  - Tasks are split into a local part (applied to SQLite at once, so the UI updates) and a retryable remote part.
  - Every DB change is broadcast to the UI as JSON deltas for reactive queries.
  - Two IMAP connections: a background worker (CONDSTORE or scan) and a foreground worker (IDLE plus on-demand body fetches).
  - Bodies for 3 months only. Stable IDs from header hashes, which can rarely collide.
  - Metadata such as read receipts syncs through `id.getmailspring.com`. That is a server dependency Commander doesn't want.
  - Sources: [README](https://github.com/Foundry376/Mailspring-Sync), [main repo](https://github.com/Foundry376/Mailspring).
- **Thunderbird** (MPL-2.0).
  - Per-folder mbox or maildir plus Mork `.msf`, and gloda FTS3 for global search, now being replaced by **Panorama**, one SQLite DB ([source docs](https://source-docs.thunderbird.net/en/latest/backend/folder_storage.html)).
  - Protocol support is being rebuilt behind a new extensible architecture: EWS took 11 months and **Microsoft Graph took 4**. Graph mail support shipped in **Thunderbird 154** (2026-09-02), mail only, with calendar to follow, and Microsoft 365 users on EWS "will need to switch" before EWS shuts off ([Thunderbird blog](https://blog.thunderbird.net/2026/09/thunderbird-desktop-new-protocol-support-microsoft-graph-api/)).
  - Takeaway: even Thunderbird is moving Microsoft 365 to Graph and storage to one SQLite file.
- **Mimestream** (closed source, macOS, Swift).
  - Gmail-only, on the Gmail API: "only stores your data and tokens on your device … direct connections to the Gmail API, without going through any intermediary sync service" ([mimestream.com](https://mimestream.com/)).
  - Microsoft 365, IMAP and JMAP are planned but not shipped ([FAQ](https://mimestream.com/faqs)).
  - It is the closest match to Commander's "no server" model, and it shows that a full-featured API client with undo-send, snooze, filters and aliases is possible without a backend.
- **Geary** (LGPL-2.1, Vala): IMAP plus SQLite with FTS5 ([schema](https://github.com/GNOME/geary/blob/main/sql/version-030.sql)).
- **notmuch and mu**: maildir plus a Xapian index. Fast and proven at scale, but GPL, and they assume a separate tool (mbsync, offlineimap) does the sync.
- **EmailEngine, Inbox Zero, Zero**: server-shaped (Redis, Postgres, webhooks). They show the feature set an AI email assistant needs, but their architecture assumes a public server, which Commander does not have.

## Implications for the decisions

### #12 Tech stack and local database

- **Build a custom sync layer for each Source. Don't adopt an engine.** Gmail goes through the Gmail API and Outlook through Graph, with REST called directly, since the new Graph TypeScript SDK is still `preview.90` and the old one hasn't been released since 2023. Copy Mailspring's process shape: an isolated sync worker per Account, tasks with local and remote halves, and change events pushed to the UI. Keep the provider APIs behind one internal "mail Source" interface so IMAP (and later JMAP) can slot in.
- **Use one SQLite database (WAL) as the local store, with FTS5 for search.** External-content or contentless-delete tables avoid duplicating text, `porter unicode61` with `detail=full` handles words, and a small trigram table can cover address and substring search if wanted. The measured numbers are fine for 3–4 Accounts. FTS5 also gives prefix search for type-ahead, which Tantivy's default parser does not. Assign rowids so they rise with message date (for example, derived from the timestamp). Then date-sorted search stays on FTS5's fast path even though backfill inserts older mail last. Put search behind an interface so Tantivy can be added later if ranked search over 1M+ messages proves slow. Reach for Tantivy now only if the stack is Rust anyway, and plan for rebuilding it from SQLite.
- **Language does not block anything.** Both Node and Rust have mature MIT or Apache options for parsing (postal-mime, mail-parser), building (Nodemailer, mail-builder), IMAP if needed (ImapFlow, async-imap) and SQLite FTS5 (`node:sqlite` or better-sqlite3, rusqlite). The real differences:
  - Tantivy, ammonia and lol_html are native to Rust.
  - DOMPurify and the Sanitizer API are native to the renderer.
  - The Node mail libraries mostly depend on one maintainer.
- **The shell must allow a long-running background process (ties to #7).** Polling sync, the Gmail send-later scheduler and Agent processing all need Commander alive, ideally as a tray or background process.
- **Shell security requirements (ties to #7):** a sandboxed iframe, a CSP, and per-request network blocking for the message view. If the shell is WebKit-based, the Sanitizer API isn't available, so DOMPurify or ammonia is needed either way.
- **Licensing:** keep GPL, AGPL and commercial code (Mailspring-Sync, Inbox Zero, EmailEngine, Xapian) out of the product. Everything needed exists under MIT, Apache or MPL.
- **Watch the Gmail quota change:** per-project charges above 80M units a day are planned for later in 2026, with "at least 90 days' notice". All Users of one OAuth client count against the same project.
- **Choose API-only or API-plus-IMAP before verification.** Adding IMAP IDLE on Gmail means requesting `https://mail.google.com/` (full access) as well as `gmail.modify`. On Outlook it means a second token audience (`outlook.office.com`). If v1 uses polling only, Commander needs just `gmail.modify` and Graph `Mail.ReadWrite`/`Mail.Send`.

### #15 Email client: what's in v1

- **Safe for v1:**
  - Reading, threading and Triage (archive, move or label, read, star, trash) across 3–4 Gmail and Outlook Accounts.
  - Local FTS5 search over all synced text, with server-side search as a fallback.
  - Compose, reply and forward with attachments, with drafts synced to the provider.
  - Commander-owned signatures.
  - Undo-send as a local hold.
  - Remote images blocked by default, with per-message and per-sender allow.
- **Needs an explicit scope call:**
  - **Send-later.** For Gmail it works only while Commander is running (no API). For Outlook, Exchange may hold it server-side through `PidTagDeferredSendTime`, but this needs testing. Options: ship it with a "Commander must be running" note, ship it for Outlook only, or defer it.
  - **Offline history depth.** Gmail costs about 300 messages a minute to backfill, so pick what to sync at first run (for example, 12 months of bodies and all headers) and backfill the rest.
  - **Real-time arrival.** Polling plus optional IMAP IDLE is the only server-free push. IDLE costs a broader Gmail scope and a second Outlook token. Choose a polling cadence (ties to the map's "Source sync design").
  - **Attachment size.** Plan for about 35 MB per message on both providers. That is Gmail's API upload cap and Exchange Online's default send limit, and base64 encoding uses up about a third of it.
  - **Attachment storage.** On demand only, never a mirror.
- **Recovery is a v1 requirement:** after Commander has been off for more than a week, Gmail history can 404 and Graph delta tokens can expire, so a full re-sync path must ship in v1.
- **Thread semantics on Outlook won't match Outlook's own UI** in edge cases (subject changes, outside replies), because Commander will thread by headers. Decide whether that is acceptable or whether Outlook `conversationId` should win.

## Sources

Provider APIs and policies
- Gmail API sync guide: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail API threads guide: https://developers.google.com/workspace/gmail/api/guides/threads
- Gmail API labels guide (SENT label): https://developers.google.com/workspace/gmail/api/guides/labels
- Gmail API sending guide: https://developers.google.com/workspace/gmail/api/guides/sending
- Gmail API usage limits (quota, planned charges): https://developers.google.com/workspace/gmail/api/reference/quota
- Gmail API batch guide: https://developers.google.com/workspace/gmail/api/guides/batch
- Gmail API uploads: https://developers.google.com/workspace/gmail/api/guides/uploads
- Gmail API push notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail API discovery document (revision 20260928): https://gmail.googleapis.com/$discovery/rest?version=v1
- users.messages.send reference: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- Gmail IMAP extensions: https://developers.google.com/workspace/gmail/imap/imap-extensions
- Gmail IMAP/SMTP XOAUTH2 (scope `https://mail.google.com/`): https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
- Gmail bandwidth limits: https://knowledge.workspace.google.com/admin/gmail/gmail-bandwidth-limits?hl=en
- Google Workspace less-secure-apps transition: https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth
- Gmail image handling: https://support.google.com/mail/answer/145919?hl=en
- Gmail attachment limits: https://support.google.com/mail/answer/6584?hl=en
- Gmail unsend: https://support.google.com/mail/answer/2819488?hl=en
- Google Account storage: https://support.google.com/googleone/answer/9312312?hl=en
- Graph delta query for messages: https://learn.microsoft.com/en-us/graph/delta-query-messages
- Graph delta query overview (token expiry): https://learn.microsoft.com/en-us/graph/delta-query-overview
- Graph throttling limits (Outlook include): https://learn.microsoft.com/en-us/graph/throttling-limits , https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/includes/throttling-outlook.md
- Graph list messages: https://learn.microsoft.com/en-us/graph/api/user-list-messages
- Graph message resource: https://learn.microsoft.com/en-us/graph/api/resources/message
- Graph conversation resource (groups): https://learn.microsoft.com/en-us/graph/api/resources/conversation
- Graph mailFolder resource: https://learn.microsoft.com/en-us/graph/api/resources/mailfolder
- Graph mailboxSettings resource: https://learn.microsoft.com/en-us/graph/api/resources/mailboxsettings
- Graph sendMail: https://learn.microsoft.com/en-us/graph/api/user-sendmail
- Graph large attachments: https://learn.microsoft.com/en-us/graph/outlook-large-attachments
- Graph MIME content: https://learn.microsoft.com/en-us/graph/outlook-get-mime-message
- Graph change notifications (webhooks): https://learn.microsoft.com/en-us/graph/change-notifications-overview , https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- Microsoft IMAP/POP/SMTP OAuth: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
- Outlook.com modern-auth requirement: https://support.microsoft.com/en-us/support/known-issues/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-ap
- Exchange Online SMTP AUTH basic-auth timeline (Exchange Team blog): https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835
- EWS deprecation in Exchange Online: https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online
- Exchange Online limits: https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits
- Outlook.com storage limits: https://support.microsoft.com/en-us/outlook/storage-limits-in-outlook-com
- MS-PST Conversation ID algorithm: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-pst/a19c8e83-bb3b-4061-b027-aa2e82061283
- EWS conversations: https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-work-with-conversations-by-using-ews-in-exchange
- Microsoft Q&A on conversationId changes (community forum, moderator answer, 2026-05-07): https://learn.microsoft.com/en-us/answers/questions/5883983/microsoft-graph-webhook-conversationid-changes-whe
- PidTagDeferredSendTime: https://learn.microsoft.com/en-us/office/client-developer/outlook/mapi/pidtagdeferredsendtime-canonical-property
- PnP sample, delayed delivery via Graph (community sample): https://pnp.github.io/script-samples/graph-delay-message-delivery/README.html
- Delay sending an email message with the EWS Managed API (archived Microsoft doc, 2013): https://learn.microsoft.com/en-us/previous-versions/office/developer/exchange-server-2010/jj220496(v=exchg.80)
- Graph userConfiguration (beta): https://learn.microsoft.com/en-us/graph/api/userconfiguration-get?view=graph-rest-beta
- Microsoft Q&A on Outlook signatures via API (community forum): https://learn.microsoft.com/en-us/answers/questions/1315401/get-email-signature-saved-to-an-outlook-account-vi

Standards
- RFC 5256 (IMAP SORT and THREAD): https://www.rfc-editor.org/rfc/rfc5256
- RFC 5322 (Internet Message Format): https://www.rfc-editor.org/rfc/rfc5322
- JWZ message threading: https://www.jwz.org/doc/threading.html
- JMAP software list: https://jmap.io/software/index.html
- GPL FAQ, mere aggregation: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation

Engines, libraries and clients (repos; activity and releases from the GitHub, crates.io and npm APIs, 2026-10-01)
- Mailspring-Sync: https://github.com/Foundry376/Mailspring-Sync (README; MailSync/main.cpp; MailSync/constants.h; MailSync/MailProcessor.cpp; commits)
- Mailspring: https://github.com/Foundry376/Mailspring (app/internal_packages/message-list/lib/email-frame.tsx; app/src/config-schema.ts)
- EmailEngine: https://emailengine.app/ , https://github.com/postalsys/emailengine/blob/master/LICENSE_EMAILENGINE.txt
- ImapFlow: https://github.com/postalsys/imapflow
- mailparser: https://github.com/nodemailer/mailparser
- postal-mime: https://github.com/postalsys/postal-mime
- Nodemailer: https://github.com/nodemailer/nodemailer
- Microsoft Graph TypeScript SDK (preview): https://github.com/microsoftgraph/msgraph-sdk-typescript
- googleapis (npm): https://www.npmjs.com/package/googleapis
- jmap-jam (npm): https://www.npmjs.com/package/jmap-jam
- async-imap: https://github.com/chatmail/async-imap
- rust-imap: https://github.com/jonhoo/rust-imap
- imap-codec / imap-next: https://github.com/duesee/imap-codec , https://github.com/duesee/imap-next
- Pimalaya email-lib: https://github.com/pimalaya/core
- mail-parser / mail-builder / jmap-client (Stalwart): https://github.com/stalwartlabs/mail-parser , https://github.com/stalwartlabs/mail-builder , https://github.com/stalwartlabs/jmap-client
- lettre: https://github.com/lettre/lettre ; mail-send: https://crates.io/crates/mail-send
- Inbox Zero: https://github.com/elie222/inbox-zero (LICENSE)
- Zero / Mail0: https://github.com/Mail-0/Zero
- Geary: https://github.com/GNOME/geary (sql/version-030.sql)
- mu: https://github.com/djcb/mu ; Xapian: https://xapian.org/
- Meilisearch licence: https://github.com/meilisearch/meilisearch/blob/main/LICENSE
- sqlite-vec: https://github.com/asg017/sqlite-vec ; LanceDB: https://github.com/lancedb/lancedb
- Thunderbird folder storage: https://source-docs.thunderbird.net/en/latest/backend/folder_storage.html
- Thunderbird Panorama: https://source-docs.thunderbird.net/en/latest/panorama/index.html
- Thunderbird gloda datastore: https://searchfox.org/comm-central/source/mailnews/db/gloda/modules/GlodaDatastore.sys.mjs
- Thunderbird blog, conversation view and Panorama (2025-10-06): https://blog.thunderbird.net/2025/10/video-conversation-view/
- Thunderbird blog, Microsoft Graph support (2026-09-02): https://blog.thunderbird.net/2026/09/thunderbird-desktop-new-protocol-support-microsoft-graph-api/
- Thunderbird remote content: https://support.mozilla.org/en-US/kb/remote-content-in-messages
- Mimestream: https://mimestream.com/ , https://mimestream.com/faqs

Storage and search
- SQLite FTS5: https://sqlite.org/fts5.html
- Node.js node:sqlite: https://nodejs.org/api/sqlite.html
- Tantivy: https://github.com/quickwit-oss/tantivy (query parser and grammar source as published in tantivy 0.26.2 / tantivy-query-grammar 0.26.0 on crates.io)
- Enron email corpus (benchmark input): https://www.cs.cmu.edu/~enron/
- Benchmark: my own run on the author's machine, 2026-10-01 (method in §2.2). This is first-hand measurement on a public corpus. The scripts aren't committed but are short to recreate: dedupe by SHA-1 of From|Date|Subject|body; FTS5 external-content table; Tantivy `en_stem` with `WithFreqsAndPositions`, merged to one segment and garbage-collected.

HTML rendering and compose
- DOMPurify README and threat model: https://github.com/cure53/DOMPurify , https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model
- HTML Sanitizer API (MDN) and browser-compat-data: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API , https://github.com/mdn/browser-compat-data/blob/main/api/Element.json
- iframe element (MDN): https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- ammonia: https://github.com/rust-ammonia/ammonia ; lol_html: https://crates.io/crates/lol_html
- TipTap: https://github.com/ueberdosis/tiptap ; Lexical: https://github.com/facebook/lexical
- juice: https://www.npmjs.com/package/juice ; html-to-text: https://www.npmjs.com/package/html-to-text

## Verification

An adversarial fact-check on 2026-10-01. Every source below was re-opened that day.

### Checked and confirmed

- **Gmail quota page** (updated 2026-09-10):
  - 6,000 units per minute per user per project, and 1,200,000 per minute per project.
  - Costs: `messages.get` 20, `messages.list` 5, `threads.get` 40, `history.list` 2, `messages.send`/`drafts.send` 100, `messages.attachments.get` 20.
  - An 80,000,000-unit daily threshold per project, with "full billing details later in 2026 with at least 90 days' notice". The threshold can't be raised.
- **Gmail guides** (updated 2026-09-15):
  - Sync guide: history is "typically available for at least one week", and a stale ID gives HTTP 404.
  - Push guide: a Pub/Sub topic, `watch` renewed at least every 7 days, pull subscriptions allowed.
- **Gmail scopes** (updated 2026-09-10): `gmail.modify`, `gmail.readonly` and `gmail.compose` are restricted. A security assessment applies "if you store restricted scope data on servers (or transmit)".
- **Gmail discovery document** (revision 20260928):
  - Upload cap of 36,700,160 bytes for `messages.send` and `drafts.create`/`update`/`send`, and 157,286,400 bytes for `insert`/`import`.
  - No scheduling parameter or method.
  - `SendAs.signature` description matches.
  - `Profile` has `messagesTotal`/`threadsTotal`.
- **Gmail help and policy pages:**
  - Bandwidth limits: 2,500 MB/day IMAP download (updated 2026-09-30).
  - 25 MB attachment limit, with Drive links above it.
  - Undo send: 5/10/20/30 s.
  - Threads guide: `threadId`, RFC 2822 `References`/`In-Reply-To` and a matching `Subject`.
- **EWS deprecation page** (updated 2026-09-04): "October 2026: EWS starts to be disabled globally", "April 2027: EWS is fully disabled". The parity roadmap lists "Non-draft MIME update/creation", Q4 CY2026.
- **Graph documentation:**
  - Outlook throttling: 10,000 requests per 10 minutes, four concurrent requests, and 150 MB of uploads per 5 minutes, per app per mailbox.
  - Delta: per folder, `$search` not supported, `@removed`, Outlook token lifetime "isn't fixed".
  - Webhooks: a publicly accessible HTTPS endpoint, or Event Hubs / Event Grid.
  - List messages: `$top` from 1 to 1000, with a 504 risk.
  - Large attachments: under 3 MB a single POST, 3–150 MB an upload session, keep ranges under 4 MB.
  - MIME doc: Outlook "does not save" messages as MIME.
  - `mailboxSettings`: no signature property.
- **Microsoft auth:**
  - IMAP OAuth works for Microsoft 365 and Outlook.com.
  - Outlook.com basic auth ended 16 Sept 2024.
- **Mailbox sizes:**
  - Exchange Online user mailboxes: 100 GB, or 50 GB on E1.
  - Outlook.com: 15 GB free, 100 GB for Microsoft 365 subscribers.
- **IMAP `CAPABILITY`:** re-probed both servers before login. The results match the doc character for character.
- **Repos and packages:**
  - Licences, versions and dates for all npm packages and crates in §1.3 match the npm and crates.io APIs. ImapFlow's GitHub licence shows NOASSERTION, but its `LICENSE.txt` and npm both say MIT.
  - Mailspring-Sync: GPL-3.0, 625 of 670 commits by one author, last push 2026-09-30, and Mailspring 1.25.0 released 2026-09-19.
  - EmailEngine: v2.81.2 on 2026-09-27, 14-day trial, "ceases to operate" without a key, $1,450 / €1,200 a year, Redis required.
  - Inbox Zero: AGPL plus extra terms that restrict monetization and require a licence at 5+ users.
  - Zero's last default-branch commit: 2025-08-31.
  - sqlite-vec v0.1.9 (2026-03-31) and its "pre-v1" warning.
  - Tantivy 0.26.2 on crates.io (2026-09-08). The latest GitHub *release* tag is 0.26.1, but crates.io has 0.26.2.
- **Search and runtimes:**
  - `node:sqlite` is "1.2 Release candidate" as of v25.7.0. FTS5 confirmed working in local Node v24.20.0 (`ENABLE_FTS5`, SQLite 3.53.4).
  - The FTS5 documentation's 1636/743/340/134 MiB quote and contentless-delete "as of version 3.43.0" match.
  - Geary schema 030 converts FTS3/4 to FTS5.
- **HTML and prior art:**
  - DOMPurify threat-model quotes match.
  - Sanitizer API: Chrome 146 and Firefox 148 support it, Safari doesn't.
  - Electron checklist item 7 is CSP.
  - Mailspring uses `autoloadImages: true` and `sandbox="allow-forms allow-same-origin"`.
  - Thunderbird blog: Graph in version 154 (2026-09-02), mail only, EWS took 11 months and Graph 4. Panorama is not before the 2026 ESR.
  - Mimestream FAQ: Gmail only, with Microsoft 365, IMAP and JMAP planned.

### Corrected

1. **Tantivy speed-up and the `enron*` row (§2.2, Short answer).** The claim that Tantivy was "4–250×" faster rested on `enron*`. Tantivy's `QueryParser` turns that into a plain term query, not a prefix query. I confirmed this by running Tantivy 0.26.2 and reading its grammar source. The claim is now "~4× (phrase) to ≥7× (terms and booleans)", with a correction note. I also added that Tantivy's default parser has no single-word prefix search, while FTS5 does.
2. **Newest-first caveat added.** The ≤0.1 ms figure depends on rowid order, which was filesystem order in the benchmark, not date order. The measurement isn't in the saved script. Commander must assign rowids that rise with date.
3. **Exchange Online message size.** "150 MB for Outlook" was the admin-configurable maximum. The default is 35 MB to send and 36 MB to receive, with 112 MB when mail leaves Microsoft's datacentres.
4. **Google basic-auth end date.** It applies to "all Google Accounts", not only Workspace.
5. **IMAP IDLE cost added.** Gmail IMAP requires the full `https://mail.google.com/` scope. Outlook IMAP needs a separate `IMAP.AccessAsUser.All` token, and admins can disable IMAP.
6. **Gmail image proxy wording.** The Gmail help page no longer mentions a proxy, so the doc now quotes only what the page says.
7. **Outlook `conversationId`.** The MS-PST algorithm is specified for PST files, not for Graph. The EWS article, which says conversations are defined by the first message's Message-ID, contradicts the Q&A answer. Both points are now flagged.
8. **Outlook send-later strengthened.** Added Microsoft's archived EWS article, which shows Exchange and Office 365 holding a `PR_DEFERRED_SEND_TIME` message in the Outbox. Graph support is still undocumented.
9. **EmailEngine licence.** The reason for "No" is now quoted from the licence: "non-transferable", with keys reusable only "within the purchasing organization".
10. **Graph delta additions.** Added `$orderby=receivedDateTime desc` and `$filter=receivedDateTime ge`, which returns at most 5,000 messages. Added `410 Gone` and `syncStateNotFound` as the resync signals.
11. **Smaller additions.** The Sanitizer API `<base>` allow-list caveat, and a note on the beta Graph `userConfiguration` API for signatures.

### Could not confirm

- **`PidTagDeferredSendTime` through Graph `sendMail`.** It is documented only via a community sample and an archived EWS article. It is untested on Outlook.com consumer accounts.
- **Whether Graph `conversationId` follows the MS-PST algorithm, and how it handles outside replies.** Microsoft sources conflict. Only live testing will settle it.
- **Whether consumer Gmail has the same 2,500 MB/day IMAP cap.** The page covers Workspace editions.
- **Typical modern HTML body size.** Still no primary source. The sizing model in §2.1 remains an assumption.
- **The FTS5 newest-first timings and the Tantivy per-query breakdown.** These came from runs whose output wasn't saved. The corpus has been deleted, so I couldn't re-run the benchmark. Only the scripts in `/tmp/emailbench` and the Tantivy query-parsing behaviour were re-checked.
- **Whether the beta `userConfiguration` API can read Outlook signatures.** Not tested.
