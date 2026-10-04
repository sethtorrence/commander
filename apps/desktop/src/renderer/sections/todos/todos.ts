import type {
  ActivityEntry,
  Actor,
  Filing,
  Item,
  ItemAction,
  ItemChange,
  LinearIssueDetail,
  LinearIssueDraft,
  LinkEnd,
  LinkType,
  Project,
  Source,
} from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';
import { describeFiling, describeFilingAnswer } from '../../projects/projects';

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
  /** The Item at the other end, or the Project (a refers-to Link to one). */
  other: LinkEnd;
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
  /** For backed Todos (a Linear Todo): the Item behind each, by Todo id. */
  backing(todos: readonly Item[]): Promise<Map<string, Item>>;
  /**
   * The workflow states a Linear Todo's issue can move to: its team's, in the team's order, as its
   * Account's Linear offers them (with the issue's own, should the catalog not have it yet).
   */
  linearStates(issue: Item): Promise<LinearState[]>;
  /** Moves a Linear Todo's issue to another state (Set Linear state…); its Todo follows. */
  setLinearState(issueId: string, state: LinearState): Promise<ActivityEntry>;
  /**
   * Sends a Todo to Linear as a new issue (the draft names it in `from`): the Todo becomes backed by
   * the issue. Returns the issue's creation entry; undoing it undoes the whole send.
   */
  sendToLinear(draft: LinearIssueDraft): Promise<ActivityEntry>;
}

export type LinearState = LinearIssueDetail['state'];

/**
 * Where a Todo made from a Block was made (origin Daily Note, or Ares suggesting it from one): its
 * Block, and the day of that Block's Daily Note.
 */
export interface MadeFrom {
  blockId: string;
  day: string;
}

const originIs = (todo: Item, origins: readonly string[]) =>
  todo.detail?.kind === 'todo' && origins.includes(todo.detail.origin);
// A Todo the User made from a Block (`[]`) is that Block's text; one Ares suggested from a Block has
// a title of its own.
const fromBlock = (todo: Item) => originIs(todo, ['daily-note', 'ares']);
const backedBy = (todo: Item) => (todo.detail?.kind === 'todo' ? todo.detail.backedBy : null);

/** The issue behind a Linear Todo, if the Item is one (the Todos Section reads them with `backing`). */
export function linearIssueOf(item: Item | undefined): (Item & { detail: LinearIssueDetail }) | null {
  return item?.detail?.kind === 'linear-issue' ? (item as Item & { detail: LinearIssueDetail }) : null;
}

// The store answers for up to 1000 Items at a time.
function pages<T>(list: readonly T[]): T[][] {
  const all: T[][] = [];
  for (let i = 0; i < list.length; i += 1000) all.push(list.slice(i, i + 1000));
  return all;
}

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
      // A Todo the User made from a Block is that Block's text: the Block changes with it.
      const [made] = await itemStore({ op: 'block-todos', query: { todoIds: [todoId] } });
      const detail = made?.block.detail;
      if (!made || detail?.kind !== 'block' || !originIs(made.todo, ['daily-note'])) {
        return itemStore({ op: 'record', action: retitle });
      }
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
      const todoIds = todos.filter(fromBlock).map((todo) => todo.id);
      const made = await Promise.all(
        pages(todoIds).map((page) => itemStore({ op: 'block-todos', query: { todoIds: page } })),
      );
      return new Map(made.flat().map(({ todo, block, day }) => [todo.id, { blockId: block.id, day }]));
    },

    async backing(todos) {
      const ids = [...new Set(todos.flatMap((todo) => backedBy(todo) ?? []))];
      const found = await Promise.all(
        pages(ids).map((page) =>
          itemStore({ op: 'query', query: { ids: page, includeDeleted: true, limit: 1000 } }),
        ),
      );
      const byId = new Map(found.flat().map((item) => [item.id, item]));
      return new Map(
        todos.flatMap((todo) => {
          const behind = byId.get(backedBy(todo) ?? '');
          return behind ? [[todo.id, behind] as const] : [];
        }),
      );
    },

    async linearStates(issue) {
      const detail = linearIssueOf(issue)?.detail;
      if (!detail || !issue.account) return [];
      const catalog = await itemStore({ op: 'source-catalog', account: issue.account });
      const states = catalog?.teams.find((team) => team.id === detail.team.id)?.states ?? [];
      return states.some((state) => state.id === detail.state.id) ? states : [...states, detail.state];
    },

    setLinearState(issueId, state) {
      return itemStore({ op: 'record', action: { type: 'edit-fields', itemId: issueId, fields: { state } } });
    },

    async sendToLinear(draft) {
      const entries = await itemStore({ op: 'send-to-linear', draft });
      const [first] = entries;
      if (!first) throw new Error('Nothing was sent');
      together.set(
        first.id,
        entries.map((entry) => entry.id),
      );
      return first;
    },
  };
}

/** How each Source is named to the User. */
export const SOURCE_NAMES: Record<Source, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
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
  // A steering warning says it in its own words (#69).
  if (entry.action === 'injection-warning') return entry.why ?? 'Instructions aimed at Ares, ignored';
  // The User's answer to Ares's filing (#71).
  if (entry.action === 'correction' || entry.action === 'confirmation')
    return describeFilingAnswer(entry, projects);
  if (entry.action !== 'undo') return `${whatItDid(entry, projects)[0]} ${who}`;
  const undone = history.find((other) => other.id === entry.undoes);
  if (!undone) return `Undone ${who}`;
  if (undone.action === 'undo') return `Redone ${who}`;
  return `${whatItDid(undone, projects)[1]} undone ${who}`;
}
