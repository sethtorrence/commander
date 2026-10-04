import type {
  ActivityEntry,
  Actor,
  ChatSetting,
  ChatSettingAction,
  ChatSettingChange,
  Item,
  ItemChange,
  Project,
} from '@commander/domain';
import type { AccountSummary, AccountsState, TeamsAccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import { describeFiling } from '../../projects/projects';
import { clockTime } from '../../settings/account-sync';
import { SOURCE_NAMES, type TodoLink } from '../todos/todos';

/*
  The Teams Section's view of the app: everything it reads from the Item store or asks of the Teams
  Accounts goes through here, so components never build requests themselves. Filing goes through
  Projects (projects/), which records it as the User's. Muting and excluding a Chat are Commander
  settings (the Item store's chat settings), which the Dashboard and Ares read too. Replying (#106)
  will add its request here.
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
  /** Reverses what an activity entry changed (filing a Chat, say). */
  undo(entryId: number): Promise<ActivityEntry>;
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

function whatChanged(changes: readonly ItemChange[], projects: readonly Project[]): [string, string] {
  const filing = changes.length === 1 && changes[0]?.field === 'filing' ? changes[0] : null;
  if (filing) return [describeFiling(filing, projects), 'Filing'];
  if (changes.length === 1 && changes[0]?.field === 'title') return ['Renamed', 'Rename'];
  return ['Changed', 'Change'];
}

// What a Teams sync changed, from the summary the log keeps of a Chat's messages.
function fromTeams(entry: ActivityEntry): string | null {
  const messages = entry.summaries?.find((summary) => summary.field === 'messages');
  if (messages?.added)
    return `${messages.added} new ${messages.added === 1 ? 'message' : 'messages'} in Teams`;
  if (messages && (messages.changed || messages.removed)) return 'Messages changed in Teams';
  return null;
}

/**
 * One line of a Chat's history: "Added from Teams", "3 new messages in Teams", "Filed under TL by
 * you", "Filing undone by you". `history` is the rest of the log, to name what an undo reversed.
 */
export function describeChatEntry(
  entry: ActivityEntry,
  history: readonly ActivityEntry[],
  projects: readonly Project[] = [],
): string {
  const who = entry.by.kind === 'rule' && entry.why ? `by ${entry.why}` : byWhom(entry.by);
  if (entry.action === 'injection-warning') return entry.why ?? 'Instructions aimed at Ares, ignored';
  if (entry.action === 'create' && entry.by.kind === 'source')
    return `Added from ${SOURCE_NAMES[entry.by.source]}`;
  if (entry.action === 'update' && entry.by.kind === 'source') {
    const said = fromTeams(entry);
    if (said) return said;
  }
  if (entry.action !== 'undo') return `${whatItDid(entry, projects)[0]} ${who}`;
  const undone = history.find((other) => other.id === entry.undoes);
  if (!undone) return `Undone ${who}`;
  if (undone.action === 'undo') return `Redone ${who}`;
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
