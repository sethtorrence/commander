import { type ConversationTurn, type FoundBy, LINK_MARKER } from '@commander/domain';
import type Database from 'better-sqlite3';
import type { EmbeddedWork, MeaningProgress, MeaningWork, QueryVector } from './meaning-index';
import { fuseRanked } from './retriever';
import { blobOf, MEANING_HITS, nearEnough, textHash, vectorFunctions } from './vectors';
import { wordQuery } from './words';

/*
  Conversations in search (#195): every turn of every Conversation with Ares, the User's and his,
  found by its words and, with search by meaning on, by what it means, as Items are. Like the word
  and meaning indexes of Items it is derived data, outside the Drizzle schema: the Conversation store
  puts each turn as it is written (in the same transaction) and drops a Conversation's turns as it
  is deleted, and the index is rebuilt from the turns when it is missing or INDEX_VERSION changes.

  - conversation_words: an FTS5 table, tokenised as search_words is, one row per turn that has
    something to find it by (the User's turns; Ares's once he has written, with each link he named
    as it shows). Its rowid is the turn's id, so nothing else is needed to tie them.
  - conversation_vectors: an embedding of each turn's text, made off the Core's main thread and
    saved later through the Item store, as search_vectors are for Items. A turn whose words change
    keeps its old embedding (marked out of date) until the new one is saved; a dropped turn's goes.
  - Finding: turns ranked by words (bm25) and by meaning (within the model's similarity floor), fused
    by reciprocal rank, then one hit per Conversation, at its best turn.
*/

// Bump to rebuild the index from the turns at the next start (a change to what is indexed).
const INDEX_VERSION = 1;

// The most of a turn that is embedded: the start of it.
const MEANING_TEXT_MAX = 2000;

// The most turns ranked by words before they are put together into Conversations.
const TURNS_RANKED = 60;

// The longest matching line shown, and how much comes before the first matching word when cut.
const LINE_MAX = 140;
const LINE_LEAD = 40;

const WORD = /[\p{L}\p{N}]+/gu;

// A turn as it is indexed: whose, in which Conversation, and the text to find it by.
export type IndexedTurn = {
  turnId: number;
  conversationId: string;
  by: ConversationTurn['by'];
  text: string;
};

export type FoundTurn = IndexedTurn & { foundBy: FoundBy[] };

// What of a turn the index reads.
export type SearchableTurn = Pick<
  ConversationTurn,
  'id' | 'conversationId' | 'by' | 'status' | 'text' | 'links'
>;

export type ConversationIndex = {
  // Called by the Conversation store with each turn it writes, inside the write's transaction.
  put(turn: SearchableTurn): void;
  // Called with the turns of a deleted Conversation (or an answer taken back).
  drop(turnIds: readonly number[]): void;
  // The best-matching turn of each Conversation that matches, best first.
  find(text: string, meaning: QueryVector | undefined, limit: number): FoundTurn[];
  // Turns whose embedding by this model is missing or out of date, newest first (keys: turn ids).
  pending(model: string, limit: number): MeaningWork[];
  save(model: string, done: readonly EmbeddedWork[]): void;
  // How many indexed turns this model has embedded, of all there are.
  progress(model: string): MeaningProgress;
};

/**
 * What of a turn is found: the User's words, or Ares's once he has written them (with each Item he
 * named as its link shows it, by its short name or title). Null when there is nothing yet.
 */
export function turnSearchText(turn: SearchableTurn): string | null {
  if (turn.by === 'ares' && (turn.status === 'queued' || turn.status === 'streaming')) return null;
  const byRef = new Map(turn.links.map((link) => [link.ref, link]));
  const text = turn.text
    .replace(LINK_MARKER, (_, ref: string) => {
      const link = byRef.get(ref);
      return link ? (link.label ?? link.title) : '';
    })
    .trim();
  return text || null;
}

const meaningText = (text: string) => text.slice(0, MEANING_TEXT_MAX);

// Lowercase without accents, so "café" matches "cafe" as the FTS5 tokeniser does.
const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// A line as it reads in a palette row: without Markdown's list, quote and heading marks or emphasis.
const tidy = (line: string) =>
  line
    .replace(/^\s*(?:[#>]+|[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The line of a turn's text that matches what was typed best (the most words typed that start one of
 * its words), or its first line when none does (found by meaning); shortened around the first
 * matching word when long.
 */
export function matchingLine(text: string, typed: string): string {
  const lines = text.split('\n').map(tidy).filter(Boolean);
  const words = [...new Set((plain(typed).match(WORD) ?? []).filter(Boolean))];
  let best = lines[0] ?? '';
  let bestScore = 0;
  for (const line of lines) {
    const own = plain(line).match(WORD) ?? [];
    const score = words.filter((word) => own.some((each) => each.startsWith(word))).length;
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  if (best.length <= LINE_MAX) return best;
  // Cut around the first word that matches (`plain` keeps the length of most text; if it doesn't,
  // the line is cut from its start).
  const lowered = plain(best);
  let at = 0;
  if (bestScore && lowered.length === best.length) {
    for (const match of lowered.matchAll(WORD)) {
      if (words.some((word) => match[0].startsWith(word))) {
        at = match.index ?? 0;
        break;
      }
    }
  }
  let start = Math.max(0, at - LINE_LEAD);
  if (start > 0) {
    const space = best.indexOf(' ', start);
    start = space >= 0 && space < at ? space + 1 : start;
  }
  let end = Math.min(best.length, start + LINE_MAX);
  if (end < best.length) {
    const space = best.lastIndexOf(' ', end);
    end = space > start ? space : end;
  }
  return `${start > 0 ? '…' : ''}${best.slice(start, end).trim()}${end < best.length ? '…' : ''}`;
}

function create(sqlite: Database.Database) {
  sqlite.exec(`
    DROP TABLE IF EXISTS conversation_words;
    DROP TABLE IF EXISTS conversation_words_meta;
    CREATE TABLE conversation_words_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE conversation_words USING fts5(
      conversation_id UNINDEXED, by UNINDEXED, text,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '2 3'
    );
  `);
}

function indexVersion(sqlite: Database.Database): number | null {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_words', 'conversation_words_meta')",
    )
    .all();
  if (tables.length < 2) return null;
  const row = sqlite.prepare("SELECT value FROM conversation_words_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}

export function openConversationIndex(
  sqlite: Database.Database,
  options: {
    // Every turn of every Conversation, page by page, for building the index from scratch.
    allTurns: () => Iterable<SearchableTurn[]>;
    // A turn waits to be embedded. Called inside the write's transaction: only schedule work.
    onMeaningPending?: () => void;
  },
): ConversationIndex {
  vectorFunctions(sqlite);
  const ADD = 'INSERT INTO conversation_words (rowid, conversation_id, by, text) VALUES (?, ?, ?, ?)';

  if (indexVersion(sqlite) !== INDEX_VERSION) {
    sqlite.transaction(() => {
      create(sqlite);
      const add = sqlite.prepare<[number, string, string, string]>(ADD);
      for (const page of options.allTurns()) {
        for (const turn of page) {
          const text = turnSearchText(turn);
          if (text) add.run(turn.id, turn.conversationId, turn.by, text);
        }
      }
      sqlite
        .prepare("INSERT INTO conversation_words_meta (key, value) VALUES ('version', ?)")
        .run(String(INDEX_VERSION));
    })();
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversation_vectors (
      turn_id INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      embedding BLOB NOT NULL
    );
    DELETE FROM conversation_vectors WHERE turn_id NOT IN (SELECT rowid FROM conversation_words);
  `);

  const statements = {
    text: sqlite.prepare<[number], { text: string }>('SELECT text FROM conversation_words WHERE rowid = ?'),
    add: sqlite.prepare<[number, string, string, string]>(ADD),
    setText: sqlite.prepare<[string, number]>('UPDATE conversation_words SET text = ? WHERE rowid = ?'),
    dropText: sqlite.prepare<[number]>('DELETE FROM conversation_words WHERE rowid = ?'),
    markStale: sqlite.prepare<[number]>('UPDATE conversation_vectors SET stale = 1 WHERE turn_id = ?'),
    dropVector: sqlite.prepare<[number]>('DELETE FROM conversation_vectors WHERE turn_id = ?'),
    turns: (ids: readonly number[]) =>
      sqlite
        .prepare(
          `SELECT rowid AS turnId, conversation_id AS conversationId, by, text FROM conversation_words
          WHERE rowid IN (${ids.map(() => '?').join(', ')})`,
        )
        .all(...ids) as IndexedTurn[],
    pending: sqlite.prepare<{ model: string; limit: number }, { turnId: number; text: string }>(
      `SELECT w.rowid AS turnId, w.text FROM conversation_words w
       LEFT JOIN conversation_vectors v ON v.turn_id = w.rowid
       WHERE v.turn_id IS NULL OR v.stale = 1 OR v.model != @model
       ORDER BY w.rowid DESC LIMIT @limit`,
    ),
    total: sqlite.prepare<[], { count: number }>('SELECT count(*) AS count FROM conversation_words'),
    embedded: sqlite.prepare<[string], { count: number }>(
      `SELECT count(*) AS count FROM conversation_vectors v JOIN conversation_words w ON w.rowid = v.turn_id
       WHERE v.model = ? AND v.stale = 0`,
    ),
    putVector: sqlite.prepare<{
      turnId: number;
      model: string;
      textHash: string;
      stale: number;
      embedding: Buffer;
    }>(
      `INSERT INTO conversation_vectors (turn_id, model, text_hash, stale, embedding)
       VALUES (@turnId, @model, @textHash, @stale, @embedding)
       ON CONFLICT (turn_id) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash,
         stale = excluded.stale, embedding = excluded.embedding`,
    ),
  };

  function drop(turnId: number) {
    statements.dropText.run(turnId);
    statements.dropVector.run(turnId);
  }

  const save = sqlite.transaction((model: string, done: readonly EmbeddedWork[]) => {
    for (const { key, text, vector } of done) {
      const turnId = Number(key);
      const current = statements.text.get(turnId);
      if (!current) continue;
      const stale = meaningText(current.text) === text ? 0 : 1;
      statements.putVector.run({ turnId, model, textHash: textHash(text), stale, embedding: blobOf(vector) });
    }
  });

  function byWords(text: string): number[] {
    const { match } = wordQuery(text);
    if (!match) return [];
    const rows = sqlite
      .prepare(
        `SELECT rowid AS turnId FROM conversation_words WHERE conversation_words MATCH ?
        ORDER BY bm25(conversation_words, 0.0, 0.0, 1.0), rowid DESC LIMIT ?`,
      )
      .all(match, TURNS_RANKED) as { turnId: number }[];
    return rows.map((row) => row.turnId);
  }

  function byMeaning(meaning: QueryVector | undefined): number[] {
    if (!meaning) return [];
    const rows = sqlite
      .prepare(
        `SELECT turn_id AS turnId, vec_distance_cosine(embedding, ?) AS distance FROM conversation_vectors
        WHERE model = ? ORDER BY distance LIMIT ?`,
      )
      .all(blobOf(meaning.vector), meaning.model, MEANING_HITS) as {
      turnId: number;
      distance: number | null;
    }[];
    return nearEnough(rows, meaning).map((row) => row.turnId);
  }

  return {
    put(turn) {
      const text = turnSearchText(turn);
      const indexed = statements.text.get(turn.id);
      if (!text) {
        if (indexed) drop(turn.id);
        return;
      }
      if (indexed?.text === text) return;
      if (indexed) {
        statements.setText.run(text, turn.id);
        statements.markStale.run(turn.id);
      } else statements.add.run(turn.id, turn.conversationId, turn.by, text);
      options.onMeaningPending?.();
    },

    drop(turnIds) {
      for (const turnId of turnIds) drop(turnId);
    },

    find(text, meaning, limit) {
      const fused = fuseRanked(
        [
          { foundBy: 'words' as const, hits: byWords(text).map((id) => ({ id: String(id), exact: false })) },
          {
            foundBy: 'meaning' as const,
            hits: byMeaning(meaning).map((id) => ({ id: String(id), exact: false })),
          },
        ],
        TURNS_RANKED,
      );
      if (!fused.length) return [];
      const turns = new Map(statements.turns(fused.map((hit) => Number(hit.id))).map((t) => [t.turnId, t]));
      const found: FoundTurn[] = [];
      const seen = new Set<string>();
      for (const hit of fused) {
        const turn = turns.get(Number(hit.id));
        if (!turn || seen.has(turn.conversationId)) continue;
        seen.add(turn.conversationId);
        found.push({ ...turn, foundBy: hit.foundBy });
        if (found.length === limit) break;
      }
      return found;
    },

    pending: (model, limit) =>
      statements.pending
        .all({ model, limit })
        .map((row) => ({ key: String(row.turnId), text: meaningText(row.text) })),

    save: (model, done) => save(model, done),

    progress: (model) => ({
      embedded: statements.embedded.get(model)?.count ?? 0,
      total: statements.total.get()?.count ?? 0,
    }),
  };
}
