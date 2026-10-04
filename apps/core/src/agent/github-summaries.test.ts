import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitHubSummary, WRITE_GITHUB_SUMMARY } from '@commander/domain';
import { createModelClient, ModelError, type ModelProviderAdapter } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { createGitHubSummaries, type GitHubSummaries } from './github-summaries';
import { createJobRunner, type JobRunner } from './runner';
import { DAY, HOUR, idOf, merged, repoHealth, syncGitHub } from './testing/github-fixtures';
import { writeGitHubSummaryJob } from './write-github-summary';

// When Ares writes the GitHub summary (#121), on a fake clock in Europe/London: the daily summary once
// the User is first active after 05:00 (or at the first GitHub sync after that), the Monday roll-up,
// no second one after a restart, and asking for one. Only the model is fake.

const TZ = 'Europe/London';
// 00:00 on Monday 5 October 2026 in London (BST).
const MONDAY = Date.UTC(2026, 9, 4, 23);

let dir: string;
let clock: number;
let store: ItemStore;
let runner: JobRunner;
let summaries: GitHubSummaries;
let calls: string[];
let failing: boolean;
let prepared: string[][];

const provider: ModelProviderAdapter = {
  async send(request) {
    const system = request.messages[0]?.content ?? '';
    calls.push(/covers (.*)\./.exec(system)?.[1] ?? '');
    if (failing) throw new ModelError('unavailable', 'The provider is down');
    const refs = [...(request.messages.at(-1)?.content ?? '').matchAll(/label="(I\d+) · /g)].map((m) => m[1]);
    return {
      text: JSON.stringify({ entries: [{ section: 'shipped', theme: null, text: 'Work shipped.', refs }] }),
      usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 },
    };
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
  const job = writeGitHubSummaryJob(store, { now: () => clock, timeZone: TZ });
  runner = createJobRunner({
    jobs: [job],
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    gate: openGate({ itemStore: store }),
    store: store.agent,
    now: () => clock,
    tickMs: null,
    log: () => {},
  });
  summaries = createGitHubSummaries({
    itemStore: store,
    runner,
    job,
    prepareWriterDetails: async (ids) => {
      prepared.push([...ids]);
    },
    now: () => clock,
    timeZone: TZ,
    log: () => {},
  });
}

function close() {
  runner.stop();
  store.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-summaries-'));
  clock = MONDAY - 2 * DAY + 4 * HOUR; // Saturday 04:00
  calls = [];
  failing = false;
  prepared = [];
  open();
  // Merged on Friday evening, and on Saturday at 03:00.
  syncGitHub(store, [merged(clock, 1, 'Friday’s change', 9), merged(clock, 2, 'Saturday’s change', 1)]);
  repoHealth(store, clock);
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

async function at(time: number) {
  clock = time;
  await summaries.due();
  await runner.settled();
}

const written = () =>
  store.githubSummaries
    .list()
    .filter(isGitHubSummary)
    .map((summary) => `${summary.detail.cadence} ${summary.detail.day}`)
    .reverse();

describe('the daily summary', () => {
  it('waits for 05:00, then is written once for the day, since the last one', async () => {
    await at(clock);
    expect(calls).toEqual([]);

    await at(MONDAY - 2 * DAY + 7 * HOUR); // Saturday 07:00: the User is first active.
    expect(written()).toEqual(['daily 2026-10-03']);
    // The writer's detail of the pull requests in range was fetched first.
    expect(prepared.at(-1)).toEqual(
      expect.arrayContaining([idOf(store, 'Friday’s change'), idOf(store, 'Saturday’s change')]),
    );

    // A GitHub sync later that day, the User coming back: nothing more.
    await at(MONDAY - 2 * DAY + 12 * HOUR);
    await at(MONDAY - 2 * DAY + 18 * HOUR);
    expect(calls).toHaveLength(1);
    expect(written()).toEqual(['daily 2026-10-03']);
  });

  it('covers everything since the last daily summary', async () => {
    await at(MONDAY - 2 * DAY + 7 * HOUR);
    // Merged on Saturday afternoon.
    syncGitHub(store, [merged(MONDAY - DAY, 3, 'Saturday afternoon’s change', 8)]);
    await at(MONDAY - DAY + 9 * HOUR); // Sunday 09:00
    const [sunday, saturday] = store.githubSummaries.list({ cadences: ['daily'] }).filter(isGitHubSummary);
    expect(sunday?.detail.range).toEqual({ from: saturday?.detail.range.to, to: MONDAY - DAY + 9 * HOUR });
  });

  it('is never written twice for a day, whatever restarts in between', async () => {
    await at(MONDAY - 2 * DAY + 7 * HOUR);
    close();
    open();
    await at(MONDAY - 2 * DAY + 8 * HOUR);
    expect(calls).toHaveLength(1);
    expect(written()).toEqual(['daily 2026-10-03']);
  });

  it('is tried again later when the model fails, and written once it answers', async () => {
    failing = true;
    await at(MONDAY - 2 * DAY + 7 * HOUR);
    expect(written()).toEqual([]);
    failing = false;
    await at(MONDAY - 2 * DAY + 7 * HOUR + 30 * 60_000);
    expect(written()).toEqual(['daily 2026-10-03']);
  });
});

describe('the Monday roll-up', () => {
  it('comes on Monday with the daily summary, covering the previous Monday to Sunday', async () => {
    // Merged early on Monday, for the daily summary.
    syncGitHub(store, [merged(MONDAY + 6 * HOUR, 4, 'Monday’s change', 4)]);
    await at(MONDAY + 6 * HOUR);
    expect(written()).toEqual(['daily 2026-10-05', 'weekly 2026-10-05']);
    const [rollUp] = store.githubSummaries.list({ cadences: ['weekly'] }).filter(isGitHubSummary);
    expect(rollUp?.detail.range).toEqual({ from: MONDAY - 7 * DAY, to: MONDAY });
    expect(rollUp?.title).toBe('GitHub roll-up · week of 28 Sep');

    close();
    open();
    await at(MONDAY + 10 * HOUR);
    expect(written()).toEqual(['daily 2026-10-05', 'weekly 2026-10-05']);
    expect(calls).toHaveLength(2);
  });
});

describe('asking for one', () => {
  it('writes one for the range and Project asked for', async () => {
    const titanlink = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
    }).project;
    const change = idOf(store, 'Saturday’s change');
    store.record(
      {
        type: 'update',
        itemId: change,
        changes: { filing: { projectId: titanlink?.id ?? '', filedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    clock = MONDAY - 2 * DAY + 4 * HOUR;
    const range = { from: MONDAY - 3 * DAY, to: clock };
    const answer = await summaries.ask({
      range,
      projectId: titanlink?.id ?? '',
      choice: { kind: 'since', day: '2026-10-02' },
    });
    expect(answer.problem).toBeNull();
    expect(answer.summary?.title).toBe('GitHub summary · Titanlink · since 2 Oct');
    expect(answer.summary?.detail).toMatchObject({
      cadence: 'on-demand',
      range,
      projectId: titanlink?.id,
      choice: { kind: 'since', day: '2026-10-02' },
    });
    const ids = isGitHubSummary(answer.summary)
      ? answer.summary.detail.sections.flatMap((section) =>
          section.groups.flatMap((group) =>
            group.repos.flatMap((repo) => repo.entries.flatMap((e) => e.itemIds)),
          ),
        )
      : [];
    expect(ids).toEqual([change]);
  });

  it('says why when there is none: the model failing, the job switched off, nothing in range', async () => {
    const range = { from: MONDAY - 3 * DAY, to: clock };
    failing = true;
    expect(await summaries.ask({ range, choice: { kind: 'since', day: '2026-10-02' } })).toEqual({
      summary: null,
      problem: 'Ares couldn’t write it: The provider is down',
    });
    runner.setEnabled(WRITE_GITHUB_SUMMARY, false);
    expect((await summaries.ask({ range, choice: { kind: 'this-week' } })).problem).toBe(
      'Ares’s GitHub summary is switched off in Settings → Ares.',
    );
    runner.setEnabled(WRITE_GITHUB_SUMMARY, true);
    failing = false;
    expect(
      await summaries.ask({
        range: { from: clock - HOUR / 2, to: clock },
        choice: { kind: 'since-yesterday' },
      }),
    ).toEqual({ summary: null, problem: 'Nothing happened in this range for Ares to write about.' });
  });
});
