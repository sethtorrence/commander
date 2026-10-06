import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, SearchQuery } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import type { QueryVector } from './meaning-index';

// Search by meaning (#73) through the Item store, against a real temporary database with fixed
// vectors standing in for the embedding model: which Items wait to be embedded, saving their
// embeddings, and the hybrid of words and meaning that search answers with.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const MODEL = 'fixed-vectors';

let dir: string;
let store: ItemStore;
let clock: number;

const open = () =>
  openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-meaning-'));
  clock = Date.UTC(2026, 9, 1, 12);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// Four made-up directions of meaning: rate limiting, contracts, travel, food.
const LIMITS = [1, 0, 0, 0];
const CONTRACTS = [0, 1, 0, 0];
const TRAVEL = [0, 0, 1, 0];
const vector = (...parts: number[]) => Float32Array.from(parts);
const near = (direction: number[], minSimilarity = 0.5): QueryVector => ({
  model: MODEL,
  vector: vector(...direction),
  minSimilarity,
});

function addTodo(title: string, projectId: string | null = null): string {
  const filing = projectId ? { projectId, filedBy: 'user' as const } : null;
  return store.record({ type: 'create', item: { kind: 'todo', title, filing } }, user).itemId;
}

// Embeds everything waiting, each by the direction its text is about.
function embedAll(directions: Record<string, number[]>) {
  for (let work = store.meaning.pending(MODEL, 10); work.length; work = store.meaning.pending(MODEL, 10)) {
    store.meaning.save(
      MODEL,
      work.map(({ key, text }) => {
        const found = Object.entries(directions).find(([word]) => text.includes(word));
        return { key, text, vector: vector(...(found?.[1] ?? [0, 0, 0, 1])) };
      }),
    );
  }
}

const titles = (query: SearchQuery, meaning?: QueryVector) =>
  store.search.query(query, meaning).hits.map((hit) => hit.item.title);

describe('finding Items by meaning', () => {
  it('finds an Item sharing no words with the query, once it is embedded', () => {
    addTodo('Throttle bursts on /sync');
    addTodo('Renew the passport');
    embedAll({ Throttle: LIMITS, passport: TRAVEL });

    const [hit, ...rest] = store.search.query({ text: 'the rate limiter thing' }, near(LIMITS)).hits;
    expect(hit?.item.title).toBe('Throttle bursts on /sync');
    expect(hit?.foundBy).toEqual(['meaning']);
    expect(rest).toEqual([]);
  });
});

describe('hybrid ranking', () => {
  it('ranks an Item found by both words and meaning above those found by one, and says how', () => {
    addTodo('Rate limit the webhook retries');
    addTodo('Throttle bursts on /sync');
    addTodo('Rate the new coffee place');
    embedAll({ limit: LIMITS, Throttle: LIMITS, coffee: TRAVEL });

    const hits = store.search.query({ text: 'rate limit' }, near(LIMITS)).hits;
    expect(hits.map((hit) => [hit.item.title, hit.foundBy])).toEqual([
      ['Rate limit the webhook retries', ['words', 'meaning']],
      ['Throttle bursts on /sync', ['meaning']],
    ]);
  });

  it('keeps an exact identifier or title first', () => {
    addTodo('Throttle bursts on /sync');
    addTodo('Contract');
    embedAll({ Throttle: CONTRACTS, Contract: TRAVEL });

    const hits = store.search.query({ text: 'contract' }, near(CONTRACTS)).hits;
    expect(hits[0]?.item.title).toBe('Contract');
    expect(hits[0]?.exact).toBe(true);
    expect(hits[1]?.item.title).toBe('Throttle bursts on /sync');
  });

  it('applies every filter to the meaning half too', () => {
    const longtail = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    }).project?.id as string;
    addTodo('Throttle bursts on /sync', longtail);
    addTodo('Back off when the API says 429');
    const note = store.ensureDailyNote('2026-09-30', user);
    store.record(
      {
        type: 'create',
        item: {
          kind: 'block',
          title: 'Ask Sam about throttling',
          detail: {
            kind: 'block',
            dailyNoteId: note.id,
            parentId: null,
            position: 'a0',
            text: 'Ask Sam about throttling',
            folded: false,
          },
        },
      },
      user,
    );
    embedAll({ Throttle: LIMITS, '429': LIMITS, throttling: LIMITS });

    const query = { text: 'rate limiter' };
    expect(titles({ ...query, projectId: longtail }, near(LIMITS))).toEqual(['Throttle bursts on /sync']);
    expect(titles({ ...query, projectId: null }, near(LIMITS)).sort()).toEqual([
      'Ask Sam about throttling',
      'Back off when the API says 429',
    ]);
    expect(titles({ ...query, kinds: ['block'] }, near(LIMITS))).toEqual(['Ask Sam about throttling']);
    expect(titles({ ...query, accounts: ['linear:org-acme'] }, near(LIMITS))).toEqual([]);
    expect(titles({ ...query, from: clock + 1 }, near(LIMITS))).toEqual([]);
  });

  it('finds nothing by meaning below the similarity floor, nor with another model’s embedding', () => {
    addTodo('Throttle bursts on /sync');
    embedAll({ Throttle: [0.6, 0.8, 0, 0] });

    expect(titles({ text: 'rate limiter' }, near(LIMITS, 0.5))).toEqual(['Throttle bursts on /sync']);
    expect(titles({ text: 'rate limiter' }, near(LIMITS, 0.7))).toEqual([]);
    expect(titles({ text: 'rate limiter' }, { ...near(LIMITS), model: 'another-model' })).toEqual([]);
  });

  it('finds by meaning only what is nearly as near as the nearest, and at most ten', () => {
    addTodo('Throttle bursts on /sync');
    addTodo('Webhook retries pile up');
    for (let n = 0; n < 15; n++) addTodo(`Backoff idea ${n}`);
    embedAll({ Throttle: [1, 0, 0, 0], Webhook: [0.9, 0.436, 0, 0], Backoff: [1, 0.05, 0, 0] });

    const margin = (value: number) => ({ ...near(LIMITS, 0.5), margin: value });
    expect(titles({ text: 'rate limiter', kinds: ['todo'] }, margin(0.05))).not.toContain(
      'Webhook retries pile up',
    );
    expect(titles({ text: 'rate limiter' }, margin(0.05))).toHaveLength(10);
    expect(titles({ text: 'rate limiter' }, margin(0.2))).toContain('Throttle bursts on /sync');
  });

  it('finds by words alone when the query has no embedding', () => {
    addTodo('Throttle bursts on /sync');
    embedAll({ Throttle: LIMITS });
    expect(titles({ text: 'rate limiter' })).toEqual([]);
    expect(titles({ text: 'throttle' })).toEqual(['Throttle bursts on /sync']);
  });
});

describe('keeping embeddings current', () => {
  const pendingTexts = () => store.meaning.pending(MODEL, 100).map((work) => work.text);

  it('has each new Item wait to be embedded, by its searchable text, newest first', () => {
    addTodo('Renew the passport');
    clock += 1000;
    addTodo('Throttle bursts on /sync');
    expect(pendingTexts()).toEqual(['Throttle bursts on /sync', 'Renew the passport']);
    expect(store.meaning.progress(MODEL)).toEqual({ embedded: 0, total: 2 });

    embedAll({ Throttle: LIMITS, passport: TRAVEL });
    expect(pendingTexts()).toEqual([]);
    expect(store.meaning.progress(MODEL)).toEqual({ embedded: 2, total: 2 });
  });

  it('embeds a changed Item again, finding it by its old embedding until then', () => {
    const id = addTodo('Throttle bursts on /sync');
    embedAll({ Throttle: LIMITS });
    store.record({ type: 'update', itemId: id, changes: { status: 'done' } }, user);
    expect(pendingTexts()).toEqual([]);

    store.record(
      { type: 'update', itemId: id, changes: { title: 'Throttle bursts on /sync and /push' } },
      user,
    );
    expect(pendingTexts()).toEqual(['Throttle bursts on /sync and /push']);
    expect(titles({ text: 'rate limiter' }, near(LIMITS))).toEqual(['Throttle bursts on /sync and /push']);
    embedAll({ Throttle: TRAVEL });
    expect(titles({ text: 'rate limiter' }, near(LIMITS))).toEqual([]);
    expect(titles({ text: 'trip' }, near(TRAVEL))).toEqual(['Throttle bursts on /sync and /push']);
  });

  it('takes tombstones and deleted Items out, and puts them back when undone', () => {
    const id = addTodo('Throttle bursts on /sync');
    embedAll({ Throttle: LIMITS });
    const deleted = store.record({ type: 'delete', itemId: id }, user);
    expect(titles({ text: 'rate limiter' }, near(LIMITS))).toEqual([]);
    expect(pendingTexts()).toEqual([]);
    expect(store.meaning.progress(MODEL)).toEqual({ embedded: 0, total: 0 });

    store.record({ type: 'undo', entryId: deleted.id }, user);
    expect(pendingTexts()).toEqual(['Throttle bursts on /sync']);
  });

  it('saves an embedding of text that changed since as out of date, and skips an Item gone since', () => {
    const changing = addTodo('Throttle bursts on /sync');
    const going = addTodo('Renew the passport');
    const work = store.meaning.pending(MODEL, 10);
    store.record({ type: 'update', itemId: changing, changes: { title: 'Throttle bursts on /push' } }, user);
    store.record({ type: 'delete', itemId: going }, user);
    store.meaning.save(
      MODEL,
      work.map((each) => ({ ...each, vector: vector(...LIMITS) })),
    );
    expect(pendingTexts()).toEqual(['Throttle bursts on /push']);
    expect(store.meaning.progress(MODEL)).toEqual({ embedded: 0, total: 1 });
    expect(titles({ text: 'rate limiter' }, near(LIMITS))).toEqual(['Throttle bursts on /push']);
  });

  it('counts an embedding by another model as missing', () => {
    addTodo('Throttle bursts on /sync');
    embedAll({ Throttle: LIMITS });
    expect(store.meaning.pending('another-model', 10).map((work) => work.text)).toEqual([
      'Throttle bursts on /sync',
    ]);
  });

  it('says when something new waits to be embedded, after the write', async () => {
    let heard = 0;
    const stop = store.meaning.onPending(() => {
      heard += 1;
    });
    const id = addTodo('Throttle bursts on /sync');
    await Promise.resolve();
    expect(heard).toBe(1);
    store.record({ type: 'update', itemId: id, changes: { status: 'done' } }, user);
    await Promise.resolve();
    expect(heard).toBe(1);
    stop();
    addTodo('Renew the passport');
    await Promise.resolve();
    expect(heard).toBe(1);
  });
});
