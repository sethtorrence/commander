import type Database from 'better-sqlite3';
import type { RetrievedHit, Retriever, RetrieverQuery } from './retriever';
import type { SearchText } from './text';
import { blobOf, MEANING_HITS, nearEnough, textHash, vectorFunctions } from './vectors';
import { filterSql, type WordChange } from './words-index';

/*
  The meaning index (#73): an embedding of each Item's searchable text (the same text the word index
  holds), so search finds Items by what they mean as well as by their words. Embeddings come from a
  model running off the Core's main thread, so they can't be written in the same transaction as the
  Item: the Item store writes the Item and its words at once, and this index marks the embedding
  missing or out of date; the meaning side of the Core (../meaning) asks what is `pending`, embeds it
  in the background and `save`s it here, through the Item store.

  - search_vectors has a row for every indexed Item: its embedding (none yet for a new Item), which
    model made it, a fingerprint of the text it was made from, and whether it waits to be embedded
    (`stale`: new, its text changed, or made by another model; an old embedding still finds the Item
    until the new one is saved). What waits is found through a partial index, newest first, so the
    backfill's lookups stay quick however many Items there are.
  - Tombstones and Items with nothing to find them by leave the index with their words; undoing the
    delete puts the Item back, waiting to be embedded again.
  - Like the word index it is derived data, outside the Drizzle schema: it fills itself again (in
    the background) if it is ever dropped, and an embedding by another model counts as missing.
  - Finding: the query's embedding is compared with every Item's (sqlite-vec's cosine distance, see
    vectors.ts) joined with search_docs, so every filter applies to this half as it does to words.
    Only Items within the model's similarity floor are found: nearest isn't always near.
*/

// The most text of an Item that is embedded: its title and identifier, then the start of the rest.
export const MEANING_TEXT_MAX = 2000;

// An embedding of what the User typed, by the model that made it, and how near an Item must be: at
// least `minSimilarity` (cosine), and within `margin` of the nearest when given.
export type QueryVector = { model: string; vector: Float32Array; minSimilarity: number; margin?: number };

// Something to embed: an Item (`key` its id) or, in Memory, a memory, with the text to embed.
export type MeaningWork = { key: string; text: string };
export type EmbeddedWork = MeaningWork & { vector: Float32Array };

export type MeaningProgress = { embedded: number; total: number };

export type MeaningIndex = Retriever & {
  // The word index's change to an Item, with its words as they are now and when it changed.
  changed(itemId: string, change: WordChange, text: SearchText | null, at: number): void;
  // Items whose embedding by this model is missing or out of date, most recently changed first.
  pending(model: string, limit: number): MeaningWork[];
  // Embeddings made from `pending`'s work. An Item gone since is skipped; one whose text changed
  // since is saved as out of date, to be embedded again.
  save(model: string, done: readonly EmbeddedWork[]): void;
  progress(model: string): MeaningProgress;
};

/** The text of an Item that is embedded. */
export function meaningTextOf(text: SearchText): string {
  return [text.title, text.identifier, text.body].filter(Boolean).join('\n').slice(0, MEANING_TEXT_MAX);
}

export function openMeaningIndex(sqlite: Database.Database): MeaningIndex {
  vectorFunctions(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS search_vectors (
      item_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      stale INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS search_vectors_pending ON search_vectors (updated_at) WHERE stale = 1;
  `);

  // Every indexed Item has a row: a missing one (the table is new, or the word index was rebuilt)
  // waits to be embedded, and one for an Item no longer indexed goes.
  const counts = sqlite
    .prepare(
      `SELECT (SELECT count(*) FROM search_docs) AS docs, (SELECT count(*) FROM search_vectors) AS vectors`,
    )
    .get() as { docs: number; vectors: number };
  if (counts.docs !== counts.vectors) {
    sqlite.transaction(() => {
      sqlite.exec(`
        DELETE FROM search_vectors WHERE item_id NOT IN (SELECT item_id FROM search_docs);
        INSERT INTO search_vectors (item_id, model, text_hash, stale, updated_at, embedding)
          SELECT d.item_id, '', '', 1, d.updated_at, NULL FROM search_docs d
          WHERE NOT EXISTS (SELECT 1 FROM search_vectors v WHERE v.item_id = d.item_id);
      `);
    })();
  }

  const statements = {
    // A new Item (or one back from a tombstone) waits for its embedding.
    add: sqlite.prepare<[string, number]>(
      `INSERT INTO search_vectors (item_id, model, text_hash, stale, updated_at, embedding)
       VALUES (?, '', '', 1, ?, NULL)
       ON CONFLICT (item_id) DO UPDATE SET stale = 1, updated_at = excluded.updated_at`,
    ),
    markStale: sqlite.prepare<[number, string, string]>(
      'UPDATE search_vectors SET stale = 1, updated_at = ? WHERE item_id = ? AND text_hash != ?',
    ),
    drop: sqlite.prepare<[string]>('DELETE FROM search_vectors WHERE item_id = ?'),
    // Embeddings by another model wait to be made again.
    otherModels: sqlite.prepare<[string]>(
      'UPDATE search_vectors SET stale = 1 WHERE stale = 0 AND model != ?',
    ),
    pending: sqlite.prepare<[number], SearchText & { itemId: string }>(
      `SELECT v.item_id AS itemId, w.title, w.identifier, w.body FROM search_vectors v
       JOIN search_docs d ON d.item_id = v.item_id
       JOIN search_words w ON w.rowid = d.doc
       WHERE v.stale = 1
       ORDER BY v.updated_at DESC LIMIT ?`,
    ),
    current: sqlite.prepare<[string], SearchText>(
      `SELECT w.title, w.identifier, w.body FROM search_docs d
       JOIN search_words w ON w.rowid = d.doc WHERE d.item_id = ?`,
    ),
    put: sqlite.prepare<{
      itemId: string;
      model: string;
      textHash: string;
      stale: number;
      embedding: Buffer;
    }>(
      `UPDATE search_vectors SET model = @model, text_hash = @textHash, stale = @stale, embedding = @embedding
       WHERE item_id = @itemId`,
    ),
    total: sqlite.prepare<[], { count: number }>('SELECT count(*) AS count FROM search_vectors'),
    embedded: sqlite.prepare<[string], { count: number }>(
      'SELECT count(*) AS count FROM search_vectors WHERE model = ? AND stale = 0',
    ),
  };

  // The model `pending` last asked for: embeddings by any other are out of date.
  let checkedModel: string | null = null;

  const save = sqlite.transaction((model: string, done: readonly EmbeddedWork[]) => {
    for (const { key, text, vector } of done) {
      const current = statements.current.get(key);
      if (!current) continue;
      const stale = meaningTextOf(current) === text ? 0 : 1;
      statements.put.run({ itemId: key, model, textHash: textHash(text), stale, embedding: blobOf(vector) });
    }
  });

  function retrieve(query: RetrieverQuery, limit: number): RetrievedHit[] {
    const { meaning } = query;
    if (!meaning) return [];
    const filters = filterSql(query);
    const rows = sqlite
      .prepare(
        `SELECT d.item_id AS itemId, vec_distance_cosine(v.embedding, @vector) AS distance
        FROM search_vectors v JOIN search_docs d ON d.item_id = v.item_id
        WHERE v.model = @model AND v.embedding IS NOT NULL${filters.where.map((w) => ` AND ${w}`).join('')}
        ORDER BY distance LIMIT @limit`,
      )
      .all({
        ...filters.params,
        model: meaning.model,
        vector: blobOf(meaning.vector),
        limit: Math.min(limit, MEANING_HITS),
      }) as { itemId: string; distance: number | null }[];
    return nearEnough(rows, meaning).map((row) => ({ itemId: row.itemId, exact: false }));
  }

  return {
    foundBy: 'meaning',
    retrieve,
    changed(itemId, change, text, at) {
      if (change === 'dropped') statements.drop.run(itemId);
      else if (change === 'added') statements.add.run(itemId, at);
      else if (change === 'changed' && text)
        statements.markStale.run(at, itemId, textHash(meaningTextOf(text)));
    },
    pending(model, limit) {
      if (model !== checkedModel) {
        statements.otherModels.run(model);
        checkedModel = model;
      }
      return statements.pending.all(limit).map((row) => ({ key: row.itemId, text: meaningTextOf(row) }));
    },
    save: (model, done) => save(model, done),
    progress: (model) => ({
      embedded: statements.embedded.get(model)?.count ?? 0,
      total: statements.total.get()?.count ?? 0,
    }),
  };
}
