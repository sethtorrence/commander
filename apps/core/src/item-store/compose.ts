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
// Send later (#139, the domain's email-send-later.ts): a scheduled message stays a draft (in no thread
// or view, and out of Drafts) with its time and who holds it in its record. One Commander sends waits
// here, saved to the Source's Drafts, until the Core's send-later clock releases it at its time as an
// ordinary `send` with no Undo hold (or finds its time passed while Commander wasn't running: missed,
// for the User to decide). One Microsoft holds is queued as a `send` at once, carrying its time
// (`deferUntil`), so Outlook keeps it in Exchange's Outbox; taking it back before then (Cancel, Edit,
// Change time, Send now, Discard) queues `cancel-send`, which takes it out of the Outbox, and the
// message goes back to being a draft (or goes again at its new time). It is put under its placeholder
// id again, so nothing that follows mistakes the message gone from Outlook for one that was sent.
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
  CANCEL_SEND_FIELD,
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
  type ScheduledEntry,
  SEND_FIELD,
  type SendLaterHeldBy,
  type Source,
  sendLaterProblem,
  UNDO_SEND_CHOICES,
} from '@commander/domain';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
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
  // Send later (#139): when the User chose it to go, and who holds it until then; null unless scheduled.
  scheduledAt: number | null;
  heldBy: SendLaterHeldBy | null;
  // When Commander found its time passed while it wasn't running; null unless missed.
  missedAt: number | null;
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
  // The message is under another external id from now on (its placeholder, when Outlook no longer has it).
  rekey(itemId: string, externalId: string): void;
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
      scheduledAt: row.scheduledAt,
      heldBy: row.heldBy,
      missedAt: row.missedAt,
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
      scheduledAt: next.scheduledAt,
      heldBy: next.heldBy,
      missedAt: next.missedAt,
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

  // A scheduled message as the composer last left it (its record and its Item), to send or save again.
  function draftOfRecord(item: Item, detail: EmailDetail, rec: ComposeRecord): ComposeDraft {
    return {
      itemId: item.id,
      mode: rec.mode,
      account: item.account as string,
      replyToItemId: rec.replyToItemId,
      to: detail.to,
      cc: detail.cc,
      bcc: detail.bcc,
      subject: detail.subject,
      body: rec.body,
      attachments: rec.attachments,
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
    if (before?.scheduledAt != null)
      throw invalid('This message is scheduled: edit it from Scheduled to change it.');
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
      scheduledAt: null,
      heldBy: null,
      missedAt: null,
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

  const base = (item: Item, entry: ActivityEntry | null, at: number) => ({
    account: item.account as string,
    source: item.source as Source,
    itemId: item.id,
    externalId: item.externalId as string,
    synced: null,
    madeAt: at,
    entryId: entry?.id ?? null,
  });

  // The `send` change waiting for the message, if one is.
  const sendRow = (itemId: string) =>
    deps.outgoing.forItem(itemId).find((row) => row.field === SEND_FIELD) ?? null;

  const mayOnlyBeSentByTheUser = (by: Actor) => {
    if (by.kind !== 'user') throw invalid('Only you can send email: Ares can draft one for you to send.');
  };
  const needsSomeone = (draft: Pick<ComposeDraft, 'to' | 'cc' | 'bcc'>) => {
    if (!draft.to.length && !draft.cc.length && !draft.bcc.length)
      throw invalid('Add someone to send this to.');
  };

  // Sends the message: saved as it is, then queued to send at `sendAt` (the end of its Undo time, or
  // now for a scheduled message whose time came).
  function send(
    input: ComposeDraft,
    context: ComposeContext,
    sendAt: number,
    at: number,
    why = 'Sent',
  ): { itemId: string; sendAt: number } {
    mayOnlyBeSentByTheUser(context.by);
    needsSomeone(input);
    const { item, rec, message } = write(input, context, at);
    const { draft: _draft, ...detail } = emailOf(item) as EmailDetail;
    const sending: EmailDetail = { ...detail, sentAt: at };
    const before = stateOf(item);
    const after = deps.writeState(item, { ...before, detail: sending }, at);
    const sent = deps.log({ ...context, action: 'update', itemId: item.id, before, after, why }, at);
    writeRecord({ ...rec, sendAt }, at);
    deps.outgoing.queue({ ...base(item, sent, at), field: SEND_FIELD, value: message, holdUntil: sendAt });
    return { itemId: item.id, sendAt };
  }

  // A scheduled message, live and still unsent, with its record.
  function scheduledOf(itemId: string): { item: Item; detail: EmailDetail; rec: ComposeRecord } {
    const item = deps.readItem(itemId);
    const detail = emailOf(item);
    const rec = record(itemId);
    if (!item || !detail || item.deletedAt !== null) throw invalid('That message is gone');
    if (!detail.draft) throw invalid('It has already been sent.');
    if (!rec || rec.scheduledAt === null || rec.heldBy === null)
      throw invalid('That message isn’t scheduled');
    return { item, detail, rec };
  }

  const contextOf = (item: Item, detail: EmailDetail, entry: Entry): ComposeContext => ({
    ...entry,
    source: item.source as Source,
    from: detail.from ?? { name: null, address: '' },
  });

  // A message Microsoft holds can be taken back only before its time, and not while it is on its way to
  // Outlook. One that never reached Outlook (waiting for the connection) can be at any time.
  function microsoftMayTakeBack(itemId: string, rec: ComposeRecord, at: number) {
    const row = sendRow(itemId);
    if (row?.status === 'sending') throw invalid('It’s on its way to Microsoft: try again in a moment.');
    const reached = !row || row.attemptedAt !== null;
    if (reached && (rec.scheduledAt ?? 0) <= at)
      throw invalid('It’s past its time: Microsoft has sent it, or is sending it now.');
  }

  // Takes a message Microsoft holds back from Outlook: a `send` that never reached it just leaves the
  // queue; one that did (or may have) is taken out of the Outbox (`cancel-send`), and the message goes
  // under its placeholder id again, so what follows makes it afresh in Outlook.
  function takeBackFromMicrosoft(item: Item, rec: ComposeRecord, at: number): Item {
    const row = sendRow(item.id);
    if (row) deps.outgoing.settle([row.id]);
    const reached = !row || row.attemptedAt !== null;
    if (!reached) return item;
    const placeholder = pendingEventExternalId(item.id);
    deps.rekey(item.id, placeholder);
    const moved = { ...item, externalId: placeholder };
    deps.outgoing.queue({
      ...base(moved, null, at),
      field: CANCEL_SEND_FIELD,
      value: { commanderId: item.id, messageId: rec.messageId },
    });
    return moved;
  }

  // The scheduled message as it should go to Outlook to be held until `deferUntil` (or sent now).
  function heldByMicrosoft(item: Item, detail: EmailDetail, rec: ComposeRecord, deferUntil: number | null) {
    const draft = draftOfRecord(item, detail, rec);
    return {
      ...outgoingOf(item.id, draft, detail.from ?? { name: null, address: '' }, detail, rec),
      deferUntil,
    };
  }

  // A scheduled message the User took back (Cancel, Edit, Discard): it won't go, and is a draft again,
  // in the Source's Drafts too unless it is being discarded.
  function unschedule(itemId: string, at: number, { redraft }: { redraft: boolean }): Item {
    const { item, detail, rec } = scheduledOf(itemId);
    let current = item;
    if (rec.heldBy === 'microsoft') {
      microsoftMayTakeBack(itemId, rec, at);
      current = takeBackFromMicrosoft(item, rec, at);
      if (redraft) {
        const draft = draftOfRecord(current, detail, rec);
        const message = outgoingOf(itemId, draft, detail.from ?? { name: null, address: '' }, detail, rec);
        deps.outgoing.queue({ ...base(current, null, at), field: DRAFT_FIELD, value: message });
      }
    }
    writeRecord({ ...rec, scheduledAt: null, heldBy: null, missedAt: null }, at);
    return current;
  }

  // The messages Commander holds for later and hasn't found missed, still unsent drafts (one deleted in
  // Gmail meanwhile, or its Account removed, waits for nothing), soonest first.
  function waitingOnCommander(): { itemId: string; scheduledAt: number }[] {
    return db
      .select({ itemId: table.itemId, scheduledAt: table.scheduledAt })
      .from(table)
      .where(and(eq(table.heldBy, 'commander'), isNull(table.missedAt), isNotNull(table.scheduledAt)))
      .all()
      .flatMap((row) => {
        const item = deps.readItem(row.itemId);
        const live = !!item && item.deletedAt === null && !!emailOf(item)?.draft;
        return live && row.scheduledAt !== null ? [{ itemId: row.itemId, scheduledAt: row.scheduledAt }] : [];
      })
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

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
      return send(input, context, sendAt, at);
    },

    /**
     * Send later (#139): the message, saved as it is, goes at `sendAt`. Commander keeps it (saved to the
     * Source's Drafts meanwhile) until its send-later clock releases it; Microsoft is handed it at once,
     * to hold in Exchange's Outbox. Only the User schedules. Runs inside a transaction.
     */
    schedule(
      input: ComposeDraft,
      context: ComposeContext,
      sendAt: number,
      heldBy: SendLaterHeldBy,
      at: number,
    ): { itemId: string; sendAt: number; heldBy: SendLaterHeldBy } {
      mayOnlyBeSentByTheUser(context.by);
      needsSomeone(input);
      const problem = sendLaterProblem(sendAt, at);
      if (problem) throw invalid(problem);
      const { item, rec, message, entry } = write(input, { ...context, why: 'Scheduled to send later' }, at);
      writeRecord({ ...rec, scheduledAt: sendAt, heldBy, missedAt: null }, at);
      if (heldBy === 'microsoft')
        deps.outgoing.queue({
          ...base(item, entry, at),
          field: SEND_FIELD,
          value: { ...message, deferUntil: sendAt },
        });
      else deps.outgoing.queue({ ...base(item, entry, at), field: DRAFT_FIELD, value: message });
      return { itemId: item.id, sendAt, heldBy };
    },

    /** Change time: the scheduled message goes at `sendAt` instead (missed or not). Runs inside a transaction. */
    reschedule(itemId: string, sendAt: number, at: number): void {
      const { item, detail, rec } = scheduledOf(itemId);
      const problem = sendLaterProblem(sendAt, at);
      if (problem) throw invalid(problem);
      if (rec.heldBy === 'microsoft') {
        microsoftMayTakeBack(itemId, rec, at);
        const moved = takeBackFromMicrosoft(item, rec, at);
        deps.outgoing.queue({
          ...base(moved, null, at),
          field: SEND_FIELD,
          value: heldByMicrosoft(moved, detail, rec, sendAt),
        });
      }
      writeRecord({ ...rec, scheduledAt: sendAt, missedAt: null }, at);
    },

    /**
     * Send now (from Scheduled or a missed send's Update line), or a message Commander holds whose time
     * came: it goes at once, as an ordinary send with no Undo hold. Runs inside a transaction.
     */
    sendScheduled(itemId: string, entry: Entry, at: number, why = 'Sent now'): void {
      mayOnlyBeSentByTheUser(entry.by);
      const { item, detail, rec } = scheduledOf(itemId);
      if (rec.heldBy === 'commander') {
        writeRecord({ ...rec, scheduledAt: null, heldBy: null, missedAt: null }, at);
        send(draftOfRecord(item, detail, rec), contextOf(item, detail, entry), at, at, why);
        return;
      }
      microsoftMayTakeBack(itemId, rec, at);
      const moved = takeBackFromMicrosoft(item, rec, at);
      const { draft: _draft, ...sent } = detail;
      const before = stateOf(moved);
      const after = deps.writeState(moved, { ...before, detail: { ...sent, sentAt: at } }, at);
      const logged = deps.log({ ...entry, action: 'update', itemId, before, after, why }, at);
      writeRecord({ ...rec, sendAt: at, scheduledAt: null, heldBy: null, missedAt: null }, at);
      deps.outgoing.queue({
        ...base(moved, logged, at),
        field: SEND_FIELD,
        value: heldByMicrosoft(moved, detail, rec, null),
      });
    },

    /** Cancel or Edit: the scheduled message won't go, and is a draft again. Runs inside a transaction. */
    unschedule(itemId: string, at: number): Item {
      return unschedule(itemId, at, { redraft: true });
    },

    /** Its time passed while Commander wasn't running (or the machine slept): missed, for the User to decide. */
    miss(itemId: string, at: number): void {
      const rec = record(itemId);
      if (rec?.heldBy !== 'commander' || rec.scheduledAt === null || rec.missedAt !== null) return;
      writeRecord({ ...rec, missedAt: at }, at);
    },

    /** The messages Commander holds that are due by `at` and not yet missed, soonest first. */
    due(at: number): { itemId: string; scheduledAt: number }[] {
      return waitingOnCommander().filter((each) => each.scheduledAt <= at);
    },

    /** When the next message Commander holds is due (not yet missed), or null when none is waiting. */
    nextDueAt(): number | null {
      return waitingOnCommander()[0]?.scheduledAt ?? null;
    },

    /** Every scheduled message, soonest first, with who holds it and how it stands. */
    scheduled(): ScheduledEntry[] {
      const rows = db.select().from(table).where(isNotNull(table.scheduledAt)).all();
      const entries: ScheduledEntry[] = [];
      for (const row of rows) {
        const item = deps.readItem(row.itemId);
        const detail = emailOf(item);
        if (!item || !detail?.draft || item.deletedAt !== null || !row.heldBy || row.scheduledAt === null)
          continue;
        const send = row.heldBy === 'microsoft' ? sendRow(row.itemId) : null;
        const cancelling = deps.outgoing.forItem(row.itemId).find((each) => each.field === CANCEL_SEND_FIELD);
        const failed = send?.status === 'failed' ? send : cancelling?.status === 'failed' ? cancelling : null;
        entries.push({
          itemId: item.id,
          account: item.account as string,
          subject: detail.subject,
          to: [...detail.to, ...detail.cc, ...detail.bcc],
          sendAt: row.scheduledAt,
          heldBy: row.heldBy,
          state:
            row.heldBy === 'commander'
              ? row.missedAt !== null
                ? 'missed'
                : 'waiting'
              : failed
                ? 'failed'
                : send || cancelling
                  ? 'handing'
                  : 'held',
          error: failed?.error ?? null,
        });
      }
      return entries.sort((a, b) => a.sendAt - b.sendAt);
    },

    /** The missed sends still waiting on the User, with when each was due and when it was found missed. */
    missed(): { itemId: string; dueAt: number; missedAt: number }[] {
      return db
        .select({ itemId: table.itemId, scheduledAt: table.scheduledAt, missedAt: table.missedAt })
        .from(table)
        .where(and(eq(table.heldBy, 'commander'), isNotNull(table.missedAt)))
        .all()
        .flatMap((row) => {
          const item = deps.readItem(row.itemId);
          const live = !!item && item.deletedAt === null && !!emailOf(item)?.draft;
          return live && row.scheduledAt !== null && row.missedAt !== null
            ? [{ itemId: row.itemId, dueAt: row.scheduledAt, missedAt: row.missedAt }]
            : [];
        });
    },

    /** Whether Microsoft holds the message for later (so its leaving Drafts is no deletion). */
    heldByMicrosoft(itemId: string): boolean {
      const rec = record(itemId);
      return rec?.heldBy === 'microsoft' && rec.scheduledAt !== null;
    },

    /**
     * Takes a message back before it goes (held for Undo, or waiting for a connection): it is a draft
     * again. Refused once it is on its way or sent. Runs inside a transaction.
     */
    undoSend(itemId: string, entry: Entry, at: number): Item {
      const item = deps.readItem(itemId);
      const detail = emailOf(item);
      if (!item || !detail || item.deletedAt !== null) throw invalid('That message is gone');
      if (record(itemId)?.scheduledAt != null)
        throw invalid('It’s scheduled: cancel it or edit it from Scheduled.');
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

    /**
     * Discards a draft (or a scheduled message, taken back first): its Item goes (a tombstone), and so
     * does the draft at the Source.
     */
    discard(itemId: string, entry: Entry, at: number): void {
      if (record(itemId)?.scheduledAt != null) unschedule(itemId, at, { redraft: false });
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

    /**
     * Retry for a message the Source refused: sent again (its earlier attempt is checked first), or
     * (send later held by Microsoft) handed to Outlook, or taken back out of its Outbox, again.
     */
    retry(itemId: string): void {
      const row = deps.outgoing
        .forItem(itemId)
        .find((each) => each.field === SEND_FIELD || each.field === CANCEL_SEND_FIELD);
      if (!row) throw invalid('That message isn’t waiting to send');
      deps.outgoing.retry(itemId);
    },

    /**
     * Every message waiting to send, oldest first: held for Undo, waiting, on its way, or refused.
     * Scheduled messages are in Scheduled instead.
     */
    outbox(now: number): OutboxEntry[] {
      const rows = db
        .select()
        .from(table)
        .where(and(isNotNull(table.sendAt), isNull(table.scheduledAt)))
        .all();
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

    /** Every draft, Commander's and those synced in, newest first (scheduled messages are in Scheduled). */
    drafts(account?: string): DraftEntry[] {
      const items = deps.emails.drafts(account);
      const ids = items.map((item) => item.id);
      const rows = ids.length
        ? db
            .select({ itemId: table.itemId, scheduledAt: table.scheduledAt })
            .from(table)
            .where(inArray(table.itemId, ids))
            .all()
        : [];
      const own = new Set(rows.map((row) => row.itemId));
      const scheduled = new Set(rows.filter((row) => row.scheduledAt !== null).map((row) => row.itemId));
      return items.flatMap((item) => {
        const detail = emailOf(item);
        if (!detail || !item.account || scheduled.has(item.id)) return [];
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
