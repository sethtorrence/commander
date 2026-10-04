import type Database from 'better-sqlite3';
import type { RetrievedHit, Retriever, SearchFilters } from './retriever';
import { exactKey, type SearchableItem, type SearchText, searchTextOf } from './text';
import { wordQuery } from './words';

/*
  The word index: an FTS5 table in Commander's database, kept current by the Item store on every
  write (it calls `put` inside the same transaction), so a saved Item is findable at once. It is a
  derived index, not data: the search module owns its tables and rebuilds them from the Items when
  they are missing or INDEX_VERSION changes, so they sit outside the Drizzle schema and migrations.

  - search_words holds each Item's title, identifier and body (searchTextOf), tokenised by unicode61
    without diacritics, with prefix indexes so the last word can match as it is typed.
  - search_docs gives each indexed Item its FTS5 rowid (Items have text ids) and keeps what filters
    and exact matches need beside it: kind, Project, Account, when it last changed, and its
    identifier and title as exact matches compare them. Ranking then reads only the FTS5 index and
    this integer-keyed table, never the Items or the stored text, which keeps it fast.
  - Exact identifier matches come first, then exact titles, then bm25 with the title and identifier
    weighted above the body.
  - Tombstones are not indexed: put drops them, and undoing the delete puts them back.
*/

// Bump to rebuild every index from the Items at the next start (a change to what is indexed).
const INDEX_VERSION = 1;

// bm25 weights for title, identifier and body.
const WEIGHTS = '10.0, 10.0, 1.0';

// Titles longer than this are never typed out whole, so they get no exact key.
const EXACT_TITLE_MAX = 200;

export type WordIndex = Retriever & {
  // Indexes the Item as it now is, or drops it (a tombstone, or nothing to find it by).
  put(item: SearchableItem): void;
};

type Doc = {
  itemId: string;
  kind: string;
  projectId: string | null;
  account: string | null;
  updatedAt: number;
  identifierKey: string | null;
  titleKey: string | null;
};

function docOf(item: SearchableItem, text: SearchText): Doc {
  const title = exactKey(text.title);
  return {
    itemId: item.id,
    kind: item.kind,
    projectId: item.filing?.projectId ?? null,
    account: item.account,
    updatedAt: item.updatedAt,
    identifierKey: text.identifier ? exactKey(text.identifier) : null,
    titleKey: title && title.length <= EXACT_TITLE_MAX ? title : null,
  };
}

function create(sqlite: Database.Database) {
  sqlite.exec(`
    DROP TABLE IF EXISTS search_words;
    DROP TABLE IF EXISTS search_docs;
    DROP TABLE IF EXISTS search_meta;
    CREATE TABLE search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE search_docs (
      doc INTEGER PRIMARY KEY,
      item_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      project_id TEXT,
      account TEXT,
      updated_at INTEGER NOT NULL,
      identifier_key TEXT,
      title_key TEXT
    );
    CREATE INDEX search_docs_identifier ON search_docs (identifier_key) WHERE identifier_key IS NOT NULL;
    CREATE INDEX search_docs_title ON search_docs (title_key) WHERE title_key IS NOT NULL;
    CREATE VIRTUAL TABLE search_words USING fts5(
      title, identifier, body,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '2 3'
    );
  `);
}

function indexVersion(sqlite: Database.Database): number | null {
  const meta = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_meta'")
    .get();
  if (!meta) return null;
  const row = sqlite.prepare("SELECT value FROM search_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}

// The filters as SQL over search_docs (aliased d), with their parameters.
function filterSql(filters: SearchFilters): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  const list = (name: string, column: string, values: readonly string[]) => {
    where.push(`${column} IN (${values.map((_, n) => `@${name}${n}`).join(', ')})`);
    values.forEach((value, n) => {
      params[`${name}${n}`] = value;
    });
  };
  if (filters.kinds) list('kind', 'd.kind', filters.kinds);
  if (filters.accounts) list('account', 'd.account', filters.accounts);
  if (filters.projectId === null) where.push('d.project_id IS NULL');
  else if (filters.projectId !== undefined) {
    where.push('d.project_id = @projectId');
    params.projectId = filters.projectId;
  }
  if (filters.from !== undefined) {
    where.push('d.updated_at >= @from');
    params.from = filters.from;
  }
  if (filters.to !== undefined) {
    where.push('d.updated_at < @to');
    params.to = filters.to;
  }
  return { where, params };
}

export function openWordIndex(
  sqlite: Database.Database,
  // Every live Item, page by page, for building the index from scratch.
  allItems: () => Iterable<SearchableItem[]>,
): WordIndex {
  const statements = () => ({
    find: sqlite.prepare<[string], { doc: number }>('SELECT doc FROM search_docs WHERE item_id = ?'),
    text: sqlite.prepare<[number], SearchText>(
      'SELECT title, identifier, body FROM search_words WHERE rowid = ?',
    ),
    // `doc` null takes the next rowid.
    addDoc: sqlite.prepare<[Doc & { doc: number | null }], { doc: number }>(
      `INSERT INTO search_docs (doc, item_id, kind, project_id, account, updated_at, identifier_key, title_key)
       VALUES (@doc, @itemId, @kind, @projectId, @account, @updatedAt, @identifierKey, @titleKey) RETURNING doc`,
    ),
    taken: sqlite.prepare<[number], { doc: number }>('SELECT doc FROM search_docs WHERE doc = ?'),
    setDoc: sqlite.prepare<[Doc & { doc: number }]>(
      `UPDATE search_docs SET kind = @kind, project_id = @projectId, account = @account,
       updated_at = @updatedAt, identifier_key = @identifierKey, title_key = @titleKey WHERE doc = @doc`,
    ),
    dropDoc: sqlite.prepare<[number]>('DELETE FROM search_docs WHERE doc = ?'),
    addText: sqlite.prepare<[number, string, string, string]>(
      'INSERT INTO search_words (rowid, title, identifier, body) VALUES (?, ?, ?, ?)',
    ),
    setText: sqlite.prepare<[string, string, string, number]>(
      'UPDATE search_words SET title = ?, identifier = ?, body = ? WHERE rowid = ?',
    ),
    dropText: sqlite.prepare<[number]>('DELETE FROM search_words WHERE rowid = ?'),
  });

  // Emails get rowids that rise with when they were sent (the next free one from sentAt × 1000), so
  // newest-first email search reads the index in rowid order however mail arrived (the first sync
  // backfills older mail after newer). Other Items take the next rowid.
  function rowidFor(item: SearchableItem, taken: { get(doc: number): unknown }): number | null {
    if (item.detail?.kind !== 'email') return null;
    for (let doc = item.detail.sentAt * 1000, tries = 0; tries < 1000; doc++, tries++) {
      if (!taken.get(doc)) return doc;
    }
    return null;
  }

  if (indexVersion(sqlite) !== INDEX_VERSION) {
    sqlite.transaction(() => {
      create(sqlite);
      const { addDoc, addText, taken } = statements();
      for (const page of allItems()) {
        for (const item of page) {
          const text = searchTextOf(item);
          if (!text) continue;
          const { doc } = addDoc.get({ ...docOf(item, text), doc: rowidFor(item, taken) }) as { doc: number };
          addText.run(doc, text.title, text.identifier, text.body);
        }
      }
      sqlite.prepare("INSERT INTO search_meta (key, value) VALUES ('version', ?)").run(String(INDEX_VERSION));
    })();
  }

  const write = statements();

  function put(item: SearchableItem) {
    const text = searchTextOf(item);
    const found = write.find.get(item.id);
    if (!text) {
      if (!found) return;
      write.dropText.run(found.doc);
      write.dropDoc.run(found.doc);
      return;
    }
    const doc = docOf(item, text);
    if (!found) {
      const added = write.addDoc.get({ ...doc, doc: rowidFor(item, write.taken) }) as { doc: number };
      write.addText.run(added.doc, text.title, text.identifier, text.body);
      return;
    }
    write.setDoc.run({ ...doc, doc: found.doc });
    // Most writes (filing, ticking, moving a Block) leave the words alone: then the FTS5 row stays.
    const indexed = write.text.get(found.doc);
    if (indexed?.title === text.title && indexed.identifier === text.identifier && indexed.body === text.body)
      return;
    write.setText.run(text.title, text.identifier, text.body, found.doc);
  }

  function retrieve(query: SearchFilters & { text: string }, limit: number): RetrievedHit[] {
    const words = wordQuery(query.text);
    if (!words.match) return [];
    const filters = filterSql(query);
    const key = exactKey(words.exact);
    // Only emails: newest first, as mail search reads (their rowids rise with when they were sent).
    const emailsOnly = query.kinds?.length === 1 && query.kinds[0] === 'email';
    // Exact identifier, then exact title: a quick lookup on search_docs' indexes.
    const exact = sqlite
      .prepare(
        `SELECT d.item_id AS itemId FROM search_docs d
        WHERE (d.identifier_key = @key OR d.title_key = @key)${filters.where.map((w) => ` AND ${w}`).join('')}
        ORDER BY d.identifier_key = @key DESC, d.updated_at DESC
        LIMIT @limit`,
      )
      .all({ ...filters.params, key, limit }) as { itemId: string }[];
    const ranked = sqlite
      .prepare(
        `SELECT d.item_id AS itemId FROM search_words w
        JOIN search_docs d ON d.doc = w.rowid
        WHERE search_words MATCH @match${filters.where.map((w) => ` AND ${w}`).join('')}
        ORDER BY ${emailsOnly ? 'w.rowid DESC' : `bm25(search_words, ${WEIGHTS}), d.updated_at DESC`}
        LIMIT @limit`,
      )
      .all({ ...filters.params, match: words.match, limit: limit + exact.length }) as { itemId: string }[];
    const exactIds = new Set(exact.map((row) => row.itemId));
    return [
      ...exact.map((row) => ({ itemId: row.itemId, exact: true })),
      ...ranked
        .filter((row) => !exactIds.has(row.itemId))
        .map((row) => ({ itemId: row.itemId, exact: false })),
    ].slice(0, limit);
  }

  return { foundBy: 'words', put, retrieve };
}
