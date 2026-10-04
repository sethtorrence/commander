// @vitest-environment jsdom
import {
  defaultOversightSettings,
  type GitHubAccess,
  type GitHubRepo,
  type GitHubWatch,
  type GitHubWatchRequest,
  type GitHubWatchResponse,
  type GitHubWatchView,
  isWatched,
  setOrgWatched,
  setRepoWatched,
} from '@commander/domain';
import type { AccountsState, GitHubAccountSummary } from '@commander/domain/ipc';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubWatchPanel } from './GitHubWatchPanel';

// Settings → GitHub over a stand-in for the main process (and the Core behind it).

const NOW = Date.UTC(2026, 9, 3, 12);
const DAY = 86_400_000;

const octocat: GitHubAccountSummary = {
  id: 'github:583231',
  source: 'github',
  name: 'octocat',
  login: 'octocat',
  signedInWith: 'github-app',
  installations: ['octocat', 'acme'],
  installUrl: 'https://github.test/apps/commander/installations/new',
  method: 'oauth',
  status: 'connected',
  user: { id: '583231', name: 'The Octocat' },
  sync: null,
};

const repo = (owner: string, name: string, changes: Partial<GitHubRepo> = {}): GitHubRepo => ({
  nodeId: `R_${owner}_${name}`,
  owner,
  name,
  visibility: 'private',
  pushedAt: NOW - 2 * DAY,
  ...changes,
});
const api = repo('acme', 'api');
const web = repo('acme', 'web', { pushedAt: NOW - 40 * DAY });
const handbook = repo('acme', 'handbook', { visibility: 'internal', pushedAt: null });
const dotfiles = repo('octocat', 'dotfiles', { visibility: 'public' });
const ref = ({ nodeId, owner, name }: GitHubRepo) => ({ nodeId, owner, name });

const acme: GitHubAccess['orgs'][number] = {
  login: 'acme',
  id: 501,
  reach: 'installed',
  repos: [api, web, handbook],
  addedByName: false,
  problem: null,
};

const listing: GitHubAccess = {
  via: 'app',
  login: 'octocat',
  orgs: [
    acme,
    { login: 'initech', id: 502, reach: 'not-installed', repos: [], addedByName: false, problem: null },
  ],
  personal: [dotfiles],
  fetchedAt: NOW,
};

let accounts: AccountsState;
let requests: GitHubWatchRequest[];
let saved: GitHubWatchView;
let answer: (request: GitHubWatchRequest) => GitHubWatchResponse;

const viewWith = (watch: GitHubWatch, changes: Partial<GitHubWatchView> = {}): GitHubWatchView => ({
  account: octocat.id,
  access: listing,
  watch,
  fromDefault: false,
  problem: null,
  ...changes,
});

beforeEach(() => {
  accounts = { accounts: [octocat], sources: [] };
  requests = [];
  saved = viewWith({ orgs: [], repos: [ref(api), ref(dotfiles)] }, { fromDefault: true });
  // By default the stand-in saves whatever comes, as the Core does when nothing held goes.
  answer = (request) => {
    if (request.op === 'save') saved = { ...saved, watch: request.watch, fromDefault: false };
    return { ok: true, view: saved };
  };
  Object.assign(window, {
    commander: {
      accounts: async () => ({ ok: true, state: accounts }),
      onAccountsChanged: () => () => {},
      githubWatch: async (request: GitHubWatchRequest) => {
        requests.push(request);
        return answer(request);
      },
      // The oversight summary's settings, in the same group (OversightSettings.test.tsx).
      itemStore: async () => defaultOversightSettings,
    },
  });
});

afterEach(cleanup);

const panel = () => render(<GitHubWatchPanel no="13" now={() => NOW} />);
const org = (login: string) => within(screen.getByTestId(`github-org-${login}`));
const repoBox = (name: string) => screen.getByRole('checkbox', { name });

describe('Settings → GitHub', () => {
  it('asks for a GitHub Account first when there is none', async () => {
    accounts = { accounts: [], sources: [] };
    panel();
    expect(await screen.findByText(/Connect a GitHub Account in Accounts/)).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it('lists installed orgs with their repos, personal repos, and orgs without the app', async () => {
    panel();

    expect(await screen.findByTestId('github-org-acme')).toBeTruthy();
    expect(requests).toEqual([{ op: 'load', account: octocat.id }]);
    const acme = org('acme');
    expect(
      acme.getAllByRole('checkbox', { name: /^acme\// }).map((box) => box.getAttribute('aria-label')),
    ).toEqual(['acme/api', 'acme/web', 'acme/handbook']);
    expect(acme.getByTestId('github-repo-acme/api').textContent).toMatch(/private.*pushed 2 days ago/);
    expect(acme.getByTestId('github-repo-acme/web').textContent).toMatch(/pushed 24 Aug 2026/);
    expect(acme.getByTestId('github-repo-acme/handbook').textContent).toMatch(/internal.*empty/);
    expect(
      within(screen.getByTestId('github-personal')).getByRole('checkbox', { name: 'octocat/dotfiles' }),
    ).toBeTruthy();

    const initech = org('initech');
    expect(initech.getByText('Commander isn’t installed here.')).toBeTruthy();
    expect(initech.getByRole('link', { name: 'Install or request…' }).getAttribute('href')).toBe(
      'https://github.test/apps/commander/installations/new/permissions?target_id=502',
    );
    expect(initech.queryByRole('checkbox', { name: 'Watch whole org' })).toBeNull();
  });

  it('shows the starting selection as checked repos, with the summary line', async () => {
    panel();
    await screen.findByTestId('github-org-acme');

    expect((repoBox('acme/api') as HTMLInputElement).checked).toBe(true);
    expect((repoBox('acme/web') as HTMLInputElement).checked).toBe(false);
    expect((repoBox('octocat/dotfiles') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('github-watch-summary').textContent).toBe(
      'Watching 2 repos: 1 in 1 org and 1 personal.',
    );
    expect(
      screen.getByText(/started with the repos you pushed to, opened pull requests in or reviewed/),
    ).toBeTruthy();
  });

  it('watches a whole org in one click, and saves at once', async () => {
    panel();
    await screen.findByTestId('github-org-acme');

    fireEvent.click(org('acme').getByRole('checkbox', { name: 'Watch whole org' }));

    await waitFor(() =>
      expect(screen.getByTestId('github-watch-summary').textContent).toBe(
        'Watching 4 repos: 3 in 1 org and 1 personal.',
      ),
    );
    expect(requests.at(-1)).toEqual({
      op: 'save',
      account: octocat.id,
      watch: { orgs: [{ login: 'acme', except: [] }], repos: [ref(dotfiles)] },
    });
    expect((repoBox('acme/web') as HTMLInputElement).checked).toBe(true);
    expect(org('acme').getByText(/repos made here later too/)).toBeTruthy();
  });

  it('checks and unchecks single repos, leaving them out of a whole org', async () => {
    saved = viewWith(setOrgWatched({ orgs: [], repos: [] }, 'acme', true));
    panel();
    await screen.findByTestId('github-org-acme');

    fireEvent.click(repoBox('acme/web'));

    await waitFor(() => expect((repoBox('acme/web') as HTMLInputElement).checked).toBe(false));
    expect(requests.at(-1)).toMatchObject({
      op: 'save',
      watch: { orgs: [{ login: 'acme', except: [ref(web)] }] },
    });
    expect(screen.getByTestId('github-watch-summary').textContent).toBe('Watching 2 repos in 1 org.');
  });

  it('narrows the repos to a search', async () => {
    panel();
    await screen.findByTestId('github-org-acme');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search repos' }), { target: { value: 'DOT' } });

    expect(screen.queryByRole('checkbox', { name: 'acme/api' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'octocat/dotfiles' })).toBeTruthy();
    expect(screen.queryByTestId('github-org-acme')).toBeNull();
  });

  it('asks before unwatching removes Items, naming how many, and removes them only when confirmed', async () => {
    answer = (request) => {
      if (request.op === 'save' && !request.confirmed && !isWatched(request.watch, api))
        return { ok: true, view: saved, confirm: { items: 12, repos: [ref(api)] } };
      if (request.op === 'save') saved = { ...saved, watch: request.watch, fromDefault: false };
      return { ok: true, view: saved };
    };
    panel();
    await screen.findByTestId('github-org-acme');

    fireEvent.click(repoBox('acme/api'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Stop watching acme\/api\?/);
    expect(dialog.textContent).toMatch(/removes 12 Items from Commander/);
    expect(dialog.textContent).toMatch(/notes and Todos stay/);

    // Cancel leaves it watched.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep watching' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((repoBox('acme/api') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(repoBox('acme/api'));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove 12 Items' }),
    );
    await waitFor(() => expect((repoBox('acme/api') as HTMLInputElement).checked).toBe(false));
    expect(requests.at(-1)).toMatchObject({
      op: 'save',
      confirmed: true,
      watch: setRepoWatched(viewWith({ orgs: [], repos: [ref(api), ref(dotfiles)] }).watch, api, false),
    });
  });

  it('adds an org by name', async () => {
    panel();
    await screen.findByTestId('github-org-acme');

    fireEvent.change(screen.getByRole('textbox', { name: 'Org name' }), { target: { value: 'globex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add org' }));

    await waitFor(() =>
      expect(requests.at(-1)).toEqual({ op: 'add-org', account: octocat.id, login: 'globex' }),
    );
  });

  it('says why GitHub couldn’t be asked, and names watched repos it can no longer reach, with Unwatch', async () => {
    const gone = repo('acme', 'retired');
    saved = viewWith(
      { orgs: [{ login: 'globex', except: [] }], repos: [ref(api), ref(gone)] },
      { problem: 'Commander couldn’t reach GitHub.' },
    );
    panel();
    await screen.findByTestId('github-org-acme');

    expect(screen.getByText(/Commander couldn’t reach GitHub\./)).toBeTruthy();
    const unreachable = within(screen.getByTestId('github-unreachable'));
    expect(unreachable.getByText('acme/retired')).toBeTruthy();
    expect(unreachable.getByText(/globex \(whole org\)/)).toBeTruthy();

    fireEvent.click(unreachable.getByRole('button', { name: 'Unwatch acme/retired' }));
    await waitFor(() =>
      expect(requests.at(-1)).toMatchObject({
        op: 'save',
        watch: { repos: [ref(api)], orgs: [{ login: 'globex' }] },
      }),
    );
  });

  it('gives a token Account the same page from its own lists', async () => {
    accounts = {
      accounts: [{ ...octocat, signedInWith: 'classic-token', installations: null, method: 'api-key' }],
      sources: [],
    };
    saved = viewWith(
      { orgs: [], repos: [] },
      {
        access: {
          ...listing,
          via: 'token',
          orgs: [{ ...acme, reach: 'token' }],
        },
      },
    );
    panel();
    await screen.findByTestId('github-org-acme');

    expect(org('acme').getByRole('checkbox', { name: 'Watch whole org' })).toBeTruthy();
    expect(screen.queryByText('Commander isn’t installed here.')).toBeNull();
    expect(screen.getByTestId('github-watch-summary').textContent).toBe('Not watching any repos yet.');
  });
});
