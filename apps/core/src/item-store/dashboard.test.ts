import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, RANK_DASHBOARD, rankingFingerprint } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// The Dashboard's side of the Item store: Ares's latest ranking, the rows the User cleared, and what
// the window reads (Ares's ranking, or why the rules rank the Dashboard instead).

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const NOW = new Date(2026, 9, 3, 14, 2).getTime();

let dir: string;
let clock: number;
let store: ItemStore;

function open() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
}

const todo = (title: string) =>
  store.record(
    {
      type: 'create',
      item: { kind: 'todo', title, detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null } },
    },
    user,
  ).itemId;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-dashboard-'));
  clock = NOW;
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const entry = (itemId: string, band: 'now' | 'today' | 'none', rank: number) => ({
  itemId,
  band,
  rank,
  reason: `Reason ${rank}`,
  fingerprint: 'f1',
});

describe('Ares’s ranking', () => {
  it('is none until he ranks, then his latest, kept across restarts', () => {
    expect(store.dashboard.aresRanking()).toEqual({ at: null, entries: [] });
    store.dashboard.saveAresRanking(NOW, [entry('a', 'now', 1), entry('suggestion:4', 'today', 1)]);
    store.dashboard.saveAresRanking(NOW + 60_000, [entry('b', 'today', 1), entry('c', 'none', 1)]);
    store.close();
    store = open();
    expect(store.dashboard.aresRanking()).toEqual({
      at: NOW + 60_000,
      entries: [entry('b', 'today', 1), entry('c', 'none', 1)],
    });
  });
});

describe('the state the window reads', () => {
  it('is the rules’ until Ares has ranked', () => {
    expect(store.dashboard.state().ranking).toEqual({
      by: 'rules',
      at: null,
      why: 'Ares hasn’t ranked it yet',
      entries: [],
    });
  });

  it('is Ares’s once he has, with when', () => {
    store.dashboard.saveAresRanking(NOW, [entry('a', 'now', 1)]);
    store.agent.saveJob(RANK_DASHBOARD, { lastRunAt: NOW, lastOutcome: 'ok' });
    expect(store.dashboard.state().ranking).toEqual({
      by: 'ares',
      at: NOW,
      why: null,
      entries: [entry('a', 'now', 1)],
    });
    // A later run with nothing new to rank leaves his ranking standing.
    store.agent.saveJob(RANK_DASHBOARD, { lastRunAt: NOW + 1, lastOutcome: 'nothing-to-do' });
    expect(store.dashboard.state().ranking.by).toBe('ares');
  });

  it('is the rules’, saying why, when ranking is Off in the Autonomy settings', () => {
    store.dashboard.saveAresRanking(NOW, [entry('a', 'now', 1)]);
    store.autonomy.saveSettings({
      ...store.autonomy.settings(),
      actions: { [RANK_DASHBOARD]: 'off' },
    });
    expect(store.dashboard.state().ranking).toMatchObject({
      by: 'rules',
      why: 'Ares is Off for ranking the Dashboard',
      entries: [],
    });
    store.autonomy.saveSettings({
      ...store.autonomy.settings(),
      everywhere: { ...store.autonomy.settings().everywhere, organise: 'off' },
      actions: {},
    });
    expect(store.dashboard.state().ranking.by).toBe('rules');
  });

  it('is Ares’s at Ask too: ranking at Ask works as Auto', () => {
    store.dashboard.saveAresRanking(NOW, [entry('a', 'now', 1)]);
    store.autonomy.saveSettings({ ...store.autonomy.settings(), actions: { [RANK_DASHBOARD]: 'ask' } });
    expect(store.dashboard.state().ranking.by).toBe('ares');
  });

  it('is the rules’ when the job is switched off', () => {
    store.dashboard.saveAresRanking(NOW, [entry('a', 'now', 1)]);
    store.agent.saveJob(RANK_DASHBOARD, { enabled: false });
    expect(store.dashboard.state().ranking).toMatchObject({
      by: 'rules',
      why: 'Rank the Dashboard is switched off in Settings → Ares',
    });
  });

  it('is the rules’ when his last run failed or was over the cap, saying so', () => {
    store.dashboard.saveAresRanking(NOW, [entry('a', 'now', 1)]);
    store.agent.saveJob(RANK_DASHBOARD, {
      lastRunAt: NOW + 1,
      lastOutcome: 'failed',
      lastProblem: 'No API key is set for Z.ai.',
    });
    expect(store.dashboard.state().ranking).toMatchObject({
      by: 'rules',
      why: 'Ares couldn’t rank it: No API key is set for Z.ai.',
      entries: [],
    });
    store.agent.saveJob(RANK_DASHBOARD, { lastOutcome: 'over-cap', lastProblem: 'Over the cap' });
    expect(store.dashboard.state().ranking.why).toBe('Ares couldn’t rank it: this month’s cap is reached');
    // His next good run counts again.
    store.dashboard.saveAresRanking(NOW + 2, [entry('a', 'now', 1)]);
    store.agent.saveJob(RANK_DASHBOARD, { lastRunAt: NOW + 2, lastOutcome: 'ok', lastProblem: null });
    expect(store.dashboard.state().ranking.by).toBe('ares');
  });
});

describe('cleared rows', () => {
  it('are kept with the Item as it was when cleared, across restarts', () => {
    const report = todo('Send the report');
    const saved = store.dashboard.saveClears({ [report]: { band: 'today', at: NOW } });
    expect(saved).toEqual({ [report]: { band: 'today', at: NOW } });
    store.close();
    store = open();
    expect(store.dashboard.state().clears).toEqual({ [report]: { band: 'today', at: NOW } });
    const item = store.get(report)?.item;
    expect(store.dashboard.clears()).toEqual([
      { itemId: report, band: 'today', at: NOW, fingerprint: item && rankingFingerprint(item) },
    ]);
  });

  it('keep the fingerprint from when each was cleared, and drop the ones no longer there', () => {
    const report = todo('Send the report');
    const other = todo('Book the room');
    store.dashboard.saveClears({ [report]: { band: 'today', at: NOW } });
    const before = store.dashboard.clears()[0]?.fingerprint;
    const item = store.get(report)?.item;
    if (item?.detail?.kind !== 'todo') throw new Error('No Todo');
    store.record({ type: 'update', itemId: report, changes: { title: 'Send the Q3 report' } }, user);
    store.dashboard.saveClears({
      [report]: { band: 'today', at: NOW },
      [other]: { band: 'now', at: NOW + 1 },
      'suggestion:3': { band: 'fyi', at: NOW + 2 },
    });
    const clears = store.dashboard.clears();
    expect(clears.find((clear) => clear.itemId === report)?.fingerprint).toBe(before);
    expect(clears.find((clear) => clear.itemId === 'suggestion:3')?.fingerprint).toBeNull();
    store.dashboard.saveClears({ [other]: { band: 'now', at: NOW + 1 } });
    expect(store.dashboard.clears().map((clear) => clear.itemId)).toEqual([other]);
  });
});
