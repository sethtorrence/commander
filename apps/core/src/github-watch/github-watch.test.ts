import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GitHubAccess,
  type GitHubRepo,
  type GitHubWatchResponse,
  githubExternalId,
  noWatch,
  setOrgWatched,
  setRepoWatched,
} from '@commander/domain';
import { SignInRefused, SourceUnavailable } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessTokenUnavailable } from '../access-tokens';
import { type ItemStore, openItemStore } from '../item-store';
import { type GitHubReader, setUpGitHubWatch } from '.';

// Settings → GitHub in the Core: it borrows the Account's token, asks GitHub what the Account can
// reach (and, the first time, which repos the User worked in), and keeps the selection through the
// Item store. GitHub itself is stood in for here; packages/sources tests the requests.

const ACCOUNT = 'github:583231';
const API = 'https://api.github.test';

const repo = (owner: string, name: string): GitHubRepo => ({
  nodeId: `R_${owner}_${name}`,
  owner,
  name,
  visibility: 'private',
  pushedAt: Date.UTC(2026, 9, 1),
});
const api = repo('acme', 'api');
const web = repo('acme', 'web');
const dotfiles = repo('octocat', 'dotfiles');
const ref = ({ nodeId, owner, name }: GitHubRepo) => ({ nodeId, owner, name });

const acme = { login: 'acme', id: 501, reach: 'installed' as const, addedByName: false, problem: null };

const listing = (changes: Partial<GitHubAccess> = {}): GitHubAccess => ({
  via: 'app',
  login: 'octocat',
  orgs: [{ ...acme, repos: [api, web] }],
  personal: [dotfiles],
  fetchedAt: Date.UTC(2026, 9, 3),
  ...changes,
});

let dir: string;
let store: ItemStore;
let sent: unknown[];
let github: { [K in keyof GitHubReader]: ReturnType<typeof vi.fn<GitHubReader[K]>> };
let token: ReturnType<typeof vi.fn>;

const watch = () =>
  setUpGitHubWatch(store, {
    send: (message) => sent.push(message),
    accessTokens: { request: token as never },
    github,
    log: () => {},
  });

async function ask(request: unknown): Promise<GitHubWatchResponse> {
  const handled = watch().handle({ type: 'github-watch-request', id: 4, apiUrl: API, request });
  expect(handled).toBe(true);
  await vi.waitFor(() =>
    expect(sent.some((m) => (m as { type: string }).type === 'github-watch-reply')).toBe(true),
  );
  const reply = sent.find((m) => (m as { type: string }).type === 'github-watch-reply') as {
    id: number;
    response: GitHubWatchResponse;
  };
  expect(reply.id).toBe(4);
  sent = sent.filter((m) => m !== reply);
  return reply.response;
}

const okView = (response: GitHubWatchResponse) => {
  if (!response.ok) throw new Error(response.error);
  return response.view;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-core-github-watch-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  sent = [];
  token = vi.fn(async () => ({ token: 'ghu_borrowed', kind: 'oauth' }));
  github = {
    readAccess: vi.fn(async () => listing()),
    readWorkedRepos: vi.fn(async () => [api.nodeId, dotfiles.nodeId]),
    readOrg: vi.fn(async (_options, login: string) =>
      login === 'globex' ? { login: 'Globex', id: 503 } : null,
    ),
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('loading Settings → GitHub', () => {
  it('lists what the Account reaches with its borrowed token, and starts with the repos worked in', async () => {
    const view = okView(await ask({ op: 'load', account: ACCOUNT }));

    expect(token).toHaveBeenCalledWith(ACCOUNT);
    expect(github.readAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: API,
        token: { token: 'ghu_borrowed', kind: 'oauth' },
        addedOrgs: [],
      }),
    );
    expect(view).toEqual({
      account: ACCOUNT,
      access: listing(),
      watch: { orgs: [], repos: [ref(api), ref(dotfiles)] },
      fromDefault: true,
      problem: null,
    });
    expect(store.githubWatch.read(ACCOUNT).watch).toEqual(view.watch);
  });

  it('works out the default only the first time', async () => {
    await ask({ op: 'load', account: ACCOUNT });
    await ask({ op: 'save', account: ACCOUNT, watch: noWatch() });
    const view = okView(await ask({ op: 'load', account: ACCOUNT }));

    expect(github.readWorkedRepos).toHaveBeenCalledTimes(1);
    expect(view.watch).toEqual(noWatch());
    expect(view.fromDefault).toBe(false);
  });

  it('shows the last listing, saying why, when GitHub can’t be asked', async () => {
    await ask({ op: 'load', account: ACCOUNT });
    github.readAccess.mockRejectedValueOnce(new SourceUnavailable('Commander couldn’t reach GitHub.'));

    const view = okView(await ask({ op: 'load', account: ACCOUNT }));

    expect(view.access).toEqual(listing());
    expect(view.problem).toBe('Commander couldn’t reach GitHub.');
  });

  it('asks to reconnect an Account whose sign-in GitHub refused, and tells the main process', async () => {
    github.readAccess.mockRejectedValueOnce(new SignInRefused('GitHub refused the sign-in: Bad credentials'));

    const view = okView(await ask({ op: 'load', account: ACCOUNT }));

    expect(view.problem).toMatch(/Reconnect/);
    expect(sent).toContainEqual({ type: 'account-refused', account: ACCOUNT });
  });

  it('says so when the Account needs reconnecting before anything can be asked', async () => {
    token.mockRejectedValueOnce(new AccessTokenUnavailable('needs-reconnect', 'needs reconnecting'));

    const view = okView(await ask({ op: 'load', account: ACCOUNT }));

    expect(github.readAccess).not.toHaveBeenCalled();
    expect(view).toMatchObject({
      access: null,
      watch: noWatch(),
      problem: expect.stringMatching(/Reconnect/),
    });
  });

  it('leaves the selection empty, to try again next time, when GitHub won’t say what the User worked in', async () => {
    github.readWorkedRepos.mockRejectedValueOnce(
      new SourceUnavailable('GitHub couldn’t answer just now (HTTP 502).'),
    );

    const view = okView(await ask({ op: 'load', account: ACCOUNT }));
    expect(view.watch).toEqual(noWatch());
    expect(view.problem).toMatch(/worked in/);
    expect(store.githubWatch.read(ACCOUNT).watch).toBeNull();

    expect(okView(await ask({ op: 'load', account: ACCOUNT })).fromDefault).toBe(true);
  });

  it('keeps watched repos the Account can no longer reach', async () => {
    await ask({ op: 'load', account: ACCOUNT });
    await ask({ op: 'save', account: ACCOUNT, watch: setOrgWatched(noWatch(), 'acme', true) });
    // The app was uninstalled from acme.
    github.readAccess.mockResolvedValueOnce(listing({ orgs: [] }));

    const view = okView(await ask({ op: 'load', account: ACCOUNT }));

    expect(view.watch.orgs).toEqual([{ login: 'acme', except: [] }]);
    expect(view.access?.orgs).toEqual([]);
  });

  it('only answers for GitHub Accounts', async () => {
    const response = await ask({ op: 'load', account: 'linear:org-acme' });
    expect(response).toMatchObject({ ok: false });
    expect(token).not.toHaveBeenCalled();
  });
});

describe('saving the selection', () => {
  const savePullRequests = () =>
    store.saveFromSource({
      source: 'github',
      account: ACCOUNT,
      items: [
        { externalId: githubExternalId(api.nodeId, 'pr/1'), kind: 'pull-request', title: 'Retry webhooks' },
        { externalId: githubExternalId(api.nodeId, 'pr/2'), kind: 'pull-request', title: 'Bump node' },
        { externalId: githubExternalId(web.nodeId, 'pr/7'), kind: 'pull-request', title: 'New header' },
      ],
    });

  it('saves at once when nothing held would be removed', async () => {
    await ask({ op: 'load', account: ACCOUNT });
    const next = setRepoWatched(setOrgWatched(noWatch(), 'acme', true), web, false);

    const response = await ask({ op: 'save', account: ACCOUNT, watch: next });

    expect(response).toEqual({
      ok: true,
      view: expect.objectContaining({ watch: next, fromDefault: false }),
    });
    expect(store.githubWatch.read(ACCOUNT).watch).toEqual(next);
  });

  it('asks first when unwatching would remove Items, naming how many, then removes them', async () => {
    await ask({ op: 'load', account: ACCOUNT });
    savePullRequests();
    const before = store.githubWatch.read(ACCOUNT).watch ?? noWatch();
    const next = setRepoWatched(before, api, false);

    const asked = await ask({ op: 'save', account: ACCOUNT, watch: next });
    expect(asked).toMatchObject({ ok: true, confirm: { items: 2, repos: [ref(api)] } });
    // Nothing changed yet.
    expect(store.githubWatch.read(ACCOUNT).watch).toEqual(before);
    expect(store.query({ source: 'github' })).toHaveLength(3);

    const done = await ask({ op: 'save', account: ACCOUNT, watch: next, confirmed: true });
    expect(done).toMatchObject({ ok: true, view: { watch: next } });
    expect(store.query({ source: 'github' }).map((item) => item.title)).toEqual(['New header']);
    expect(store.activity({ limit: 1 })[0]).toMatchObject({
      by: { kind: 'user' },
      why: 'Stopped watching acme/api',
    });
    // Open views catch up.
    expect(sent).toContainEqual({
      type: 'items-changed',
      itemIds: expect.arrayContaining([expect.any(String)]),
    });
  });

  it('removes the Items of every repo in an org unwatched whole, those no longer listed too', async () => {
    await ask({ op: 'load', account: ACCOUNT });
    await ask({ op: 'save', account: ACCOUNT, watch: setOrgWatched(noWatch(), 'acme', true) });
    savePullRequests();
    // acme/web has gone from the listing since (archived, say).
    github.readAccess.mockResolvedValueOnce(listing({ orgs: [{ ...acme, repos: [api] }] }));
    await ask({ op: 'load', account: ACCOUNT });

    const asked = await ask({ op: 'save', account: ACCOUNT, watch: noWatch() });
    expect(asked).toMatchObject({ confirm: { items: 3 } });
    await ask({ op: 'save', account: ACCOUNT, watch: noWatch(), confirmed: true });
    expect(store.query({ source: 'github' })).toEqual([]);
  });

  it('refuses a malformed selection', async () => {
    const response = await ask({ op: 'save', account: ACCOUNT, watch: { orgs: 'all' } });
    expect(response).toMatchObject({ ok: false });
  });
});

describe('adding an org by name', () => {
  it('looks the org up, remembers it and lists it from then on', async () => {
    github.readAccess.mockImplementation(async ({ addedOrgs }) =>
      listing({
        orgs: [
          ...listing().orgs,
          ...(addedOrgs ?? []).map((login) => ({
            login,
            id: 503,
            reach: 'not-installed' as const,
            repos: [],
            addedByName: true,
            problem: null,
          })),
        ],
      }),
    );

    const view = okView(await ask({ op: 'add-org', account: ACCOUNT, login: 'globex' }));

    expect(store.githubWatch.read(ACCOUNT).addedOrgs).toEqual(['Globex']);
    expect(view.access?.orgs.map((org) => org.login)).toEqual(['acme', 'Globex']);
  });

  it('says when GitHub has no such org', async () => {
    const response = await ask({ op: 'add-org', account: ACCOUNT, login: 'no-such-org' });
    expect(response).toMatchObject({ ok: false, error: 'GitHub has no org called no-such-org.' });
    expect(store.githubWatch.read(ACCOUNT).addedOrgs).toEqual([]);
  });
});

describe('the messages it answers', () => {
  it('ignores other messages', () => {
    expect(watch().handle({ type: 'item-store-request', id: 1 })).toBe(false);
  });

  it('answers a malformed request with the reason', async () => {
    const response = await ask({ op: 'load' });
    expect(response).toMatchObject({ ok: false, view: null });
  });
});

describe('the end-to-end tests’ hook', () => {
  const seed = {
    type: 'github-test-items',
    account: ACCOUNT,
    items: [{ repoNodeId: api.nodeId, number: 42, title: 'Retry webhooks' }],
  };

  it('saves pull requests as GitHub sync will, only with test hooks on', () => {
    expect(watch().handle(seed)).toBe(false);
    expect(store.query({ source: 'github' })).toEqual([]);

    const hooked = setUpGitHubWatch(store, {
      send: (message) => sent.push(message),
      accessTokens: { request: token as never },
      github,
      testHooks: true,
    });
    expect(hooked.handle(seed)).toBe(true);
    expect(store.query({ source: 'github' })).toMatchObject([
      {
        kind: 'pull-request',
        account: ACCOUNT,
        externalId: `${api.nodeId}:pull/42`,
        title: 'Retry webhooks',
      },
    ]);
    expect(store.githubWatch.countItems(ACCOUNT, [api.nodeId])).toBe(1);
  });
});

describe('for GitHub sync', () => {
  it('reads each Account’s selection', async () => {
    await ask({ op: 'load', account: ACCOUNT });
    expect(watch().selection(ACCOUNT)).toEqual({ orgs: [], repos: [ref(api), ref(dotfiles)] });
    expect(watch().selection('github:2')).toBeNull();
  });
});
