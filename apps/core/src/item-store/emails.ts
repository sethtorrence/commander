import {
  addressName,
  EMAIL_VIEWS,
  type EmailBody,
  type EmailDetail,
  type EmailFixedView,
  type EmailLabel,
  type EmailListView,
  type EmailSearchQuery,
  type EmailSearchResult,
  type EmailThread,
  type EmailThreadList,
  type EmailThreadQuery,
  type EmailThreadSummary,
  type EmailViewCounts,
  type EmailViewQuery,
  emailSearchMatches,
  emailSearchQuery,
  emailThreadQuery,
  emailViewQuery,
  flagsInView,
  gmailCatalog,
  type Item,
  isPickableLabel,
  parseEmailSearch,
  type sourceItem,
  type ThreadFlags,
  type ThreadingMessage,
  threadFlagsOf,
  threadingOf,
  threadMessages,
  threadSnoozedUntil,
} from '@commander/domain';
import { and, asc, desc, eq, inArray, isNull, lte, type SQL, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import type { Search } from '../search';
import type { ItemRow } from './rows';
import * as schema from './schema';

// Emails in the Item store: their detail (with what thread lists and threading look up in columns),
// the Message-IDs each names (for threading mail among what is held), their bodies kept beside the
// Item (never in its detail or the activity log), and the Email Section's reads (a view's threads,
// each view's counts, Section search, the labels to pick from, and one thread with its bodies), and
// the snoozes due (#135). Which view a thread is in is the domain's rule (flagsInView), over flags
// aggregated here per thread. Threading runs as mail is saved: whatever order mail
// comes in (the first sync downloads newest first, so replies before their parents), each email is
// threaded among the Account's live mail it is connected to, and mail already held that a new
// message joins to another thread moves to it (domain threadMessages).

type Db = BetterSQLite3Database<typeof schema>;
// A Source Item as a batch holds it once parsed.
type SourceItem = z.output<typeof sourceItem>;

// The most of a thread list one read returns.
const THREADS_MAX = 500;
// SQLite's limit on bound parameters is generous, but lists are read in chunks of this many.
const CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}

const mentionedIds = (detail: EmailDetail) => [
  ...new Set([detail.messageId, detail.inReplyTo, ...detail.references].filter((id): id is string => !!id)),
];

const VIEW_NAMES: Record<EmailFixedView, string> = {
  inbox: 'Inbox',
  starred: 'Starred',
  snoozed: 'Snoozed',
  archive: 'Archive',
  trash: 'Trash',
};
// The most messages Section search reads when no words narrow it (operators only).
const SEARCH_SCAN_MAX = 5000;
// The most messages the word index hands Section search.
const SEARCH_HITS_MAX = 200;
// Joins the label ids a thread's aggregate lists (the unit separator, never in a Gmail label id).
const SEPARATOR = '\u001f';

// A thread as the views read it: its flags (see threadFlagsOf), unread messages, and when it sorts.
type ThreadRow = ThreadFlags & {
  account: string;
  threadKey: string;
  unread: number;
  // Its latest message, or when it came back from a snooze if later: the inbox sorts by this.
  sortAt: number;
};

export function emailsIn(
  db: Db,
  {
    withDetails,
    now,
    search,
  }: { withDetails: (rows: ItemRow[]) => Item[]; now: () => number; search: () => Search },
) {
  const { emailDetails, emailMessageIds, emailBodies, items } = schema;

  function readDetails(itemIds: string[]): Map<string, EmailDetail> {
    const details = new Map<string, EmailDetail>();
    for (const ids of chunks(itemIds)) {
      for (const row of db.select().from(emailDetails).where(inArray(emailDetails.itemId, ids)).all()) {
        details.set(row.itemId, { kind: 'email', ...row.data });
      }
    }
    return details;
  }

  function writeDetail(itemId: string, detail: EmailDetail | null) {
    if (!detail) {
      db.delete(emailDetails).where(eq(emailDetails.itemId, itemId)).run();
      db.delete(emailMessageIds).where(eq(emailMessageIds.itemId, itemId)).run();
      return;
    }
    const { kind: _kind, ...data } = detail;
    const values = {
      messageId: detail.messageId,
      threadKey: detail.threadKey,
      sourceThreadId: detail.sourceThreadId,
      sentAt: detail.sentAt,
      unread: !detail.read,
      inInbox: detail.inInbox,
      hasAttachments: detail.attachments.some((attachment) => !attachment.inline),
      inTrash: detail.inTrash ?? false,
      snoozedUntil: detail.snooze && !detail.snooze.returned ? detail.snooze.until : null,
      returnedFrom: detail.snooze?.returned ? detail.snooze.until : null,
      data,
    };
    db.insert(emailDetails)
      .values({ itemId, ...values })
      .onConflictDoUpdate({ target: emailDetails.itemId, set: values })
      .run();
    const wanted = mentionedIds(detail);
    const present = db
      .select({ messageId: emailMessageIds.messageId })
      .from(emailMessageIds)
      .where(eq(emailMessageIds.itemId, itemId))
      .all()
      .map((row) => row.messageId);
    const gone = present.filter((id) => !wanted.includes(id));
    if (gone.length) {
      db.delete(emailMessageIds)
        .where(and(eq(emailMessageIds.itemId, itemId), inArray(emailMessageIds.messageId, gone)))
        .run();
    }
    const added = wanted.filter((id) => !present.includes(id));
    if (added.length)
      db.insert(emailMessageIds)
        .values(added.map((messageId) => ({ itemId, messageId })))
        .run();
  }

  // The live emails of an Account, as Items, matching `where` on email_details (joined as `e`).
  function liveEmails(source: string, account: string, where: SQL | undefined): Item[] {
    const rows = db
      .select({ item: items })
      .from(items)
      .innerJoin(emailDetails, eq(emailDetails.itemId, items.id))
      .where(
        and(
          eq(items.source, source as Item['source'] & string),
          eq(items.account, account),
          isNull(items.deletedAt),
          where,
        ),
      )
      .all();
    return withDetails(rows.map((row) => row.item));
  }

  /**
   * Gives a batch's emails their thread keys among the Account's live mail, and returns the held
   * emails that move to another thread because of them (as Source Items to save alongside).
   */
  function thread(
    source: string,
    account: string,
    incoming: SourceItem[],
  ): { items: SourceItem[]; moved: SourceItem[] } {
    const emails = incoming.filter((item) => item.detail?.kind === 'email');
    if (!emails.length) return { items: incoming, moved: [] };
    const detailOf = (item: SourceItem) => item.detail as EmailDetail;

    // The held mail they connect to: sharing a Message-ID, or a Source thread, and then every message
    // of those threads, so whole threads are judged together.
    const ids = [...new Set(emails.flatMap((item) => mentionedIds(detailOf(item))))];
    const sourceThreads = [
      ...new Set(
        emails.flatMap((item) =>
          detailOf(item).sourceThreadId ? [detailOf(item).sourceThreadId as string] : [],
        ),
      ),
    ];
    const externalIds = emails.map((item) => item.externalId);
    const related = new Map<string, Item>();
    const add = (found: Item[]) => {
      for (const item of found) related.set(item.id, item);
    };
    for (const chunk of chunks(ids)) {
      const byId = db
        .selectDistinct({ itemId: emailMessageIds.itemId })
        .from(emailMessageIds)
        .where(inArray(emailMessageIds.messageId, chunk))
        .all()
        .map((row) => row.itemId);
      for (const itemIds of chunks(byId))
        add(liveEmails(source, account, inArray(emailDetails.itemId, itemIds)));
    }
    for (const chunk of chunks(sourceThreads))
      add(liveEmails(source, account, inArray(emailDetails.sourceThreadId, chunk)));
    for (const chunk of chunks(externalIds))
      add(liveEmails(source, account, inArray(items.externalId, chunk)));
    const keys = [
      ...new Set(
        [...related.values()].flatMap((item) =>
          item.detail?.kind === 'email' ? [item.detail.threadKey] : [],
        ),
      ),
    ];
    for (const chunk of chunks(keys))
      add(liveEmails(source, account, inArray(emailDetails.threadKey, chunk)));

    const held = new Map(
      [...related.values()].flatMap((item) =>
        item.externalId && item.detail?.kind === 'email' ? [[item.externalId, item] as const] : [],
      ),
    );
    const messages: ThreadingMessage[] = [];
    const arriving = new Set(externalIds);
    for (const item of emails) {
      const before = held.get(item.externalId);
      const kept = before?.detail?.kind === 'email' ? before.detail.threadKey : null;
      messages.push({ ...threadingOf(item.externalId, detailOf(item)), threadKey: kept });
    }
    for (const [externalId, item] of held) {
      if (!arriving.has(externalId) && item.detail?.kind === 'email')
        messages.push(threadingOf(externalId, item.detail));
    }
    const threadKeys = threadMessages(messages);

    const keyed = incoming.map((item) => {
      const key = item.detail?.kind === 'email' ? threadKeys.get(item.externalId) : undefined;
      return key ? { ...item, detail: { ...detailOf(item), threadKey: key } } : item;
    });
    const moved: SourceItem[] = [];
    for (const [externalId, item] of held) {
      if (arriving.has(externalId) || item.detail?.kind !== 'email') continue;
      const key = threadKeys.get(externalId);
      if (!key || key === item.detail.threadKey) continue;
      moved.push({
        externalId,
        kind: 'email',
        title: item.title,
        people: item.people,
        status: item.status,
        detail: { ...item.detail, threadKey: key },
      });
    }
    return { items: keyed, moved };
  }

  function readBody(itemId: string): EmailBody | null {
    const row = db.select().from(emailBodies).where(eq(emailBodies.itemId, itemId)).get();
    return row
      ? { text: row.text, html: row.html, textFromHtml: row.textFromHtml, truncated: row.truncated }
      : null;
  }

  /** Keeps an email's bodies. Returns whether they changed. */
  function writeBody(itemId: string, body: EmailBody): boolean {
    const current = readBody(itemId);
    if (
      current &&
      current.text === body.text &&
      current.html === body.html &&
      current.textFromHtml === body.textFromHtml &&
      current.truncated === body.truncated
    ) {
      return false;
    }
    db.insert(emailBodies)
      .values({ itemId, ...body })
      .onConflictDoUpdate({ target: emailBodies.itemId, set: body })
      .run();
    return true;
  }

  function deleteBodies(itemIds: string[]) {
    for (const ids of chunks(itemIds)) db.delete(emailBodies).where(inArray(emailBodies.itemId, ids)).run();
  }

  // Every live email of the threads named, by Account.
  function messagesOf(threads: { account: string; threadKey: string }[]): Item[] {
    const byAccount = new Map<string, string[]>();
    for (const { account, threadKey } of threads)
      byAccount.set(account, [...(byAccount.get(account) ?? []), threadKey]);
    const found: Item[] = [];
    for (const [account, keys] of byAccount) {
      for (const chunk of chunks(keys)) {
        const rows = db
          .select({ item: items })
          .from(items)
          .innerJoin(emailDetails, eq(emailDetails.itemId, items.id))
          .where(
            and(eq(items.account, account), isNull(items.deletedAt), inArray(emailDetails.threadKey, chunk)),
          )
          .orderBy(asc(emailDetails.sentAt), asc(items.id))
          .all();
        found.push(...withDetails(rows.map((row) => row.item)));
      }
    }
    return found;
  }

  const detailOfItem = (item: Item) => item.detail as EmailDetail;

  function summaryOf(account: string, threadKey: string, messages: Item[]): EmailThreadSummary | null {
    const ordered = [...messages].sort(
      (a, b) => detailOfItem(a).sentAt - detailOfItem(b).sentAt || a.id.localeCompare(b.id),
    );
    const latest = ordered.at(-1);
    if (!latest) return null;
    const senders: string[] = [];
    for (const message of ordered) {
      const detail = detailOfItem(message);
      const name = detail.sentByMe ? 'me' : addressName(detail.from) || '(unknown sender)';
      if (!senders.includes(name)) senders.push(name);
    }
    const last = detailOfItem(latest);
    const details = ordered.map(detailOfItem);
    const live = details.filter((detail) => !detail.inTrash);
    const labels = new Map<string, EmailLabel>();
    for (const detail of live)
      for (const label of detail.labels) if (isPickableLabel(label.id)) labels.set(label.id, label);
    const returned = details.flatMap((detail) => (detail.snooze?.returned ? [detail.snooze.until] : []));
    return {
      account,
      threadKey,
      subject: last.subject || latest.title,
      senders,
      snippet: last.snippet,
      latestAt: last.sentAt,
      messageCount: ordered.length,
      unreadCount: ordered.filter((message) => !detailOfItem(message).read).length,
      hasAttachments: ordered.some((message) =>
        detailOfItem(message).attachments.some((each) => !each.inline),
      ),
      latest,
      itemIds: ordered.map((message) => message.id),
      starred: live.some((detail) => detail.starred),
      labels: [...labels.values()].sort((a, b) => a.name.localeCompare(b.name)),
      inTrash: live.length < details.length,
      snoozedUntil: threadSnoozedUntil(details, now()),
      returnedFrom: returned.length ? Math.max(...returned) : null,
    };
  }

  // Every thread of the Account (or every Account), as the views read it.
  function threadRows(account: string | undefined): ThreadRow[] {
    const at = now();
    const notTrashed = sql`not ${emailDetails.inTrash}`;
    const rows = db
      .select({
        account: items.account,
        threadKey: emailDetails.threadKey,
        latestAt: sql<number>`max(${emailDetails.sentAt})`,
        returnedAt: sql<number>`max(coalesce(${emailDetails.returnedFrom}, 0))`,
        unread: sql<number>`sum(${emailDetails.unread})`,
        inbox: sql<number>`max(${emailDetails.inInbox} and ${notTrashed})`,
        starred: sql<number>`max(coalesce(json_extract(${emailDetails.data}, '$.starred'), 0) and ${notTrashed})`,
        trashed: sql<number>`max(${emailDetails.inTrash})`,
        live: sql<number>`min(${emailDetails.inTrash}) = 0`,
        snoozed: sql<number>`min(coalesce(${emailDetails.snoozedUntil}, 0))`,
        labels: sql<
          string | null
        >`group_concat(case when ${emailDetails.inTrash} then null else (select group_concat(json_extract(label.value, '$.id'), ${SEPARATOR}) from json_each(${emailDetails.data}, '$.labels') label) end, ${SEPARATOR})`,
      })
      .from(emailDetails)
      .innerJoin(items, eq(items.id, emailDetails.itemId))
      .where(
        and(
          isNull(items.deletedAt),
          eq(items.kind, 'email'),
          account ? eq(items.account, account) : undefined,
        ),
      )
      .groupBy(items.account, emailDetails.threadKey)
      .all();
    return rows.flatMap((row) =>
      row.account
        ? [
            {
              account: row.account,
              threadKey: row.threadKey,
              unread: Number(row.unread),
              sortAt: Math.max(Number(row.latestAt), Number(row.returnedAt)),
              inInbox: !!row.inbox,
              starred: !!row.starred,
              trashed: !!row.trashed,
              live: !!row.live,
              snoozedUntil: Number(row.snoozed) > at ? Number(row.snoozed) : null,
              labels: new Set(row.labels ? row.labels.split(SEPARATOR) : []),
            },
          ]
        : [],
    );
  }

  const newestFirst = (a: ThreadRow, b: ThreadRow) =>
    b.sortAt - a.sortAt || a.account.localeCompare(b.account) || a.threadKey.localeCompare(b.threadKey);

  // The summaries of these threads, in the order given.
  function summaries(shown: { account: string; threadKey: string }[]): EmailThreadSummary[] {
    const grouped = new Map<string, Item[]>();
    for (const message of messagesOf(shown)) {
      const key = `${message.account}\u0000${detailOfItem(message).threadKey}`;
      grouped.set(key, [...(grouped.get(key) ?? []), message]);
    }
    return shown.flatMap(
      ({ account, threadKey }) =>
        summaryOf(account, threadKey, grouped.get(`${account}\u0000${threadKey}`) ?? []) ?? [],
    );
  }

  /** A view's threads (the Inbox unless asked), newest first, with how many have unread mail. */
  function threads(input: EmailThreadQuery = {}): EmailThreadList {
    const query = emailThreadQuery.parse(input);
    const view: EmailListView = query.view ?? 'inbox';
    const rows = threadRows(query.account)
      .filter((row) => flagsInView(row, view))
      .sort(newestFirst);
    return {
      threads: summaries(rows.slice(0, query.limit ?? THREADS_MAX)),
      unreadThreads: rows.filter((row) => row.unread > 0).length,
      total: rows.length,
    };
  }

  /** The labels the User can put on mail: from the Account's catalog, and any its mail carries. */
  function labelsOf(account: string | undefined): EmailLabel[] {
    const found = new Map<string, EmailLabel>();
    const { sourceCatalogs } = schema;
    const catalogs = db
      .select({ catalog: sourceCatalogs.catalog })
      .from(sourceCatalogs)
      .where(account ? eq(sourceCatalogs.account, account) : eq(sourceCatalogs.source, 'gmail'))
      .all();
    for (const row of catalogs) {
      const parsed = gmailCatalog.safeParse(row.catalog);
      if (!parsed.success) continue;
      for (const label of parsed.data.labels)
        if (!label.system && isPickableLabel(label.id))
          found.set(label.id, { id: label.id, name: label.name });
    }
    const carried = db
      .selectDistinct({
        id: sql<string | null>`json_extract(label.value, '$.id')`,
        name: sql<string | null>`json_extract(label.value, '$.name')`,
      })
      .from(sql`${emailDetails}, json_each(${emailDetails.data}, '$.labels') label`)
      .innerJoin(items, eq(items.id, emailDetails.itemId))
      .where(and(isNull(items.deletedAt), account ? eq(items.account, account) : undefined))
      .all();
    for (const label of carried) {
      if (label.id && label.name !== null && isPickableLabel(label.id) && !found.has(label.id))
        found.set(label.id, { id: label.id, name: label.name });
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** Each view's threads and unread ones: the fixed views, then each label by name. */
  function viewCounts(input: EmailViewQuery = {}): EmailViewCounts {
    const query = emailViewQuery.parse(input);
    const rows = threadRows(query.account);
    const countOf = (view: EmailListView, name: string) => {
      const inView = rows.filter((row) => flagsInView(row, view));
      return { view, name, threads: inView.length, unread: inView.filter((row) => row.unread > 0).length };
    };
    return {
      views: [
        ...EMAIL_VIEWS.map((view) => countOf(view, VIEW_NAMES[view])),
        ...labelsOf(query.account).map((label) => countOf(`label:${label.id}`, label.name)),
      ],
    };
  }

  /** Section search: threads with a message matching the words and operators, newest first. */
  function searchThreads(input: EmailSearchQuery): EmailSearchResult {
    const query = emailSearchQuery.parse(input);
    const parsed = parseEmailSearch(query.text);
    let view: EmailListView | null = parsed.view;
    if (parsed.label) {
      const label = labelsOf(query.account).find((each) => each.name.toLowerCase() === parsed.label);
      if (!label) return { threads: [] };
      view = `label:${label.id}`;
    }
    // The messages the words find (the word index), or the newest messages when only operators were typed.
    let candidates: Item[];
    if (parsed.words) {
      candidates = search()
        .query({
          text: parsed.words,
          kinds: ['email'],
          ...(query.account ? { accounts: [query.account] } : {}),
          limit: SEARCH_HITS_MAX,
        })
        .hits.map((hit) => hit.item);
    } else {
      const rows = db
        .select({ item: items })
        .from(items)
        .innerJoin(emailDetails, eq(emailDetails.itemId, items.id))
        .where(and(isNull(items.deletedAt), query.account ? eq(items.account, query.account) : undefined))
        .orderBy(desc(emailDetails.sentAt))
        .limit(SEARCH_SCAN_MAX)
        .all();
      candidates = withDetails(rows.map((row) => row.item));
    }
    const keys = new Map<string, { account: string; threadKey: string }>();
    for (const item of candidates) {
      if (!item.account || item.detail?.kind !== 'email' || !emailSearchMatches(item.detail, parsed))
        continue;
      const { threadKey } = item.detail;
      keys.set(`${item.account}\u0000${threadKey}`, { account: item.account, threadKey });
    }
    const at = now();
    const found = summaries([...keys.values()]).filter((summary) => {
      const flags = threadFlagsOf([...readDetails(summary.itemIds).values()], at);
      // Trashed threads only with in:trash: Gmail's search leaves Trash out too.
      return view ? flagsInView(flags, view) : flags.live;
    });
    found.sort((a, b) => b.latestAt - a.latestAt || a.threadKey.localeCompare(b.threadKey));
    return { threads: found.slice(0, query.limit ?? THREADS_MAX) };
  }

  /** The threads with a snooze due by `at`. */
  function dueSnoozes(at: number): { account: string; threadKey: string }[] {
    return db
      .selectDistinct({ account: items.account, threadKey: emailDetails.threadKey })
      .from(emailDetails)
      .innerJoin(items, eq(items.id, emailDetails.itemId))
      .where(and(isNull(items.deletedAt), lte(emailDetails.snoozedUntil, at)))
      .all()
      .flatMap((row) => (row.account ? [{ account: row.account, threadKey: row.threadKey }] : []));
  }

  /** When the next snooze is due, or null when nothing is snoozed. */
  function nextSnoozeAt(): number | null {
    const row = db
      .select({ at: sql<number | null>`min(${emailDetails.snoozedUntil})` })
      .from(emailDetails)
      .innerJoin(items, eq(items.id, emailDetails.itemId))
      .where(isNull(items.deletedAt))
      .get();
    return row?.at ?? null;
  }

  function threadView(account: string, threadKey: string): EmailThread | null {
    const messages = messagesOf([{ account, threadKey }]);
    if (!messages.length) return null;
    return {
      account,
      threadKey,
      messages: messages.map((item) => ({ item, body: readBody(item.id) })),
    };
  }

  // The external ids of an Account's live Items from a Source (for a re-sync to tell what's gone).
  function externalIds(source: string, account: string): string[] {
    return db
      .select({ externalId: items.externalId })
      .from(items)
      .where(
        and(
          eq(items.source, source as Item['source'] & string),
          eq(items.account, account),
          isNull(items.deletedAt),
        ),
      )
      .all()
      .flatMap((row) => (row.externalId ? [row.externalId] : []));
  }

  return {
    readDetails,
    writeDetail,
    thread,
    readBody,
    writeBody,
    deleteBodies,
    threads,
    threadView,
    externalIds,
    messagesOf,
    viewCounts,
    searchThreads,
    labelsOf,
    dueSnoozes,
    nextSnoozeAt,
  };
}

export type EmailStore = ReturnType<typeof emailsIn>;
