import type {
  ActivityEntry,
  Actor,
  Filing,
  Item,
  ItemChange,
  ItemRef,
  LinkType,
  Project,
  Source,
} from '@commander/domain';
import { describeFiling } from '../../projects/projects';

/*
  The Todos Section's view of the Item store: everything it reads or changes goes through here, so
  components never build Item store requests themselves. It reaches the store only through the
  window's bridge (`window.commander.itemStore`), where every action is recorded as the User's.
*/

/** The window's Item store channel (the preload bridge), or a stand-in for tests. */
export type ItemStoreClient = Window['commander']['itemStore'];

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
  /** Changes a Todo's title. */
  rename(todoId: string, title: string): Promise<ActivityEntry>;
  /** Deletes a Todo. It stays in the Item store with its history and Links, so undo brings it back. */
  remove(todoId: string): Promise<ActivityEntry>;
  /** A Todo's Links in both directions: from it first, then backlinks, each oldest first. */
  links(todoId: string): Promise<TodoLink[]>;
  /** A Todo's activity log, newest first. */
  history(todoId: string): Promise<ActivityEntry[]>;
  /** Reverses what an activity entry changed. */
  undo(entryId: number): Promise<ActivityEntry>;
}

const EMPTY = 'A Todo can’t be empty';

export function todosIn(itemStore: ItemStoreClient): Todos {
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

    rename(todoId, title) {
      const trimmed = title.trim();
      if (!trimmed) return Promise.reject(new Error(EMPTY));
      return itemStore({
        op: 'record',
        action: { type: 'update', itemId: todoId, changes: { title: trimmed } },
      });
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

    undo(entryId) {
      return itemStore({ op: 'record', action: { type: 'undo', entryId } });
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
