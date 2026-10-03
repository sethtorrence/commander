import type { ActivityEntry, Actor, Item, ItemChange, Source } from '@commander/domain';

/*
  The Todos Section's view of the Item store: everything it reads or changes goes through here, so
  components never build Item store requests themselves. It reaches the store only through the
  window's bridge (`window.commander.itemStore`), where every action is recorded as the User's.
*/

/** The window's Item store channel (the preload bridge), or a stand-in for tests. */
export type ItemStoreClient = Window['commander']['itemStore'];

export interface Todos {
  /** Every Todo that hasn't been deleted, open and ticked, in the order they were added. */
  list(): Promise<Item[]>;
  /** Adds a Todo the User typed: origin manual, Unfiled. Returns its activity entry. */
  add(title: string): Promise<ActivityEntry>;
  /** Ticks a Todo (done) or unticks it. */
  setDone(todoId: string, done: boolean): Promise<ActivityEntry>;
  /** A Todo's activity log, newest first. */
  history(todoId: string): Promise<ActivityEntry[]>;
  /** Reverses what an activity entry changed. */
  undo(entryId: number): Promise<ActivityEntry>;
}

export function todosIn(itemStore: ItemStoreClient): Todos {
  return {
    async list() {
      const todos = await itemStore({ op: 'query', query: { kinds: ['todo'], statuses: ['open', 'done'] } });
      return todos.sort((a, b) => a.createdAt - b.createdAt);
    },

    add(title) {
      const trimmed = title.trim();
      if (!trimmed) return Promise.reject(new Error('A Todo can’t be empty'));
      return itemStore({
        op: 'record',
        action: {
          type: 'create',
          item: {
            kind: 'todo',
            title: trimmed,
            filing: null,
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

    history(todoId) {
      return itemStore({ op: 'activity', query: { itemId: todoId } });
    },

    undo(entryId) {
      return itemStore({ op: 'record', action: { type: 'undo', entryId } });
    },
  };
}

const SOURCE_NAMES: Record<Source, string> = {
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
function whatItDid(entry: ActivityEntry): [string, string] {
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
      return whatChanged(entry.changes);
  }
}

function whatChanged(changes: ItemChange[]): [string, string] {
  const status = changes.find((change) => change.field === 'status');
  if (status?.after === 'done') return ['Ticked', 'Tick'];
  if (status?.before === 'done') return ['Unticked', 'Untick'];
  if (changes.length === 1 && changes[0]?.field === 'title') return ['Renamed', 'Rename'];
  return ['Changed', 'Change'];
}

/**
 * One line of a Todo's history: "Added by you", "Ticked by you", "Tick undone by you". `history`
 * is the rest of the log, to name what an undo reversed.
 */
export function describeEntry(entry: ActivityEntry, history: readonly ActivityEntry[]): string {
  const who = byWhom(entry.by);
  if (entry.action !== 'undo') return `${whatItDid(entry)[0]} ${who}`;
  const undone = history.find((other) => other.id === entry.undoes);
  if (!undone) return `Undone ${who}`;
  if (undone.action === 'undo') return `Redone ${who}`;
  return `${whatItDid(undone)[1]} undone ${who}`;
}
