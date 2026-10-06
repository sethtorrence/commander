import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ComposeContext, type ItemStore, openItemStore } from '@commander/core/src/item-store';
import { type SendLater, setUpSendLater } from '@commander/core/src/send-later';
import { setUpSync } from '@commander/core/src/sync';
import type { ComposeDraft } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeGmail, type FakeGmail } from './fake-gmail';

// Send later for a Gmail Account below the window (#139): the Item store, the Core's send-later clock
// (a fake clock, moved by hand), and the sync engine with Commander's own Gmail adapter, against a fake
// Gmail on this machine. A message scheduled while Commander runs is saved to Gmail's Drafts and sent
// at its time, once; one whose time passed while Commander was closed is never sent on the next start.

const ME = 'alex@gmail.test';
const ACCOUNT = 'google:alex';
const HOUR = 60 * 60_000;
const migrationsFolder = join(import.meta.dirname, '../../../../core/drizzle');
const from = { name: 'Alex Kim', address: ME };
const gmail: ComposeContext = { by: { kind: 'user' }, source: 'gmail', from };

let dir: string;
let fake: FakeGmail;
let server: Server;
let store: ItemStore;
let sync: ReturnType<typeof setUpSync>;
let sendLater: SendLater;
let clock: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commander-send-later-gmail-'));
  fake = createFakeGmail();
  server = createServer((request, response) => {
    void fake.handle(request, response, new URL(request.url ?? '/', 'http://localhost'), ME);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
  sync = setUpSync(store, {
    send: () => {},
    accessTokens: { request: async () => ({ token: 'ya29.fake', kind: 'oauth' }) },
    log: () => {},
  });
  sync.handle({
    type: 'sync-accounts',
    accounts: [{ id: ACCOUNT, sources: ['gmail'], needsReconnect: false, connectedAt: Date.now() }],
    endpoints: { linear: 'http://127.0.0.1:9/unused', gmail: base },
  });
  // The send-later clock is the test's: it moves only when the test says.
  clock = Date.now();
  startSendLater();
});

afterEach(async () => {
  sendLater.stop();
  sync.stop();
  store.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

function startSendLater() {
  sendLater = setUpSendLater({ store, now: () => clock, timers: false, log: () => {} });
}

const draft: ComposeDraft = {
  mode: 'new',
  account: ACCOUNT,
  to: [{ name: 'Dana Whitfield', address: 'dana@northwind.test' }],
  cc: [],
  bcc: [],
  subject: 'Venue options',
  body: [{ type: 'paragraph', runs: [{ text: 'Here are three.' }] }],
  attachments: [],
};

describe('send later through Gmail', () => {
  it('saves it to Gmail’s Drafts, and sends it at its time, once', async () => {
    const { itemId } = store.compose.schedule(draft, gmail, clock + HOUR, 'commander');
    await expect.poll(() => store.outgoing.forItem(itemId).length, { timeout: 10_000 }).toBe(0);
    expect(fake.sent).toEqual([]);

    clock += HOUR - 60_000;
    sendLater.tick();
    expect(store.outgoing.forItem(itemId)).toEqual([]);

    clock += 61_000;
    sendLater.tick();
    await expect.poll(() => fake.sent.length, { timeout: 10_000 }).toBe(1);
    const subject = fake.sent[0]?.mime.headers.find((header) => header.name.toLowerCase() === 'subject');
    expect(subject?.value).toBe('Venue options');
    await expect
      .poll(() => store.get(itemId)?.item.externalId, { timeout: 10_000 })
      .not.toMatch(/^commander:|^draft:/);
    expect(store.compose.scheduled()).toEqual([]);

    // Its time doesn't come twice.
    clock += HOUR;
    sendLater.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.sent).toHaveLength(1);
  });

  it('never sends one whose time passed while Commander was closed: it is missed', async () => {
    const { itemId } = store.compose.schedule(draft, gmail, clock + HOUR, 'commander');
    sendLater.stop();
    clock += 3 * HOUR;
    startSendLater();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(fake.sent).toEqual([]);
    expect(store.compose.scheduled()).toMatchObject([{ itemId, state: 'missed' }]);
  });
});
