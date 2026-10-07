import {
  type Conversation,
  type ConversationHit,
  type Item,
  type Memory,
  type Person,
  type Project,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  searchQuery,
} from '@commander/domain';
import type Database from 'better-sqlite3';
import {
  type ConversationIndex,
  matchingLine,
  openConversationIndex,
  type SearchableTurn,
} from './conversation-index';
import { type MeaningIndex, openMeaningIndex, type QueryVector } from './meaning-index';
import { fuse, type Retriever } from './retriever';
import { type SearchableItem, searchTextOf } from './text';
import { openWordIndex } from './words-index';

export type { ConversationIndex } from './conversation-index';
export type { EmbeddedWork, MeaningProgress, MeaningWork, QueryVector } from './meaning-index';

/*
  Global search, behind its own interface. The Item store opens it on the same database, calls
  `put` with every Item it writes (inside the write's transaction) and hands `query` to the window.
  Everything about how Items are found stays in here: two retrievers fused by reciprocal rank, the
  FTS5 word index and the meaning index (#73, embeddings of the same text). Words answer at once;
  meaning answers only when the query brings its embedding (`meaning`), which the Core's meaning side
  makes off the main thread, so a plain search never waits on a model. Tantivy could replace the
  word index without callers changing. Conversations with Ares are found here too (#195), turn by
  turn, by their own word and meaning index (conversation-index.ts), which the Conversation store
  keeps current as the Item store does Items'.
*/

export type Search = {
  // `meaning`: the query's text embedded, to find Items by meaning too (none: words only).
  query(query: SearchQuery, meaning?: QueryVector): SearchResult;
};

export type SearchIndex = Search & {
  // Called by the Item store with every Item it creates or changes.
  put(item: SearchableItem): void;
  // What waits to be embedded, and saving embeddings (the Item store hands these to ../meaning).
  meaning: Pick<MeaningIndex, 'pending' | 'save' | 'progress'>;
  // The Conversation store's hooks (put each turn written, drop a deleted Conversation's turns), and
  // what of Conversations waits to be embedded.
  conversations: Pick<ConversationIndex, 'put' | 'drop' | 'pending' | 'save'>;
};

export type SearchSources = {
  // Every live Item, page by page, for building an index from scratch.
  allItems: () => Iterable<SearchableItem[]>;
  // Items by id, with their detail, in any order.
  load: (itemIds: string[]) => Item[];
  // The Projects offered for filing (not archived), in their order.
  projects: () => Project[];
  // An email's body text, kept beside its Item (null when none is kept).
  bodyText?: (itemId: string) => string | null;
  // Everyone Commander knows (#117), the User first, then by name.
  people?: () => Person[];
  // What Ares knows (#74) matching the words typed (and their meaning), best first: Memory finds its own.
  memories?: (text: string, meaning?: QueryVector) => Memory[];
  // Every turn of every Conversation, page by page, for building their index from scratch (#195).
  allTurns?: () => Iterable<SearchableTurn[]>;
  // Conversations by id, for naming the ones found (#195).
  conversations?: (ids: string[]) => Conversation[];
  // Something new waits to be embedded. Called inside the write's transaction: only schedule work.
  onMeaningPending?: () => void;
};

const sentAtOf = (item: Item) => (item.detail?.kind === 'email' ? item.detail.sentAt : null);

/**
 * Emails newest first: each email hit keeps a place an email had in the ranked list, but they are
 * dealt into those places by date (the palette groups results by kind, so its Email group reads
 * newest first, as mail search does). Other hits stay where they are.
 */
function emailsNewestFirst(hits: SearchHit[]): SearchHit[] {
  const emails = hits.filter((hit) => sentAtOf(hit.item) !== null && !hit.exact);
  const byDate = [...emails].sort((a, b) => (sentAtOf(b.item) ?? 0) - (sentAtOf(a.item) ?? 0));
  let next = 0;
  return hits.map((hit) => (sentAtOf(hit.item) !== null && !hit.exact ? (byDate[next++] as SearchHit) : hit));
}

const DEFAULT_LIMIT = 50;
const PEOPLE_LIMIT = 8;
const CONVERSATIONS_LIMIT = 6;
const WORD = /[\p{L}\p{N}]+/gu;

export function openSearch(sqlite: Database.Database, sources: SearchSources): SearchIndex {
  // An email is indexed with its body text, which the Item doesn't carry.
  const withBody = (item: SearchableItem): SearchableItem =>
    item.kind === 'email' && item.bodyText === undefined
      ? { ...item, bodyText: sources.bodyText?.(item.id) ?? null }
      : item;
  const words = openWordIndex(sqlite, function* () {
    for (const page of sources.allItems()) yield page.map(withBody);
  });
  const meaning = openMeaningIndex(sqlite);
  const retrievers: Retriever[] = [words, meaning];
  const conversations = openConversationIndex(sqlite, {
    allTurns: sources.allTurns ?? (() => []),
    onMeaningPending: sources.onMeaningPending,
  });

  // The Conversations whose turns match, each at its best turn and the line of it that matched.
  function matchingConversations(text: string, vector: QueryVector | undefined): ConversationHit[] {
    if (!sources.conversations) return [];
    const found = conversations.find(text, vector, CONVERSATIONS_LIMIT);
    if (!found.length) return [];
    const byId = new Map(
      sources.conversations(found.map((turn) => turn.conversationId)).map((each) => [each.id, each]),
    );
    return found.flatMap((turn) => {
      const conversation = byId.get(turn.conversationId);
      if (!conversation) return [];
      return [
        {
          conversationId: conversation.id,
          title: conversation.title,
          day: conversation.day,
          daily: conversation.daily,
          turnId: turn.turnId,
          by: turn.by,
          line: matchingLine(turn.text, text),
          foundBy: turn.foundBy,
        },
      ];
    });
  }

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

  // People whose name has words starting with each word typed, or one of whose handles (an address,
  // a login) starts with what was typed.
  function matchingPeople(text: string): Person[] {
    const typed = (text.match(WORD) ?? []).map((word) => word.toLowerCase());
    const whole = text.trim().toLowerCase();
    if (!typed.length || !sources.people) return [];
    const found: Person[] = [];
    for (const person of sources.people()) {
      const named = (person.name.match(WORD) ?? []).map((word) => word.toLowerCase());
      const byName = typed.every((word) => named.some((name) => name.startsWith(word)));
      const byHandle = person.handles.some(({ handle }) => {
        const bare = handle.slice(handle.indexOf(':') + 1).toLowerCase();
        return handle.toLowerCase().startsWith(whole) || bare.startsWith(whole);
      });
      if (byName || byHandle) found.push(person);
      if (found.length === PEOPLE_LIMIT) break;
    }
    return found;
  }

  return {
    put(raw) {
      const item = withBody(raw);
      const change = words.put(item);
      if (change === 'unchanged' || change === 'none') return;
      meaning.changed(item.id, change, change === 'dropped' ? null : searchTextOf(item), item.updatedAt);
      if (change !== 'dropped') sources.onMeaningPending?.();
    },

    meaning: { pending: meaning.pending, save: meaning.save, progress: meaning.progress },

    conversations: {
      put: conversations.put,
      drop: conversations.drop,
      pending: conversations.pending,
      save: conversations.save,
    },

    query(input, vector) {
      const { limit = DEFAULT_LIMIT, ...query } = searchQuery.parse(input);
      const fused = fuse(
        retrievers.map((retriever) => ({
          foundBy: retriever.foundBy,
          hits: retriever.retrieve({ ...query, meaning: vector }, limit),
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
      return {
        hits: emailsNewestFirst(hits),
        projects: narrowed ? [] : matchingProjects(query.text),
        people: narrowed ? [] : matchingPeople(query.text),
        memories: narrowed ? [] : (sources.memories?.(query.text, vector) ?? []),
        conversations: narrowed ? [] : matchingConversations(query.text, vector),
      };
    },
  };
}
