import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ComposeDraft,
  DELETE_FIELD,
  DRAFT_FIELD,
  type EmailDetail,
  type OutgoingMessage,
  SEND_FIELD,
  type SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ComposeContext, type ItemStore, openItemStore } from '.';

// Messages written in Commander (#138) in the Item store: a draft is an email Item from its first save,
// kept out of threads and views and queued for the Source's Drafts folder; sending holds it for the Undo
// time in the outgoing queue, shows it in its thread at once, and the Source's answer (or, after a
// crash, the synced copy's Message-ID) makes it the same Item as the Source's message, so it appears
// once. Only the User sends.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACCOUNT = 'google:sam';
const T = Date.UTC(2026, 9, 7, 9);
const me = { name: 'Sam Rivera', address: 'sam@home.test' };
const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
const user: ComposeContext = { by: { kind: 'user' }, source: 'gmail', from: me };

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-compose-'));
  clock = T;
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function email(id: string, fields: Partial<EmailDetail> = {}): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@northwind.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@northwind.test>`,
    sourceThreadId: 'g-thread',
    from: dana,
    to: [me],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Q4 offsite dates',
    sentAt: T - 60 * 60_000,
    snippet: 'Can you do Thursday?',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
  return {
    externalId: id,
    kind: 'email',
    title: detail.subject,
    people: ['dana@northwind.test'],
    status: 'open',
    detail,
    body: { text: 'Can you do Thursday?', html: null, textFromHtml: false, truncated: false },
  };
}

function receive(...items: SourceItem[]) {
  return store.saveFromSource({ source: 'gmail', account: ACCOUNT, items, deleted: [] });
}

const original = () => store.fromSource({ source: 'gmail', account: ACCOUNT }, ['m1'])[0];

function reply(fields: Partial<ComposeDraft> = {}): ComposeDraft {
  return {
    mode: 'reply',
    account: ACCOUNT,
    replyToItemId: original()?.id ?? null,
    to: [dana],
    cc: [],
    bcc: [],
    subject: 'Re: Q4 offsite dates',
    body: [{ type: 'paragraph', runs: [{ text: 'Thursday works.' }] }],
    attachments: [],
    ...fields,
  };
}

const quote = { html: '<div class="gmail_quote">Can you do Thursday?</div>', text: '> Can you do Thursday?' };
const itemOf = (itemId: string) => store.get(itemId)?.item;
const detailOf = (itemId: string) => itemOf(itemId)?.detail as EmailDetail;
const queued = (itemId: string) => store.outgoing.forItem(itemId);
const threadKeyOf = () => (original()?.detail as EmailDetail | undefined)?.threadKey ?? '';
const threadOf = () => store.emailThread(ACCOUNT, threadKeyOf());

describe('a draft', () => {
  it('is an email Item from its first save, kept out of threads and views, and queued for Gmail’s Drafts', () => {
    receive(email('m1'));
    const { itemId } = store.compose.save(reply(), { ...user, quote });

    const item = itemOf(itemId);
    expect(item).toMatchObject({
      kind: 'email',
      source: 'gmail',
      account: ACCOUNT,
      externalId: `commander:${itemId}`,
    });
    expect(detailOf(itemId)).toMatchObject({
      draft: true,
      sentByMe: true,
      inInbox: false,
      from: me,
      to: [dana],
      subject: 'Re: Q4 offsite dates',
      inReplyTo: '<m1@northwind.test>',
      references: ['<m1@northwind.test>'],
      threadKey: threadKeyOf(),
    });
    expect(threadOf()?.messages.map((each) => each.item.id)).toEqual([original()?.id]);
    expect(store.emailThreads().threads).toHaveLength(1);
    expect(store.compose.drafts()).toEqual([
      expect.objectContaining({ itemId, subject: 'Re: Q4 offsite dates', commanders: true }),
    ]);

    const [draft] = queued(itemId);
    expect(draft).toMatchObject({ field: DRAFT_FIELD, status: 'pending', nextAttemptAt: null });
    expect(draft?.value).toMatchObject({
      commanderId: itemId,
      messageId: `<${itemId}@home.test>`,
      from: me,
      inReplyTo: '<m1@northwind.test>',
      references: ['<m1@northwind.test>'],
      sourceThreadId: 'g-thread',
      replyToExternalId: 'm1',
      text: 'Thursday works.\n\n> Can you do Thursday?',
    } satisfies Partial<OutgoingMessage>);
    expect((draft?.value as OutgoingMessage | undefined)?.html).toContain(
      '<div class="gmail_quote">Can you do Thursday?</div>',
    );
  });

  it('saves again into the one change waiting, keeping its quote and Message-ID', () => {
    receive(email('m1'));
    const { itemId } = store.compose.save(reply(), { ...user, quote });
    clock += 2_000;
    store.compose.save(
      reply({ itemId, body: [{ type: 'paragraph', runs: [{ text: 'Friday, actually.' }] }] }),
      user,
    );

    expect(queued(itemId)).toHaveLength(1);
    expect((queued(itemId)[0]?.value as OutgoingMessage | undefined)?.text).toBe(
      'Friday, actually.\n\n> Can you do Thursday?',
    );
    expect(store.compose.record(itemId)).toMatchObject({ quote, messageId: `<${itemId}@home.test>` });
    expect(store.emailBody(itemId)?.text).toBe('Friday, actually.\n\n> Can you do Thursday?');
  });

  it('takes the Source’s id from Gmail’s answer, and its text then', () => {
    receive(email('m1'));
    const { itemId } = store.compose.save(reply(), user);
    const answer = email('draft:r-1', {
      ...detailOf(itemId),
      messageId: `<${itemId}@home.test>`,
      draft: true,
      sentByMe: false,
    });
    store.saveFromSource({
      source: 'gmail',
      account: ACCOUNT,
      items: [
        {
          ...answer,
          commanderItemId: itemId,
          body: { text: 'Thursday works.', html: null, textFromHtml: false, truncated: false },
        },
      ],
      deleted: [],
    });

    expect(itemOf(itemId)?.externalId).toBe('draft:r-1');
    expect(store.compose.answeredText(itemId)).toBe('Thursday works.');
    expect(store.compose.drafts()).toHaveLength(1);
  });

  it('refuses attachments over 35 MB, and a draft of another Account', () => {
    receive(email('m1'));
    const big = {
      id: crypto.randomUUID(),
      name: 'big.bin',
      type: 'application/octet-stream',
      size: 36 * 1024 * 1024,
    };
    expect(() => store.compose.save(reply({ attachments: [big] }), user)).toThrow(/35 MB per message/);
    const { itemId } = store.compose.save(reply(), user);
    expect(() => store.compose.save(reply({ itemId, account: 'google:other' }), user)).toThrow(
      'A draft goes from the Account it was written in',
    );
  });

  it('is discarded: its Item goes, the draft at Gmail is deleted, and a sync doesn’t bring it back', () => {
    receive(email('m1'));
    const { itemId } = store.compose.save(reply(), user);
    store.saveFromSource({
      source: 'gmail',
      account: ACCOUNT,
      items: [{ ...email('draft:r-1', { ...detailOf(itemId), draft: true }), commanderItemId: itemId }],
      deleted: [],
    });
    store.compose.discard(itemId, { by: { kind: 'user' } });

    expect(itemOf(itemId)?.deletedAt).not.toBeNull();
    expect(store.compose.drafts()).toEqual([]);
    expect(queued(itemId).map((row) => row.field)).toContain(DELETE_FIELD);
    receive(email('draft:r-1', { ...detailOf(itemId), draft: true }));
    expect(itemOf(itemId)?.deletedAt).not.toBeNull();
  });

  it('made in Gmail opens and saves as a draft of Commander’s, still Gmail’s draft', () => {
    receive(
      email('draft:r-9', {
        draft: true,
        sentByMe: false,
        inInbox: false,
        from: me,
        to: [dana],
        subject: 'Lunch?',
      }),
    );
    const [synced] = store.compose.drafts();
    expect(synced).toMatchObject({ subject: 'Lunch?', commanders: false });

    store.compose.save(
      { ...reply({ mode: 'new', replyToItemId: null, subject: 'Lunch next week?' }), itemId: synced?.itemId },
      user,
    );

    expect(itemOf(synced?.itemId as string)?.externalId).toBe('draft:r-9');
    expect(store.compose.drafts()).toEqual([
      expect.objectContaining({ subject: 'Lunch next week?', commanders: true }),
    ]);
    expect(queued(synced?.itemId as string)[0]).toMatchObject({
      field: DRAFT_FIELD,
      externalId: 'draft:r-9',
    });
  });
});

describe('sending', () => {
  it('holds the message for the Undo time, and shows it in its thread at once', () => {
    receive(email('m1'));
    const { itemId, sendAt } = store.compose.send(reply(), user, T + 10_000);

    expect(sendAt).toBe(T + 10_000);
    expect(detailOf(itemId).draft).toBeUndefined();
    expect(threadOf()?.messages.map((each) => each.item.id)).toEqual([original()?.id, itemId]);
    const send = queued(itemId).find((row) => row.field === SEND_FIELD);
    expect(send).toMatchObject({ status: 'pending', nextAttemptAt: T + 10_000 });
    expect(store.outgoing.due(ACCOUNT, T + 5_000)).toEqual([]);
    expect(store.outgoing.due(ACCOUNT, T + 10_000)).toHaveLength(1);
    expect(store.compose.outbox()).toEqual([
      expect.objectContaining({ itemId, state: 'held', sendAt: T + 10_000 }),
    ]);
    expect(store.compose.drafts()).toEqual([]);
  });

  it('is taken back by Undo while it waits: a draft again, with nothing left to send', () => {
    receive(email('m1'));
    const { itemId } = store.compose.send(reply(), user, T + 10_000);
    clock += 4_000;
    store.compose.undoSend(itemId, { by: { kind: 'user' } });

    expect(detailOf(itemId).draft).toBe(true);
    expect(queued(itemId).some((row) => row.field === SEND_FIELD)).toBe(false);
    expect(store.compose.outbox()).toEqual([]);
    expect(threadOf()?.messages).toHaveLength(1);
    expect(store.compose.record(itemId)?.sendAt).toBeNull();
  });

  it('can’t be taken back once it is on its way', () => {
    receive(email('m1'));
    const { itemId } = store.compose.send(reply(), user, T);
    const send = queued(itemId).find((row) => row.field === SEND_FIELD);
    store.outgoing.markSending([send?.id as number], T);

    expect(() => store.compose.undoSend(itemId, { by: { kind: 'user' } })).toThrow(
      'It’s on its way, so it can’t be taken back now.',
    );
    expect(store.compose.outbox()).toEqual([expect.objectContaining({ itemId, state: 'sending' })]);
  });

  it('is never sent by Ares', () => {
    receive(email('m1'));
    expect(() => store.compose.send(reply(), { ...user, by: { kind: 'ares' } }, T)).toThrow(
      'Only you can send email: Ares can draft one for you to send.',
    );
    expect(() => store.compose.send(reply({ to: [] }), user, T)).toThrow('Add someone to send this to.');
  });

  it('waits in the Outbox once its time has passed, and stays there with the reason when Gmail refuses it', () => {
    receive(email('m1'));
    const { itemId } = store.compose.send(reply(), user, T + 10_000);
    clock = T + 20_000;
    expect(store.compose.outbox()[0]?.state).toBe('waiting');

    const send = queued(itemId).find((row) => row.field === SEND_FIELD);
    store.outgoing.fail([send?.id as number], {
      error: 'Gmail refused to send this message: Invalid To header',
      failed: true,
      nextAttemptAt: null,
    });
    expect(store.compose.outbox()).toEqual([
      expect.objectContaining({
        state: 'failed',
        error: 'Gmail refused to send this message: Invalid To header',
      }),
    ]);
    store.compose.retry(itemId);
    expect(store.compose.outbox()[0]?.state).toBe('waiting');
  });

  it('goes at once when Commander is quitting', () => {
    receive(email('m1'));
    store.compose.send(reply(), user, T + 60_000);

    expect(store.compose.releaseHeld()).toEqual([ACCOUNT]);
    expect(store.outgoing.due(ACCOUNT, T)).toHaveLength(1);
  });

  it('appears once in its thread: the answer names it, and the next sync finds the same Item', () => {
    receive(email('m1'));
    const { itemId } = store.compose.send(reply(), user, T);
    const sent = email('m2', {
      messageId: `<${itemId}@home.test>`,
      inReplyTo: '<m1@northwind.test>',
      references: ['<m1@northwind.test>'],
      from: me,
      to: [dana],
      sentByMe: true,
      inInbox: false,
      labels: [{ id: 'SENT', name: 'Sent' }],
      subject: 'Re: Q4 offsite dates',
      sentAt: T + 1_000,
    });
    const send = queued(itemId).find((row) => row.field === SEND_FIELD);
    store.outgoing.settle([send?.id as number]);
    store.saveFromSource({
      source: 'gmail',
      account: ACCOUNT,
      items: [{ ...sent, commanderItemId: itemId }],
      deleted: [],
    });
    // The next sync brings the same message.
    receive(sent);

    expect(itemOf(itemId)?.externalId).toBe('m2');
    expect(threadOf()?.messages.map((each) => each.item.id)).toEqual([original()?.id, itemId]);
    expect(store.compose.outbox()).toEqual([]);
  });

  it('appears once when a sync brings the sent message before Gmail’s answer was saved (a crash)', () => {
    receive(email('m1'));
    const { itemId } = store.compose.send(reply(), user, T);
    receive(
      email('m2', {
        messageId: `<${itemId}@home.test>`,
        inReplyTo: '<m1@northwind.test>',
        references: ['<m1@northwind.test>'],
        from: me,
        sentByMe: true,
        inInbox: false,
        sentAt: T + 1_000,
      }),
    );

    expect(itemOf(itemId)?.externalId).toBe('m2');
    expect(threadOf()?.messages.map((each) => each.item.id)).toEqual([original()?.id, itemId]);
  });

  it('takes the place of a copy a sync saved first, which gives way', () => {
    receive(email('m1'));
    const { itemId } = store.compose.send(reply(), user, T);
    // A copy saved first under its own id (Outlook gives its sent copy a Message-ID of its own).
    receive(
      email('m2', {
        messageId: '<outlook-own@x>',
        from: me,
        sentByMe: true,
        inInbox: false,
        inReplyTo: '<m1@northwind.test>',
        references: ['<m1@northwind.test>'],
        sentAt: T + 1_000,
      }),
    );
    const copy = store.fromSource({ source: 'gmail', account: ACCOUNT }, ['m2'])[0];
    store.saveFromSource({
      source: 'gmail',
      account: ACCOUNT,
      items: [
        {
          ...email('m2', {
            messageId: '<outlook-own@x>',
            from: me,
            sentByMe: true,
            inInbox: false,
            inReplyTo: '<m1@northwind.test>',
            references: ['<m1@northwind.test>'],
            sentAt: T + 1_000,
          }),
          commanderItemId: itemId,
        },
      ],
      deleted: [],
    });

    expect(itemOf(itemId)?.externalId).toBe('m2');
    expect(itemOf(copy?.id as string)?.deletedAt).not.toBeNull();
    expect(threadOf()?.messages.map((each) => each.item.id)).toEqual([original()?.id, itemId]);
  });

  it('stays sent whatever a late answer to saving its draft says', () => {
    receive(email('m1'));
    const { itemId } = store.compose.save(reply(), user);
    store.compose.send(reply({ itemId }), user, T + 10_000);
    store.saveFromSource({
      source: 'gmail',
      account: ACCOUNT,
      items: [{ ...email('draft:r-1', { ...detailOf(itemId), draft: true }), commanderItemId: itemId }],
      deleted: [],
    });

    expect(detailOf(itemId).draft).toBeUndefined();
    expect(threadOf()?.messages).toHaveLength(2);
  });
});

describe('Settings', () => {
  it('keeps the default Account, the Undo time and each Account’s signature', () => {
    expect(store.compose.settings.read()).toEqual({ defaultAccount: null, undoSeconds: 10 });
    store.compose.settings.save({ defaultAccount: ACCOUNT, undoSeconds: 30 });
    expect(store.compose.settings.read()).toEqual({ defaultAccount: ACCOUNT, undoSeconds: 30 });

    expect(store.compose.signatures.read(ACCOUNT)).toBeNull();
    const signature = [{ type: 'paragraph' as const, runs: [{ text: 'Sam', bold: true }] }];
    store.compose.signatures.save(ACCOUNT, signature);
    expect(store.compose.signatures.read(ACCOUNT)).toEqual(signature);
  });
});
