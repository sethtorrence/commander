import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, GitHubSummaryDetail, SummaryCadence } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpUpdates, type Updates } from '.';

// Ares's GitHub summary in the Update (#121): the latest unseen daily summary or roll-up is one For
// your information line with its first lines, gone once the User opens it or a newer one comes, and
// asking Ares for a summary from the GitHub Section goes through the Update's channel.

const HOUR = 3_600_000;
const ares: ActionContext = { by: { kind: 'ares' } };

let dir: string;
let clock: number;
let store: ItemStore;
let updates: Updates;

const provider: ModelProviderAdapter = {
  async send() {
    return { text: '{"lines":[]}', usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 10 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-updates-github-'));
  clock = Date.UTC(2026, 9, 5, 6);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  updates = setUpUpdates({
    itemStore: store,
    gate: openGate({ itemStore: store }),
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    now: () => clock,
    summariseGitHub: async (request) => ({ summary: null, problem: `asked for ${request.choice.kind}` }),
    log: () => {},
  });
});

afterEach(() => {
  updates.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(cadence: SummaryCadence, onFire: string[] = []): string {
  const detail: GitHubSummaryDetail = {
    kind: 'github-summary',
    cadence,
    day: '2026-10-05',
    range: { from: clock - 24 * HOUR, to: clock },
    choice: cadence === 'on-demand' ? { kind: 'this-week' } : null,
    writtenAt: clock,
    sections: [
      {
        kind: 'shipped',
        groups: [
          {
            project: null,
            repos: [
              {
                repo: { nodeId: 'R_api', owner: 'acme', name: 'api' },
                entries: [
                  { theme: 'Retries', text: 'Webhook retries landed.', itemIds: ['x'], plain: false },
                ],
              },
            ],
          },
        ],
      },
    ],
    onFire,
    counts: { shipped: 1, started: 0, stuck: 0, onFire: onFire.length },
    seenAt: null,
  };
  clock += 60_000;
  return store.record(
    { type: 'create', item: { kind: 'github-summary', title: 'GitHub summary · since yesterday', detail } },
    ares,
  ).itemId;
}

const summaryLines = () => updates.queue.list().filter((line) => line.about.kind === 'github-summary');

describe('the GitHub summary in the Update', () => {
  it('queues the latest unseen one, For your information, with its first lines', async () => {
    const id = write('daily');
    updates.sweep();
    expect(summaryLines()).toEqual([
      expect.objectContaining({
        group: 'fyi',
        section: 'github',
        itemIds: [id],
        about: {
          kind: 'github-summary',
          summaryId: id,
          label: 'GitHub summary · since yesterday',
          lead: 'Retries: Webhook retries landed. Nothing on fire.',
          onFire: false,
        },
      }),
    ]);
    const update = await updates.give();
    expect(update?.lines.find((line) => line.kind === 'github-summary')?.text).toBe(
      'GitHub summary · since yesterday: 1 shipped, and nothing on fire. Nothing needs you; open it when you want the detail.',
    );
  });

  it('goes once the User opens it, and never comes back', () => {
    const id = write('daily');
    updates.sweep();
    store.githubSummaries.markSeen(id);
    updates.sweep();
    expect(summaryLines()).toEqual([]);
  });

  it('gives way to a newer one, and leaves out what was asked for on demand', () => {
    write('daily');
    updates.sweep();
    const rollUp = write('weekly', ['Main is failing on acme/api']);
    write('on-demand');
    updates.sweep();
    expect(summaryLines().map((line) => [line.about, line.importance])).toEqual([
      [expect.objectContaining({ summaryId: rollUp, onFire: true }), 0.8],
    ]);
  });

  it('stays dealt with once dismissed', () => {
    write('daily');
    updates.sweep();
    const [line] = summaryLines();
    updates.act(line?.id ?? 0, 'dismiss');
    updates.sweep();
    expect(summaryLines()).toEqual([]);
  });

  it('asks Ares for a summary through the Update’s channel', async () => {
    const replies: unknown[] = [];
    const answered = new Promise<void>((resolve) => {
      const again = setUpUpdates({
        itemStore: store,
        gate: openGate({ itemStore: store }),
        client: createModelClient({
          settings: () => store.models.settings(),
          providers: { zai: provider },
          ledger: store.models,
          now: () => clock,
        }),
        summariseGitHub: async (request) => ({ summary: null, problem: `asked for ${request.choice.kind}` }),
        send: (message) => {
          replies.push(message);
          again.stop();
          resolve();
        },
        log: () => {},
      });
      again.handle({
        type: 'updates-request',
        id: 7,
        request: {
          op: 'summarise-github',
          request: { range: { from: 0, to: clock }, choice: { kind: 'this-week' } },
        },
      });
    });
    await answered;
    expect(replies).toEqual([
      {
        type: 'updates-reply',
        id: 7,
        response: { ok: true, result: { summary: null, problem: 'asked for this-week' } },
      },
    ]);
  });
});
