import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, GitHubSummaryDetail, SummaryCadence } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Ares's GitHub summaries in the Item store (#121): Items of his (kind github-summary), each kept with
// its cadence and day, listed newest first, and marked seen without touching the activity log.

const ares: ActionContext = { by: { kind: 'ares' } };
const HOUR = 3_600_000;

let dir: string;
let clock: number;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-summaries-'));
  clock = Date.UTC(2026, 9, 5, 6);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const detail = (cadence: SummaryCadence, day: string, writtenAt: number): GitHubSummaryDetail => ({
  kind: 'github-summary',
  cadence,
  day,
  range: { from: writtenAt - 24 * HOUR, to: writtenAt },
  choice: cadence === 'on-demand' ? { kind: 'this-week' } : null,
  writtenAt,
  sections: [
    {
      kind: 'shipped',
      groups: [
        {
          project: null,
          repos: [
            {
              repo: { nodeId: 'R_api', owner: 'acme', name: 'api' },
              entries: [{ theme: null, text: 'Retries landed.', itemIds: ['pr-1'], plain: false }],
            },
          ],
        },
      ],
    },
  ],
  onFire: [],
  counts: { shipped: 1, started: 0, stuck: 0, onFire: 0 },
  seenAt: null,
});

function write(summary: GitHubSummaryDetail): string {
  return store.record(
    { type: 'create', item: { kind: 'github-summary', title: 'GitHub summary', detail: summary } },
    ares,
  ).itemId;
}

describe('GitHub summaries', () => {
  it('keep their detail, newest first, by cadence when asked', () => {
    const monday = write(detail('daily', '2026-10-05', clock));
    const rollUp = write(detail('weekly', '2026-10-05', clock + 60_000));
    const asked = write(detail('on-demand', '2026-10-05', clock + 2 * HOUR));
    expect(store.githubSummaries.list().map((item) => item.id)).toEqual([asked, rollUp, monday]);
    expect(
      store.githubSummaries.list({ cadences: ['daily', 'weekly'], limit: 1 }).map((item) => item.id),
    ).toEqual([rollUp]);
    expect(store.get(monday)?.item.detail).toEqual(detail('daily', '2026-10-05', clock));
  });

  it('say whether one was written for a day, and where the last daily one ended', () => {
    expect(store.githubSummaries.lastDailyTo()).toBeNull();
    expect(store.githubSummaries.writtenFor('daily', '2026-10-05')).toBe(false);
    write(detail('daily', '2026-10-04', clock - 24 * HOUR));
    const today = write(detail('daily', '2026-10-05', clock));
    expect(store.githubSummaries.writtenFor('daily', '2026-10-05')).toBe(true);
    expect(store.githubSummaries.writtenFor('weekly', '2026-10-05')).toBe(false);
    expect(store.githubSummaries.lastDailyTo()).toBe(clock);
    // A deleted one doesn't count.
    store.record({ type: 'delete', itemId: today }, ares);
    expect(store.githubSummaries.writtenFor('daily', '2026-10-05')).toBe(false);
    expect(store.githubSummaries.lastDailyTo()).toBe(clock - 24 * HOUR);
  });

  it('are marked seen the first time the User opens one, with nothing in the activity log', () => {
    const id = write(detail('daily', '2026-10-05', clock));
    const entries = store.activity({ itemId: id }).length;
    clock += HOUR;
    const seen = store.githubSummaries.markSeen(id);
    expect(seen?.detail).toMatchObject({ seenAt: clock });
    clock += HOUR;
    expect(store.githubSummaries.markSeen(id)?.detail).toMatchObject({ seenAt: clock - HOUR });
    expect(store.activity({ itemId: id })).toHaveLength(entries);
    expect(store.githubSummaries.markSeen('not-a-summary')).toBeNull();
  });
});
