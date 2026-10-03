import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultModelSettings, type ModelCall } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

const migrationsFolder = join(import.meta.dirname, '../../drizzle');

let dir: string;
let clock: number;
const stores: ItemStore[] = [];

function open() {
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  stores.push(store);
  return store;
}

function reopen(store: ItemStore) {
  store.close();
  stores.splice(stores.indexOf(store), 1);
  return open();
}

const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();

function call(overrides: Partial<ModelCall>): ModelCall {
  return {
    at: clock,
    job: 'sort-email',
    tier: 'quick',
    provider: 'zai',
    model: 'glm-5.3-flash',
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 10,
    latencyMs: 1_600,
    costUsd: 0.001,
    outcome: 'ok',
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-models-'));
  clock = at(15, 18);
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the usage ledger', () => {
  it('totals today and this month, and breaks the month down by day, job and provider', () => {
    let store = open();
    store.models.record(call({ at: at(15, 9), job: 'sort-email', costUsd: 0.25, inputTokens: 1_000 }));
    store.models.record(
      call({ at: at(15, 10), job: 'meeting-prep', tier: 'deep', costUsd: 0.5, cachedTokens: 40 }),
    );
    store.models.record(call({ at: at(3), job: 'sort-email', costUsd: 1, outputTokens: 300 }));
    store.models.record(
      call({ at: at(3), job: 'sort-email', costUsd: 0, outcome: 'rate-limit', inputTokens: 0 }),
    );
    store.models.record(call({ at: at(2), job: 'local-test', model: 'qwen3', costUsd: null }));
    // Last month: not part of this month's totals.
    store.models.record(call({ at: new Date(2026, 8, 30, 23).getTime(), costUsd: 9 }));
    store = reopen(store);

    const usage = store.models.usageSummary();

    expect(usage.month).toBe('2026-10');
    expect(usage.today).toEqual({
      calls: 2,
      errors: 0,
      inputTokens: 1_100,
      cachedTokens: 40,
      outputTokens: 20,
      costUsd: 0.75,
      unpricedCalls: 0,
    });
    expect(usage.thisMonth).toMatchObject({ calls: 5, errors: 1, costUsd: 1.75, unpricedCalls: 1 });
    expect(usage.byDay.map(({ day, calls, costUsd }) => ({ day, calls, costUsd }))).toEqual([
      { day: '2026-10-15', calls: 2, costUsd: 0.75 },
      { day: '2026-10-03', calls: 2, costUsd: 1 },
      { day: '2026-10-02', calls: 1, costUsd: 0 },
    ]);
    expect(usage.byJob.map(({ job, calls, costUsd }) => ({ job, calls, costUsd }))).toEqual([
      { job: 'sort-email', calls: 3, costUsd: 1.25 },
      { job: 'meeting-prep', calls: 1, costUsd: 0.5 },
      { job: 'local-test', calls: 1, costUsd: 0 },
    ]);
    expect(usage.byProvider).toMatchObject([{ provider: 'zai', calls: 5, costUsd: 1.75 }]);
  });

  it('adds up spend since a moment, for the cap', () => {
    const store = open();
    store.models.record(call({ at: at(1, 0), costUsd: 0.2 }));
    store.models.record(call({ at: at(10), costUsd: 0.3 }));
    store.models.record(call({ at: at(10), costUsd: null }));

    expect(store.models.spentSince(at(1, 0))).toBeCloseTo(0.5, 10);
    expect(store.models.spentSince(at(5))).toBeCloseTo(0.3, 10);
  });

  it('keeps one cap warning a month, and the Usage page shows this month’s', () => {
    let store = open();
    const warning = { month: '2026-10', at: at(14), spentUsd: 8.1, capUsd: 10 };

    expect(store.models.recordCapWarning(warning)).toBe(true);
    store = reopen(store);
    expect(store.models.recordCapWarning({ ...warning, at: at(15), spentUsd: 9 })).toBe(false);

    expect(store.models.usageSummary()).toMatchObject({ capWarning: warning });
    clock = new Date(2026, 10, 2).getTime();
    expect(store.models.usageSummary().capWarning).toBeNull();
  });
});

describe('model settings', () => {
  it('default to GLM-5.3-Flash on Z.ai, with Quick thinking low and Deep thinking high', () => {
    const settings = open().models.settings();

    expect(settings).toEqual(defaultModelSettings);
    expect(settings.tiers.quick).toMatchObject({
      provider: 'zai',
      model: 'glm-5.3-flash',
      reasoningEffort: 'low',
    });
    expect(settings.tiers.deep.reasoningEffort).toBe('high');
  });

  it('persist once saved', () => {
    let store = open();
    const changed = {
      ...defaultModelSettings,
      tiers: {
        ...defaultModelSettings.tiers,
        deep: { ...defaultModelSettings.tiers.deep, reasoningEffort: 'max' as const },
      },
      jobOverrides: { 'sort-email': { reasoningEffort: 'high' as const } },
      monthlyCapUsd: 5,
    };

    store.models.saveSettings(changed);
    store = reopen(store);

    expect(store.models.settings()).toEqual(changed);
  });

  it('refuse settings outside the contract', () => {
    const store = open();

    expect(() => store.models.saveSettings({ ...defaultModelSettings, monthlyCapUsd: -1 })).toThrow();
    expect(store.models.settings()).toEqual(defaultModelSettings);
  });
});
