import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, SORT_INTO_BUCKETS, sortingLine } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { type Agent, setUpAgent } from '.';
import { allowCloudMail, DAY, deliver, GMAIL, HOUR, type MailInput, moveThread } from './fixtures/emails';

// Ares and a new Account's mail (#141), through the Agent: what a sync brings is sorted at once, a
// bounded batch, newest first; the rest of the 30-day download is sorted in the background while the
// machine stays idle, in bounded batches, newest first, with progress for the Email status line; and
// it stops when the User comes back or the month's cap is reached. Real Item store and gate; a fake
// model that sorts everything into FYI.

const user: ActionContext = { by: { kind: 'user' } };
const T = new Date(2026, 9, 7, 9).getTime();

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let agent: Agent;
let calls: ProviderRequest[];

const sorts = (request: ProviderRequest) => !!request.messages[0]?.content.includes('You sort the User');
const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const text = sorts(request)
      ? '{"bucket":"FYI","confidence":0.95,"reason":"Nothing to do"}'
      : request.messages[0]?.content.includes('You file the User')
        ? '{"filings":[]}'
        : '{"todos":[],"ranking":[],"facts":[],"lines":[]}';
    return { text, usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};
const sortCalls = () => calls.filter(sorts);
const subjects = () =>
  sortCalls().map((call) => /┆ Subject: (.*)/.exec(call.messages.at(-1)?.content ?? '')?.[1]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  dir = mkdtempSync(join(tmpdir(), 'commander-email-agent-'));
  clock = T;
  calls = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  allowCloudMail(store);
  gate = openGate({ itemStore: store });
  agent = setUpAgent(store, {
    gate,
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    send: () => {},
    now: () => clock,
    idleAfterMs: 5 * 60_000,
    backfillPauseMs: 1_000,
    maxEmailsPerRun: 10,
    log: () => {},
  });
});

afterEach(() => {
  agent.stop();
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function wait(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
  await agent.runner.settled();
}

// A new Account's download: 35 threads, one a day-ish, newest first by subject number.
function download(count: number): Record<string, string> {
  const mail: MailInput[] = Array.from({ length: count }, (_, n) => ({
    id: `m${n + 1}`,
    subject: `Mail ${n + 1}`,
    sentAt: T - (n + 1) * 20 * HOUR,
  }));
  return deliver(store, clock, mail);
}

describe('Ares and a new Account’s mail', () => {
  it('sorts a bounded batch as it arrives, then the rest while idle, newest first, with progress', async () => {
    const ids = download(35);
    const inScope = Object.values(ids).filter((id) => {
      const detail = store.get(id)?.item.detail;
      return detail?.kind === 'email' && detail.sentAt >= T - 30 * DAY;
    });
    expect(inScope.length).toBe(35);
    expect(store.emailSorting.progress()).toEqual({ done: 0, total: 35 });

    agent.synced({ source: 'gmail', account: GMAIL, outcome: 'synced', itemIds: Object.values(ids) });
    await agent.runner.settled();
    expect(subjects()).toEqual(Array.from({ length: 10 }, (_, n) => `Mail ${n + 1}`));
    expect(store.emailSorting.progress()).toEqual({ done: 10, total: 35 });
    expect(sortingLine(store.emailSorting.progress())).toBe('Ares is sorting: 10 of 35');

    // Idle: batch after batch, newest first, until all are sorted.
    agent.idle();
    await agent.runner.settled();
    for (let i = 0; i < 6; i++) await wait(1_000);
    expect(subjects()).toEqual(Array.from({ length: 35 }, (_, n) => `Mail ${n + 1}`));
    expect(store.emailSorting.progress()).toEqual({ done: 35, total: 35 });
    expect(sortingLine(store.emailSorting.progress())).toBeNull();
    expect(store.get(ids.m35 as string)?.item.detail).toMatchObject({
      bucket: { bucketId: 'fyi', sortedBy: 'ares' },
    });
  });

  it('stops the backfill when the User comes back, and when the month’s cap is reached', async () => {
    download(35);
    agent.idle();
    await agent.runner.settled();
    expect(sortCalls()).toHaveLength(10);

    // The User changes something: no more batches until the machine is idle again.
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Back' } }, user);
    agent.userChanged([todo.itemId]);
    for (let i = 0; i < 4; i++) await wait(1_000);
    expect(sortCalls()).toHaveLength(10);

    // Idle again, but the month's cap stops the calls: the backfill waits rather than spinning.
    const settings = store.models.settings();
    store.models.saveSettings({ ...settings, monthlyCapUsd: 0.000001 });
    store.models.record({
      at: clock,
      job: 'other',
      tier: 'quick',
      provider: 'zai',
      model: 'glm-5.3-flash',
      inputTokens: 1,
      cachedTokens: 0,
      outputTokens: 1,
      latencyMs: 1,
      costUsd: 1,
      outcome: 'ok',
    });
    agent.idle();
    for (let i = 0; i < 4; i++) await wait(1_000);
    expect(sortCalls()).toHaveLength(10);
    expect(store.agent.job(SORT_INTO_BUCKETS).lastOutcome).toBe('nothing-to-do');
    // Mail that arrives is still sorted (Quick calls carry on past the cap).
    const ids = deliver(store, clock, [{ id: 'new', subject: 'Just arrived' }]);
    agent.synced({ source: 'gmail', account: GMAIL, outcome: 'synced', itemIds: [ids.new as string] });
    await agent.runner.settled();
    expect(subjects().at(-1)).toBe('Just arrived');
  });

  it('dismisses his suggestion once the User sorts the email, or a reply makes it no longer the latest', async () => {
    deliver(store, clock, [{ id: 'a', subject: 'A' }]);
    const ids = deliver(store, clock, [{ id: 'b', subject: 'B' }]);
    // Two suggestions, as an unsure Ares would leave them.
    for (const id of [ids.a, ids.b] as string[]) {
      gate.propose({
        action: SORT_INTO_BUCKETS,
        actionKind: 'organise',
        section: 'email',
        itemId: id,
        itemActions: [
          { type: 'edit-fields', itemId: id, fields: { bucket: { bucketId: 'fyi', sortedBy: 'ares' } } },
        ],
        confidence: 0.5,
        reason: 'Maybe',
      });
    }
    const entries = moveThread(store, ids.a as string, 'receipts');
    agent.userChanged(entries.map((entry) => entry.itemId));
    deliver(store, clock, [
      {
        id: 'b2',
        subject: 'Re: B',
        inReplyTo: '<b@mail.test>',
        references: ['<b@mail.test>'],
        sourceThreadId: 'g-b',
        sentAt: clock - HOUR / 2,
      },
    ]);
    agent.synced({ source: 'gmail', account: GMAIL, outcome: 'synced', itemIds: [] });
    await agent.runner.settled();
    expect(store.autonomy.proposals({ action: SORT_INTO_BUCKETS, statuses: ['pending'] })).toEqual([]);
  });
});
