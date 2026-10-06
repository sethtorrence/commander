import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANCEL_SEND_FIELD,
  type ComposeDraft,
  DELETE_FIELD,
  DRAFT_FIELD,
  type EmailDetail,
  type OutgoingMessage,
  pendingEventExternalId,
  SEND_FIELD,
  type SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ComposeContext, type ItemStore, openItemStore } from '.';

// Send later in the Item store (#139): a scheduled message stays a draft (in no thread, out of Drafts
// and the Outbox) and is listed in Scheduled with its time and who holds it. One Commander sends is
// saved to Gmail's Drafts and released at its time as an ordinary send with no Undo hold, or marked
// missed; one Microsoft holds goes to Outlook at once with its time, and is taken back out of Exchange's
// Outbox (`cancel-send`) to cancel it, edit it, change its time or send it now. Only the User schedules.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GMAIL = 'google:sam';
const WORK = 'outlook:3f6a1c2e-0000-4000-8000-00000000c0de:u-sam';
const T = Date.UTC(2026, 9, 7, 9);
const HOUR = 60 * 60_000;
const me = { name: 'Sam Rivera', address: 'sam@home.test' };
const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
const gmail: ComposeContext = { by: { kind: 'user' }, source: 'gmail', from: me };
const outlook: ComposeContext = { by: { kind: 'user' }, source: 'outlook', from: me };

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-send-later-'));
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

const draft = (account: string, fields: Partial<ComposeDraft> = {}): ComposeDraft => ({
  mode: 'new',
  account,
  to: [dana],
  cc: [],
  bcc: [],
  subject: 'Venue options',
  body: [{ type: 'paragraph', runs: [{ text: 'Here are three.' }] }],
  attachments: [],
  ...fields,
});

const detailOf = (itemId: string) => store.get(itemId)?.item.detail as EmailDetail;
const rows = (itemId: string) => store.outgoing.forItem(itemId);
const fields = (itemId: string) => rows(itemId).map((row) => row.field);
const queuedValue = (itemId: string, field: string) =>
  rows(itemId).find((row) => row.field === field)?.value as OutgoingMessage | undefined;

// What the sync engine does with the Outlook adapter's answer to a held send: the copy Exchange keeps
// in its Outbox comes back still unsent, naming the Item.
function microsoftHolds(itemId: string, externalId = 'AAMk-outbox-1=') {
  const ids = rows(itemId).map((row) => row.id);
  store.outgoing.markSending(ids, clock);
  store.transaction(() => {
    store.outgoing.settle(ids);
    const detail = detailOf(itemId);
    const item: SourceItem = {
      externalId,
      kind: 'email',
      title: detail.subject,
      status: 'archived',
      commanderItemId: itemId,
      detail: { ...detail, messageId: '<held-1@outlook.test>', draft: true },
    };
    store.saveFromSource({ source: 'outlook', account: WORK, items: [item], deleted: [] });
  });
}

describe('scheduling a message Commander sends (Gmail)', () => {
  it('keeps it a draft, saved to Gmail’s Drafts, out of threads, Drafts and the Outbox, and lists it in Scheduled', () => {
    const { itemId, sendAt, heldBy } = store.compose.schedule(draft(GMAIL), gmail, T + 2 * HOUR, 'commander');

    expect({ sendAt, heldBy }).toEqual({ sendAt: T + 2 * HOUR, heldBy: 'commander' });
    expect(detailOf(itemId).draft).toBe(true);
    expect(fields(itemId)).toEqual([DRAFT_FIELD]);
    expect(store.compose.drafts()).toEqual([]);
    expect(store.compose.outbox()).toEqual([]);
    expect(store.emailThreads({}).threads).toEqual([]);
    expect(store.compose.scheduled()).toEqual([
      {
        itemId,
        account: GMAIL,
        subject: 'Venue options',
        to: [dana],
        sendAt: T + 2 * HOUR,
        heldBy: 'commander',
        state: 'waiting',
        error: null,
      },
    ]);
    expect(store.compose.nextDueAt()).toBe(T + 2 * HOUR);
  });

  it('refuses a time that has passed, one more than a year away, a message with no one to send to, and Ares', () => {
    expect(() => store.compose.schedule(draft(GMAIL), gmail, T - 1, 'commander')).toThrow(
      'Pick a time later than now.',
    );
    expect(() => store.compose.schedule(draft(GMAIL), gmail, T + 400 * 24 * HOUR, 'commander')).toThrow(
      'Pick a time within the next year.',
    );
    expect(() => store.compose.schedule(draft(GMAIL, { to: [] }), gmail, T + HOUR, 'commander')).toThrow(
      'Add someone to send this to.',
    );
    expect(() =>
      store.compose.schedule(draft(GMAIL), { ...gmail, by: { kind: 'ares' } }, T + HOUR, 'commander'),
    ).toThrow(/Only you can send email/);
    expect(store.compose.scheduled()).toEqual([]);
  });

  it('won’t take a save from a composer while it is scheduled', () => {
    const { itemId } = store.compose.schedule(draft(GMAIL), gmail, T + HOUR, 'commander');
    expect(() => store.compose.save(draft(GMAIL, { itemId, subject: 'Changed' }), gmail)).toThrow(
      'This message is scheduled: edit it from Scheduled to change it.',
    );
  });

  it('is due at its time, and goes then as an ordinary send with no Undo hold', () => {
    const { itemId } = store.compose.schedule(draft(GMAIL), gmail, T + HOUR, 'commander');
    expect(store.compose.due(T + HOUR - 1)).toEqual([]);
    expect(store.compose.due(T + HOUR)).toEqual([{ itemId, scheduledAt: T + HOUR }]);

    clock = T + HOUR;
    store.compose.sendScheduled(itemId, { by: { kind: 'user' } }, 'Sent at the time you chose');

    const send = rows(itemId).find((row) => row.field === SEND_FIELD);
    expect(send).toMatchObject({ nextAttemptAt: T + HOUR, status: 'pending' });
    expect((send?.value as OutgoingMessage | undefined)?.deferUntil).toBeUndefined();
    expect(detailOf(itemId).draft).toBeUndefined();
    expect(store.compose.scheduled()).toEqual([]);
    expect(store.compose.outbox().map((entry) => entry.itemId)).toEqual([itemId]);
    expect(store.compose.nextDueAt()).toBeNull();
    expect(store.activity({ itemId }).map((entry) => entry.why)).toContain('Sent at the time you chose');
  });

  it('a missed time stays in Scheduled, marked missed, until the User decides; a new time clears it', () => {
    const { itemId } = store.compose.schedule(draft(GMAIL), gmail, T + HOUR, 'commander');
    store.compose.miss(itemId, T + 5 * HOUR);

    expect(store.compose.scheduled()[0]).toMatchObject({ state: 'missed', sendAt: T + HOUR });
    expect(store.compose.missed()).toEqual([{ itemId, dueAt: T + HOUR, missedAt: T + 5 * HOUR }]);
    // Missed is never due again by itself.
    expect(store.compose.due(T + 6 * HOUR)).toEqual([]);
    expect(store.compose.nextDueAt()).toBeNull();

    clock = T + 6 * HOUR;
    store.compose.reschedule(itemId, T + 8 * HOUR);
    expect(store.compose.scheduled()[0]).toMatchObject({ state: 'waiting', sendAt: T + 8 * HOUR });
    expect(store.compose.missed()).toEqual([]);
  });

  it('Cancel makes it a draft again, back in Drafts', () => {
    const { itemId } = store.compose.schedule(draft(GMAIL), gmail, T + HOUR, 'commander');
    store.compose.unschedule(itemId);

    expect(store.compose.scheduled()).toEqual([]);
    expect(store.compose.drafts().map((each) => each.itemId)).toEqual([itemId]);
    expect(store.compose.record(itemId)).toMatchObject({ scheduledAt: null, heldBy: null, missedAt: null });
    expect(() => store.compose.unschedule(itemId)).toThrow('That message isn’t scheduled');
  });

  it('one deleted in Gmail meanwhile is due for nothing, and leaves Scheduled', () => {
    const { itemId } = store.compose.schedule(draft(GMAIL), gmail, T + HOUR, 'commander');
    const externalId = store.get(itemId)?.item.externalId as string;
    store.saveFromSource({ source: 'gmail', account: GMAIL, items: [], deleted: [externalId] });

    expect(store.get(itemId)?.item.deletedAt).not.toBeNull();
    expect(store.compose.due(T + 2 * HOUR)).toEqual([]);
    expect(store.compose.nextDueAt()).toBeNull();
    expect(store.compose.scheduled()).toEqual([]);
  });

  it('Discard throws it away, in Gmail too', () => {
    const { itemId } = store.compose.schedule(draft(GMAIL), gmail, T + HOUR, 'commander');
    store.compose.discard(itemId, { by: { kind: 'user' } });

    expect(store.get(itemId)?.item.deletedAt).toBe(T);
    expect(fields(itemId)).toContain(DELETE_FIELD);
    expect(store.compose.scheduled()).toEqual([]);
  });
});

describe('scheduling a message Microsoft holds (Outlook work Account)', () => {
  it('hands it to Outlook at once with its time, and it is held by Microsoft once Outlook has it', () => {
    const { itemId } = store.compose.schedule(draft(WORK), outlook, T + 2 * HOUR, 'microsoft');

    expect(fields(itemId)).toEqual([SEND_FIELD]);
    expect(queuedValue(itemId, SEND_FIELD)?.deferUntil).toBe(T + 2 * HOUR);
    expect(rows(itemId)[0]?.nextAttemptAt).toBeNull();
    expect(store.compose.scheduled()[0]).toMatchObject({ heldBy: 'microsoft', state: 'handing' });
    // Not Commander's to send at its time.
    expect(store.compose.due(T + 3 * HOUR)).toEqual([]);

    microsoftHolds(itemId);
    expect(store.compose.scheduled()[0]).toMatchObject({ heldBy: 'microsoft', state: 'held' });
    expect(detailOf(itemId).draft).toBe(true);
    expect(store.get(itemId)?.item.externalId).toBe('AAMk-outbox-1=');
    expect(store.compose.outbox()).toEqual([]);
    expect(store.emailThreads({}).threads).toEqual([]);
  });

  it('a sync that no longer finds it in Drafts leaves it alone: Exchange holds it in the Outbox', () => {
    const { itemId } = store.compose.schedule(draft(WORK), outlook, T + 2 * HOUR, 'microsoft');
    microsoftHolds(itemId);
    store.saveFromSource({ source: 'outlook', account: WORK, items: [], deleted: ['AAMk-outbox-1='] });

    expect(store.get(itemId)?.item.deletedAt).toBeNull();
    expect(store.compose.scheduled()).toHaveLength(1);
  });

  it('Cancel before Outlook had it just takes its send out of the queue: it is a draft in Outlook again', () => {
    const { itemId } = store.compose.schedule(draft(WORK), outlook, T + 2 * HOUR, 'microsoft');
    store.compose.unschedule(itemId);

    expect(fields(itemId)).toEqual([DRAFT_FIELD]);
    expect(store.compose.scheduled()).toEqual([]);
    expect(store.compose.drafts().map((each) => each.itemId)).toEqual([itemId]);
  });

  it('Cancel takes it out of the Outbox, and it goes back to Outlook’s Drafts, under its placeholder id', () => {
    const { itemId } = store.compose.schedule(draft(WORK), outlook, T + 2 * HOUR, 'microsoft');
    microsoftHolds(itemId);
    store.compose.unschedule(itemId);

    expect(fields(itemId)).toEqual([CANCEL_SEND_FIELD, DRAFT_FIELD]);
    expect(queuedValue(itemId, CANCEL_SEND_FIELD)).toMatchObject({ commanderId: itemId });
    expect(store.get(itemId)?.item.externalId).toBe(pendingEventExternalId(itemId));
    expect(rows(itemId).every((row) => row.externalId === pendingEventExternalId(itemId))).toBe(true);
    expect(store.compose.scheduled()).toEqual([]);
  });

  it('Change time takes it out of the Outbox and hands it over again for the new time', () => {
    const { itemId } = store.compose.schedule(draft(WORK), outlook, T + 2 * HOUR, 'microsoft');
    microsoftHolds(itemId);
    store.compose.reschedule(itemId, T + 26 * HOUR);

    expect(fields(itemId)).toEqual([CANCEL_SEND_FIELD, SEND_FIELD]);
    expect(queuedValue(itemId, SEND_FIELD)?.deferUntil).toBe(T + 26 * HOUR);
    expect(store.compose.scheduled()[0]).toMatchObject({ sendAt: T + 26 * HOUR, state: 'handing' });
  });

  it('Change time before Outlook had it only changes the time it is handed over with', () => {
    const { itemId } = store.compose.schedule(draft(WORK), outlook, T + 2 * HOUR, 'microsoft');
    store.compose.reschedule(itemId, T + 26 * HOUR);

    expect(fields(itemId)).toEqual([SEND_FIELD]);
    expect(queuedValue(itemId, SEND_FIELD)?.deferUntil).toBe(T + 26 * HOUR);
  });

  it('Send now takes it out of the Outbox and sends it at once, in its thread', () => {
    const { itemId } = store.compose.schedule(draft(WORK), outlook, T + 2 * HOUR, 'microsoft');
    microsoftHolds(itemId);
    store.compose.sendScheduled(itemId, { by: { kind: 'user' } });

    expect(fields(itemId)).toEqual([CANCEL_SEND_FIELD, SEND_FIELD]);
    expect(queuedValue(itemId, SEND_FIELD)?.deferUntil).toBeNull();
    expect(detailOf(itemId).draft).toBeUndefined();
    expect(store.compose.scheduled()).toEqual([]);
    expect(store.compose.outbox().map((entry) => entry.itemId)).toEqual([itemId]);
  });

  it('can’t be taken back once its time has passed, nor while it is on its way to Outlook', () => {
    const { itemId } = store.compose.schedule(draft(WORK), outlook, T + 2 * HOUR, 'microsoft');
    store.outgoing.markSending(
      rows(itemId).map((row) => row.id),
      clock,
    );
    expect(() => store.compose.unschedule(itemId)).toThrow(/on its way to Microsoft/);

    microsoftHolds(itemId);
    clock = T + 2 * HOUR;
    expect(() => store.compose.unschedule(itemId)).toThrow(/past its time/);
    expect(() => store.compose.reschedule(itemId, T + 30 * HOUR)).toThrow(/past its time/);
  });
});
