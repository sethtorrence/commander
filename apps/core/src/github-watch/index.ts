// Settings → GitHub in the Core (#113): what each GitHub Account can reach and what it watches.
// Requests come from the window through the main process, which adds where GitHub's API lives. The
// Account's token is borrowed per request and never kept. The selection is kept through the Item
// store; GitHub sync (#114) reads it with `selection`.
import {
  type CoreAccountRefused,
  type CoreGitHubWatchReply,
  type CoreMessage,
  coreGitHubTestItems,
  coreGitHubWatchRequest,
  defaultWatch,
  type GitHubAccess,
  type GitHubRepoRef,
  type GitHubWatch,
  type GitHubWatchResponse,
  type GitHubWatchView,
  githubExternalId,
  type githubWatchRequest,
  knownRepos,
  noWatch,
  stoppedWatching,
} from '@commander/domain';
import {
  type GitHubApiOptions,
  readGitHubAccess,
  readGitHubOrg,
  readWorkedRepos,
  SignInRefused,
} from '@commander/sources';
import { z } from 'zod';
import { type AccessTokens, AccessTokenUnavailable } from '../access-tokens';
import type { ItemStore } from '../item-store';

// How the Core asks GitHub (stood in for in tests).
export type GitHubReader = {
  readAccess(options: GitHubApiOptions & { addedOrgs?: readonly string[] }): Promise<GitHubAccess>;
  readWorkedRepos(options: GitHubApiOptions): Promise<string[]>;
  readOrg(options: GitHubApiOptions, login: string): Promise<{ login: string; id: number } | null>;
};

const fromGitHub: GitHubReader = {
  readAccess: readGitHubAccess,
  readWorkedRepos,
  readOrg: readGitHubOrg,
};

export type GitHubWatchOptions = {
  send: (message: CoreGitHubWatchReply | CoreAccountRefused | CoreMessage) => void;
  accessTokens: Pick<AccessTokens, 'request'>;
  github?: GitHubReader;
  log?: (message: string) => void;
  // End-to-end tests (--test-hooks) may save GitHub Items as sync will (github-test-items).
  testHooks?: boolean;
};

type Request = z.output<typeof githubWatchRequest>;

const envelope = z.object({ type: z.literal('github-watch-request'), id: z.number().int().positive() });

const RECONNECT =
  'GitHub refused this Account’s sign-in. Reconnect it in Settings → Accounts to see what it can reach.';

// A failure, as the User reads it.
class Refusal extends Error {}

// "acme/api", "acme/api and acme/web", "acme/api, acme/web and 3 more".
function named(repos: GitHubRepoRef[]): string {
  const names = repos.map((repo) => `${repo.owner}/${repo.name}`);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

export function setUpGitHubWatch(
  store: ItemStore,
  {
    send,
    accessTokens,
    github = fromGitHub,
    log = (message) => console.warn(message),
    testHooks = false,
  }: GitHubWatchOptions,
) {
  const view = (account: string, problem: string | null = null): GitHubWatchView => {
    const record = store.githubWatch.read(account);
    return {
      account,
      access: record.access,
      watch: record.watch ?? noWatch(),
      fromDefault: record.fromDefault,
      problem,
    };
  };

  // The Account's token, for one request to GitHub. Throws a Refusal the User can read.
  async function borrow(account: string, apiUrl: string): Promise<GitHubApiOptions> {
    try {
      return { apiUrl, token: await accessTokens.request(account) };
    } catch (error) {
      if (error instanceof AccessTokenUnavailable && error.reason === 'needs-reconnect')
        throw new Refusal(RECONNECT);
      throw new Refusal(error instanceof Error ? error.message : String(error));
    }
  }

  // What went wrong asking GitHub, for the User. A refused sign-in also goes to the main process,
  // which may mark the Account Reconnect.
  function problemOf(account: string, error: unknown): string {
    if (error instanceof SignInRefused) {
      send({ type: 'account-refused', account });
      return RECONNECT;
    }
    if (error instanceof Refusal) return error.message;
    log(`Couldn't ask GitHub about ${account}: ${String(error)}`);
    return error instanceof Error ? error.message : String(error);
  }

  async function load(account: string, apiUrl: string): Promise<GitHubWatchView> {
    const record = store.githubWatch.read(account);
    let options: GitHubApiOptions;
    let access: GitHubAccess;
    try {
      options = await borrow(account, apiUrl);
      access = await github.readAccess({ ...options, addedOrgs: record.addedOrgs });
    } catch (error) {
      return view(account, problemOf(account, error));
    }
    store.githubWatch.saveAccess(account, access);
    if (record.watch) return view(account);
    try {
      store.githubWatch.startWith(account, defaultWatch(access, await github.readWorkedRepos(options)));
      return view(account);
    } catch (error) {
      const why = problemOf(account, error);
      return view(
        account,
        `Commander couldn’t work out which repos you worked in lately, so nothing is checked yet. ${why}`,
      );
    }
  }

  async function save(account: string, watch: GitHubWatch, confirmed: boolean): Promise<GitHubWatchResponse> {
    const record = store.githubWatch.read(account);
    const stop = stoppedWatching(record.watch ?? noWatch(), watch, knownRepos(record.access, record.seen));
    const holding = stop.filter((repo) => store.githubWatch.countItems(account, [repo.nodeId]) > 0);
    if (holding.length && !confirmed) {
      const items = store.githubWatch.countItems(
        account,
        holding.map((repo) => repo.nodeId),
      );
      return { ok: true, view: view(account), confirm: { items, repos: holding } };
    }
    const removed = store.githubWatch.save(account, watch, {
      stop: holding,
      why: `Stopped watching ${named(holding)}`,
    });
    if (removed.length) send({ type: 'items-changed', itemIds: removed });
    return { ok: true, view: view(account) };
  }

  async function addOrg(account: string, login: string, apiUrl: string): Promise<GitHubWatchResponse> {
    let found: { login: string; id: number } | null;
    try {
      found = await github.readOrg(await borrow(account, apiUrl), login);
    } catch (error) {
      return { ok: false, error: problemOf(account, error), view: view(account) };
    }
    if (!found) return { ok: false, error: `GitHub has no org called ${login}.`, view: view(account) };
    store.githubWatch.addOrg(account, found.login);
    return { ok: true, view: await load(account, apiUrl) };
  }

  async function answer(request: Request, apiUrl: string): Promise<GitHubWatchResponse> {
    if (!request.account.startsWith('github:'))
      return { ok: false, error: `${request.account} isn’t a GitHub Account.`, view: null };
    switch (request.op) {
      case 'load':
        return { ok: true, view: await load(request.account, apiUrl) };
      case 'save':
        return save(request.account, request.watch, request.confirmed);
      case 'add-org':
        return addOrg(request.account, request.login, apiUrl);
    }
  }

  // The end-to-end tests' stand-in for GitHub sync: pull requests, keyed as sync keys them.
  function saveTestItems(raw: unknown): boolean {
    const parsed = coreGitHubTestItems.safeParse(raw);
    if (!parsed.success) return false;
    const { account, items } = parsed.data;
    const saved = store.saveFromSource({
      source: 'github',
      account,
      items: items.map(({ repoNodeId, number, title }) => ({
        externalId: githubExternalId(repoNodeId, `pull/${number}`),
        kind: 'pull-request',
        title,
      })),
    });
    if (saved.created.length) send({ type: 'items-changed', itemIds: saved.created });
    return true;
  }

  return {
    // A message from the main process. Returns true when it was a Settings → GitHub request; the
    // answer follows when GitHub has.
    handle(raw: unknown): boolean {
      if (testHooks && saveTestItems(raw)) return true;
      const header = envelope.safeParse(raw);
      if (!header.success) return false;
      const { id } = header.data;
      const reply = (response: GitHubWatchResponse) => send({ type: 'github-watch-reply', id, response });
      const parsed = coreGitHubWatchRequest.safeParse(raw);
      if (!parsed.success) {
        reply({
          ok: false,
          error: `Malformed Settings → GitHub request: ${parsed.error.message}`,
          view: null,
        });
        return true;
      }
      answer(parsed.data.request, parsed.data.apiUrl).then(reply, (error: unknown) => {
        log(`Settings → GitHub request failed: ${String(error)}`);
        reply({ ok: false, error: error instanceof Error ? error.message : String(error), view: null });
      });
      return true;
    },

    // What an Account watches, for GitHub sync; null before its first selection.
    selection: (account: string): GitHubWatch | null => store.githubWatch.read(account).watch,
  };
}
