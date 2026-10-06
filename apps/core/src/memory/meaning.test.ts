import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore, type QueryVector } from '../item-store';

// Memory looked up by meaning (#73, ADR 0006): memories wait to be embedded beside the Items, through
// the Item store, and a lookup that brings its embedding finds a memory phrased differently from
// what Ares is working on. Fixed vectors stand in for the embedding model.

const MODEL = 'fixed-vectors';
const ON_CALL = [1, 0, 0];
const LAUNCH = [0, 1, 0];
const OTHER = [0, 0, 1];

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-memory-meaning-'));
  clock = Date.UTC(2026, 9, 4, 9);
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

const near = (direction: number[]): QueryVector => ({
  model: MODEL,
  vector: Float32Array.from(direction),
  minSimilarity: 0.5,
});

function embedAll(directions: Record<string, number[]>) {
  for (let work = store.meaning.pending(MODEL, 10); work.length; work = store.meaning.pending(MODEL, 10)) {
    store.meaning.save(
      MODEL,
      work.map(({ key, text }) => {
        const found = Object.entries(directions).find(([word]) => text.includes(word));
        return { key, text, vector: Float32Array.from(found?.[1] ?? OTHER) };
      }),
    );
  }
}

const learn = (text: string, kind: 'fact' | 'preference' = 'fact', keywords?: string) =>
  store.memory.learn({ kind, text, keywords, confirmed: true, sources: [] });

describe('Memory by meaning', () => {
  it('finds a memory phrased differently from what Ares is working on', () => {
    const rota = learn('Sam runs the pager rota for Titanlink');
    learn('Longtail launches in November');
    embedAll({ pager: ON_CALL, launches: LAUNCH });

    const found = store.memory.lookup({ text: 'Update the on-call schedule', meaning: near(ON_CALL) });
    expect(found.map((memory) => [memory.id, memory.foundBy])).toEqual([[rota?.id, ['meaning']]]);
    // Without the embedding, its words share nothing with the lookup.
    expect(store.memory.lookup({ text: 'Update the on-call schedule' })).toEqual([]);
  });

  it('embeds memories by their text and keywords, again when edited, and drops deleted ones', () => {
    const rota = learn('Sam runs the pager rota', 'fact', 'Titanlink on call');
    expect(store.meaning.pending(MODEL, 10).map((work) => work.text)).toEqual([
      'Sam runs the pager rota\nTitanlink on call',
    ]);
    embedAll({ pager: ON_CALL });
    expect(store.meaning.pending(MODEL, 10)).toEqual([]);
    expect(store.meaning.progress(MODEL)).toEqual({ embedded: 1, total: 1 });

    store.memory.change({ type: 'confirm', memoryId: rota?.id as string });
    expect(store.meaning.pending(MODEL, 10)).toEqual([]);
    store.memory.change({ type: 'edit', memoryId: rota?.id as string, text: 'Priya runs the launch' });
    expect(store.meaning.pending(MODEL, 10).map((work) => work.text)).toEqual([
      'Priya runs the launch\nTitanlink on call',
    ]);
    embedAll({ launch: LAUNCH });
    expect(store.memory.lookup({ text: 'go-live', meaning: near(LAUNCH) }).map((m) => m.id)).toEqual([
      rota?.id,
    ]);

    store.memory.change({ type: 'delete', memoryId: rota?.id as string });
    expect(store.memory.lookup({ text: 'go-live', meaning: near(LAUNCH) })).toEqual([]);
    expect(store.meaning.progress(MODEL)).toEqual({ embedded: 0, total: 0 });
  });

  it('keeps to the kinds asked for', () => {
    learn('Sam runs the pager rota');
    const preference = learn('Put pager alerts under TL', 'preference');
    embedAll({ pager: ON_CALL });
    expect(
      store.memory
        .lookup({ text: 'on call', kinds: ['preference'], meaning: near(ON_CALL) })
        .map((m) => m.id),
    ).toEqual([preference?.id]);
  });

  it('fuses meaning into the palette’s Memory group', () => {
    const rota = learn('Sam runs the pager rota');
    embedAll({ pager: ON_CALL });
    expect(store.search.query({ text: 'on call' }).memories).toEqual([]);
    expect(store.search.query({ text: 'on call' }, near(ON_CALL)).memories?.map((m) => m.id)).toEqual([
      rota?.id,
    ]);
  });
});
