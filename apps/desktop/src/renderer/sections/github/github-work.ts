import type { ActivityEntry, GitHubDiscussionResponse, Item } from '@commander/domain';
import type { AccountsState, GitHubAccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import type { TodoLink } from '../todos/todos';

/*
  The GitHub Section's view of the app: everything it reads from the Item store, asks of the Core
  (a discussion) or of the GitHub Accounts goes through here, so components never build requests
  themselves. Filing goes through Projects (projects/), which records it as the User's. GitHub is
  read-only in v1: nothing here writes to GitHub.
*/

/** One of a pull request's or issue's Links: from it to another Item, or a backlink to it. */
export type WorkLink = TodoLink;

export interface GitHubWork {
  /** Every pull request and issue Commander holds, open and closed, not deleted. */
  list(): Promise<Item[]>;
  /** The reviews asked of the User that are still waiting (review-request Items). */
  reviewRequests(): Promise<Item[]>;
  /** Its Links in both directions: from it first, then backlinks, each oldest first. */
  links(itemId: string): Promise<WorkLink[]>;
  /** Its activity log, newest first. */
  history(itemId: string): Promise<ActivityEntry[]>;
  /** Reverses what an activity entry changed (filing, say). */
  undo(entryId: number): Promise<ActivityEntry>;
  /** Removes a Link from it, as the User (undone with Ctrl+Z). */
  unlink(itemId: string, link: WorkLink): Promise<ActivityEntry>;
  /**
   * Its discussion (comments, reviews, review comments) and, for a pull request, its checks: kept by
   * the Core until the Item changes, else fetched from GitHub now.
   */
  discussion(itemId: string): Promise<GitHubDiscussionResponse>;
  /** The labels that make an issue skill-managed (#120, Settings → GitHub). */
  skillLabels(): Promise<string[]>;
}

// The Item store answers at most 1000 Items a query.
const MOST = 1000;

type DiscussionBridge = Pick<Window['commander'], 'githubDiscussion'>;

export function githubWorkIn(itemStore: ItemStoreClient, bridge: DiscussionBridge): GitHubWork {
  const query = (kind: 'pull-request' | 'github-issue', status: 'open' | 'done') =>
    itemStore({ op: 'query', query: { kinds: [kind], statuses: [status], limit: MOST } });
  return {
    async list() {
      const found = await Promise.all([
        query('pull-request', 'open'),
        query('github-issue', 'open'),
        query('pull-request', 'done'),
        query('github-issue', 'done'),
      ]);
      return found.flat();
    },

    reviewRequests() {
      return itemStore({ op: 'query', query: { kinds: ['review-request'], limit: MOST } });
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

    unlink(itemId, { type, other }) {
      return itemStore({
        op: 'record',
        action: { type: 'unlink', from: itemId, linkType: type, to: other.id },
      });
    },

    discussion(itemId) {
      return bridge.githubDiscussion({ itemId });
    },

    async skillLabels() {
      return (await itemStore({ op: 'github-oversight-settings' })).skillLabels;
    },
  };
}

/** The GitHub Accounts, as Settings → Accounts has them: who signed in, and how each is syncing. */
export interface GitHubAccountsClient {
  list(): Promise<GitHubAccountSummary[]>;
  /** Syncs the Account at once (the sync engine's refresh). */
  syncNow(accountId: string): Promise<void>;
  /** Called with the Accounts whenever they or their syncing change. Returns the unsubscribe. */
  onChange(listener: (accounts: GitHubAccountSummary[]) => void): () => void;
}

type AccountsBridge = Pick<Window['commander'], 'accounts' | 'onAccountsChanged'>;

const githubOnly = (state: AccountsState): GitHubAccountSummary[] =>
  state.accounts.filter((account): account is GitHubAccountSummary => account.source === 'github');

export function githubAccountsIn(bridge: AccountsBridge): GitHubAccountsClient {
  return {
    async list() {
      return githubOnly((await bridge.accounts({ op: 'list' })).state);
    },
    async syncNow(accountId) {
      await bridge.accounts({ op: 'sync-now', accountId });
    },
    onChange(listener) {
      return bridge.onAccountsChanged((state) => listener(githubOnly(state)));
    },
  };
}
