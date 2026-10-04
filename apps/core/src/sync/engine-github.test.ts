import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHubCatalog } from '@commander/domain';
import {
  RateLimited,
  type SourceAdapter,
  type SyncRequest,
  type SyncResult,
  type SyncWatch,
} from '@commander/sources';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from './engine';

// The sync engine with a GitHub-like adapter: each sync request carries the Account's watch list and
// the catalog its last sync kept (repo health, updated bit by bit), and Settings → Accounts shows the
// last hour's use of the Source's hourly limits.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const GITHUB = 'github:583231';
const WATCH: SyncWatch = { selection: { orgs: [{ login: 'acme', except: [] }], repos: [] }, orgs: ['acme'] };

let dir: string;
let store: ItemStore;
let clock: number;
let engine: SyncEngine | undefined;
let requests: SyncRequest[];
let behave: (request: SyncRequest) => Promise<SyncResult>;

const catalog = (checkedAt: number): GitHubCatalog => ({
  kind: 'github',
  repos: [
    {
      repo: { nodeId: 'R_api', owner: 'acme', name: 'api' },
      defaultBranch: 'main',
      head: { oid: 'a1b2c3', checks: 'success', committedAt: checkedAt },
      commits: [],
      checkedAt,
    },
  ],
});

const adapter: SourceAdapter = {
  source: 'github',
  cadence: { defaultMinutes: 15, choices: [15] },
  hourlyLimits: { requests: 5000, complexity: 5000 },
  sync: (request) => {
    requests.push(request);
    return behave(request);
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-engine-github-'));
  clock = T0;
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  requests = [];
  behave = async (request) => {
    request.saveCatalog?.(catalog(clock));
    return { cursor: { at: clock }, cost: { requests: 3, complexity: 7 } };
  };
  engine = createSyncEngine({
    store,
    adapters: [adapter],
    accessTokens: { request: async () => ({ token: 'ghu_never_stored', kind: 'oauth' }) },
    watchOf: async (account) => (account === GITHUB ? WATCH : null),
    now: () => clock,
    random: () => 0,
    log: () => {},
  });
  engine.setAccounts([{ id: GITHUB, source: 'github', needsReconnect: false }]);
});

afterEach(() => {
  engine?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('hands each sync the Account’s watch list and the catalog its last sync kept', async () => {
  await engine?.refresh(GITHUB);
  clock += 15 * 60_000;
  await engine?.refresh(GITHUB);

  expect(requests.map((request) => request.watch)).toEqual([WATCH, WATCH]);
  expect(requests[0]?.catalog ?? null).toBeNull();
  expect(requests[1]?.catalog).toEqual(catalog(T0));
  expect(store.syncState.sourceCatalog(GITHUB)).toEqual(catalog(clock));
});

it('shows the last hour’s use of the Source’s hourly limits', async () => {
  await engine?.refresh(GITHUB);
  clock += 15 * 60_000;
  behave = async () => {
    throw new RateLimited('GitHub asked Commander to slow down.', 120_000, { requests: 1, complexity: 2 });
  };
  await engine?.refresh(GITHUB);

  expect(engine?.statuses()[0]?.hourUse).toEqual({
    requests: 4,
    complexity: 9,
    requestLimit: 5000,
    complexityLimit: 5000,
  });
  // An hour on, the first sync no longer counts.
  clock = T0 + 61 * 60_000;
  expect(engine?.statuses()[0]?.hourUse).toMatchObject({ requests: 1, complexity: 2 });
  expect(engine?.statuses()[0]).toMatchObject({
    activity: 'backing-off',
    problem: { kind: 'rate-limited', message: 'GitHub asked Commander to slow down.' },
  });
  expect(engine?.statuses()[0]?.nextSyncAt).toBeGreaterThanOrEqual(T0 + 15 * 60_000 + 120_000);
});
