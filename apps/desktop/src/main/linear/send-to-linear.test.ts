import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ItemStore, openItemStore } from '@commander/core/src/item-store';
import { setUpSync } from '@commander/core/src/sync';
import type { ActivityEntry, Item, ItemAction, LinearIssueDetail } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_LABELS, FAKE_STATES } from './fake-linear-issues';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from './fake-linear-server';

// Send to Linear end to end below the window: the Item store queues a new issue's creation, the Core's
// sync engine sends it through the Linear adapter to a fake Linear on this machine, and the issue
// comes back numbered. Stopping Commander after Linear made the issue but before Commander heard
// (a crash, a lost answer) and starting it again never makes a second issue; undoing a send deletes
// the issue in Linear.

const API_KEY = 'lin_api_send_to_linear';
const ACCOUNT = `linear:${ACME.id}`;
const ME = viewerOf(ACME);
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const TODO = FAKE_STATES.find((state) => state.name === 'Todo') as (typeof FAKE_STATES)[number];
const migrationsFolder = join(import.meta.dirname, '../../../../core/drizzle');

let dir: string;
let fake: FakeLinear;
let store: ItemStore;
let sync: ReturnType<typeof setUpSync>;

function start() {
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
  sync = setUpSync(store, {
    send: () => {},
    accessTokens: { request: async () => ({ token: API_KEY, kind: 'api-key' }) },
    log: () => {},
  });
  sync.handle({
    type: 'sync-accounts',
    accounts: [{ id: ACCOUNT, source: 'linear', needsReconnect: false, me: ME.id }],
    endpoints: { linear: fake.apiUrl },
  });
}

async function stop() {
  sync.stop();
  // What was on its way when Commander stopped never arrives.
  await new Promise((resolve) => setTimeout(resolve, 50));
  store.close();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commander-send-to-linear-'));
  fake = await startFakeLinear();
  fake.addApiKey(API_KEY, ACME);
  fake.issues.setCatalog(ACME.id, [
    { team: ENG, states: FAKE_STATES, members: [ME], labels: FAKE_LABELS, cycles: [], projects: [] },
  ]);
  start();
  // The first sync brings what the workspace offers: its teams, states and members.
  await expect.poll(() => store.syncState.catalog(ACCOUNT)?.teams.length).toBe(1);
});

afterEach(async () => {
  sync.stop();
  store.close();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

function send(): { issue: Item; entries: ActivityEntry[] } {
  const entries = store.sendToLinear(
    { account: ACCOUNT, team: ENG, title: 'Write the runbook', assignee: ME, state: TODO, priority: 2 },
    { by: { kind: 'user' } },
  );
  return { issue: store.get(entries[0]?.itemId as string)?.item as Item, entries };
}

const identifierOf = (itemId: string) =>
  (store.get(itemId)?.item.detail as LinearIssueDetail | undefined)?.identifier;
const creations = () =>
  fake.graphqlRequests.filter((request) => request.operationName === 'CommanderIssueCreate');

describe('Send to Linear, through the sync engine', () => {
  it('makes the issue in Linear under Commander’s id, and the Item takes Linear’s number', async () => {
    const { issue } = send();
    await expect.poll(() => identifierOf(issue.id)).toBe('ENG-1');
    expect(fake.issues.get(issue.externalId as string)).toMatchObject({
      title: 'Write the runbook',
      priority: 2,
      assignee: { id: ME.id },
      state: { name: 'Todo' },
    });
    expect(store.outgoing.forItem(issue.id)).toEqual([]);
  });

  it('never makes a second issue when Commander stops between Linear making it and hearing so', async () => {
    fake.delayWriteAnswers(2000);
    const { issue } = send();
    await expect.poll(() => creations().length).toBe(1);
    await stop();
    fake.delayWriteAnswers(0);

    start();
    await expect.poll(() => identifierOf(issue.id), { timeout: 10_000 }).toBe('ENG-1');
    expect(creations()).toHaveLength(1);
    expect(store.query({ kinds: ['linear-issue'] })).toHaveLength(1);
  });

  it('deletes the issue in Linear when the send is undone', async () => {
    const { issue, entries } = send();
    await expect.poll(() => identifierOf(issue.id)).toBe('ENG-1');
    store.recordAll(
      [...entries].reverse().map((entry): ItemAction => ({ type: 'undo', entryId: entry.id })),
      { by: { kind: 'user' } },
    );
    await expect.poll(() => fake.issues.get(issue.externalId as string).trashed).toBe(true);
    expect(store.get(issue.id)?.item.deletedAt).not.toBeNull();
  });
});
