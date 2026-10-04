import {
  type ActivityEntry,
  type Actor,
  COMMENT_FIELD,
  type Item,
  type ItemAction,
  type ItemChange,
  LABEL_FIELD,
  type LinearCatalog,
  type LinearComment,
  type LinearIssueDraft,
  type OutgoingChange,
  type Project,
  syncedFieldsOf,
} from '@commander/domain';
import type { AccountSummary, AccountsState, LinearAccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import { describeFiling, describeFilingAnswer } from '../../projects/projects';
import { clockTime } from '../../settings/account-sync';
import { SOURCE_NAMES, type TodoLink } from '../todos/todos';

/*
  The Linear Section's view of the app: everything it reads from the Item store or asks of the
  Linear Accounts goes through here, so components never build requests themselves. Filing goes
  through Projects (projects/), which records it as the User's.

  Two-way sync: changing an issue's synced fields and commenting are Item store edits (recorded as
  the User's, undoable); the Core queues each for Linear and sends it in the background. The
  Section reads back what is still on its way (or couldn't sync), retries, and reads what each
  Account's Linear offers the pickers.
*/

/** One of an issue's Links: from it to another Item, or a backlink from another Item to it. */
export type IssueLink = TodoLink;

export interface LinearIssues {
  /** Every Linear issue Commander holds, open and closed (closed ones go back 30 days), not deleted. */
  list(): Promise<Item[]>;
  /** An issue's Links in both directions: from it first, then backlinks, each oldest first. */
  links(itemId: string): Promise<IssueLink[]>;
  /** An issue's activity log, newest first. */
  history(itemId: string): Promise<ActivityEntry[]>;
  /** Reverses what an activity entry changed (filing an issue, say). */
  undo(entryId: number): Promise<ActivityEntry>;
  /**
   * Changes some of an issue's synced fields (`state`, `priority`, `label:<id>`…), leaving the rest
   * as they are now. Shows at once; Linear gets it in the background.
   */
  edit(itemId: string, fields: Record<string, unknown>): Promise<ActivityEntry>;
  /** Posts a comment, under an id made here so a retried post is never posted twice. */
  comment(itemId: string, body: string, author: LinearComment['author']): Promise<ActivityEntry>;
  /** The changes made here still on their way to Linear, or that couldn't sync. */
  outgoing(): Promise<OutgoingChange[]>;
  /** Sends an issue's changes that couldn't sync again. */
  retry(itemId: string): Promise<void>;
  /** What an Account's Linear offers the pickers, as its last sync fetched it (null before then). */
  catalog(accountId: string): Promise<LinearCatalog | null>;
  /**
   * New Linear issue: makes it at once and sends it to Linear in the background. Returns its creation
   * entry; undoing that entry here undoes the whole send (deleting the issue in Linear).
   */
  sendToLinear(draft: LinearIssueDraft): Promise<ActivityEntry>;
}

// The Item store answers at most 1000 Items a query.
const MOST = 1000;

export function linearIssuesIn(itemStore: ItemStoreClient): LinearIssues {
  // Changes made here that were recorded as several entries (a send), by their first entry's id.
  const together = new Map<number, number[]>();

  return {
    async list() {
      const [open, closed] = await Promise.all([
        itemStore({ op: 'query', query: { kinds: ['linear-issue'], statuses: ['open'], limit: MOST } }),
        itemStore({ op: 'query', query: { kinds: ['linear-issue'], statuses: ['done'], limit: MOST } }),
      ]);
      return [...open, ...closed];
    },

    async links(itemId) {
      const view = await itemStore({ op: 'get', itemId });
      if (!view) return [];
      return [
        ...view.links.map((link) => ({ type: link.type, backlink: false, other: link.to })),
        ...view.backlinks.map((link) => ({ type: link.type, backlink: true, other: link.from })),
      ];
    },

    history(itemId) {
      return itemStore({ op: 'activity', query: { itemId } });
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

    edit(itemId, fields) {
      return itemStore({ op: 'record', action: { type: 'edit-fields', itemId, fields } });
    },

    comment(itemId, body, author) {
      const id = crypto.randomUUID();
      const at = Date.now();
      const comment: LinearComment = { id, author, body, createdAt: at, updatedAt: at };
      return itemStore({
        op: 'record',
        action: { type: 'edit-fields', itemId, fields: { [`${COMMENT_FIELD}${id}`]: comment } },
      });
    },

    async outgoing() {
      const changes = await itemStore({ op: 'outgoing', query: {} });
      return changes.filter((change) => change.source === 'linear');
    },

    async retry(itemId) {
      await itemStore({ op: 'retry-outgoing', itemId });
    },

    catalog(accountId) {
      return itemStore({ op: 'source-catalog', account: accountId });
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

/** The Linear Accounts, as Settings → Accounts has them: who signed in, and how each is syncing. */
export interface LinearAccountsClient {
  list(): Promise<AccountSummary[]>;
  /** Syncs the Account at once (the sync engine's refresh). */
  syncNow(accountId: string): Promise<void>;
  /** Called with the Accounts whenever they or their syncing change. Returns the unsubscribe. */
  onChange(listener: (accounts: AccountSummary[]) => void): () => void;
}

type AccountsBridge = Pick<Window['commander'], 'accounts' | 'onAccountsChanged'>;

const linearOnly = (state: AccountsState): LinearAccountSummary[] =>
  state.accounts.filter((account): account is LinearAccountSummary => account.source === 'linear');

export function linearAccountsIn(bridge: AccountsBridge): LinearAccountsClient {
  return {
    async list() {
      return linearOnly((await bridge.accounts({ op: 'list' })).state);
    },
    async syncNow(accountId) {
      await bridge.accounts({ op: 'sync-now', accountId });
    },
    onChange(listener) {
      return bridge.onAccountsChanged((state) => listener(linearOnly(state)));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Wording

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

// What an entry did, as [past tense, noun]: ["Closed", "Close"].
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

// Whether two values read from the Item store are the same (key order aside).
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) =>
    sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

// How the activity log names an issue's synced fields.
const FIELD_NAMES: Record<string, string> = {
  state: 'State',
  assignee: 'Assignee',
  priority: 'Priority',
  dueDate: 'Due date',
  estimate: 'Estimate',
  cycle: 'Cycle',
  linearProject: 'Linear project',
};

/** The synced fields a change to an issue's detail touched, by name: "Priority", "Labels", "Comment". */
export function changedFieldNames(changes: readonly ItemChange[]): string[] {
  const detail = changes.find((change) => change.field === 'detail');
  if (detail?.field !== 'detail') return [];
  const before = syncedFieldsOf(detail.before) ?? {};
  const after = syncedFieldsOf(detail.after) ?? {};
  const names = new Set<string>();
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameValue(before[field] ?? null, after[field] ?? null)) continue;
    if (field.startsWith(LABEL_FIELD)) names.add('Labels');
    else if (field.startsWith(COMMENT_FIELD)) names.add(after[field] ? 'Comment' : 'Comment deleted');
    else names.add(FIELD_NAMES[field] ?? field);
  }
  return [...names];
}

// Whether a change touched nothing but the issue's updated time.
function onlyBookkeeping(changes: readonly ItemChange[]): boolean {
  const [only, ...rest] = changes;
  if (!only || rest.length || only.field !== 'detail' || !only.before || !only.after) return false;
  return sameValue({ ...only.before, updatedAt: 0 }, { ...only.after, updatedAt: 0 });
}

const andList = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)?.toLowerCase()}`;

function whatChanged(changes: ItemChange[], projects: readonly Project[]): [string, string] {
  const filing = changes.length === 1 && changes[0]?.field === 'filing' ? changes[0] : null;
  if (filing) return [describeFiling(filing, projects), 'Filing'];
  const status = changes.find((change) => change.field === 'status');
  if (status?.after === 'done') return ['Closed', 'Close'];
  if (status?.before === 'done') return ['Reopened', 'Reopen'];
  if (changes.length === 1 && changes[0]?.field === 'title') return ['Renamed', 'Rename'];
  const fields = changedFieldNames(changes);
  if (fields.length === 1 && fields[0] === 'Comment') return ['Commented', 'Comment'];
  if (fields.length === 1 && fields[0] === 'Comment deleted') return ['Comment deleted', 'Comment deletion'];
  if (fields.length) {
    const named = andList(fields.map((name) => name.replace(' deleted', '')));
    return [`${named} changed`, `${named} change`];
  }
  // Only Linear's own bookkeeping moved (its updated time, after a change sent from here, say).
  if (onlyBookkeeping(changes)) return ['Updated', 'Update'];
  return ['Changed', 'Change'];
}

/**
 * One line of an issue's history: "Added from Linear", "Closed in Linear", "Filed under LT by you",
 * "Filing undone by you". `history` is the rest of the log, to name what an undo reversed.
 */
export function describeIssueEntry(
  entry: ActivityEntry,
  history: readonly ActivityEntry[],
  projects: readonly Project[] = [],
): string {
  // A Rule's entry says which Rule: "by Rule: team is ENG".
  const who = entry.by.kind === 'rule' && entry.why ? `by ${entry.why}` : byWhom(entry.by);
  if (entry.action === 'create' && entry.by.kind === 'source')
    return `Added from ${SOURCE_NAMES[entry.by.source]}`;
  // A steering warning says it in its own words (#69).
  if (entry.action === 'injection-warning') return entry.why ?? 'Instructions aimed at Ares, ignored';
  // The User's answer to Ares's filing (#71).
  if (entry.action === 'correction' || entry.action === 'confirmation')
    return describeFilingAnswer(entry, projects);
  // A change in Linear that won over the User's says so: "Changed in Linear by Priya Patel at 14:02".
  if (entry.by.kind === 'source' && entry.why) return entry.why;
  if (entry.action !== 'undo') return `${whatItDid(entry, projects)[0]} ${who}`;
  const undone = history.find((other) => other.id === entry.undoes);
  if (!undone) return `Undone ${who}`;
  if (undone.action === 'undo') return `Redone ${who}`;
  return `${whatItDid(undone, projects)[1]} undone ${who}`;
}

/**
 * The Section's thin status line: when Linear last synced ("Synced 14:02"), that it is syncing now,
 * or the sync engine's problem in its own words. With several Accounts each is named. The GitHub
 * Section shares it, with its own words for no Account.
 */
export function syncLine(
  accounts: readonly AccountSummary[],
  now: Date,
  none = 'No Linear Account connected',
): { text: string; problem: boolean } {
  if (!accounts.length) return { text: none, problem: false };
  const each = accounts.map((account) => {
    const sync = account.sync;
    if (sync?.problem) return { text: sync.problem.message, problem: true, sep: ': ' };
    if (sync?.activity === 'syncing') return { text: 'Syncing…', problem: false, sep: ' ' };
    if (sync?.lastSyncedAt)
      return { text: `Synced ${clockTime(sync.lastSyncedAt, now)}`, problem: false, sep: ' ' };
    return { text: 'Not synced yet', problem: false, sep: ': ' };
  });
  const problem = each.some((line) => line.problem);
  const [only] = each;
  if (each.length === 1 && only) return { text: only.text, problem };
  const text = each
    .map((line, index) => {
      const name = accounts[index]?.name ?? '';
      const words = line.sep === ' ' ? line.text.charAt(0).toLowerCase() + line.text.slice(1) : line.text;
      return `${name}${line.sep}${words}`;
    })
    .join(' · ');
  return { text, problem };
}
