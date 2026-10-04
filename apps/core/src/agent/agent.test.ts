import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, AresStatus } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { type Agent, setUpAgent } from '.';

// The Agent in the Core: what it hears of (the User's changes, Source syncs, the machine idle) and
// when Ares's jobs run because of it. Real Item store and gate; the model is a fake provider.

const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let agent: Agent;
let calls: ProviderRequest[];
let statuses: AresStatus[];
let note: string;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    return { text: '{"todos":[]}', usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};

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
  it('runs Suggest Todos once the User pauses after changing a Block, and says when Ares works', async () => {
    const block = writeBlock('need to send Dana the Q3 numbers');
    agent.userChanged([block]);
    await wait(19_000);
    expect(calls).toHaveLength(0);
    await wait(1_000);
    expect(calls).toHaveLength(1);
    expect(statuses).toEqual([
      { type: 'ares-status', working: true, running: ['Suggest Todos'] },
      { type: 'ares-status', working: false, running: [] },
    ]);
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
    expect(calls).toHaveLength(0);
  });

  it('catches up when the User has changed nothing for a while, once per quiet spell', async () => {
    // Started with nothing written: its first look (once the start-up pause is up) finds nothing.
    await wait(20_000);
    expect(calls).toHaveLength(0);
    // Written somewhere the Core didn't hear about as typing: the catch-up finds it.
    writeBlock('renew passport');
    await wait(5 * 60_000);
    expect(calls).toHaveLength(1);
    writeBlock('call the bank');
    await wait(10 * 60_000);
    expect(calls).toHaveLength(1);
    // After the User is back and quiet again, another catch-up.
    agent.userChanged([]);
    await wait(5 * 60_000);
    expect(calls).toHaveLength(2);
  });

  it('after a restart, looks at what the User wrote since its last run once they pause', async () => {
    agent.runner.run('suggest-todos');
    await agent.runner.settled();
    expect(calls).toHaveLength(0); // nothing written yet
    writeBlock('need to send Dana the Q3 numbers');
    agent.stop();
    store.close();

    open();
    await wait(20_000);
    expect(calls).toHaveLength(1);
  });
});
