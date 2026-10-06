// Messages written in Commander (#138, the domain's email-compose.ts) in the Item store. A message is
// an `email` Item from its first save: made at once under a placeholder external id (`commander:<item
// id>`), with Commander's own record beside it (email_compose: its body as the composer's model, its
// attachments, how it was begun, the quote below it and its Message-ID), its bodies kept as any
// email's are, and what reaches the Source queued in the same transaction (ADR 0003):
//
// - `draft`: the message as the User last left it, saved to the Account's Drafts folder. Later saves
//   fold into the one waiting (the outgoing queue keeps a field's latest value), so a burst of typing
//   saves once.
// - `send`: the message to send, held until the end of its Undo time (the queue's `holdUntil`), then
//   sent; Undo takes it out while it waits (or is offline), never once it is on its way. Only the User
//   sends: Ares can leave a draft, never a send (#11).
// - `delete`: a draft discarded (the Item stays as a tombstone, like any deletion).
//
// The Source's answer to a draft or a send names the Item (`commanderItemId`), and saving it gives the
// Item the Source's id: the draft's, then the sent message's, which the next sync finds as the same
// Item. A sync that brings the sent message before that answer was saved (a crash in between) matches
// it by its Message-ID (matchMessage), so a sent message appears once in its thread. Drafts made in
// Gmail or Outlook open in the composer too: their first save here starts their record, and their
// changes go to the draft the Source already holds.
import { randomUUID } from 'node:crypto';
import {
  type ActivityEntry,
  type Actor,
  attachmentsProblem,
  bodyText,
  type ComposeAttachment,
  type ComposeBody,
  type ComposeDraft,
  type ComposeMode,
  composeDraft,
  DEFAULT_UNDO_SEND_SECONDS,
  DELETE_FIELD,
  DRAFT_FIELD,
  type DraftEntry,
  type EmailAddress,
  type EmailBody,
  type EmailComposeSettings,
  type EmailDetail,
  emailComposeSettings,
  type Item,
  type ItemState,
  isPendingEventExternalId,
  messageBodies,
  newMessageId,
  type OutboxEntry,
  type OutgoingMessage,
  pendingEventExternalId,
  replyThreading,
  SEND_FIELD,
  type Source,
  UNDO_SEND_CHOICES,
} from '@commander/domain';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { EmailStore } from './emails';
import type { OutgoingQueue } from './outgoing';
import * as schema from './schema';

type Entry = { by: Actor; why?: string | null };

// The most of the message's text an email's snippet holds.
const SNIPPET_MAX = 200;

/** A message's record beside its Item. */
export type ComposeRecord = {
  itemId: string;
  mode: ComposeMode;
  replyToItemId: string | null;
  body: ComposeBody;
  attachments: ComposeAttachment[];
  quote: { html: string; text: string } | null;
  messageId: string;
  // When it goes (the end of its Undo time), once the User pressed Send; null while a draft.
  sendAt: number | null;
};

/** What saving or sending needs beyond the composer's draft: who it is from, and the quote below it. */
export type ComposeContext = Entry & {
  // The Account's mail Source, and the From line (its name and address).
  source: Source;
  from: EmailAddress;
  // The quoted history below a reply (or the forwarded message), when the message has none yet.
  quote?: { html: string; text: string } | null;
};

export type ComposeDeps = {
  db: BetterSQLite3Database<typeof schema>;
  now: () => number;
  readItem(id: string): Item | undefined;
  insert(
    identity: Pick<Item, 'kind' | 'source' | 'account' | 'externalId'>,
    state: ItemState,
    at: number,
    chosenId: string,
  ): { id: string; state: ItemState };
  writeState(item: Item, state: ItemState, at: number): ItemState;
  log(
    entry: Entry & {
      action: 'create' | 'update' | 'delete';
      itemId: string;
      before: ItemState | null;
      after: ItemState;
    },
    at: number,
  ): ActivityEntry;
  outgoing: OutgoingQueue;
  emails: EmailStore;
  invalid(message: string): Error;
};

const stateOf = (item: Item): ItemState => ({
  title: item.title,
  people: item.people,
  status: item.status,
  filing: item.filing,
  detail: item.detail,
  deletedAt: item.deletedAt,
});

const emailOf = (item: Item | undefined): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;

export function composeIn(deps: ComposeDeps) {
  const { db, invalid } = deps;
  const { emailCompose: table, emailComposeSettings: settingsTable, emailSignatures } = schema;

  function record(itemId: string): ComposeRecord | null {
    const row = db.select().from(table).where(eq(table.itemId, itemId)).get();
    if (!row) return null;
    return {
      itemId: row.itemId,
      mode: row.mode,
      replyToItemId: row.replyToItemId,
      body: row.body,
      attachments: row.attachments,
      quote:
        row.quoteHtml !== null && row.quoteText !== null
          ? { html: row.quoteHtml, text: row.quoteText }
          : null,
      messageId: row.messageId,
      sendAt: row.sendAt,
    };
  }

  function writeRecord(next: ComposeRecord, at: number) {
    const values = {
      mode: next.mode,
      replyToItemId: next.replyToItemId,
      body: next.body,
      attachments: next.attachments,
      quoteHtml: next.quote?.html ?? null,
      quoteText: next.quote?.text ?? null,
      messageId: next.messageId,
      sendAt: next.sendAt,
      updatedAt: at,
    };
    db.insert(table)
      .values({ itemId: next.itemId, ...values })
      .onConflictDoUpdate({ target: table.itemId, set: values })
      .run();
  }

  // The message replied to or forwarded, when it is still there.
  function replyTo(draft: ComposeDraft): { item: Item; detail: EmailDetail } | null {
    if (!draft.replyToItemId) return null;
    const item = deps.readItem(draft.replyToItemId);
    const detail = emailOf(item);
    return item && detail && item.deletedAt === null ? { item, detail } : null;
  }

  /** The `draft` and `send` value: the whole message as the Source gets it. */
  function outgoingOf(
    itemId: string,
    draft: ComposeDraft,
    from: EmailAddress,
    detail: EmailDetail,
    rec: ComposeRecord,
  ): OutgoingMessage {
    const original = replyTo(draft);
    const bodies = messageBodies(draft.body, rec.quote);
    return {
      commanderId: itemId,
      messageId: rec.messageId,
      mode: draft.mode,
      from,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: bodies.html,
      text: bodies.text,
      attachments: draft.attachments,
      // As the message's detail threads it: a reply's from the message it answers; a draft made elsewhere
      // keeps its own (its thread in Gmail too).
      inReplyTo: detail.inReplyTo,
      references: detail.references,
      sourceThreadId: detail.sourceThreadId,
      replyToExternalId: original?.item.externalId ?? null,
    };
  }

  // The message's detail as the composer left it: an email the User wrote, read, never in the inbox.
  function detailFor(
    _itemId: string,
    draft: ComposeDraft,
    from: EmailAddress,
    rec: ComposeRecord,
    held: EmailDetail | null,
    at: number,
  ): EmailDetail {
    const original = replyTo(draft);
    const threading =
      (draft.mode === 'reply' || draft.mode === 'reply-all') && original
        ? replyThreading(original.detail)
        : { inReplyTo: null, references: [] as string[] };
    const threaded = (draft.mode === 'reply' || draft.mode === 'reply-all') && original;
    const text = bodyText(draft.body);
    return {
      kind: 'email',
      messageId: held?.messageId ?? rec.messageId,
      inReplyTo: threaded ? threading.inReplyTo : (held?.inReplyTo ?? null),
      references: threaded ? threading.references : (held?.references ?? []),
      threadKey: threaded ? original.detail.threadKey : (held?.threadKey ?? `mid:${rec.messageId}`),
      sourceThreadId: threaded ? original.detail.sourceThreadId : (held?.sourceThreadId ?? null),
      from,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      replyTo: [],
      subject: draft.subject,
      sentAt: at,
      snippet: text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX),
      read: true,
      starred: false,
      inInbox: false,
      sentByMe: true,
      labels: held?.labels ?? [],
      ...(held?.folder !== undefined ? { folder: held.folder } : {}),
      attachments: draft.attachments.map((each) => ({
        name: each.name,
        type: each.type,
        size: each.size,
        partId: `compose:${each.id}`,
        inline: false,
      })),
      hasInvitation: false,
      listUnsubscribe: null,
      listId: null,
      ...(held?.sourceVersion ? { sourceVersion: held.sourceVersion } : {}),
      draft: true,
    };
  }

  const peopleOf = (draft: ComposeDraft) => [
    ...new Set([...draft.to, ...draft.cc, ...draft.bcc].map((each) => each.address.trim().toLowerCase())),
  ];

  // Saves the composer's message: makes its Item on the first save, or updates the draft it was.
  function write(
    input: ComposeDraft,
    context: ComposeContext,
    at: number,
  ): { item: Item; rec: ComposeRecord; message: OutgoingMessage; entry: ActivityEntry } {
    const parsed = composeDraft.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That message can’t be saved');
    const draft = parsed.data;
    const problem = attachmentsProblem(draft.attachments);
    if (problem) throw invalid(problem);
    const held = draft.itemId ? deps.readItem(draft.itemId) : undefined;
    if (draft.itemId && !held) throw invalid('That draft is gone');
    if (held) {
      const detail = emailOf(held);
      if (held.deletedAt !== null || !detail) throw invalid('That draft is gone');
      if (!detail.draft) throw invalid('That message has already been sent');
      if (held.account !== draft.account) throw invalid('A draft goes from the Account it was written in');
    }
    const itemId = held?.id ?? randomUUID();
    const before = record(itemId);
    const heldDetail = emailOf(held);
    const rec: ComposeRecord = {
      itemId,
      mode: draft.mode,
      replyToItemId: draft.replyToItemId ?? before?.replyToItemId ?? null,
      body: draft.body,
      attachments: draft.attachments,
      quote: before?.quote ?? context.quote ?? null,
      messageId: before?.messageId ?? heldDetail?.messageId ?? newMessageId(itemId, context.from.address),
      sendAt: null,
    };
    const detail = detailFor(itemId, draft, context.from, rec, heldDetail, at);
    const state: ItemState = {
      title: draft.subject || '(no subject)',
      people: peopleOf(draft),
      status: 'archived',
      filing: held?.filing ?? null,
      detail,
      deletedAt: null,
    };
    const bodies = messageBodies(draft.body, rec.quote);
    const body: EmailBody = { text: bodies.text, html: bodies.html, textFromHtml: false, truncated: false };
    let entry: ActivityEntry;
    let item: Item;
    if (held) {
      const was = stateOf(held);
      const after = deps.writeState(held, state, at);
      entry = deps.log({ ...context, action: 'update', itemId, before: was, after }, at);
      item = { ...held, ...after };
    } else {
      deps.emails.writeBody(itemId, body);
      const made = deps.insert(
        {
          kind: 'email',
          source: context.source,
          account: draft.account,
          externalId: pendingEventExternalId(itemId),
        },
        state,
        at,
        itemId,
      );
      entry = deps.log({ ...context, action: 'create', itemId, before: null, after: made.state }, at);
      item = deps.readItem(itemId) as Item;
    }
    deps.emails.writeBody(itemId, body);
    writeRecord(rec, at);
    return { item, rec, message: outgoingOf(itemId, draft, context.from, detail, rec), entry };
  }

  const base = (item: Item, entry: ActivityEntry, at: number) => ({
    account: item.account as string,
    source: item.source as Source,
    itemId: item.id,
    externalId: item.externalId as string,
    synced: null,
    madeAt: at,
    entryId: entry.id,
  });

  // The `send` change waiting for the message, if one is.
  const sendRow = (itemId: string) =>
    deps.outgoing.forItem(itemId).find((row) => row.field === SEND_FIELD) ?? null;

  return {
    record,

    /** Saves a draft, and queues it for the Source's Drafts folder. Runs inside a transaction. */
    save(input: ComposeDraft, context: ComposeContext, at: number): { itemId: string } {
      const { item, message, entry } = write(input, context, at);
      deps.outgoing.queue({ ...base(item, entry, at), field: DRAFT_FIELD, value: message });
      return { itemId: item.id };
    },

    /**
     * Sends the message: saved as it is, then queued to send at `sendAt` (the end of its Undo time).
     * Only the User sends. Runs inside a transaction.
     */
    send(
      input: ComposeDraft,
      context: ComposeContext,
      sendAt: number,
      at: number,
    ): { itemId: string; sendAt: number } {
      if (context.by.kind !== 'user')
        throw invalid('Only you can send email: Ares can draft one for you to send.');
      if (!input.to.length && !input.cc.length && !input.bcc.length)
        throw invalid('Add someone to send this to.');
      const { item, rec, message } = write(input, context, at);
      const { draft: _draft, ...detail } = emailOf(item) as EmailDetail;
      const sending: EmailDetail = { ...detail, sentAt: at };
      const before = stateOf(item);
      const after = deps.writeState(item, { ...before, detail: sending }, at);
      const sent = deps.log(
        { ...context, action: 'update', itemId: item.id, before, after, why: 'Sent' },
        at,
      );
      writeRecord({ ...rec, sendAt }, at);
      deps.outgoing.queue({ ...base(item, sent, at), field: SEND_FIELD, value: message, holdUntil: sendAt });
      return { itemId: item.id, sendAt };
    },

    /**
     * Takes a message back before it goes (held for Undo, or waiting for a connection): it is a draft
     * again. Refused once it is on its way or sent. Runs inside a transaction.
     */
    undoSend(itemId: string, entry: Entry, at: number): Item {
      const item = deps.readItem(itemId);
      const detail = emailOf(item);
      if (!item || !detail || item.deletedAt !== null) throw invalid('That message is gone');
      const row = sendRow(itemId);
      if (!row) throw invalid(detail.draft ? 'That message hasn’t been sent' : 'It has already been sent.');
      if (row.status === 'sending') throw invalid('It’s on its way, so it can’t be taken back now.');
      deps.outgoing.settle([row.id]);
      const rec = record(itemId);
      if (rec) writeRecord({ ...rec, sendAt: null }, at);
      const before = stateOf(item);
      const after = deps.writeState(item, { ...before, detail: { ...detail, draft: true } }, at);
      deps.log({ ...entry, action: 'update', itemId, before, after, why: 'Undo send' }, at);
      return { ...item, ...after };
    },

    /** Discards a draft: its Item goes (a tombstone), and so does the draft at the Source. */
    discard(itemId: string, entry: Entry, at: number): void {
      const item = deps.readItem(itemId);
      const detail = emailOf(item);
      if (!item || !detail || item.deletedAt !== null) throw invalid('That draft is gone');
      if (!detail.draft) throw invalid('That message has already been sent');
      const before = stateOf(item);
      const after = deps.writeState(item, { ...before, deletedAt: at }, at);
      const logged = deps.log({ ...entry, action: 'delete', itemId, before, after }, at);
      deps.emails.deleteBodies([itemId]);
      const rec = record(itemId);
      deps.outgoing.queue({
        ...base(item, logged, at),
        field: DELETE_FIELD,
        value: { commanderId: itemId, messageId: rec?.messageId ?? detail.messageId ?? '' },
      });
    },

    /** Retry for a message the Source refused: sent again (its earlier attempt is checked first). */
    retry(itemId: string): void {
      const row = sendRow(itemId);
      if (!row) throw invalid('That message isn’t waiting to send');
      deps.outgoing.retry(itemId);
    },

    /** Every message waiting to send, oldest first: held for Undo, waiting, on its way, or refused. */
    outbox(now: number): OutboxEntry[] {
      const rows = db.select().from(table).where(isNotNull(table.sendAt)).all();
      if (!rows.length) return [];
      const entries: OutboxEntry[] = [];
      for (const row of rows) {
        const send = sendRow(row.itemId);
        const item = deps.readItem(row.itemId);
        const detail = emailOf(item);
        if (!send || !item || !detail || item.deletedAt !== null) continue;
        const state =
          send.status === 'sending'
            ? 'sending'
            : send.status === 'failed'
              ? 'failed'
              : row.sendAt !== null && row.sendAt > now
                ? 'held'
                : 'waiting';
        entries.push({
          itemId: item.id,
          account: item.account as string,
          subject: detail.subject,
          to: [...detail.to, ...detail.cc, ...detail.bcc],
          state,
          sendAt: row.sendAt,
          error: send.error,
          threadKey: detail.threadKey,
        });
      }
      return entries.sort((a, b) => (a.sendAt ?? 0) - (b.sendAt ?? 0));
    },

    /** Every draft, Commander's and those synced in, newest first. */
    drafts(account?: string): DraftEntry[] {
      const items = deps.emails.drafts(account);
      const ids = items.map((item) => item.id);
      const own = new Set(
        ids.length
          ? db
              .select({ itemId: table.itemId })
              .from(table)
              .where(inArray(table.itemId, ids))
              .all()
              .map((row) => row.itemId)
          : [],
      );
      return items.flatMap((item) => {
        const detail = emailOf(item);
        if (!detail || !item.account) return [];
        return [
          {
            itemId: item.id,
            account: item.account,
            subject: detail.subject,
            to: detail.to,
            snippet: detail.snippet,
            updatedAt: item.updatedAt,
            commanders: own.has(item.id),
          },
        ];
      });
    },

    /**
     * The message written in Commander that a message the Source synced is (a crash came between
     * sending it and saving the Source's answer): the live Item of the same Account and Source whose
     * record has its Message-ID, or null.
     */
    matchMessage(source: Source, account: string, messageId: string | null): Item | null {
      if (!messageId) return null;
      const rows = db
        .select({ itemId: table.itemId })
        .from(table)
        .where(eq(table.messageId, messageId))
        .all();
      for (const { itemId } of rows) {
        const item = deps.readItem(itemId);
        if (item && item.deletedAt === null && item.source === source && item.account === account)
          return item;
      }
      // Outlook gives the message its own Message-ID: the Item holds that one, from the draft's answer.
      const byDetail = db
        .select({ itemId: schema.emailDetails.itemId })
        .from(schema.emailDetails)
        .innerJoin(table, eq(table.itemId, schema.emailDetails.itemId))
        .where(eq(schema.emailDetails.messageId, messageId))
        .all();
      for (const { itemId } of byDetail) {
        const item = deps.readItem(itemId);
        if (item && item.deletedAt === null && item.source === source && item.account === account)
          return item;
      }
      return null;
    },

    /** Whether the Item is a message written in Commander that hasn't reached its Source as sent. */
    isUnsent(item: Item): boolean {
      return isPendingEventExternalId(item.externalId) && !!record(item.id);
    },

    /** The attachments every message not yet sent still needs (their files are kept until then). */
    attachmentsInUse(): Set<string> {
      const used = new Set<string>();
      for (const row of db
        .select({ itemId: table.itemId, attachments: table.attachments })
        .from(table)
        .all()) {
        if (!row.attachments.length) continue;
        const queued = deps.outgoing
          .forItem(row.itemId)
          .some((change) => change.field === DRAFT_FIELD || change.field === SEND_FIELD);
        const item = deps.readItem(row.itemId);
        const draft = !!item && item.deletedAt === null && !!emailOf(item)?.draft;
        if (queued || draft) for (const each of row.attachments) used.add(each.id);
      }
      return used;
    },

    /** The Source answered Commander's save of a draft: its text then, to tell later changes made there. */
    answered(itemId: string, text: string) {
      db.update(table).set({ sourceText: text }).where(eq(table.itemId, itemId)).run();
    },

    /** The draft's text as the Source last answered Commander's save of it, or null. */
    answeredText(itemId: string): string | null {
      return (
        db.select({ sourceText: table.sourceText }).from(table).where(eq(table.itemId, itemId)).get()
          ?.sourceText ?? null
      );
    },

    settings: {
      read(): EmailComposeSettings {
        const row = db.select().from(settingsTable).where(eq(settingsTable.id, 1)).get();
        const undoSeconds = (UNDO_SEND_CHOICES as readonly number[]).includes(row?.undoSeconds ?? 0)
          ? (row?.undoSeconds as EmailComposeSettings['undoSeconds'])
          : DEFAULT_UNDO_SEND_SECONDS;
        return { defaultAccount: row?.defaultAccount ?? null, undoSeconds };
      },
      save(input: EmailComposeSettings, at: number): EmailComposeSettings {
        const parsed = emailComposeSettings.safeParse(input);
        if (!parsed.success) throw invalid('Undo send can hold a message for 5, 10, 20, 30 or 60 seconds');
        const values = { ...parsed.data, updatedAt: at };
        db.insert(settingsTable)
          .values({ id: 1, ...values })
          .onConflictDoUpdate({ target: settingsTable.id, set: values })
          .run();
        return parsed.data;
      },
    },

    signatures: {
      read(account: string): ComposeBody | null {
        return (
          db.select().from(emailSignatures).where(eq(emailSignatures.account, account)).get()?.body ?? null
        );
      },
      save(account: string, body: ComposeBody, at: number): ComposeBody {
        db.insert(emailSignatures)
          .values({ account, body, updatedAt: at })
          .onConflictDoUpdate({ target: emailSignatures.account, set: { body, updatedAt: at } })
          .run();
        return body;
      },
      remove(account: string) {
        db.delete(emailSignatures).where(eq(emailSignatures.account, account)).run();
      },
    },
  };
}

export type ComposeStore = ReturnType<typeof composeIn>;
