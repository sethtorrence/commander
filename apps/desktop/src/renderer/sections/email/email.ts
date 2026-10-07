import type {
  ActivityEntry,
  Bucket,
  EmailInvitationCard,
  EmailLabel,
  EmailListView,
  EmailSearchResult,
  EmailThread,
  EmailThreadList,
  EmailViewCounts,
  EventResponse,
  Item,
  ItemAction,
  MessageFields,
  OutgoingChange,
  ReadyReply,
  SortingProgress,
} from '@commander/domain';
import {
  type CloudMailAnswer,
  FILE_INTO_PROJECTS,
  LEARN_WRITING_STYLE,
  SORT_INTO_BUCKETS,
} from '@commander/domain';
import type {
  AccountSummary,
  AccountsState,
  GoogleAccountSummary,
  OutlookAccountSummary,
} from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import { clockTime } from '../../settings/account-sync';
import { type EmailTodoDraft, makeEmailTodo } from './email-todo';

/*
  The Email Section's view of the app: everything it reads from the Item store, or asks of the email
  Accounts, goes through here, so components never build requests themselves. Emails are Items, one
  per message; the Section shows them as threads. Filing a thread files each of its messages, as one
  change the User can undo, and so does organising it (#135): archive, Trash, star, read, labels and
  snooze are edits of each message's synced fields (ADR 0003), which the Core queues for Gmail or
  Outlook. So is moving it to a Bucket (#137), though that stays in Commander. A Todo made from an
  email (#140) is the Todo and its made-from Link, as one change. An invitation email's card (#144) is
  answered on its event, exactly as from Calendar.
*/

export interface EmailClient {
  /**
   * A view's threads (the inbox unless asked), newest first: every Account's, or one Account's; in one
   * Bucket (or Unsorted) when asked, with the view's counts by Bucket and Project.
   */
  threads(query: {
    account?: string;
    view?: EmailListView;
    bucket?: string;
    limit?: number;
  }): Promise<EmailThreadList>;
  /** The User's Buckets, in their order. */
  buckets(): Promise<Bucket[]>;
  /** Each view's threads and unread ones, with a view per label. */
  views(account?: string): Promise<EmailViewCounts>;
  /** The Section's search (`/`), with its operators, newest first. */
  search(text: string, account?: string): Promise<EmailSearchResult>;
  /** The labels the User can put on mail in an Account (or any). */
  labels(account?: string): Promise<EmailLabel[]>;
  /** Edits messages' synced fields, as one change. Returns its entries. */
  edit(changes: readonly MessageFields[]): Promise<ActivityEntry[]>;
  /** The changes still on their way to Gmail or Outlook (or that couldn't sync) for these messages. */
  outgoing(itemIds: readonly string[]): Promise<OutgoingChange[]>;
  /** Sends a message's changes that couldn't sync again. */
  retry(itemId: string): Promise<void>;
  /** A message's activity log, newest first (for the note when a change made in Gmail or Outlook won). */
  history(itemId: string): Promise<ActivityEntry[]>;
  /** One thread's messages, oldest first, with their plain-text bodies. */
  thread(account: string, threadKey: string): Promise<EmailThread | null>;
  /** One email Item (to open the thread it is in). */
  item(itemId: string): Promise<Item | null>;
  /** Files every message of a thread under a Project (or Unfiled), as one change. */
  file(itemIds: string[], projectId: string | null): Promise<ActivityEntry[]>;
  /** Undoes a change made here, all its entries at once. */
  undo(entryIds: number[]): Promise<void>;
  /** Makes a Todo from an email (#140), with its made-from Link, as one change. Returns its entries. */
  makeTodo(draft: EmailTodoDraft): Promise<ActivityEntry[]>;
  /** How far Ares has got sorting the mail in scope (#141), for the status line. */
  sorting(): Promise<SortingProgress>;
  /** Confirms Ares's suggested Bucket on an email: sorted there, by the User. Returns its entries. */
  confirmBucket(proposalId: number): Promise<number[]>;
  /** Each Gmail Account's answer to "Let Ares read mail from …?" (#141), by Account id. */
  cloudMail(): Promise<Record<string, CloudMailAnswer>>;
  /** Saves an Account's answer; allowed, Ares starts sorting its mail at once. */
  answerCloudMail(account: string, answer: CloudMailAnswer): Promise<void>;
  /**
   * Draft a reply (#143): Ares drafts the User's reply to a thread (by any of its messages), with what
   * they want said when given; it waits at the end of the thread as his suggested reply.
   */
  draftReply(itemId: string, instruction?: string): Promise<ReadyReply>;
  /** Dismiss on Ares's suggested reply (by the message it answers): away until a new message arrives. */
  dismissSuggestedReply(itemId: string): Promise<void>;
  /**
   * An invitation email's card (#144): its event, with what it overlaps in the User's other Accounts
   * (the Core refreshing the Account's calendar first when it isn't synced yet), or why it can't be shown.
   */
  invitation(itemId: string): Promise<EmailInvitationCard>;
  /** Answers an invitation's event exactly as from Calendar (#129): its answer fields, as the User. */
  answerInvitation(eventId: string, fields: Record<string, EventResponse>): Promise<ActivityEntry>;
}

/** The window's channels to Ares (his suggestions, his jobs, his Skills) and his settings. */
type Bridges = {
  autonomy: () => Window['commander']['autonomy'];
  models: () => Window['commander']['models'];
  updates?: () => Window['commander']['updates'];
};

export function emailIn(
  itemStore: ItemStoreClient,
  bridges: Bridges = { autonomy: () => window.commander.autonomy, models: () => window.commander.models },
): EmailClient {
  return {
    threads: (query) => itemStore({ op: 'email-threads', query }),
    buckets: () => itemStore({ op: 'buckets' }),
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
    makeTodo: (draft) => makeEmailTodo(itemStore, draft),
    sorting: () => itemStore({ op: 'email-sorting' }),
    async confirmBucket(proposalId) {
      const record = await bridges.autonomy()({ op: 'accept', proposalId });
      return record.entryIds;
    },
    async cloudMail() {
      const response = await bridges.models()({ op: 'settings' });
      if (!response.ok) throw new Error(response.error);
      return response.result.cloudMail ?? {};
    },
    async answerCloudMail(account, answer) {
      const response = await bridges.models()({ op: 'set-cloud-mail', account, answer });
      if (!response.ok) throw new Error(response.error);
      if (answer !== 'allowed') return;
      for (const job of [SORT_INTO_BUCKETS, FILE_INTO_PROJECTS, LEARN_WRITING_STYLE])
        await bridges.autonomy()({ op: 'run-job', job });
    },
    draftReply: (itemId, instruction) =>
      (bridges.updates?.() ?? window.commander.updates)({
        op: 'draft-email-reply',
        itemId,
        ...(instruction?.trim() ? { instruction } : {}),
      }),
    async dismissSuggestedReply(itemId) {
      await itemStore({ op: 'dismiss-suggested-reply', itemId });
    },
    invitation: (itemId) => itemStore({ op: 'email-invitation', itemId }),
    answerInvitation: (eventId, fields) =>
      itemStore({ op: 'record', action: { type: 'edit-fields', itemId: eventId, fields } }),
  };
}

/** An email Account: a Google Account carrying Gmail, or an Outlook Account carrying its mail (#136). */
export type EmailAccountSummary = GoogleAccountSummary | OutlookAccountSummary;

/** The address an email Account signed in with. */
export const emailAddressOf = (account: EmailAccountSummary) =>
  account.source === 'google' ? account.email : account.userPrincipalName;

/** The Source an email Account's mail comes from. */
export const mailSourceOf = (account: EmailAccountSummary): 'gmail' | 'outlook' =>
  account.source === 'google' ? 'gmail' : 'outlook';

/** What the User calls an email Account's mail: Gmail or Outlook. */
export const providerOf = (account: EmailAccountSummary | undefined): 'Gmail' | 'Outlook' =>
  account?.source === 'outlook' ? 'Outlook' : 'Gmail';

/** The email Accounts (Google Accounts with Gmail on, Outlook Accounts with mail on), and how each is syncing. */
export interface EmailAccountsClient {
  list(): Promise<EmailAccountSummary[]>;
  /** Syncs the Account's mail at once (the sync engine's refresh of its Gmail or Outlook). */
  refresh(accountId: string, source?: 'gmail' | 'outlook'): Promise<void>;
  /** Called with the Accounts whenever they or their syncing change. Returns the unsubscribe. */
  onChange(listener: (accounts: EmailAccountSummary[]) => void): () => void;
}

type AccountsBridge = Pick<Window['commander'], 'accounts' | 'onAccountsChanged'>;

/** The Accounts whose mail Commander syncs: Google Accounts with Gmail on, Outlook Accounts with mail on. */
export const emailAccountsOf = (accounts: readonly AccountSummary[]): EmailAccountSummary[] =>
  accounts.filter(
    (account): account is EmailAccountSummary =>
      (account.source === 'google' || account.source === 'outlook') &&
      account.sources.some((each) => each.source === mailSourceOf(account) && each.enabled),
  );

export function emailAccountsIn(bridge: AccountsBridge): EmailAccountsClient {
  const of = (state: AccountsState) => emailAccountsOf(state.accounts);
  return {
    async list() {
      return of((await bridge.accounts({ op: 'list' })).state);
    },
    async refresh(accountId, source = 'gmail') {
      await bridge.accounts({ op: 'sync-now', accountId, source });
    },
    onChange(listener) {
      return bridge.onAccountsChanged((state) => listener(of(state)));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Wording

const COUNT = new Intl.NumberFormat('en');

// An Account's mail sync: its Gmail's or Outlook's, of the Sources it carries (its calendar syncs too).
function lineFor(
  account: EmailAccountSummary,
  now: Date,
): { text: string; problem: boolean; syncing: boolean } {
  const source = mailSourceOf(account);
  const carried = account.sources.find((each) => each.source === source)?.sync;
  const sync = carried ?? (account.sync?.source === source ? account.sync : null);
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
  accounts: readonly EmailAccountSummary[],
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
      const account = accounts[index];
      const name = account ? emailAddressOf(account) : '';
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
