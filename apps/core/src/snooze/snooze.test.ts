import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreMessage, EmailDetail, ItemAction, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpSnooze } from '.';

// Snooze in the Core (#135): a snoozed thread comes back at its time while Commander runs (the window
// or the tray), and one whose time passed while Commander was closed comes back at the next start.
// The clock is the module's own, so tests (and the end-to-end tests' hook) can move it.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T = Date.UTC(2026, 9, 7, 9);
const HOUR = 60 * 60_000;

let dir: string;
let store: ItemStore;
let clock: number;
let sent: CoreMessage[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-snooze-'));
  clock = T;
  sent = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  const detail: EmailDetail = {
    kind: 'email',
    messageId: '<a@mail.test>',
    inReplyTo: null,
    references: [],
    threadKey: 'mid:<a@mail.test>',
    sourceThreadId: 'g-a',
    from: { name: 'Dana', address: 'dana@northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Q4 offsite dates',
    sentAt: T - HOUR,
    snippet: '',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
  };
  const item: SourceItem = { externalId: 'a', kind: 'email', title: detail.subject, status: 'open', detail };
  store.saveFromSource({ source: 'gmail', account: 'google:alex', items: [item], deleted: [] });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function snoozeUntil(until: number) {
  const [email] = store.query({ kinds: ['email'] });
  const action: ItemAction = {
    type: 'edit-fields',
    itemId: email?.id as string,
    fields: { snooze: { until, returned: false } },
  };
  store.record(action, { by: { kind: 'user' } });
  return email?.id as string;
}

const inbox = () => store.emailThreads({}).threads.map((thread) => thread.subject);

describe('snooze', () => {
  it('brings a thread back once its time comes, and tells the window', () => {
    const id = snoozeUntil(T + HOUR);
    const snooze = setUpSnooze({
      store,
      send: (message) => sent.push(message),
      now: () => clock,
      timers: false,
    });

    snooze.tick();
    expect(inbox()).toEqual([]);
    expect(sent).toEqual([]);

    clock = T + HOUR;
    snooze.tick();

    expect(inbox()).toEqual(['Q4 offsite dates']);
    expect(sent).toEqual([{ type: 'items-changed', itemIds: [id] }]);
    snooze.stop();
  });

  it('brings back at start-up a thread whose time passed while Commander was closed', () => {
    snoozeUntil(T + HOUR);
    clock = T + 10 * HOUR;

    const snooze = setUpSnooze({
      store,
      send: (message) => sent.push(message),
      now: () => clock,
      timers: false,
    });

    expect(inbox()).toEqual(['Q4 offsite dates']);
    snooze.stop();
  });

  it('lets the end-to-end tests move its clock on, only with test hooks', () => {
    snoozeUntil(T + HOUR);
    const hooked = setUpSnooze({
      store,
      send: (message) => sent.push(message),
      now: () => clock,
      timers: false,
      testHooks: true,
    });

    expect(hooked.handle({ type: 'snooze-test-clock', offsetMs: 2 * HOUR })).toBe(true);
    expect(inbox()).toEqual(['Q4 offsite dates']);
    hooked.stop();

    const plain = setUpSnooze({
      store,
      send: (message) => sent.push(message),
      now: () => clock,
      timers: false,
    });
    expect(plain.handle({ type: 'snooze-test-clock', offsetMs: 2 * HOUR })).toBe(false);
    plain.stop();
  });

  it('waits for the next snooze with a timer, looking again at least every minute', () => {
    snoozeUntil(T + HOUR);
    const waits: number[] = [];
    const snooze = setUpSnooze({
      store,
      send: () => {},
      now: () => clock,
      setTimer: (ms) => {
        waits.push(ms);
        return () => {};
      },
    });

    expect(waits).toEqual([60_000]);
    snoozeUntil(T + 30_000);
    snooze.changed();
    expect(waits.at(-1)).toBe(30_000);
    snooze.stop();
  });
});
