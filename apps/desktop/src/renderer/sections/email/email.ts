import type {
  ActivityEntry,
  EmailLabel,
  EmailListView,
  EmailSearchResult,
  EmailThread,
  EmailThreadList,
  EmailViewCounts,
  Item,
  ItemAction,
  MessageFields,
  OutgoingChange,
} from '@commander/domain';
import type { AccountSummary, AccountsState, GoogleAccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import { clockTime } from '../../settings/account-sync';

/*
  The Email Section's view of the app: everything it reads from the Item store, or asks of the email
  Accounts, goes through here, so components never build requests themselves. Emails are Items, one
  per message; the Section shows them as threads. Filing a thread files each of its messages, as one
  change the User can undo, and so does organising it (#135): archive, Trash, star, read, labels and
  snooze are edits of each message's synced fields (ADR 0003), which the Core queues for Gmail.
*/

export interface EmailClient {
  /** A view's threads (the inbox unless asked), newest first: every Account's, or one Account's. */
  threads(query: { account?: string; view?: EmailListView; limit?: number }): Promise<EmailThreadList>;
  /** Each view's threads and unread ones, with a view per label. */
  views(account?: string): Promise<EmailViewCounts>;
  /** The Section's search (`/`), with its operators, newest first. */
  search(text: string, account?: string): Promise<EmailSearchResult>;
  /** The labels the User can put on mail in an Account (or any). */
  labels(account?: string): Promise<EmailLabel[]>;
  /** Edits messages' synced fields, as one change. Returns its entries. */
  edit(changes: readonly MessageFields[]): Promise<ActivityEntry[]>;
  /** The changes still on their way to Gmail (or that couldn't sync) for these messages. */
  outgoing(itemIds: readonly string[]): Promise<OutgoingChange[]>;
  /** Sends a message's changes that couldn't sync again. */
  retry(itemId: string): Promise<void>;
  /** A message's activity log, newest first (for the note when a change made in Gmail won). */
  history(itemId: string): Promise<ActivityEntry[]>;
  /** One thread's messages, oldest first, with their plain-text bodies. */
  thread(account: string, threadKey: string): Promise<EmailThread | null>;
  /** One email Item (to open the thread it is in). */
  item(itemId: string): Promise<Item | null>;
  /** Files every message of a thread under a Project (or Unfiled), as one change. */
  file(itemIds: string[], projectId: string | null): Promise<ActivityEntry[]>;
  /** Undoes a change made here, all its entries at once. */
  undo(entryIds: number[]): Promise<void>;
}

export function emailIn(itemStore: ItemStoreClient): EmailClient {
  return {
    threads: (query) => itemStore({ op: 'email-threads', query }),
    views: (account) => itemStore({ op: 'email-views', query: account ? { account } : {} }),
    search: (text, account) =>
      itemStore({ op: 'email-search', query: { text, ...(account ? { account } : {}) } }),
    labels: (account) => itemStore({ op: 'email-labels', ...(account ? { account } : {}) }),
    edit(changes) {
      const actions = changes.map(
        ({ itemId, fields }): ItemAction => ({ type: 'edit-fields', itemId, fields }),
      );
      return actions.length ? itemStore({ op: 'record-all', actions }) : Promise.resolve([]);
    },
    outgoing: (itemIds) =>
      itemIds.length ? itemStore({ op: 'outgoing', query: { itemIds: [...itemIds] } }) : Promise.resolve([]),
    async retry(itemId) {
      await itemStore({ op: 'retry-outgoing', itemId });
    },
    history: (itemId) => itemStore({ op: 'activity', query: { itemId, limit: 20 } }),
    thread: (account, threadKey) => itemStore({ op: 'email-thread', account, threadKey }),
    async item(itemId) {
      return (await itemStore({ op: 'get', itemId }))?.item ?? null;
    },
    file(itemIds, projectId) {
      const filing = projectId ? { projectId, filedBy: 'user' as const } : null;
      const actions = itemIds.map((itemId): ItemAction => ({ type: 'update', itemId, changes: { filing } }));
      return itemStore({ op: 'record-all', actions });
    },
    async undo(entryIds) {
      const actions = [...entryIds].reverse().map((entryId): ItemAction => ({ type: 'undo', entryId }));
      if (actions.length) await itemStore({ op: 'record-all', actions });
    },
  };
}

/** The email Accounts (Google Accounts with Gmail on, so far), and how each is syncing. */
export interface EmailAccountsClient {
  list(): Promise<GoogleAccountSummary[]>;
  /** Syncs the Account's mail at once (the sync engine's refresh of its Gmail). */
  refresh(accountId: string): Promise<void>;
  /** Called with the Accounts whenever they or their syncing change. Returns the unsubscribe. */
  onChange(listener: (accounts: GoogleAccountSummary[]) => void): () => void;
}

type AccountsBridge = Pick<Window['commander'], 'accounts' | 'onAccountsChanged'>;

/** The Accounts whose mail Commander syncs: Google Accounts with Gmail switched on. */
export const emailAccountsOf = (accounts: readonly AccountSummary[]): GoogleAccountSummary[] =>
  accounts.filter(
    (account): account is GoogleAccountSummary =>
      account.source === 'google' && account.sources.some((each) => each.source === 'gmail' && each.enabled),
  );

export function emailAccountsIn(bridge: AccountsBridge): EmailAccountsClient {
  const of = (state: AccountsState) => emailAccountsOf(state.accounts);
  return {
    async list() {
      return of((await bridge.accounts({ op: 'list' })).state);
    },
    async refresh(accountId) {
      await bridge.accounts({ op: 'sync-now', accountId, source: 'gmail' });
    },
    onChange(listener) {
      return bridge.onAccountsChanged((state) => listener(of(state)));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Wording

const COUNT = new Intl.NumberFormat('en');

// An Account's mail sync: its Gmail's, of the Sources it carries (Google Calendar syncs too).
function lineFor(
  account: GoogleAccountSummary,
  now: Date,
): { text: string; problem: boolean; syncing: boolean } {
  const carried = account.sources.find((each) => each.source === 'gmail')?.sync;
  const sync = carried ?? (account.sync?.source === 'gmail' ? account.sync : null);
  if (sync?.progress) {
    const { done, total } = sync.progress;
    return {
      text: `Downloading 30 days: ${COUNT.format(done)} of ~${COUNT.format(total)}`,
      problem: false,
      syncing: true,
    };
  }
  if (sync?.problem) return { text: sync.problem.message, problem: true, syncing: false };
  if (sync?.activity === 'syncing') return { text: 'Syncing…', problem: false, syncing: true };
  if (sync?.lastSyncedAt)
    return { text: `Synced ${clockTime(sync.lastSyncedAt, now)}`, problem: false, syncing: false };
  return { text: 'Not synced yet', problem: false, syncing: false };
}

/**
 * The Section's thin status line: when mail last synced ("Synced 14:02"), the first download's
 * progress ("Downloading 30 days: 1,240 of ~3,000"), or what went wrong. With several Accounts,
 * each is named.
 */
export function emailSyncLine(
  accounts: readonly GoogleAccountSummary[],
  now: Date,
): { text: string; problem: boolean; syncing: boolean } {
  if (!accounts.length) return { text: 'No email Account connected', problem: false, syncing: false };
  const lines = accounts.map((account) => lineFor(account, now));
  const problem = lines.some((line) => line.problem);
  const syncing = lines.some((line) => line.syncing);
  const [only] = lines;
  if (lines.length === 1 && only) return only;
  const text = lines
    .map((line, index) => {
      const name = accounts[index]?.email ?? '';
      return line.problem
        ? `${name}: ${line.text}`
        : `${name} ${line.text.charAt(0).toLowerCase()}${line.text.slice(1)}`;
    })
    .join(' · ');
  return { text, problem, syncing };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** When a thread last had mail: "14:02" today, "Yesterday", "28 Sep", or "30 Dec 2025". */
export function threadTime(at: number, now: Date): string {
  const date = new Date(at);
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/** When a message was sent, in full: "Fri 2 Oct 2026, 16:00". */
export function sentTime(at: number): string {
  const date = new Date(at);
  const weekday = date.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${weekday} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
