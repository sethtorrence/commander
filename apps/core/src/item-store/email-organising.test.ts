import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type EmailDetail,
  type ItemAction,
  type SourceItem,
  type ThreadAction,
  threadActionFields,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Organising email in the Item store (#135): archive, read, star, Trash and labels are edits of each
// message's synced fields, so they show at once, queue for Gmail in the same transaction, survive a
// sync and undo field by field (ADR 0003). Snooze is Commander's own field: never queued, kept through
// syncs, and woken at its time. The Email Section reads its views, their counts and its search here.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ALEX = 'google:alex';
const SAM = 'google:sam';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 7, 9);
const HOUR = 60 * 60_000;

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-email-organising-'));
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
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: `g-${id}`,
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Subject ${id}`,
    sentAt: T - HOUR,
    snippet: `Snippet ${id}`,
    read: false,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }, ...(fields.read ? [] : [{ id: 'UNREAD', name: 'Unread' }])],
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
    people: [detail.from?.address ?? ''],
    status: detail.inInbox ? 'open' : 'archived',
    detail,
    body: { text: `Body of ${id}`, html: null, textFromHtml: false, truncated: false },
  };
}

const reply = (id: string, parent: SourceItem, fields: Partial<EmailDetail> = {}): SourceItem => {
  const of = parent.detail as EmailDetail;
  return email(id, {
    inReplyTo: of.messageId,
    references: [of.messageId as string],
    sourceThreadId: of.sourceThreadId,
    subject: `Re: ${of.subject}`,
    ...fields,
  });
};

const save = (items: SourceItem[], account = ALEX) =>
  store.saveFromSource({ source: 'gmail', account, items, deleted: [] });

const subjects = (query: Parameters<ItemStore['emailThreads']>[0] = {}) =>
  store.emailThreads(query).threads.map((thread) => thread.subject);

const threadNamed = (subject: string) => {
  const found = store
    .emailThreads({ view: 'inbox' })
    .threads.concat(
      ...(['starred', 'snoozed', 'archive', 'trash'] as const).map(
        (view) => store.emailThreads({ view }).threads,
      ),
    )
    .find((thread) => thread.subject === subject);
  if (!found) throw new Error(`No thread ${subject}`);
  return found;
};

/** Does a thread action as the window does: one edit-fields per message, as one change. */
function act(subject: string, action: ThreadAction) {
  const thread = store.emailThread(threadNamed(subject).account, threadNamed(subject).threadKey);
  const messages = (thread?.messages ?? []).map(({ item }) => ({
    id: item.id,
    detail: item.detail as EmailDetail,
  }));
  const actions = threadActionFields(action, messages).map(
    ({ itemId, fields }): ItemAction => ({ type: 'edit-fields', itemId, fields }),
  );
  return store.recordAll(actions, user);
}

const undo = (entries: { id: number }[]) =>
  store.recordAll(
    [...entries].reverse().map((entry): ItemAction => ({ type: 'undo', entryId: entry.id })),
    user,
  );

const queued = () => store.outgoing.list().map(({ field }) => field);

const offsite = email('a', { subject: 'Q4 offsite dates', sentAt: T - 3 * HOUR });
const offsiteReply = reply('b', offsite, { sentAt: T - 2 * HOUR });
const receipt = email('r', { subject: 'Your order has shipped', sentAt: T - HOUR, read: true });

describe('organising a thread', () => {
  it('archives at once: the thread leaves the inbox for Archive, and each message’s change queues for Gmail', () => {
    save([offsite, offsiteReply, receipt]);

    act('Re: Q4 offsite dates', { type: 'archive' });

    expect(subjects()).toEqual(['Your order has shipped']);
    expect(subjects({ view: 'archive' })).toEqual(['Re: Q4 offsite dates']);
    expect(queued()).toEqual(['inbox', 'inbox']);
  });

  it('keeps the change through a sync that still has Gmail’s old value, and undo takes it back', () => {
    save([offsite, offsiteReply]);
    const entries = act('Re: Q4 offsite dates', { type: 'archive' });

    // A sync before the change reached Gmail.
    save([offsite, offsiteReply]);
    expect(subjects()).toEqual([]);

    undo(entries);
    expect(subjects()).toEqual(['Re: Q4 offsite dates']);
    // Back to what Gmail has: nothing left to send.
    expect(queued()).toEqual([]);
  });

  it('marks read and unread, stars, and adds and removes labels', () => {
    save([offsite, offsiteReply]);
    const receipts = { id: 'Label_1', name: 'Receipts' };

    act('Re: Q4 offsite dates', { type: 'read' });
    expect(threadNamed('Re: Q4 offsite dates').unreadCount).toBe(0);
    act('Re: Q4 offsite dates', { type: 'star' });
    act('Re: Q4 offsite dates', { type: 'label', label: receipts });

    const thread = threadNamed('Re: Q4 offsite dates');
    expect(thread).toMatchObject({ starred: true, labels: [receipts] });
    expect(subjects({ view: 'starred' })).toEqual(['Re: Q4 offsite dates']);
    expect(subjects({ view: 'label:Label_1' })).toEqual(['Re: Q4 offsite dates']);
    expect(queued().sort()).toEqual(['label:Label_1', 'label:Label_1', 'read', 'read', 'starred'].sort());

    act('Re: Q4 offsite dates', { type: 'unlabel', labelId: 'Label_1' });
    expect(subjects({ view: 'label:Label_1' })).toEqual([]);
  });

  it('moves a thread to Trash, out of every view but Trash, and Move to inbox brings it back', () => {
    save([offsite, offsiteReply, receipt]);

    act('Re: Q4 offsite dates', { type: 'star' });
    act('Re: Q4 offsite dates', { type: 'trash' });

    expect(subjects()).toEqual(['Your order has shipped']);
    expect(subjects({ view: 'starred' })).toEqual([]);
    expect(subjects({ view: 'archive' })).toEqual([]);
    expect(subjects({ view: 'trash' })).toEqual(['Re: Q4 offsite dates']);
    expect(threadNamed('Re: Q4 offsite dates').inTrash).toBe(true);

    act('Re: Q4 offsite dates', { type: 'move-to-inbox' });
    expect(subjects()).toEqual(['Your order has shipped', 'Re: Q4 offsite dates']);
    expect(subjects({ view: 'trash' })).toEqual([]);
  });

  it('keeps mail that Gmail has in Trash, in Trash', () => {
    save([
      email('t', { subject: 'Old newsletter', inTrash: true, labels: [{ id: 'TRASH', name: 'Trash' }] }),
    ]);

    expect(subjects()).toEqual([]);
    expect(subjects({ view: 'trash' })).toEqual(['Old newsletter']);
  });
});

describe('snooze', () => {
  it('hides the thread in Snoozed, never queues for Gmail, and keeps the snooze through syncs', () => {
    save([offsite, offsiteReply, receipt]);

    act('Re: Q4 offsite dates', { type: 'snooze', until: T + 2 * HOUR });

    expect(subjects()).toEqual(['Your order has shipped']);
    expect(subjects({ view: 'snoozed' })).toEqual(['Re: Q4 offsite dates']);
    expect(threadNamed('Re: Q4 offsite dates').snoozedUntil).toBe(T + 2 * HOUR);
    expect(queued()).toEqual([]);

    save([offsite, offsiteReply]);
    expect(subjects({ view: 'snoozed' })).toEqual(['Re: Q4 offsite dates']);
  });

  it('is undone like any change', () => {
    save([offsite]);
    const entries = act('Q4 offsite dates', { type: 'snooze', until: T + 2 * HOUR });

    undo(entries);

    expect(subjects()).toEqual(['Q4 offsite dates']);
    expect(subjects({ view: 'snoozed' })).toEqual([]);
  });

  it('returns the thread at its time: top of the inbox, the latest message unread, marked as back from snooze', () => {
    save([offsite, offsiteReply, receipt]);
    act('Re: Q4 offsite dates', { type: 'read' });
    act('Re: Q4 offsite dates', { type: 'snooze', until: T + 2 * HOUR });
    expect(store.nextSnoozeAt()).toBe(T + 2 * HOUR);

    // Not yet.
    expect(store.wakeSnoozed(T + HOUR)).toEqual([]);

    clock = T + 2 * HOUR + 5_000;
    const woken = store.wakeSnoozed(T + 2 * HOUR + 5_000);

    expect(woken).toHaveLength(2);
    expect(subjects()).toEqual(['Re: Q4 offsite dates', 'Your order has shipped']);
    expect(threadNamed('Re: Q4 offsite dates')).toMatchObject({
      unreadCount: 1,
      snoozedUntil: null,
      returnedFrom: T + 2 * HOUR,
    });
    expect(store.nextSnoozeAt()).toBeNull();
    // Marking it unread goes to Gmail, as the User's own change.
    expect(queued()).toContain('read');
    expect(store.activity({ itemId: woken[1] })[0]?.by).toEqual({ kind: 'user' });
  });

  it('returns a thread whose time passed while Commander was closed', () => {
    save([offsite]);
    act('Q4 offsite dates', { type: 'snooze', until: T + HOUR });
    store.close();
    // Opened again the next day.
    clock = T + 24 * HOUR;
    store = openItemStore({
      path: join(dir, 'commander.db'),
      snapshotDir: join(dir, 'snapshots'),
      migrationsFolder,
      now: () => clock,
    });

    expect(store.wakeSnoozed(clock)).toHaveLength(1);
    expect(subjects()).toEqual(['Q4 offsite dates']);
  });

  it('archiving a thread that came back clears its "Snoozed until"', () => {
    save([offsite]);
    act('Q4 offsite dates', { type: 'snooze', until: T + HOUR });
    store.wakeSnoozed(T + HOUR);

    act('Q4 offsite dates', { type: 'archive' });

    expect(threadNamed('Q4 offsite dates').returnedFrom).toBeNull();
  });
});

describe('views and counts', () => {
  it('counts each view’s threads and unread ones, with a view per label', () => {
    save([
      offsite,
      offsiteReply,
      receipt,
      email('s', {
        subject: 'Starred one',
        starred: true,
        read: true,
        labels: [{ id: 'STARRED', name: 'Starred' }],
      }),
      email('l', {
        subject: 'Old receipt',
        inInbox: false,
        labels: [
          { id: 'UNREAD', name: 'Unread' },
          { id: 'Label_1', name: 'Receipts' },
        ],
      }),
    ]);
    store.syncState.saveCatalog(
      ALEX,
      'gmail',
      {
        kind: 'gmail',
        labels: [
          { id: 'INBOX', name: 'INBOX', system: true },
          { id: 'Label_1', name: 'Receipts', system: false },
          { id: 'Label_2', name: 'Travel', system: false },
        ],
      },
      T,
    );

    const { views } = store.emailViews({});

    expect(views).toEqual([
      { view: 'inbox', name: 'Inbox', threads: 3, unread: 1 },
      { view: 'starred', name: 'Starred', threads: 1, unread: 0 },
      { view: 'snoozed', name: 'Snoozed', threads: 0, unread: 0 },
      { view: 'archive', name: 'Archive', threads: 1, unread: 1 },
      { view: 'trash', name: 'Trash', threads: 0, unread: 0 },
      { view: 'label:Label_1', name: 'Receipts', threads: 1, unread: 1 },
      { view: 'label:Label_2', name: 'Travel', threads: 0, unread: 0 },
    ]);
    expect(store.emailLabels(ALEX)).toEqual([
      { id: 'Label_1', name: 'Receipts' },
      { id: 'Label_2', name: 'Travel' },
    ]);
  });

  it('narrows the views to one Account', () => {
    save([offsite]);
    save([email('sams')], SAM);

    expect(store.emailViews({ account: SAM }).views[0]).toMatchObject({ view: 'inbox', threads: 1 });
    expect(subjects({ account: SAM })).toEqual(['Subject sams']);
  });
});

describe('Section search', () => {
  beforeEach(() => {
    save([
      offsite,
      offsiteReply,
      receipt,
      email('cert', {
        subject: 'Staging certificate',
        from: { name: 'Priya Patel', address: 'priya@contoso.test' },
        sentAt: T - 30 * 60_000,
        attachments: [{ name: 'cert.pem', type: 'text/plain', size: 1, partId: '1', inline: false }],
      }),
    ]);
    save([email('sam-offsite', { subject: 'Offsite catering' })], SAM);
  });

  const found = (text: string, account?: string) =>
    store.emailSearch({ text, ...(account ? { account } : {}) }).threads.map((thread) => thread.subject);

  it('finds threads by their words, newest first, in every Account or one', () => {
    expect(found('offsite')).toEqual(['Offsite catering', 'Re: Q4 offsite dates']);
    expect(found('offsite', ALEX)).toEqual(['Re: Q4 offsite dates']);
  });

  it('understands from:, to:, subject:, has:attachment and is:unread, with or without words', () => {
    expect(found('from:priya')).toEqual(['Staging certificate']);
    expect(found('to:alex subject:shipped')).toEqual(['Your order has shipped']);
    expect(found('has:attachment')).toEqual(['Staging certificate']);
    expect(found('is:unread offsite', ALEX)).toEqual(['Re: Q4 offsite dates']);
    expect(found('is:unread shipped')).toEqual([]);
  });

  it('searches one view with in:, and leaves Trash out unless asked', () => {
    act('Your order has shipped', { type: 'archive' });
    act('Staging certificate', { type: 'trash' });

    expect(found('in:archive')).toEqual(['Your order has shipped']);
    expect(found('certificate')).toEqual([]);
    expect(found('certificate in:trash')).toEqual(['Staging certificate']);
  });
});
