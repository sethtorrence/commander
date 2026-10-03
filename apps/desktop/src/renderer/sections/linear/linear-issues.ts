import type { ActivityEntry, Actor, Item, ItemChange, Project } from '@commander/domain';
import type { AccountSummary, AccountsState } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import { describeFiling } from '../../projects/projects';
import { clockTime } from '../../settings/account-sync';
import { SOURCE_NAMES, type TodoLink } from '../todos/todos';

/*
  The Linear Section's view of the app: everything it reads from the Item store or asks of the
  Linear Accounts goes through here, so components never build requests themselves. Read-only
  for now; filing goes through Projects (projects/), which records it as the User's.

  Two-way sync (#60) adds the writes here: changing an issue's fields and commenting.
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
}

// The Item store answers at most 1000 Items a query.
const MOST = 1000;

export function linearIssuesIn(itemStore: ItemStoreClient): LinearIssues {
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

    undo(entryId) {
      return itemStore({ op: 'record', action: { type: 'undo', entryId } });
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

const linearOnly = (state: AccountsState) => state.accounts.filter((account) => account.source === 'linear');

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

function whatChanged(changes: ItemChange[], projects: readonly Project[]): [string, string] {
  const filing = changes.length === 1 && changes[0]?.field === 'filing' ? changes[0] : null;
  if (filing) return [describeFiling(filing, projects), 'Filing'];
  const status = changes.find((change) => change.field === 'status');
  if (status?.after === 'done') return ['Closed', 'Close'];
  if (status?.before === 'done') return ['Reopened', 'Reopen'];
  if (changes.length === 1 && changes[0]?.field === 'title') return ['Renamed', 'Rename'];
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
  const who = byWhom(entry.by);
  if (entry.action === 'create' && entry.by.kind === 'source')
    return `Added from ${SOURCE_NAMES[entry.by.source]}`;
  if (entry.action !== 'undo') return `${whatItDid(entry, projects)[0]} ${who}`;
  const undone = history.find((other) => other.id === entry.undoes);
  if (!undone) return `Undone ${who}`;
  if (undone.action === 'undo') return `Redone ${who}`;
  return `${whatItDid(undone, projects)[1]} undone ${who}`;
}

/**
 * The Section's thin status line: when Linear last synced ("Synced 14:02"), that it is syncing now,
 * or the sync engine's problem in its own words. With several Accounts each is named.
 */
export function syncLine(accounts: readonly AccountSummary[], now: Date): { text: string; problem: boolean } {
  if (!accounts.length) return { text: 'No Linear Account connected', problem: false };
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
