import {
  type Item,
  type Project,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  searchQuery,
} from '@commander/domain';
import type Database from 'better-sqlite3';
import { fuse, type Retriever } from './retriever';
import type { SearchableItem } from './text';
import { openWordIndex } from './words-index';

/*
  Global search, behind its own interface. The Item store opens it on the same database, calls
  `put` with every Item it writes (inside the write's transaction) and hands `query` to the window.
  Everything about how Items are found stays in here: today one retriever, the FTS5 word index;
  search by meaning (#73) adds a second retriever, fused with the first, and Tantivy could replace
  the word index, with neither change reaching callers.
*/

export type Search = {
  query(query: SearchQuery): SearchResult;
};

export type SearchIndex = Search & {
  // Called by the Item store with every Item it creates or changes.
  put(item: SearchableItem): void;
};

export type SearchSources = {
  // Every live Item, page by page, for building an index from scratch.
  allItems: () => Iterable<SearchableItem[]>;
  // Items by id, with their detail, in any order.
  load: (itemIds: string[]) => Item[];
  // The Projects offered for filing (not archived), in their order.
  projects: () => Project[];
};

const DEFAULT_LIMIT = 50;
const WORD = /[\p{L}\p{N}]+/gu;

export function openSearch(sqlite: Database.Database, sources: SearchSources): SearchIndex {
  const words = openWordIndex(sqlite, sources.allItems);
  const retrievers: Retriever[] = [words];

  // The calendar day each Block or Daily Note belongs to, for opening it in Notes.
  function daysOf(items: Item[]): Map<string, string> {
    const days = new Map<string, string>();
    const noteOf = new Map<string, string>();
    for (const item of items) {
      if (item.detail?.kind === 'daily-note') days.set(item.id, item.detail.day);
      if (item.detail?.kind === 'block') noteOf.set(item.id, item.detail.dailyNoteId);
    }
    const noteIds = [...new Set(noteOf.values())];
    if (!noteIds.length) return days;
    const rows = sqlite
      .prepare(
        `SELECT item_id AS noteId, day FROM daily_note_details WHERE item_id IN (${noteIds.map(() => '?').join(', ')})`,
      )
      .all(...noteIds) as { noteId: string; day: string }[];
    const dayOfNote = new Map(rows.map((row) => [row.noteId, row.day]));
    for (const [blockId, noteId] of noteOf) {
      const day = dayOfNote.get(noteId);
      if (day) days.set(blockId, day);
    }
    return days;
  }

  // Projects whose code is the query, or whose name has words starting with each word typed.
  function matchingProjects(text: string): Project[] {
    const typed = (text.match(WORD) ?? []).map((word) => word.toLowerCase());
    if (!typed.length) return [];
    return sources.projects().filter((project) => {
      if (typed.length === 1 && typed[0] === project.code.toLowerCase()) return true;
      const named = (project.name.match(WORD) ?? []).map((word) => word.toLowerCase());
      return typed.every((word) => named.some((name) => name.startsWith(word)));
    });
  }

  return {
    put: (item) => words.put(item),

    query(input) {
      const { limit = DEFAULT_LIMIT, ...query } = searchQuery.parse(input);
      const fused = fuse(
        retrievers.map((retriever) => ({
          foundBy: retriever.foundBy,
          hits: retriever.retrieve(query, limit),
        })),
        limit,
      );
      const byId = new Map(sources.load(fused.map((hit) => hit.itemId)).map((item) => [item.id, item]));
      const days = daysOf([...byId.values()]);
      const hits: SearchHit[] = [];
      for (const hit of fused) {
        const item = byId.get(hit.itemId);
        if (item) hits.push({ item, day: days.get(item.id) ?? null, exact: hit.exact, foundBy: hit.foundBy });
      }
      const narrowed =
        query.kinds !== undefined ||
        query.projectId !== undefined ||
        query.accounts !== undefined ||
        query.from !== undefined ||
        query.to !== undefined;
      return { hits, projects: narrowed ? [] : matchingProjects(query.text) };
    },
  };
}
