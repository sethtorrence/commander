import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ItemKind, LinearIssueDetail, SearchQuery } from '@commander/domain';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import * as schema from '../item-store/schema';

// Search stays instant on a big database: 50,000 Items (Linear issues with descriptions and
// comments, Todos, Daily Notes and their Blocks) over a small vocabulary, so common words match
// most of them: a harder case than real notes. Each query must answer in under 50 ms.

const ISSUES = 30_000;
const TODOS = 8_000;
const DAYS = 400;
const BLOCKS_PER_DAY = 30;
const TOTAL = ISSUES + TODOS + DAYS * (BLOCKS_PER_DAY + 1);
const BUDGET_MS = 50;

const WORDS = (
  'login loop sync throttle burst invoice export import cache token refresh session cookie banner ' +
  'onboarding billing receipt webhook retry queue worker deploy staging release rollback metric ' +
  'dashboard chart filter search palette shortcut keyboard theme accent badge project rule bucket ' +
  'email calendar meeting agenda notes standup review merge branch commit test flaky timeout crash'
).split(' ');

let seed = 7;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const word = () => WORDS[Math.floor(random() * WORDS.length)] as string;
const sentence = (n: number) => Array.from({ length: n }, word).join(' ');

let dir: string;
let store: ItemStore;
const start = Date.UTC(2025, 0, 1);

function issueDetail(n: number): LinearIssueDetail {
  const identifier = `ENG-${n}`;
  return {
    kind: 'linear-issue',
    identifier,
    url: `https://linear.app/acme/issue/${identifier}`,
    team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#999999' },
    priority: 0,
    assignee: null,
    creator: null,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: sentence(40),
    comments: [0, 1].map((c) => ({
      id: `c-${n}-${c}`,
      author: null,
      body: sentence(15),
      createdAt: start,
      updatedAt: start,
    })),
    createdAt: start,
    updatedAt: start,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
}

// The Items go straight into the tables (as 50,000 saves through the Item store would take half a
// minute), then the Item store opens and builds the index from them, as on the first start after
// search arrived. That build is timed too.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-search-speed-'));
  const path = join(dir, 'commander.db');
  const options = {
    path,
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  };
  openItemStore(options).close();

  const sqlite = new Database(path);
  const db = drizzle(sqlite, { schema });
  const item = (id: string, kind: ItemKind, title: string, at: number) => ({
    id,
    kind,
    source: kind === 'linear-issue' ? ('linear' as const) : null,
    account: kind === 'linear-issue' ? 'linear:org-acme' : null,
    externalId: kind === 'linear-issue' ? id : null,
    title,
    people: [],
    status: 'open' as const,
    createdAt: at,
    updatedAt: at,
  });
  sqlite.transaction(() => {
    for (let n = 1; n <= ISSUES; n++) {
      const id = `issue-${n}`;
      const { kind: _kind, ...data } = issueDetail(n);
      db.insert(schema.items)
        .values(item(id, 'linear-issue', sentence(6), start + n * 1000))
        .run();
      db.insert(schema.linearIssueDetails).values({ itemId: id, identifier: data.identifier, data }).run();
    }
    for (let n = 1; n <= TODOS; n++) {
      db.insert(schema.items)
        .values(item(`todo-${n}`, 'todo', sentence(5), start + n * 1000))
        .run();
      db.insert(schema.todoDetails)
        .values({ itemId: `todo-${n}` })
        .run();
    }
    for (let d = 0; d < DAYS; d++) {
      const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
      const noteId = `note-${day}`;
      db.insert(schema.items)
        .values(item(noteId, 'daily-note', `Daily Note ${day}`, start))
        .run();
      db.insert(schema.dailyNoteDetails).values({ itemId: noteId, day }).run();
      for (let b = 0; b < BLOCKS_PER_DAY; b++) {
        const id = `block-${day}-${b}`;
        const text = sentence(10);
        db.insert(schema.items)
          .values(item(id, 'block', text, start + d * 86_400_000))
          .run();
        db.insert(schema.blockDetails)
          .values({ itemId: id, dailyNoteId: noteId, parentId: null, position: `a${b}`, text, folded: false })
          .run();
      }
    }
    sqlite.exec('DROP TABLE search_meta');
  })();
  sqlite.close();

  const began = performance.now();
  store = openItemStore(options);
  console.info(`Built the search index for ${TOTAL} Items in ${Math.round(performance.now() - began)} ms`);
}, 120_000);

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const QUERIES: SearchQuery[] = [
  { text: 'ENG-418' },
  { text: 'login' },
  { text: 'login loop' },
  { text: 'thrott' },
  { text: 'invoice export retry' },
  { text: 'w' },
  { text: 'de' },
  { text: 'sync', kinds: ['block', 'daily-note'] },
  { text: 'deploy staging', projectId: null },
  { text: 'webhook', accounts: ['linear:org-acme'], from: start + 10_000_000 },
];

it(`answers in under ${BUDGET_MS} ms on ${TOTAL} Items`, () => {
  const timings: Record<string, number> = {};
  for (const query of QUERIES) {
    store.search.query(query);
    // The slowest of a few runs, so one lucky run can't pass it.
    let slowest = 0;
    for (let run = 0; run < 3; run++) {
      const began = performance.now();
      const result = store.search.query(query);
      slowest = Math.max(slowest, performance.now() - began);
      expect(result.hits.length).toBeGreaterThan(0);
    }
    timings[JSON.stringify(query)] = Math.round(slowest * 10) / 10;
  }
  console.info('Search timings (ms):', timings);
  for (const ms of Object.values(timings)) expect(ms).toBeLessThan(BUDGET_MS);
  expect(store.search.query({ text: 'ENG-418' }).hits[0]?.item.title).toBeDefined();
  expect(store.search.query({ text: 'ENG-418' }).hits[0]?.exact).toBe(true);
}, 60_000);
