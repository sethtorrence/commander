import {
  type ActivityEntry,
  type ChannelChoices,
  type ChannelPostDetail,
  type ChannelReply,
  type ChannelSettingAction,
  type Item,
  REPLY_FIELD,
  SEEN_FIELD,
  unseenMessages,
} from '@commander/domain';
import type { AccountsResponse, AccountsState, TeamsAccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';

/*
  Channel posts (#111), as the window reaches them: everything Settings → Teams and the Teams Section
  read or ask about Channel posts goes through here, so components never build requests themselves.

  - Access: whether each Teams Account's sign-in carries ChannelMessage.Read.All, Request access (a
    Microsoft sign-in again, asking for the Channel post permissions too) and Sync Channel posts on or
    off, through Settings → Accounts' bridge.
  - Choosing channels: each Account's teams and channels as its last sync listed them, and excluding
    or including one again (the Item store's channel settings; excluding deletes its posts).
  - The posts: `channel-post` Items; replying (the post's synced field `reply:<clientId>`, under an id
    made here so a retry never posts it twice, queued for Teams by the Core like a Chat's reply); and
    Commander's own seen mark (`seen`, never sent to Teams, as Teams keeps no read state for channels).
*/

export type ChannelPost = Item & { detail: ChannelPostDetail };

export const isChannelPost = (item: Item): item is ChannelPost =>
  item.kind === 'channel-post' && item.detail?.kind === 'channel-post' && item.deletedAt === null;

/** Whether an Account syncs Channel posts: granted and switched on. */
export const syncsChannelPosts = (account: TeamsAccountSummary) =>
  !!account.channelPosts?.granted && account.channelPosts.enabled;

export interface ChannelPostsClient {
  /** The Teams Accounts, with where each stands on Channel posts. */
  accounts(): Promise<TeamsAccountSummary[]>;
  /** Called with the Teams Accounts whenever they change. Returns the unsubscribe. */
  onAccounts(listener: (accounts: TeamsAccountSummary[]) => void): () => void;
  /** Request access: signs in to the Account again asking for the Channel post permissions too. */
  requestAccess(accountId: string): Promise<AccountsResponse>;
  /** Sync Channel posts on or off (only once granted). */
  setEnabled(accountId: string, enabled: boolean): Promise<AccountsResponse>;
  /** Asks the Account for a light sync at once. */
  syncNow(accountId: string): Promise<void>;
  /** Each Account's teams and channels, each with whether it is excluded. */
  choices(): Promise<ChannelChoices[]>;
  /** Excludes a team or channel (deleting its posts) or includes it again. */
  change(action: ChannelSettingAction): Promise<ChannelChoices>;
  /** Every Channel post Commander holds. */
  list(): Promise<Item[]>;
  /** Replies to a post with plain text: shows at once, and Teams gets it in the background. */
  reply(itemId: string, text: string): Promise<ActivityEntry>;
  /** Marks a post seen up to `at` (Commander's own mark). */
  markSeen(itemId: string, at: number): Promise<ActivityEntry>;
  /** What kind of Item this is (a post, or a Chat), or null when Commander holds none. */
  kindOf(itemId: string): Promise<string | null>;
}

type Bridge = Pick<Window['commander'], 'accounts' | 'onAccountsChanged'>;

const teamsOnly = (state: AccountsState): TeamsAccountSummary[] =>
  state.accounts.filter((account): account is TeamsAccountSummary => account.source === 'teams');

// The Item store answers at most 1000 Items a query.
const MOST = 1000;

export function channelPostsIn(bridge: Bridge, itemStore: ItemStoreClient): ChannelPostsClient {
  return {
    async accounts() {
      return teamsOnly((await bridge.accounts({ op: 'list' })).state);
    },
    onAccounts(listener) {
      return bridge.onAccountsChanged((state) => listener(teamsOnly(state)));
    },
    requestAccess(accountId) {
      return bridge.accounts({ op: 'request-channel-access', accountId });
    },
    setEnabled(accountId, enabled) {
      return bridge.accounts({ op: 'set-channel-posts', accountId, enabled });
    },
    async syncNow(accountId) {
      await bridge.accounts({ op: 'sync-now', accountId });
    },
    choices() {
      return itemStore({ op: 'channel-choices' });
    },
    change(action) {
      return itemStore({ op: 'change-channel-setting', action });
    },
    list() {
      return itemStore({ op: 'query', query: { kinds: ['channel-post'], limit: MOST } });
    },
    reply(itemId, text) {
      const reply: ChannelReply = { clientId: crypto.randomUUID(), text, createdAt: Date.now() };
      return itemStore({
        op: 'record',
        action: { type: 'edit-fields', itemId, fields: { [`${REPLY_FIELD}${reply.clientId}`]: reply } },
      });
    },
    markSeen(itemId, at) {
      return itemStore({
        op: 'record',
        action: { type: 'edit-fields', itemId, fields: { [SEEN_FIELD]: at } },
      });
    },
    async kindOf(itemId) {
      return (await itemStore({ op: 'get', itemId }))?.item.kind ?? null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The Channels group: by team, then channel, posts by latest activity

export type ChannelGroup = { key: string; team: string; channel: string; posts: ChannelPost[] };

/**
 * The posts of the Accounts that sync Channel posts, grouped by team then channel (teams and
 * channels by name), each channel's posts newest activity first. `include`: the Project filter.
 */
export function channelGroups(
  items: readonly Item[],
  accounts: readonly TeamsAccountSummary[],
  include: (item: Item) => boolean = () => true,
): ChannelGroup[] {
  const on = new Set(accounts.filter(syncsChannelPosts).map((account) => account.id));
  const groups = new Map<string, ChannelGroup>();
  for (const item of items) {
    if (!isChannelPost(item) || !item.account || !on.has(item.account) || !include(item)) continue;
    const { team, channel } = item.detail;
    const key = `${item.account}\n${team.id}\n${channel.id}`;
    const group = groups.get(key) ?? { key, team: team.name, channel: channel.name, posts: [] };
    group.posts.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values())
    group.posts.sort((a, b) => b.detail.lastActivityAt - a.detail.lastActivityAt || (a.id < b.id ? -1 : 1));
  return [...groups.values()].sort(
    (a, b) =>
      a.team.localeCompare(b.team) || a.channel.localeCompare(b.channel) || a.key.localeCompare(b.key),
  );
}

/** How many messages from others in a post the User hasn't seen (Commander's own mark). */
export const unseenCount = (post: ChannelPost, me: string | null) => unseenMessages(post.detail, me).length;
