import type Database from 'better-sqlite3';
import { wordQuery } from '../search/words';
import type { IndexedMemory, MemoryRetriever, RetrieverQuery } from './retriever';

/*
  Memory's word index: an FTS5 table beside global search's, tokenised the same way (unicode61
  without diacritics, prefix indexes for the word being typed), kept current as each memory is saved
  (in the same transaction), so a memory is findable the moment it is learned. Like search's, it is
  derived data, not part of the Drizzle schema: it is rebuilt from the memories when it is missing or
  INDEX_VERSION changes.

  It holds each live memory's text and its keywords (words it is found by but never shown, such as
  an example's Item's title and team), the text weighted above them. Two ways to ask:
  - typed (What Ares knows, the palette): every word must match, the last one as a prefix, as global
    search reads what the User types;
  - about (a job's lookup): any of the meaningful words of what Ares is working on, ranked by bm25,
    so the memories sharing the most (and the rarest) words come first.
*/

// Bump to rebuild the index from the memories at the next start (a change to what is indexed).
const INDEX_VERSION = 1;

// bm25 weights for text and keywords.
const WEIGHTS = '2.0, 1.0';

// At most this many words of what Ares is working on go into a lookup, the first ones it gives (an
// Item's title, identifier, Source fields and people come before its text).
const MAX_LOOKUP_WORDS = 16;

const WORD = /[\p{L}\p{N}]+/gu;

// Words too common to say what something is about.
const STOPWORDS = new Set(
  (
    'a an and are as at be but by can for from had has have he her his how i if in into is it its me my ' +
    'no not of on or our out she so than that the their them then there these they this to up us was we ' +
    'were what when where which who why will with would you your about after all also any been before ' +
    'being both did does done each few more most other over same should some such too under until very ' +
    'via just need needs'
  ).split(' '),
);

export type MemoryWordIndex = MemoryRetriever & {
  put(memory: IndexedMemory): void;
  drop(memoryId: string): void;
};

/** The meaningful words of a text as an FTS5 query matching any of them, or null when it has none. */
export function anyWordQuery(text: string): string | null {
  const words = [
    ...new Set(
      (text.match(WORD) ?? [])
        .map((word) => word.toLowerCase())
        .filter((word) => (word.length > 2 || /\d/.test(word)) && !STOPWORDS.has(word)),
    ),
  ].slice(0, MAX_LOOKUP_WORDS);
  return words.length ? words.map((word) => `"${word}"`).join(' OR ') : null;
}

function create(sqlite: Database.Database) {
  sqlite.exec(`
    DROP TABLE IF EXISTS memory_words;
    DROP TABLE IF EXISTS memory_words_meta;
    CREATE TABLE memory_words_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_words USING fts5(
      memory_id UNINDEXED, kind UNINDEXED, text, keywords,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '2 3'
    );
  `);
}

function indexVersion(sqlite: Database.Database): number | null {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('memory_words', 'memory_words_meta')",
    )
    .all();
  if (tables.length < 2) return null;
  const row = sqlite.prepare("SELECT value FROM memory_words_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}

export function openMemoryWords(
  sqlite: Database.Database,
  // Every live memory, for building the index from scratch.
  all: () => Iterable<IndexedMemory>,
): MemoryWordIndex {
  if (indexVersion(sqlite) !== INDEX_VERSION) {
    sqlite.transaction(() => {
      create(sqlite);
      const add = sqlite.prepare(
        'INSERT INTO memory_words (memory_id, kind, text, keywords) VALUES (?, ?, ?, ?)',
      );
      for (const memory of all()) add.run(memory.id, memory.kind, memory.text, memory.keywords);
      sqlite
        .prepare("INSERT INTO memory_words_meta (key, value) VALUES ('version', ?)")
        .run(String(INDEX_VERSION));
    })();
  }

  const drop = sqlite.prepare<[string]>('DELETE FROM memory_words WHERE memory_id = ?');
  const add = sqlite.prepare<[string, string, string, string]>(
    'INSERT INTO memory_words (memory_id, kind, text, keywords) VALUES (?, ?, ?, ?)',
  );

  function retrieve(query: RetrieverQuery, limit: number) {
    const match = query.typed ? wordQuery(query.text).match : anyWordQuery(query.text);
    if (!match) return [];
    const kinds = query.kinds ?? [];
    const rows = sqlite
      .prepare(
        `SELECT memory_id AS id FROM memory_words WHERE memory_words MATCH ?
        ${kinds.length ? `AND kind IN (${kinds.map(() => '?').join(', ')})` : ''}
        ORDER BY bm25(memory_words, 0.0, 0.0, ${WEIGHTS}) LIMIT ?`,
      )
      .all(match, ...kinds, limit) as { id: string }[];
    return rows.map((row) => ({ id: row.id, exact: false }));
  }

  return {
    foundBy: 'words',
    put(memory) {
      drop.run(memory.id);
      add.run(memory.id, memory.kind, memory.text, memory.keywords);
    },
    drop: (memoryId) => {
      drop.run(memoryId);
    },
    retrieve,
  };
}
