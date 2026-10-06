// Ares's suggested replies to email threads (#143), and the User's sent mail as his drafting reads it.
//
// - A suggested reply is Ares's own record beside its thread (one row per thread), never an Item and
//   never at the Source: his draft (`ready`), the User's Dismiss (`dismissed`), or opened in the
//   composer as a draft (`opened`). Each answers one message, the thread's latest when it was written;
//   once another message is the latest, the row no longer counts (a dismissal included), so a new
//   message brings the thread back for him.
// - The card at the end of a thread (`forThread`): his draft when one waits; otherwise an offer when the
//   thread's latest message is someone else's, in Needs reply, from an Account whose mail Ares may read,
//   with "Draft replies" above Off in Email (at Ask that is all he does until asked; at Auto when sure
//   his job usually has the draft waiting by the time the User looks).
// - The User's sent mail: a sample of an Account's (what "Learn writing style" reads), the User's
//   earlier messages to the people of a thread (what a draft reads beside it), and whether a link is in
//   any of it (a link that is in neither the thread nor the User's sent mail is one Ares added).
import {
  type AutonomySettings,
  CONFIDENCE_BAR,
  DRAFT_REPLIES,
  decide,
  type EmailDetail,
  type EmailThread,
  type Item,
  type ModelSettings,
  mayReadMail,
  NEEDS_REPLY,
  type ReadyReply,
  type SuggestedReply,
} from '@commander/domain';
import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ItemRow } from './rows';
import * as schema from './schema';

type Row = typeof schema.suggestedReplies.$inferSelect;

export type NewSuggestedReply = {
  account: string;
  threadKey: string;
  // The message it replies to: the thread's latest.
  answering: string;
  body: string;
  addedLinks: readonly string[];
  confidence: number;
};

export type SuggestedReplyStore = {
  // The card at the end of a thread: Ares's draft, or his offer to draft one, or nothing.
  forThread(thread: Pick<EmailThread, 'account' | 'threadKey' | 'messages'>): SuggestedReply | null;
  // Ares's draft for a thread, replacing whatever was there.
  save(reply: NewSuggestedReply): ReadyReply;
  // The User's Dismiss, by the message it answers: away until a new message arrives. Null when that
  // message is gone.
  dismiss(itemId: string): { account: string; threadKey: string } | null;
  // The draft waiting for this message (its thread's latest), for Open in composer.
  ready(itemId: string): ReadyReply | null;
  // Open in composer made it the draft `draftItemId`.
  opened(itemId: string, draftItemId: string): void;
  // Whether the thread's latest message already has a draft of his, or was dismissed or opened: his
  // job leaves it alone.
  settled(account: string, threadKey: string, answering: string): boolean;
  // The User's own sent messages in an Account sent since then, newest first, at most `limit`.
  sent(account: string, since: number, limit: number): Item[];
  // The User's own messages in an Account to (or copying) any of these addresses, newest first, outside
  // the given thread, at most `limit`.
  sentTo(account: string, addresses: readonly string[], exceptThread: string, limit: number): Item[];
  // The Accounts with sent mail of the User's since then.
  sentAccounts(since: number): { account: string; source: string | null }[];
  // Which of these links appear in any of the User's sent mail.
  inSentMail(links: readonly string[]): Set<string>;
  // The addresses the User's own mail in an Account was sent from, lower-cased.
  ownAddresses(account: string): string[];
};

const lower = (address: string) => address.trim().toLowerCase();
// A LIKE pattern for text holding `value` anywhere (with `\` as the escape).
const containing = (value: string) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export function suggestedRepliesIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    now,
    withDetails,
    readItem,
    messagesOf,
    autonomy,
    models,
  }: {
    now: () => number;
    withDetails: (rows: ItemRow[]) => Item[];
    readItem: (itemId: string) => Item | undefined;
    messagesOf: (threads: { account: string; threadKey: string }[]) => Item[];
    autonomy: () => AutonomySettings;
    models: () => Pick<ModelSettings, 'cloudMail'>;
  },
): SuggestedReplyStore {
  const { suggestedReplies, items, emailDetails, emailBodies } = schema;

  const rowOf = (account: string, threadKey: string): Row | undefined =>
    db
      .select()
      .from(suggestedReplies)
      .where(and(eq(suggestedReplies.account, account), eq(suggestedReplies.threadKey, threadKey)))
      .get();

  const readyOf = (row: Row): ReadyReply => ({
    state: 'ready',
    answering: row.answering,
    body: row.body,
    addedLinks: row.addedLinks,
    confidence: row.confidence,
    sure: row.confidence >= CONFIDENCE_BAR,
    at: row.at,
  });

  const emailOf = (item: Item | undefined): EmailDetail | null =>
    item?.detail?.kind === 'email' ? item.detail : null;

  // The message's thread, and its latest message, when the message is a live email in one.
  function threadOf(itemId: string): { account: string; threadKey: string; latest: Item } | null {
    const item = readItem(itemId);
    const email = emailOf(item);
    if (!item || !email || !item.account || item.deletedAt !== null || email.draft) return null;
    const latest = messagesOf([{ account: item.account, threadKey: email.threadKey }]).at(-1);
    return latest ? { account: item.account, threadKey: email.threadKey, latest } : null;
  }

  // Whether Ares may offer a reply to a thread whose latest message is this.
  function offerable(latest: Item): boolean {
    const email = emailOf(latest);
    if (!email || email.sentByMe || email.bucket?.bucketId !== NEEDS_REPLY) return false;
    if (!mayReadMail(models(), latest.source, latest.account)) return false;
    return (
      decide(
        { action: DRAFT_REPLIES, actionKind: 'organise', section: 'email', confidence: 1, chained: false },
        autonomy(),
      ) !== 'off'
    );
  }

  function ownMessages(where: SQL | undefined, limit: number): Item[] {
    const rows = db
      .select({ item: items })
      .from(items)
      .innerJoin(emailDetails, eq(emailDetails.itemId, items.id))
      .where(
        and(
          isNull(items.deletedAt),
          eq(items.kind, 'email'),
          eq(emailDetails.draft, false),
          sql`coalesce(json_extract(${emailDetails.data}, '$.sentByMe'), 0) = 1`,
          where,
        ),
      )
      .orderBy(desc(emailDetails.sentAt), desc(items.id))
      .limit(limit)
      .all();
    return withDetails(rows.map((row) => row.item));
  }

  return {
    forThread({ account, threadKey, messages }) {
      const latest = messages.at(-1)?.item;
      if (!latest) return null;
      const row = rowOf(account, threadKey);
      if (row && row.answering === latest.id) {
        if (row.status === 'ready') return readyOf(row);
        return null;
      }
      return offerable(latest) ? { state: 'offered', answering: latest.id } : null;
    },

    save(reply) {
      const at = now();
      const changes = {
        answering: reply.answering,
        body: reply.body,
        addedLinks: [...reply.addedLinks],
        confidence: reply.confidence,
        status: 'ready' as const,
        draftItemId: null,
        at,
        updatedAt: at,
      };
      db.insert(suggestedReplies)
        .values({ account: reply.account, threadKey: reply.threadKey, ...changes })
        .onConflictDoUpdate({ target: [suggestedReplies.account, suggestedReplies.threadKey], set: changes })
        .run();
      return readyOf(rowOf(reply.account, reply.threadKey) as Row);
    },

    dismiss(itemId) {
      const thread = threadOf(itemId);
      if (!thread) return null;
      const at = now();
      const row = rowOf(thread.account, thread.threadKey);
      const sameMessage = row?.answering === thread.latest.id;
      db.insert(suggestedReplies)
        .values({
          account: thread.account,
          threadKey: thread.threadKey,
          answering: thread.latest.id,
          body: sameMessage ? (row?.body ?? '') : '',
          addedLinks: sameMessage ? (row?.addedLinks ?? []) : [],
          confidence: sameMessage ? (row?.confidence ?? 0) : 0,
          status: 'dismissed',
          draftItemId: null,
          at: sameMessage ? (row?.at ?? at) : at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [suggestedReplies.account, suggestedReplies.threadKey],
          set: {
            answering: thread.latest.id,
            status: 'dismissed',
            draftItemId: null,
            updatedAt: at,
            ...(sameMessage ? {} : { body: '', addedLinks: [], confidence: 0, at }),
          },
        })
        .run();
      return { account: thread.account, threadKey: thread.threadKey };
    },

    ready(itemId) {
      const thread = threadOf(itemId);
      if (!thread || thread.latest.id !== itemId) return null;
      const row = rowOf(thread.account, thread.threadKey);
      return row && row.status === 'ready' && row.answering === itemId ? readyOf(row) : null;
    },

    opened(itemId, draftItemId) {
      db.update(suggestedReplies)
        .set({ status: 'opened', draftItemId, updatedAt: now() })
        .where(and(eq(suggestedReplies.answering, itemId), eq(suggestedReplies.status, 'ready')))
        .run();
    },

    settled(account, threadKey, answering) {
      return rowOf(account, threadKey)?.answering === answering;
    },

    sent(account, since, limit) {
      return ownMessages(and(eq(items.account, account), sql`${emailDetails.sentAt} >= ${since}`), limit);
    },

    sentTo(account, addresses, exceptThread, limit) {
      const wanted = [...new Set(addresses.map(lower))].filter(Boolean);
      if (!wanted.length) return [];
      // Recipients live in the detail's JSON: any To or Cc address among those wanted.
      const among = sql.join(
        wanted.map((address) => sql`${address}`),
        sql`, `,
      );
      return ownMessages(
        and(
          eq(items.account, account),
          sql`${emailDetails.threadKey} <> ${exceptThread}`,
          sql`(exists (select 1 from json_each(${emailDetails.data}, '$.to') r where lower(json_extract(r.value, '$.address')) in (${among}))
            or exists (select 1 from json_each(${emailDetails.data}, '$.cc') r where lower(json_extract(r.value, '$.address')) in (${among})))`,
        ),
        limit,
      );
    },

    sentAccounts(since) {
      return db
        .selectDistinct({ account: items.account, source: items.source })
        .from(items)
        .innerJoin(emailDetails, eq(emailDetails.itemId, items.id))
        .where(
          and(
            isNull(items.deletedAt),
            eq(items.kind, 'email'),
            eq(emailDetails.draft, false),
            sql`${emailDetails.sentAt} >= ${since}`,
            sql`coalesce(json_extract(${emailDetails.data}, '$.sentByMe'), 0) = 1`,
          ),
        )
        .all()
        .flatMap((row) => (row.account ? [{ account: row.account, source: row.source }] : []));
    },

    ownAddresses(account) {
      return db
        .selectDistinct({
          address: sql<string | null>`lower(json_extract(${emailDetails.data}, '$.from.address'))`,
        })
        .from(emailDetails)
        .innerJoin(items, eq(items.id, emailDetails.itemId))
        .where(
          and(
            isNull(items.deletedAt),
            eq(items.account, account),
            sql`coalesce(json_extract(${emailDetails.data}, '$.sentByMe'), 0) = 1`,
          ),
        )
        .all()
        .flatMap((row) => (row.address ? [row.address] : []));
    },

    inSentMail(links) {
      const found = new Set<string>();
      for (const link of new Set(links)) {
        const hit = db
          .select({ itemId: emailBodies.itemId })
          .from(emailBodies)
          .innerJoin(emailDetails, eq(emailDetails.itemId, emailBodies.itemId))
          .innerJoin(items, eq(items.id, emailBodies.itemId))
          .where(
            and(
              isNull(items.deletedAt),
              eq(emailDetails.draft, false),
              sql`coalesce(json_extract(${emailDetails.data}, '$.sentByMe'), 0) = 1`,
              sql`(${emailBodies.text} like ${containing(link)} escape '\\' or ${emailBodies.html} like ${containing(link)} escape '\\')`,
            ),
          )
          .limit(1)
          .get();
        if (hit) found.add(link);
      }
      return found;
    },
  };
}
