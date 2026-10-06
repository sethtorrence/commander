import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ComposeDraft,
  type EmailDetail,
  type OutgoingMessage,
  SEND_FIELD,
  type SourceItem,
} from '@commander/domain';
import {
  type SourceAdapter,
  SourceUnavailable,
  WriteRejected,
  type WriteRequest,
  type WriteResult,
} from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ComposeContext, type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from './engine';

// Sending email through the outgoing queue and the sync engine (#138, ADR 0003): held for the Undo
// time, then written once; Undo takes it out before it goes; offline it waits; and an attempt whose
// outcome is unknown (a timeout, or Commander stopping mid-way) is handed back with when it began, so
// the adapter looks for what it did before sending again: never twice. A fake Gmail adapter stands in.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 7, 9);
const ACCOUNT = 'google:sam';
const me = { name: 'Sam Rivera', address: 'sam@home.test' };
const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
const user: ComposeContext = { by: { kind: 'user' }, source: 'gmail', from: me };

type Behaviour = (request: WriteRequest) => Promise<WriteResult>;

function fakeGmail() {
  const writes: WriteRequest[] = [];
  const delivered: OutgoingMessage[] = [];
  const scripted: Behaviour[] = [];
  const sends: Behaviour = async (request) => {
    const send = request.changes.find((change) => change.field === SEND_FIELD);
    const message = send?.value as OutgoingMessage;
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
        inReplyTo: message.inReplyTo,
        references: message.references,
        threadKey: `mid:${message.messageId}`,
        sourceThreadId: message.sourceThreadId,
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
  };
  const adapter: SourceAdapter = {
    source: 'gmail',
    cadence: { defaultMinutes: 15, choices: [15] },
    sync: async () => ({ cursor: null, cost: { requests: 1, complexity: 1 } }),
    write: async (request) => {
      writes.push(request);
      return (scripted.shift() ?? sends)(request);
    },
  };
  return { adapter, writes, delivered, next: (...behaviours: Behaviour[]) => scripted.push(...behaviours) };
}

let dir: string;
let store: ItemStore;
let gmail: ReturnType<typeof fakeGmail>;
let engine: SyncEngine;

function start() {
  return createSyncEngine({
    store,
    adapters: [gmail.adapter],
    accessTokens: { request: async () => ({ token: 't', kind: 'oauth' }) },
    random: () => 0,
    log: () => {},
  });
}

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

const sendRows = (itemId: string) => store.outgoing.forItem(itemId).filter((row) => row.field === SEND_FIELD);

beforeEach(async () => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-compose-send-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
  gmail = fakeGmail();
  engine = start();
  engine.setAccounts([{ id: ACCOUNT, source: 'gmail', needsReconnect: false }]);
  await vi.advanceTimersByTimeAsync(10);
});

afterEach(() => {
  engine.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('sending through the outgoing queue', () => {
  it('holds a message for the Undo time, then sends it once and it becomes Gmail’s message', async () => {
    const { itemId } = store.compose.send(draft(), user, Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(gmail.writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(gmail.delivered.map((message) => message.subject)).toEqual(['Venue options']);
    expect(sendRows(itemId)).toEqual([]);
    expect(store.get(itemId)?.item.externalId).toBe('sent-1');
    expect(store.compose.outbox()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gmail.delivered).toHaveLength(1);
  });

  it('sends nothing when Undo takes it back during the hold', async () => {
    const { itemId } = store.compose.send(draft(), user, Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(4_000);
    store.compose.undoSend(itemId, { by: { kind: 'user' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gmail.writes).toEqual([]);
    expect((store.get(itemId)?.item.detail as EmailDetail | undefined)?.draft).toBe(true);
  });

  it('waits while offline, and goes once back online', async () => {
    engine.setSystemState({ awake: true, online: false });
    const { itemId } = store.compose.send(draft(), user, Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gmail.writes).toEqual([]);
    expect(store.compose.outbox()).toEqual([expect.objectContaining({ itemId, state: 'waiting' })]);

    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(gmail.delivered).toHaveLength(1);
  });

  it('retries an attempt whose outcome is unknown, telling the adapter when it began', async () => {
    gmail.next(async () => {
      throw new SourceUnavailable('Commander couldn’t reach Gmail.');
    });
    const sentAt = Date.now();
    store.compose.send(draft(), user, sentAt);
    await vi.advanceTimersByTimeAsync(10);
    expect(gmail.writes[0]?.changes[0]?.attemptedAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(gmail.writes).toHaveLength(2);
    expect(gmail.writes[1]?.changes[0]?.attemptedAt).toBe(sentAt);
  });

  it('after Commander stopped mid-send, the next start hands the attempt’s time to the adapter', async () => {
    let finish!: () => void;
    gmail.next(
      () =>
        new Promise<WriteResult>((_resolve, reject) => {
          finish = () => reject(new Error('stopped'));
        }),
    );
    const sentAt = Date.now();
    const { itemId } = store.compose.send(draft(), user, sentAt);
    await vi.advanceTimersByTimeAsync(10);
    expect(sendRows(itemId)[0]?.status).toBe('sending');
    // Commander stops with the send on its way; a new Core starts on the same database.
    engine.stop();
    finish();
    engine = start();
    engine.setAccounts([{ id: ACCOUNT, source: 'gmail', needsReconnect: false }]);
    await vi.advanceTimersByTimeAsync(10);

    expect(gmail.writes).toHaveLength(2);
    expect(gmail.writes[1]?.changes.find((change) => change.field === SEND_FIELD)?.attemptedAt).toBe(sentAt);
  });

  it('keeps a refused send in the Outbox with Gmail’s reason, and Retry sends it', async () => {
    gmail.next(async () => {
      throw new WriteRejected('Gmail refused to send this message: Invalid To header');
    });
    const { itemId } = store.compose.send(draft(), user, Date.now());
    await vi.advanceTimersByTimeAsync(10);
    expect(store.compose.outbox()).toEqual([
      expect.objectContaining({
        itemId,
        state: 'failed',
        error: 'Gmail refused to send this message: Invalid To header',
      }),
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gmail.writes).toHaveLength(1);

    store.compose.retry(itemId);
    await vi.advanceTimersByTimeAsync(10);
    expect(gmail.delivered).toHaveLength(1);
    expect(store.compose.outbox()).toEqual([]);
  });

  it('sends held messages at once when Commander is quitting', async () => {
    store.compose.send(draft(), user, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(gmail.writes).toEqual([]);
    store.compose.releaseHeld();
    await vi.advanceTimersByTimeAsync(10);
    expect(gmail.delivered).toHaveLength(1);
  });
});
