import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ComposeDraft,
  type OutgoingMessage,
  SEND_FIELD,
  type SourceItem,
  type UpdateView,
} from '@commander/domain';
import { createModelClient, ModelError, type ModelProviderAdapter } from '@commander/models';
import type { SourceAdapter, WriteRequest } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openGate } from '../autonomy/gate';
import { type ComposeContext, type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from '../sync/engine';
import { setUpUpdates, type Updates } from '../updates';
import { LOOK_AGAIN_MS, ON_TIME_MS, type SendLater, setUpSendLater } from '.';

// Send later's clock in the Core (#139), on a real Item store, sync engine and Update queue with a fake
// clock (fake timers, set before the store opens) and a fake Gmail adapter: a message scheduled while
// Commander runs goes at its time, through the same path as any send and with no Undo hold; one whose
// time passed while Commander was closed, or the machine asleep, never goes by itself on the next start
// or wake, but becomes a Needs you now line whose Send now, Edit and Discard work; and one whose time
// passed while Commander ran offline goes when the connection returns, with no question asked. Times
// here are absolute; the suite runs the same in any time zone (TZ=UTC, America/Denver, Etc/GMT-12).

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACCOUNT = 'google:sam';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const me = { name: 'Sam Rivera', address: 'sam@home.test' };
const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
const gmail: ComposeContext = { by: { kind: 'user' }, source: 'gmail', from: me };
const user = { by: { kind: 'user' as const } };

let dir: string;
let store: ItemStore;
let engine: SyncEngine;
let sendLater: SendLater;
let updates: Updates;
let delivered: OutgoingMessage[];
let changed: string[][];

function fakeGmail(): SourceAdapter {
  return {
    source: 'gmail',
    cadence: { defaultMinutes: 15, choices: [15] },
    sync: async () => ({ cursor: null, cost: { requests: 1, complexity: 1 } }),
    write: async (request: WriteRequest) => {
      const message = request.changes.find((change) => change.field === SEND_FIELD)?.value as
        | OutgoingMessage
        | undefined;
      if (!message) return { item: null, superseded: [], cost: { requests: 1, complexity: 1 } };
      delivered.push(message);
      const item: SourceItem = {
        externalId: `sent-${delivered.length}`,
        kind: 'email',
        title: message.subject,
        status: 'archived',
        commanderItemId: message.commanderId,
        detail: {
          kind: 'email',
          messageId: message.messageId,
          inReplyTo: null,
          references: [],
          threadKey: `mid:${message.messageId}`,
          sourceThreadId: null,
          from: message.from,
          to: message.to,
          cc: [],
          bcc: [],
          replyTo: [],
          subject: message.subject,
          sentAt: Date.now(),
          snippet: message.text,
          read: true,
          starred: false,
          inInbox: false,
          sentByMe: true,
          labels: [{ id: 'SENT', name: 'Sent' }],
          attachments: [],
          hasInvitation: false,
          listUnsubscribe: null,
          listId: null,
        },
      };
      return { item, superseded: [], cost: { requests: 2, complexity: 120 } };
    },
  };
}

// The model is off: Update lines are their kinds' plain sentences.
const noModel: ModelProviderAdapter = {
  send: () => Promise.reject(new ModelError('no-key', 'No API key is saved for Z.ai.')),
  stream: () => Promise.reject(new Error('not used')),
};

function startSendLater() {
  sendLater = setUpSendLater({ store, onChanged: (itemIds) => changed.push(itemIds), log: () => {} });
}

async function start(at: number) {
  vi.useFakeTimers({ now: at });
  dir = mkdtempSync(join(tmpdir(), 'commander-send-later-clock-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
  delivered = [];
  changed = [];
  engine = createSyncEngine({
    store,
    adapters: [fakeGmail()],
    accessTokens: { request: async () => ({ token: 't', kind: 'oauth' }) },
    random: () => 0,
    log: () => {},
  });
  engine.setAccounts([{ id: ACCOUNT, source: 'gmail', needsReconnect: false }]);
  const gate = openGate({ itemStore: store, onChange: () => updates?.sweep() });
  updates = setUpUpdates({
    itemStore: store,
    gate,
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: noModel },
      ledger: store.models,
      now: () => Date.now(),
    }),
    now: () => Date.now(),
    sendLater: {
      sendNow: (itemId) => store.compose.sendScheduled(itemId, user),
      discard: (itemId) => store.compose.discard(itemId, user),
    },
  });
  startSendLater();
  await vi.advanceTimersByTimeAsync(10);
}

afterEach(() => {
  sendLater.stop();
  updates.stop();
  engine.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const draft = (fields: Partial<ComposeDraft> = {}): ComposeDraft => ({
  mode: 'new',
  account: ACCOUNT,
  to: [dana],
  cc: [],
  bcc: [],
  subject: 'Venue options',
  body: [{ type: 'paragraph', runs: [{ text: 'Here are three.' }] }],
  attachments: [],
  ...fields,
});

function schedule(sendAt: number) {
  const { itemId } = store.compose.schedule(draft(), gmail, sendAt, 'commander');
  sendLater.changed();
  return itemId;
}

const missedLines = () => updates.queue.list().filter((line) => line.about.kind === 'missed-send');

// Thursday 8 October 2026, 08:59 UTC; and the same just after midnight there.
const MORNING = Date.UTC(2026, 9, 8, 8, 59);
const AFTER_MIDNIGHT = Date.UTC(2026, 9, 8, 0, 1);

describe.each([
  ['in the morning', MORNING],
  ['just after midnight', AFTER_MIDNIGHT],
])('send later while Commander runs (%s)', (_when, at) => {
  beforeEach(() => start(at));

  it('sends at its time through the same path as any send, with no Undo hold, and asks nothing', async () => {
    const itemId = schedule(at + HOUR);
    await vi.advanceTimersByTimeAsync(HOUR - MINUTE);
    expect(delivered).toEqual([]);

    await vi.advanceTimersByTimeAsync(MINUTE + 1_000);
    expect(delivered.map((message) => message.subject)).toEqual(['Venue options']);
    expect(store.get(itemId)?.item.externalId).toBe('sent-1');
    expect(store.compose.scheduled()).toEqual([]);
    expect(changed).toContainEqual([itemId]);
    expect(missedLines()).toEqual([]);
  });

  it('running but offline at its time: it goes when the connection returns, with no question asked', async () => {
    const itemId = schedule(at + 10 * MINUTE);
    engine.setSystemState({ awake: true, online: false });
    sendLater.systemState({ awake: true });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(delivered).toEqual([]);
    expect(store.compose.outbox()).toMatchObject([{ itemId, state: 'waiting' }]);

    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toHaveLength(1);
    expect(store.compose.missed()).toEqual([]);
    expect(missedLines()).toEqual([]);
  });

  it('a time that passed while the machine slept is missed on waking, never sent by surprise', async () => {
    const itemId = schedule(at + 10 * MINUTE);
    engine.setSystemState({ awake: false, online: true });
    sendLater.systemState({ awake: false });
    vi.setSystemTime(at + 3 * HOUR);
    engine.setSystemState({ awake: true, online: true });
    sendLater.systemState({ awake: true });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(delivered).toEqual([]);
    expect(store.compose.scheduled()).toMatchObject([{ itemId, state: 'missed' }]);
    updates.sweep();
    expect(missedLines()).toMatchObject([{ group: 'now', itemIds: [itemId], section: 'email' }]);
  });

  it('a timer firing long after its time (the machine slept unnoticed) counts as missed', async () => {
    const itemId = schedule(at + 10 * MINUTE);
    // The clock jumps on with no timer firing, as across a suspend nobody reported.
    vi.setSystemTime(at + 10 * MINUTE + ON_TIME_MS + MINUTE);
    await vi.advanceTimersByTimeAsync(LOOK_AGAIN_MS);

    expect(delivered).toEqual([]);
    expect(store.compose.scheduled()).toMatchObject([{ itemId, state: 'missed' }]);
  });
});

describe('send later missed while Commander was closed', () => {
  beforeEach(() => start(MORNING));

  // Commander quits with the message scheduled, and starts again after its time.
  async function closedPastItsTime(sendAt: number, startsAt: number) {
    const itemId = schedule(sendAt);
    sendLater.stop();
    vi.setSystemTime(startsAt);
    startSendLater();
    updates.sweep();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    return itemId;
  }

  async function update(): Promise<UpdateView> {
    const view = await updates.give();
    if (!view) throw new Error('No Update');
    return view;
  }

  it('never sends on the next start, and asks in the next Update: “Your email to Dana was due at …”', async () => {
    const dueAt = MORNING + HOUR;
    const itemId = await closedPastItsTime(dueAt, MORNING + 5 * HOUR);

    expect(delivered).toEqual([]);
    expect(store.compose.scheduled()).toMatchObject([{ itemId, state: 'missed', sendAt: dueAt }]);
    const view = await update();
    const line = view.lines.find((each) => each.kind === 'missed-send');
    const due = new Date(dueAt);
    const clock = `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
    expect(line?.group).toBe('now');
    expect(line?.text).toMatch(
      new RegExp(`^Your email to Dana \\(“Venue options”\\) was due .*at ${clock}\\. Send it now\\?$`),
    );
    expect(line?.rows).toMatchObject([
      { itemId, section: 'email', actions: ['send-now', 'edit', 'discard'] },
    ]);
  });

  it('Send now sends it, and the line is done', async () => {
    const itemId = await closedPastItsTime(MORNING + HOUR, MORNING + 5 * HOUR);
    const [line] = missedLines();
    updates.actRow(line?.id as number, itemId, 'send-now');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(delivered.map((message) => message.subject)).toEqual(['Venue options']);
    expect(updates.queue.line(line?.id as number)?.status).toBe('done');
    expect(store.compose.scheduled()).toEqual([]);
  });

  it('Discard throws it away (in Gmail too), and the line is done', async () => {
    const itemId = await closedPastItsTime(MORNING + HOUR, MORNING + 5 * HOUR);
    const [line] = missedLines();
    updates.actRow(line?.id as number, itemId, 'discard');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(delivered).toEqual([]);
    expect(store.get(itemId)?.item.deletedAt).not.toBeNull();
    expect(updates.queue.line(line?.id as number)?.status).toBe('done');
  });

  it('Edit (in the window) takes it back as a draft, and the line goes on its own', async () => {
    const itemId = await closedPastItsTime(MORNING + HOUR, MORNING + 5 * HOUR);
    const [line] = missedLines();
    store.compose.unschedule(itemId);
    updates.sweep();

    expect(updates.queue.line(line?.id as number)?.status).toBe('resolved');
    expect(store.compose.drafts().map((each) => each.itemId)).toEqual([itemId]);
    expect(delivered).toEqual([]);
  });

  it('a line dismissed doesn’t come back; the message stays in Scheduled, missed, until the User decides', async () => {
    const itemId = await closedPastItsTime(MORNING + HOUR, MORNING + 5 * HOUR);
    const [line] = missedLines();
    updates.act(line?.id as number, 'dismiss');
    updates.sweep();
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(missedLines()).toEqual([]);
    expect(store.compose.scheduled()).toMatchObject([{ itemId, state: 'missed' }]);
    expect(delivered).toEqual([]);
  });

  it('a time still to come when Commander starts again goes at its time', async () => {
    await closedPastItsTime(MORNING + 3 * HOUR, MORNING + HOUR);
    expect(missedLines()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(delivered).toHaveLength(1);
  });
});
