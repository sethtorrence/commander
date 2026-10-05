import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';

// Memory stays quick to look up as it grows: 10,000 memories (examples with keywords, facts about
// People and Projects) over a small vocabulary, so a lookup's words match many of them. Every job's
// prompt looks Memory up, and the palette searches it as the User types: each must answer in under
// 25 ms.

const MEMORIES = 10_000;
const PEOPLE = 200;
const BUDGET_MS = 25;

const WORDS = (
  'login loop sync throttle burst invoice export import cache token refresh session cookie banner ' +
  'onboarding billing receipt webhook retry queue worker deploy staging release rollback metric ' +
  'dashboard chart filter search palette shortcut keyboard theme accent badge pager rota relay'
).split(' ');

let seed = 11;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const word = () => WORDS[Math.floor(random() * WORDS.length)] as string;
const sentence = (n: number) => Array.from({ length: n }, word).join(' ');

let dir: string;
let store: ItemStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-memory-speed-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  store.transaction(() => {
    for (let n = 0; n < MEMORIES; n++) {
      const person = n % PEOPLE;
      store.memory.learn({
        kind: n % 3 ? 'example' : 'fact',
        key: `speed:${n}`,
        text: `Linear issue ENG-${n} (team ENG · ${word()}) belongs to TX (Tactics), not TL (Titanlink)`,
        keywords: sentence(12),
        confirmed: n % 2 === 0,
        handles: [`person-${person}@acme.test`],
        sources: [],
      });
    }
  });
}, 120_000);

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function timed(run: () => unknown): number {
  run();
  const started = performance.now();
  for (let i = 0; i < 10; i++) run();
  return (performance.now() - started) / 10;
}

it('looks up the memories about an Item by its words and people in under 25 ms', () => {
  const ms = timed(() =>
    store.memory.lookup({
      text: `Pager rota relay retries ${sentence(30)}`,
      handles: ['person-7@acme.test', 'person-9@acme.test'],
    }),
  );
  expect(ms).toBeLessThan(BUDGET_MS);
});

it('searches what Ares knows as the User types in under 25 ms', () => {
  for (const typed of ['b', 'be', 'belongs ta', 'relay pag']) {
    expect(timed(() => store.search.query({ text: typed }))).toBeLessThan(BUDGET_MS);
  }
});
