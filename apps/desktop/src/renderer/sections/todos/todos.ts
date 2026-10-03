import type {
  ActivityEntry,
  Actor,
  Filing,
  Item,
  ItemAction,
  ItemChange,
  ItemRef,
  LinkType,
  Project,
  Source,
} from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';
import { describeFiling } from '../../projects/projects';

/*
  The Todos Section's view of the Item store: everything it reads or changes goes through here, so
  components never build Item store requests themselves. It reaches the store only through the
  window's bridge (`window.commander.itemStore`), where every action is recorded as the User's.
*/

export type { ItemStoreClient } from '../../item-store/client';

/** One of a Todo's Links: from the Todo to another Item, or a backlink from another Item to it. */
export interface TodoLink {
  type: LinkType;
  /** True when the Link points at the Todo from the other Item. */
  backlink: boolean;
  /** The Item at the other end. */
  other: ItemRef;
}

export interface Todos {
  /**
   * Every Todo that hasn't been deleted: the open ones in the order they were added, then the
   * ticked ones, most recently changed first.
   */
  list(): Promise<Item[]>;
  /** Adds a Todo the User typed: origin manual, Unfiled unless filed. Returns its activity entry. */
  add(title: string, filing?: Filing): Promise<ActivityEntry>;
  /** Ticks a Todo (done) or unticks it. */
  setDone(todoId: string, done: boolean): Promise<ActivityEntry>;
  /** Changes a Todo's title; a Todo made from a Block changes the Block's text with it, as one change. */
  rename(todoId: string, title: string): Promise<ActivityEntry>;
  /** Deletes a Todo. It stays in the Item store with its history and Links, so undo brings it back. */
  remove(todoId: string): Promise<ActivityEntry>;
  /** A Todo's Links in both directions: from it first, then backlinks, each oldest first. */
  links(todoId: string): Promise<TodoLink[]>;
  /** A Todo's activity log, newest first. */
  history(todoId: string): Promise<ActivityEntry[]>;
  /**
   * Reverses a change made here, given its (first) activity entry: with it, anything recorded as part
   * of the same change (the Block of a Todo renamed here).
   */
  undo(entryId: number): Promise<ActivityEntry>;
  /** For the Todos made from a Block (origin Daily Note): the Block and its day, by Todo id. */
  madeFrom(todos: readonly Item[]): Promise<Map<string, MadeFrom>>;
}

/** Where a Todo of origin Daily Note was made: its Block, and the day of that Block's Daily Note. */
export interface MadeFrom {
  blockId: string;
  day: string;
}

const fromDailyNote = (todo: Item) => todo.detail?.kind === 'todo' && todo.detail.origin === 'daily-note';

const EMPTY = 'A Todo can’t be empty';

export function todosIn(itemStore: ItemStoreClient): Todos {
  // Changes made here that were recorded as several entries, by their first entry's id.
  const together = new Map<number, number[]>();

  return {
    async list() {
      // The store answers newest change first, which is the order ticked Todos are shown in.
      const [open, done] = await Promise.all([
        itemStore({ op: 'query', query: { kinds: ['todo'], statuses: ['open'], limit: 1000 } }),
        itemStore({ op: 'query', query: { kinds: ['todo'], statuses: ['done'], limit: 200 } }),
      ]);
      return [...open.sort((a, b) => a.createdAt - b.createdAt), ...done];
    },

    add(title, filing = null) {
      const trimmed = title.trim();
      if (!trimmed) return Promise.reject(new Error(EMPTY));
      return itemStore({
        op: 'record',
        action: {
          type: 'create',
          item: {
            kind: 'todo',
            title: trimmed,
            filing,
            detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
          },
        },
      });
    },

    setDone(todoId, done) {
      return itemStore({
        op: 'record',
        action: { type: 'update', itemId: todoId, changes: { status: done ? 'done' : 'open' } },
      });
    },

    async rename(todoId, title) {
      const trimmed = title.trim();
      if (!trimmed) throw new Error(EMPTY);
      const retitle: ItemAction = { type: 'update', itemId: todoId, changes: { title: trimmed } };
      // A Todo made from a Block is that Block's text: the Block changes with it.
      const [made] = await itemStore({ op: 'block-todos', query: { todoIds: [todoId] } });
      const detail = made?.block.detail;
      if (!made || detail?.kind !== 'block') return itemStore({ op: 'record', action: retitle });
      const entries = await itemStore({
        op: 'record-all',
        actions: [
          retitle,
          { type: 'update', itemId: made.block.id, changes: { detail: { ...detail, text: trimmed } } },
        ],
      });
      const [first] = entries;
      if (!first) throw new Error('Nothing was recorded');
      together.set(
        first.id,
        entries.map((entry) => entry.id),
      );
      return first;
    },

    remove(todoId) {
      return itemStore({ op: 'record', action: { type: 'delete', itemId: todoId } });
    },

    async links(todoId) {
      const view = await itemStore({ op: 'get', itemId: todoId });
      if (!view) return [];
      return [
        ...view.links.map((link) => ({ type: link.type, backlink: false, other: link.to })),
        ...view.backlinks.map((link) => ({ type: link.type, backlink: true, other: link.from })),
      ];
    },

    history(todoId) {
      return itemStore({ op: 'activity', query: { itemId: todoId } });
    },

    async undo(entryId) {
      const entries = together.get(entryId);
      if (!entries) return itemStore({ op: 'record', action: { type: 'undo', entryId } });
      const actions = [...entries].reverse().map((id): ItemAction => ({ type: 'undo', entryId: id }));
      const [first] = await itemStore({ op: 'record-all', actions });
      if (!first) throw new Error('Nothing was undone');
      together.delete(entryId);
      return first;
    },

    async madeFrom(todos) {
      const todoIds = todos.filter(fromDailyNote).map((todo) => todo.id);
      // The store answers for up to 1000 Todos at a time.
      const pages = [];
      for (let i = 0; i < todoIds.length; i += 1000) pages.push(todoIds.slice(i, i + 1000));
      const made = await Promise.all(
        pages.map((page) => itemStore({ op: 'block-todos', query: { todoIds: page } })),
      );
      return new Map(made.flat().map(({ todo, block, day }) => [todo.id, { blockId: block.id, day }]));
    },
  };
}

/** How each Source is named to the User. */
export const SOURCE_NAMES: Record<Source, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-calendar': 'Google Calendar',
  teams: 'Teams',
  linear: 'Linear',
  github: 'GitHub',
};

function byWhom(actor: Actor): string {
  switch (actor.kind) {
    case 'user':
      return 'by you';
    case 'ares':
      return 'by Ares';
    case 'rule':
      return 'by a Rule';
    case 'source':
      return `in ${SOURCE_NAMES[actor.source]}`;
  }
}

// What an entry did, as [past tense, noun]: ["Ticked", "Tick"].
function whatItDid(entry: ActivityEntry, projects: readonly Project[]): [string, string] {
  switch (entry.action) {
    case 'create':
      return ['Added', 'Add'];
    case 'delete':
    case 'tombstone':
      return ['Deleted', 'Delete'];
    case 'link':
      return ['Linked', 'Link'];
    case 'unlink':
      return ['Unlinked', 'Unlink'];
    default:
      return whatChanged(entry.changes, projects);
  }
}

function whatChanged(changes: ItemChange[], projects: readonly Project[]): [string, string] {
  const filing = changes.length === 1 && changes[0]?.field === 'filing' ? changes[0] : null;
  if (filing) return [describeFiling(filing, projects), 'Filing'];
  const status = changes.find((change) => change.field === 'status');
  if (status?.after === 'done') return ['Ticked', 'Tick'];
  if (status?.before === 'done') return ['Unticked', 'Untick'];
  if (changes.length === 1 && changes[0]?.field === 'title') return ['Title changed', 'Title change'];
  return ['Changed', 'Change'];
}

/**
 * One line of a Todo's history: "Added by you", "Ticked by you", "Tick undone by you". `history`
 * is the rest of the log, to name what an undo reversed; `projects` names Projects by their code
 * ("Filed under LT by you").
 */
export function describeEntry(
  entry: ActivityEntry,
  history: readonly ActivityEntry[],
  projects: readonly Project[] = [],
): string {
  const who = byWhom(entry.by);
  if (entry.action !== 'undo') return `${whatItDid(entry, projects)[0]} ${who}`;
  const undone = history.find((other) => other.id === entry.undoes);
  if (!undone) return `Undone ${who}`;
  if (undone.action === 'undo') return `Redone ${who}`;
  return `${whatItDid(undone, projects)[1]} undone ${who}`;
}
