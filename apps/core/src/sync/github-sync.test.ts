import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, Project } from '@commander/domain';
import { createGitHubSource, type SyncWatch } from '@commander/sources';
import { afterEach, beforeEach, expect, it } from 'vitest';
import changed from '../../../../packages/sources/src/github/recorded/sync-changed.json';
import firstSync from '../../../../packages/sources/src/github/recorded/sync-first-sync.json';
import unchanged from '../../../../packages/sources/src/github/recorded/sync-unchanged.json';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from './engine';

// GitHub sync end to end in the Core: the GitHub adapter against the recorded answers its own tests
// use, the sync engine and a real Item store. Re-running a sync with nothing changed leaves every
// Item as it was and adds nothing to the activity log; filing and Links survive later syncs.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { path: string }; response: Recorded };

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GITHUB = 'github:583231';
const T0 = Date.UTC(2026, 9, 3, 12);
const user: ActionContext = { by: { kind: 'user' } };
const WATCH: SyncWatch = {
  selection: {
    orgs: [{ login: 'acme', except: [] }],
    repos: [{ nodeId: 'R_kgDOOctoDotfiles', owner: 'octocat', name: 'dotfiles' }],
  },
  orgs: ['acme'],
};

let dir: string;
let store: ItemStore;
let clock: number;
let engine: SyncEngine;
let answers: Exchange[];

// GitHub, answering each request with the next recording (the adapter's own tests check the requests).
const fetch = (async (input: string | URL | Request) => {
  const next = answers.shift();
  if (!next) throw new Error(`Unexpected request ${String(input)}`);
  expect(String(input)).toContain(next.request.path.split('?')[0]);
  const { status, headers, body } = next.response;
  return new Response(status === 304 || body === null ? null : JSON.stringify(body), { status, headers });
}) as typeof globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-sync-'));
  clock = T0;
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  engine = createSyncEngine({
    store,
    adapters: [createGitHubSource({ apiUrl: () => 'https://api.github.test', fetch, now: () => clock })],
    accessTokens: { request: async () => ({ token: 'ghu_never_stored', kind: 'oauth' }) },
    watchOf: () => WATCH,
    now: () => clock,
    random: () => 0,
    log: () => {},
  });
  engine.setAccounts([{ id: GITHUB, source: 'github', needsReconnect: false }]);
});

afterEach(() => {
  engine.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function syncWith(exchanges: unknown[], at: number) {
  answers = [...(exchanges as Exchange[])];
  clock = at;
  await engine.refresh(GITHUB);
  expect(answers).toEqual([]);
}

it('saves every kind, and re-running with nothing changed changes no Item and logs nothing', async () => {
  await syncWith(firstSync, T0);
  const kinds = store.query({ source: 'github' }).map((item) => item.kind);
  expect(new Set(kinds)).toEqual(
    new Set(['pull-request', 'github-issue', 'review-request', 'github-release']),
  );
  expect(store.syncState.sourceCatalog(GITHUB)?.kind).toBe('github');
  const items = store.query({ source: 'github', includeDeleted: true });
  const activity = store.activity({ limit: 1000 });

  await syncWith(unchanged, T0 + 15 * 60_000);

  expect(store.query({ source: 'github', includeDeleted: true })).toEqual(items);
  expect(store.activity({ limit: 1000 })).toEqual(activity);
  expect(engine.statuses()[0]).toMatchObject({ problem: null, hourUse: { requests: 5, complexity: 14 } });
});

it('keeps filing and Links through later syncs, and tombstones the review request the User met', async () => {
  await syncWith(firstSync, T0);
  const pull = store
    .query({ kinds: ['pull-request'] })
    .find((item) => item.title === 'Rotate the signing keys');
  const request = store
    .query({ kinds: ['review-request'] })
    .find((item) => item.title === 'Rotate the signing keys');
  if (!pull || !request) throw new Error('missing Items');
  expect(request.detail).toMatchObject({ pullRequestId: pull.id });
  const project = store.changeProject({
    type: 'create',
    project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
  }).project as Project;
  store.record(
    { type: 'update', itemId: pull.id, changes: { filing: { projectId: project.id, filedBy: 'user' } } },
    user,
  );
  const todo = store.record(
    { type: 'create', item: { kind: 'todo', title: 'Review the key rotation' } },
    user,
  );
  store.link({ from: todo.itemId, linkType: 'about', to: pull.id }, user);

  await syncWith(unchanged, T0 + 15 * 60_000);
  await syncWith(changed, T0 + 30 * 60_000);

  expect(store.get(pull.id)).toMatchObject({
    item: { filing: { projectId: project.id, filedBy: 'user' }, detail: { reviewDecision: 'approved' } },
    backlinks: [{ type: 'about', from: { id: todo.itemId } }],
  });
  expect(store.get(request.id)?.item.deletedAt).toBe(T0 + 30 * 60_000);
});
