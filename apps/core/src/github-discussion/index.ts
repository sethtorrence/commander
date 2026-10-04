// The GitHub Section's discussions in the Core (#115): opening a pull request or issue asks for its
// comments, reviews and (for a pull request) checks, which GitHub sync never fetches. Requests come
// from the window through the main process, which adds where GitHub's API lives. The answer is kept
// beside the Item's detail through the Item store, for the detail's `updatedAt` it was fetched for:
// asking again while the Item is unchanged costs GitHub nothing, and once a sync brings a change the
// next ask fetches again. The Account's token is borrowed per request and never kept.
import {
  type CoreAccountRefused,
  type CoreGitHubDiscussionReply,
  coreGitHubDiscussionRequest,
  type GitHubDiscussion,
  type GitHubDiscussionResponse,
} from '@commander/domain';
import { readGitHubDiscussion, SignInRefused } from '@commander/sources';
import { z } from 'zod';
import { type AccessTokens, AccessTokenUnavailable } from '../access-tokens';
import type { ItemStore } from '../item-store';

export type GitHubDiscussionOptions = {
  send: (message: CoreGitHubDiscussionReply | CoreAccountRefused) => void;
  accessTokens: Pick<AccessTokens, 'request'>;
  // How the Core asks GitHub (stood in for in tests).
  read?: typeof readGitHubDiscussion;
  now?: () => number;
  log?: (message: string) => void;
};

const envelope = z.object({ type: z.literal('github-discussion-request'), id: z.number().int().positive() });

const RECONNECT = 'GitHub refused this Account’s sign-in. Reconnect it in Settings → Accounts.';

// A failure, as the User reads it.
class Refusal extends Error {}

export function setUpGitHubDiscussion(
  store: ItemStore,
  {
    send,
    accessTokens,
    read = readGitHubDiscussion,
    now = Date.now,
    log = (message) => console.warn(message),
  }: GitHubDiscussionOptions,
) {
  // Fetches under way, by Item and version, so asking twice at once asks GitHub once.
  const fetching = new Map<string, Promise<GitHubDiscussion>>();

  async function fetchFor(
    account: string,
    apiUrl: string,
    itemId: string,
    target: { kind: 'pull-request' | 'github-issue'; nodeId: string },
    updatedAt: number,
  ): Promise<GitHubDiscussion> {
    let token: Awaited<ReturnType<AccessTokens['request']>>;
    try {
      token = await accessTokens.request(account);
    } catch (error) {
      if (error instanceof AccessTokenUnavailable && error.reason === 'needs-reconnect')
        throw new Refusal(RECONNECT);
      throw new Refusal(error instanceof Error ? error.message : String(error));
    }
    try {
      const found = await read({ apiUrl, token }, target);
      const discussion: GitHubDiscussion = { ...found, forUpdatedAt: updatedAt, fetchedAt: now() };
      store.githubDiscussions.save(itemId, discussion);
      return discussion;
    } catch (error) {
      if (error instanceof SignInRefused) {
        send({ type: 'account-refused', account });
        throw new Refusal(RECONNECT);
      }
      throw error;
    }
  }

  async function answer(itemId: string, apiUrl: string): Promise<GitHubDiscussionResponse> {
    const item = store.get(itemId)?.item;
    const detail = item?.detail;
    if (
      !item ||
      item.deletedAt !== null ||
      !item.account ||
      (detail?.kind !== 'pull-request' && detail?.kind !== 'github-issue')
    )
      return { ok: false, error: 'Commander has no such pull request or issue.' };
    const kept = store.githubDiscussions.read(itemId);
    if (kept && kept.forUpdatedAt === detail.updatedAt) return { ok: true, discussion: kept };
    const key = `${itemId}@${detail.updatedAt}`;
    let under = fetching.get(key);
    if (!under) {
      under = fetchFor(
        item.account,
        apiUrl,
        itemId,
        { kind: detail.kind, nodeId: detail.nodeId },
        detail.updatedAt,
      ).finally(() => fetching.delete(key));
      fetching.set(key, under);
    }
    try {
      return { ok: true, discussion: await under };
    } catch (error) {
      if (!(error instanceof Refusal)) log(`Couldn't fetch a GitHub discussion: ${String(error)}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    // A message from the main process. Returns true when it was a discussion request; the answer
    // follows when GitHub has.
    handle(raw: unknown): boolean {
      const header = envelope.safeParse(raw);
      if (!header.success) return false;
      const { id } = header.data;
      const reply = (response: GitHubDiscussionResponse) =>
        send({ type: 'github-discussion-reply', id, response });
      const parsed = coreGitHubDiscussionRequest.safeParse(raw);
      if (!parsed.success) {
        reply({ ok: false, error: `Malformed discussion request: ${parsed.error.message}` });
        return true;
      }
      void answer(parsed.data.request.itemId, parsed.data.apiUrl).then(reply);
      return true;
    },
  };
}
