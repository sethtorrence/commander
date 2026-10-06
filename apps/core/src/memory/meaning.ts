import type Database from 'better-sqlite3';
import type { EmbeddedWork, MeaningProgress, MeaningWork } from '../search/meaning-index';
import { blobOf, MEANING_HITS, nearEnough, textHash, vectorFunctions } from '../search/vectors';
import type { IndexedMemory, MemoryRetriever, RetrieverQuery } from './retriever';

/*
  Memory's lookup by meaning (#73): an embedding of each live memory's text and keywords, the third
  retriever beside words and fields (retriever.ts), so "the pager rota" is found when Ares is working
  on "the on-call schedule". Like search's meaning index (../search/meaning-index.ts), embeddings
  are made off the Core's main thread and saved later through the Item store, so a save only marks a
  memory's embedding out of date (when its words changed) and a delete removes it. Derived data
  (`memory_vectors`), outside the Drizzle schema, filled again in the background when missing.
*/

/** What is embedded of a memory: its text, then the words it is also found by. */
export const memoryMeaningText = (memory: Pick<IndexedMemory, 'text' | 'keywords'>) =>
  [memory.text, memory.keywords].filter(Boolean).join('\n');

export type MemoryMeaningIndex = MemoryRetriever & {
  put(memory: IndexedMemory): void;
  drop(memoryId: string): void;
  // Live memories whose embedding by this model is missing or out of date, most recently changed first.
  pending(model: string, limit: number): MeaningWork[];
  save(model: string, done: readonly EmbeddedWork[]): void;
  progress(model: string): MeaningProgress;
};

export function openMemoryMeaning(sqlite: Database.Database): MemoryMeaningIndex {
  vectorFunctions(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      embedding BLOB NOT NULL
    );
  `);

  const statements = {
    markStale: sqlite.prepare<[string, string]>(
      'UPDATE memory_vectors SET stale = 1 WHERE memory_id = ? AND text_hash != ?',
    ),
    drop: sqlite.prepare<[string]>('DELETE FROM memory_vectors WHERE memory_id = ?'),
    pending: sqlite.prepare<{ model: string; limit: number }, { id: string; text: string; keywords: string }>(
      `SELECT m.id, m.text, m.keywords FROM memories m
       LEFT JOIN memory_vectors v ON v.memory_id = m.id
       WHERE m.deleted_at IS NULL AND (v.memory_id IS NULL OR v.stale = 1 OR v.model != @model)
       ORDER BY m.updated_at DESC LIMIT @limit`,
    ),
    current: sqlite.prepare<[string], { text: string; keywords: string }>(
      'SELECT text, keywords FROM memories WHERE id = ? AND deleted_at IS NULL',
    ),
    put: sqlite.prepare<{ id: string; model: string; textHash: string; stale: number; embedding: Buffer }>(
      `INSERT INTO memory_vectors (memory_id, model, text_hash, stale, embedding)
       VALUES (@id, @model, @textHash, @stale, @embedding)
       ON CONFLICT (memory_id) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash,
         stale = excluded.stale, embedding = excluded.embedding`,
    ),
    total: sqlite.prepare<[], { count: number }>(
      'SELECT count(*) AS count FROM memories WHERE deleted_at IS NULL',
    ),
    embedded: sqlite.prepare<[string], { count: number }>(
      `SELECT count(*) AS count FROM memory_vectors v JOIN memories m ON m.id = v.memory_id
       WHERE m.deleted_at IS NULL AND v.model = ? AND v.stale = 0`,
    ),
  };

  const save = sqlite.transaction((model: string, done: readonly EmbeddedWork[]) => {
    for (const { key, text, vector } of done) {
      const current = statements.current.get(key);
      if (!current) continue;
      const stale = memoryMeaningText(current) === text ? 0 : 1;
      statements.put.run({ id: key, model, textHash: textHash(text), stale, embedding: blobOf(vector) });
    }
  });

  function retrieve(query: RetrieverQuery, limit: number) {
    const { meaning } = query;
    if (!meaning) return [];
    const kinds = query.kinds ?? [];
    const rows = sqlite
      .prepare(
        `SELECT v.memory_id AS id, vec_distance_cosine(v.embedding, ?) AS distance
        FROM memory_vectors v JOIN memories m ON m.id = v.memory_id
        WHERE m.deleted_at IS NULL AND v.model = ?
        ${kinds.length ? `AND m.kind IN (${kinds.map(() => '?').join(', ')})` : ''}
        ORDER BY distance LIMIT ?`,
      )
      .all(blobOf(meaning.vector), meaning.model, ...kinds, Math.min(limit, MEANING_HITS)) as {
      id: string;
      distance: number | null;
    }[];
    return nearEnough(rows, meaning).map((row) => ({ id: row.id, exact: false }));
  }

  return {
    foundBy: 'meaning',
    retrieve,
    put(memory) {
      statements.markStale.run(memory.id, textHash(memoryMeaningText(memory)));
    },
    drop(memoryId) {
      statements.drop.run(memoryId);
    },
    pending: (model, limit) =>
      statements.pending.all({ model, limit }).map((row) => ({ key: row.id, text: memoryMeaningText(row) })),
    save: (model, done) => save(model, done),
    progress: (model) => ({
      embedded: statements.embedded.get(model)?.count ?? 0,
      total: statements.total.get()?.count ?? 0,
    }),
  };
}
