import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, CoreMessage } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { type Agent, setUpAgent } from '.';

// The Agent in the Core: what it hears of (the User's changes, Source syncs, Ares's own suggestions,
// the machine idle) and when Ares's jobs run because of it. Real Item store and gate; the model is a
// fake provider, answering each job with nothing to do.

const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let agent: Agent;
let calls: ProviderRequest[];
let statuses: CoreMessage[];
let note: string;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const text = ranks(request) ? '{"ranking":[]}' : suggests(request) ? '{"todos":[]}' : '{"facts":[]}';
    return { text, usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};

// Which job a call was for, by its instructions.
const ranks = (request: ProviderRequest) =>
  !!request.messages[0]?.content.includes("rank the User's Dashboard");
const suggests = (request: ProviderRequest) =>
  !!request.messages[0]?.content.includes('You find the things the User needs to do');
const suggestCalls = () => calls.filter(suggests);
const rankCalls = () => calls.filter(ranks);

function open() {
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store });
  agent = setUpAgent(store, {
    gate,
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    send: (message) => statuses.push(message),
    now: () => clock,
    idleAfterMs: 5 * 60_000,
    log: () => {},
  });
}

function writeBlock(text: string): string {
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: {
          kind: 'block',
          dailyNoteId: note,
          parentId: null,
          position: `a${text.length}`,
          text,
          folded: false,
        },
      },
    },
    user,
  ).itemId;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  dir = mkdtempSync(join(tmpdir(), 'commander-agent-'));
  clock = new Date(2026, 9, 3, 9, 30).getTime();
  calls = [];
  statuses = [];
  open();
  note = store.ensureDailyNote('2026-10-03', user).id;
});

afterEach(() => {
  agent.stop();
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// Lets time pass on the clock and the timers together.
async function wait(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
  await agent.runner.settled();
}

describe('the Agent', () => {
  it('learns an example the moment the User dismisses a suggestion of his (#74)', async () => {
    const block = writeBlock('maybe book flights for the offsite');
    const outcome = gate.propose({
      itemId: block,
      action: 'suggest-todos',
      actionKind: 'organise',
      section: 'notes',
      itemActions: [
        {
          type: 'create',
          item: {
            kind: 'todo',
            title: 'Book flights',
            detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
          },
        },
        { type: 'link', from: { step: 0 }, linkType: 'made-from', to: block },
      ],
      confidence: 0.5,
      reason: 'You wrote it',
    });
    if (outcome.decision !== 'ask') throw new Error('expected a suggestion');
    gate.dismiss(outcome.suggestion.id);
    agent.aresChanged();
    expect(store.memory.list().memories.map((memory) => memory.text)).toEqual([
      'Not a Todo: “maybe book flights for the offsite” (Ares suggested “Book flights”)',
    ]);
  });

  it('runs Suggest Todos once the User pauses after changing a Block, and says when Ares works', async () => {
    const block = writeBlock('need to send Dana the Q3 numbers');
    agent.userChanged([block]);
    await wait(19_000);
    expect(suggestCalls()).toHaveLength(0);
    await wait(1_000);
    expect(suggestCalls()).toHaveLength(1);
    // Other jobs that follow typing (Propose events) look too, finding nothing for them here.
    expect(statuses).toContainEqual({ type: 'ares-status', working: true, running: ['Suggest Todos'] });
    expect(statuses.at(-1)).toEqual({ type: 'ares-status', working: false, running: [] });
  });

  it('doesn’t take a change to anything but a Block for typing in a Daily Note', async () => {
    const todo = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Pay rent',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
      user,
    ).itemId;
    agent.userChanged([todo]);
    await wait(30_000);
    expect(suggestCalls()).toHaveLength(0);
  });

  it('catches up when the User has changed nothing for a while, once per quiet spell', async () => {
    // Started with nothing written: its first look (once the start-up pause is up) finds nothing.
    await wait(20_000);
    expect(suggestCalls()).toHaveLength(0);
    // Written somewhere the Core didn't hear about as typing: the catch-up finds it.
    writeBlock('renew passport');
    await wait(5 * 60_000);
    expect(suggestCalls()).toHaveLength(1);
    writeBlock('call the bank');
    await wait(10 * 60_000);
    expect(suggestCalls()).toHaveLength(1);
    // After the User is back and quiet again, another catch-up.
    agent.userChanged([]);
    await wait(5 * 60_000);
    expect(suggestCalls()).toHaveLength(2);
  });

  it('after a restart, looks at what the User wrote since its last run once they pause', async () => {
    agent.runner.run('suggest-todos');
    await agent.runner.settled();
    expect(suggestCalls()).toHaveLength(0); // nothing written yet
    writeBlock('need to send Dana the Q3 numbers');
    agent.stop();
    store.close();

    open();
    await wait(20_000);
    expect(suggestCalls()).toHaveLength(1);
  });

  it('ranks the Dashboard a few seconds after the Todos stop changing, after a sync, and after Ares suggests, and says when it has', async () => {
    const todo = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Pay rent',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
      user,
    ).itemId;
    agent.userChanged([todo]);
    await wait(3_000);
    expect(rankCalls()).toHaveLength(0);
    await wait(2_000);
    expect(rankCalls()).toHaveLength(1);
    expect(statuses).toContainEqual({ type: 'dashboard-ranked', at: clock });

    // Nothing changed since: a sync makes no call, and the Dashboard hears it was ranked again.
    statuses = [];
    agent.synced({ source: 'linear', account: 'linear:org-acme', outcome: 'synced', itemIds: [] });
    await wait(0);
    expect(rankCalls()).toHaveLength(1);
    expect(statuses).toContainEqual({ type: 'dashboard-ranked', at: clock });

    store.record({ type: 'update', itemId: todo, changes: { title: 'Pay the rent' } }, user);
    agent.aresChanged();
    await wait(5_000);
    expect(rankCalls()).toHaveLength(2);
  });

  it('plans meeting prep again after each calendar sync: a meeting synced 20 minutes ahead is prepared at once', async () => {
    const prepares = () =>
      calls.filter((call) => call.messages[0]?.content.includes('prepare the User for a meeting'));
    const start = clock + 20 * 60_000;
    store.saveFromSource({
      source: 'google-calendar',
      account: 'google:1',
      items: [
        {
          externalId: 'sync',
          kind: 'event',
          title: '1:1 with Priya',
          detail: {
            kind: 'event',
            calendar: { id: 'primary', name: 'Primary', colour: '#9fe1e7' },
            accountEmail: 'alex@acme.test',
            start: { at: start, timeZone: null, date: null },
            end: { at: start + 30 * 60_000, timeZone: null, date: null },
            allDay: false,
            location: null,
            description: null,
            organiser: { email: 'alex@acme.test', name: null, self: true },
            attendees: [
              {
                email: 'priya@acme.test',
                name: 'Priya',
                self: false,
                response: 'accepted',
                organiser: false,
                optional: false,
                resource: false,
              },
            ],
            myResponse: 'accepted',
            meetingUrl: null,
            busy: true,
            private: false,
            seriesId: null,
            webUrl: null,
            createdByCommander: null,
          },
        },
      ],
    });
    await wait(0);
    expect(prepares()).toHaveLength(0);
    agent.synced({ source: 'google-calendar', account: 'google:1', outcome: 'synced', itemIds: [] });
    await wait(0);
    expect(prepares()).toHaveLength(1);
  });
});
