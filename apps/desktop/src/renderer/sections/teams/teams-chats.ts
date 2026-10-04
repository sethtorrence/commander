import {
  type ActivityEntry,
  type Actor,
  type ChatReply,
  type ChatSetting,
  type ChatSettingAction,
  type ChatSettingChange,
  type Item,
  type ItemChange,
  MESSAGE_FIELD,
  type OutgoingChange,
  type Project,
  READ_FIELD,
  syncedFieldsOf,
} from '@commander/domain';
import type { AccountSummary, AccountsState, TeamsAccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import { describeFiling, describeFilingAnswer } from '../../projects/projects';
import { clockTime } from '../../settings/account-sync';
import { SOURCE_NAMES, type TodoLink } from '../todos/todos';

/*
  The Teams Section's view of the app: everything it reads from the Item store or asks of the Teams
  Accounts goes through here, so components never build requests themselves. Filing goes through
  Projects (projects/), which records it as the User's. Muting and excluding a Chat are Commander
  settings (the Item store's chat settings), which the Dashboard and Ares read too.

  Two-way sync (#106): replying and reading a Chat (or marking it unread) are Item store edits of its
  synced fields, recorded as the User's and undoable; the Core queues each for Teams and sends it in
  the background. A reply goes under an id made here, so a retry never posts it twice. Only the User
  sends a reply: whatever Ares drafts (#110) goes in the reply box for the User to send, and the Item
  store refuses a reply from anyone else.
*/

/** One of a Chat's Links: from it to another Item, or a backlink from another Item to it. */
export type ChatLink = TodoLink;

export interface TeamsChats {
  /** Every Chat Commander holds (excluded ones are deleted, so not among them). */
  list(): Promise<Item[]>;
  /** The Chats the User muted or excluded, every Account's. */
  settings(): Promise<ChatSetting[]>;
  /** Mutes, unmutes, excludes (deleting its Item) or includes a Chat again. */
  change(action: ChatSettingAction): Promise<ChatSettingChange>;
  /** A Chat's Links in both directions: from it first, then backlinks. */
  links(itemId: string): Promise<ChatLink[]>;
  /** A Chat's activity log, newest first. */
  history(itemId: string): Promise<ActivityEntry[]>;
  /** Reverses what an activity entry changed (filing a Chat, say). A queued reply is cancelled. */
  undo(entryId: number): Promise<ActivityEntry>;
  /** Replies to a Chat with plain text: shows at once, and Teams gets it in the background. */
  reply(itemId: string, text: string): Promise<ActivityEntry>;
  /** Marks a Chat read to its latest message, or unread from the latest message someone else sent. */
  setRead(itemId: string, read: boolean): Promise<ActivityEntry>;
  /** The changes made here still on their way to Teams, or that couldn't sync. */
  outgoing(): Promise<OutgoingChange[]>;
  /** Sends a Chat's changes that couldn't sync again. */
  retry(itemId: string): Promise<void>;
}

// The Item store answers at most 1000 Items a query.
const MOST = 1000;

export function teamsChatsIn(itemStore: ItemStoreClient): TeamsChats {
  return {
    list() {
      return itemStore({ op: 'query', query: { kinds: ['chat'], limit: MOST } });
    },
    settings() {
      return itemStore({ op: 'chat-settings' });
    },
    change(action) {
      return itemStore({ op: 'change-chat-setting', action });
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
    reply(itemId, text) {
      const reply: ChatReply = { clientId: crypto.randomUUID(), text, createdAt: Date.now() };
      return itemStore({
        op: 'record',
        action: { type: 'edit-fields', itemId, fields: { [`${MESSAGE_FIELD}${reply.clientId}`]: reply } },
      });
    },
    setRead(itemId, read) {
      return itemStore({
        op: 'record',
        action: { type: 'edit-fields', itemId, fields: { [READ_FIELD]: read } },
      });
    },
    async outgoing() {
      const changes = await itemStore({ op: 'outgoing', query: {} });
      return changes.filter((change) => change.source === 'teams');
    },
    async retry(itemId) {
      await itemStore({ op: 'retry-outgoing', itemId });
    },
  };
}

/** The Teams Accounts, as Settings → Accounts has them: who signed in, and how each is syncing. */
export interface TeamsAccountsClient {
  list(): Promise<TeamsAccountSummary[]>;
  /** Checks the Account at once (the sync engine's refresh, a light sync). */
  syncNow(accountId: string): Promise<void>;
  /** Called with the Accounts whenever they or their syncing change. Returns the unsubscribe. */
  onChange(listener: (accounts: TeamsAccountSummary[]) => void): () => void;
}

type AccountsBridge = Pick<Window['commander'], 'accounts' | 'onAccountsChanged'>;

const teamsOnly = (state: AccountsState): TeamsAccountSummary[] =>
  state.accounts.filter((account): account is TeamsAccountSummary => account.source === 'teams');

export function teamsAccountsIn(bridge: AccountsBridge): TeamsAccountsClient {
  return {
    async list() {
      return teamsOnly((await bridge.accounts({ op: 'list' })).state);
    },
    async syncNow(accountId) {
      await bridge.accounts({ op: 'sync-now', accountId });
    },
    onChange(listener) {
      return bridge.onAccountsChanged((state) => listener(teamsOnly(state)));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Wording

const EXCLUDED_WHY = 'Excluded the Chat from Commander';

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

// What an entry did, as [past tense, noun]: ["Filed under TL", "Filing"].
function whatItDid(entry: ActivityEntry, projects: readonly Project[]): [string, string] {
  switch (entry.action) {
    case 'create':
      return ['Added', 'Add'];
    case 'delete':
      return entry.why === EXCLUDED_WHY ? ['Excluded from Commander', 'Exclusion'] : ['Deleted', 'Delete'];
    case 'tombstone':
      return ['Left or deleted', 'Delete'];
    case 'link':
      return ['Linked', 'Link'];
    case 'unlink':
      return ['Unlinked', 'Unlink'];
    default:
      return whatChanged(entry.changes, projects);
  }
}

// What a change made in Commander did to a Chat's synced fields: replied (the reply's field), or
// read it or marked it unread.
export function chatEdit(
  changes: readonly ItemChange[],
): { kind: 'reply'; field: string } | { kind: 'read'; read: boolean } | null {
  const detail = changes.find((change) => change.field === 'detail');
  if (detail?.field !== 'detail') return null;
  const before = syncedFieldsOf(detail.before);
  const after = syncedFieldsOf(detail.after);
  if (!before || !after) return null;
  const added = Object.keys(after).find(
    (field) => field.startsWith(MESSAGE_FIELD) && after[field] && !before[field],
  );
  if (added) return { kind: 'reply', field: added };
  if (before[READ_FIELD] !== after[READ_FIELD]) return { kind: 'read', read: after[READ_FIELD] === true };
  return null;
}

function whatChanged(changes: readonly ItemChange[], projects: readonly Project[]): [string, string] {
  const filing = changes.length === 1 && changes[0]?.field === 'filing' ? changes[0] : null;
  if (filing) return [describeFiling(filing, projects), 'Filing'];
  const edit = chatEdit(changes);
  if (edit?.kind === 'reply') return ['Replied', 'Reply'];
  if (edit?.kind === 'read')
    return edit.read ? ['Marked read', 'Mark as read'] : ['Marked unread', 'Mark as unread'];
  if (changes.length === 1 && changes[0]?.field === 'title') return ['Renamed', 'Rename'];
  return ['Changed', 'Change'];
}

// What a Teams sync changed: from the summary the log keeps of a Chat's messages, or its read time.
function fromTeams(entry: ActivityEntry): string | null {
  const messages = entry.summaries?.find((summary) => summary.field === 'messages');
  if (messages?.added)
    return `${messages.added} new ${messages.added === 1 ? 'message' : 'messages'} in Teams`;
  if (messages && (messages.changed || messages.removed)) return 'Messages changed in Teams';
  // The User's read time moved: read there (or a change from here confirmed), or marked unread.
  const detail = entry.changes.find((change) => change.field === 'detail');
  if (detail?.field === 'detail' && detail.before?.kind === 'chat' && detail.after?.kind === 'chat') {
    if (detail.before.lastReadAt !== detail.after.lastReadAt)
      return detail.after.unreadCount === 0 ? 'Read in Teams' : 'Marked unread in Teams';
  }
  return null;
}

// Where a reply stands: sent to Teams, on its way, couldn't sync, or cancelled.
function replyStanding(
  entry: ActivityEntry,
  field: string,
  history: readonly ActivityEntry[],
  outgoing: readonly OutgoingChange[],
): string {
  if (history.some((other) => other.action === 'undo' && other.undoes === entry.id)) return 'cancelled';
  const queued = outgoing.find((change) => change.itemId === entry.itemId && change.field === field);
  if (queued?.status === 'failed') return 'couldn’t sync';
  if (queued) return 'sending to Teams';
  return 'sent to Teams';
}

/**
 * One line of a Chat's history: "Added from Teams", "3 new messages in Teams", "Filed under TL by
 * you", "Replied by you · sent to Teams", "Filing undone by you". `history` is the rest of the
 * log, to name what an undo reversed; `outgoing`, the changes still on their way to Teams.
 */
export function describeChatEntry(
  entry: ActivityEntry,
  history: readonly ActivityEntry[],
  projects: readonly Project[] = [],
  outgoing: readonly OutgoingChange[] = [],
): string {
  const who = entry.by.kind === 'rule' && entry.why ? `by ${entry.why}` : byWhom(entry.by);
  if (entry.action === 'injection-warning') return entry.why ?? 'Instructions aimed at Ares, ignored';
  // The User's answer to Ares's filing (#108).
  if (entry.action === 'correction' || entry.action === 'confirmation')
    return describeFilingAnswer(entry, projects);
  if (entry.action === 'create' && entry.by.kind === 'source')
    return `Added from ${SOURCE_NAMES[entry.by.source]}`;
  if (entry.action === 'update' && entry.by.kind === 'source') {
    // A change in Teams that won over the User's says so: "Changed in Teams at 14:02".
    if (entry.why) return entry.why;
    const said = fromTeams(entry);
    if (said) return said;
  }
  if (entry.action !== 'undo') {
    const said = `${whatItDid(entry, projects)[0]} ${who}`;
    const edit = entry.action === 'update' ? chatEdit(entry.changes) : null;
    return edit?.kind === 'reply' ? `${said} · ${replyStanding(entry, edit.field, history, outgoing)}` : said;
  }
  const undone = history.find((other) => other.id === entry.undoes);
  if (!undone) return `Undone ${who}`;
  if (undone.action === 'undo') return `Redone ${who}`;
  if (chatEdit(undone.changes)?.kind === 'reply') return `Reply cancelled ${who}`;
  return `${whatItDid(undone, projects)[1]} undone ${who}`;
}

/**
 * The Section's thin status line: when Teams was last checked ("Checked 14:02"), that it is checking
 * now, or the Account's problem in its own words. With several Accounts each is named.
 */
export function checkLine(
  accounts: readonly AccountSummary[],
  now: Date,
): { text: string; problem: boolean } {
  if (!accounts.length) return { text: 'No Teams Account connected', problem: false };
  const each = accounts.map((account) => {
    const sync = account.sync;
    if (sync?.problem) return { text: sync.problem.message, problem: true, sep: ': ' };
    if (sync?.activity === 'syncing') return { text: 'Checking…', problem: false, sep: ' ' };
    if (sync?.lastSyncedAt)
      return { text: `Checked ${clockTime(sync.lastSyncedAt, now)}`, problem: false, sep: ' ' };
    return { text: 'Not checked yet', problem: false, sep: ': ' };
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
