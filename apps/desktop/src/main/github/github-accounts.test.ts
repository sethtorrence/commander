import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountStore, credentialKey } from '../accounts/account-store';
import { fakeSafeStorage } from '../fake-safe-storage';
import { createSecrets, type Secrets } from '../secrets';
import { type FakeGitHub, type FakeGitHubUser, OCTOCAT, startFakeGitHub } from './fake-github-server';
import type { GhCli } from './gh-cli';
import { createGitHubAccounts, type GitHubAccounts } from './github-accounts';
import type { GitHubConfig } from './github-config';

// GitHub Accounts against the fake GitHub: the device flow with Commander's GitHub App, a classic
// personal access token and gh's sign-in; refreshing, reconnecting, removing, and where the app is
// installed. Time is simulated, and the User enters the shown code on GitHub at the first poll.

const MONA: FakeGitHubUser = { id: 1_000_002, login: 'mona', name: 'Mona Lisa' };
const HOUR = 60 * 60_000;

let dir: string;
let github: FakeGitHub;
let config: GitHubConfig;
let clock: number;
let removedItems: string[];
let secrets: Secrets;
let logs: string[];
// Who enters the shown code on GitHub, or 'nobody' to leave it waiting.
let approver: FakeGitHubUser | 'nobody';
let gh: GhCli;
let ghToken: string;
const octocatId = `github:${OCTOCAT.id}`;

function start(overrides: { secrets?: Secrets; config?: Partial<GitHubConfig> } = {}): GitHubAccounts {
  const accounts: GitHubAccounts = createGitHubAccounts({
    config: { ...config, ...overrides.config },
    secrets: overrides.secrets ?? secrets,
    store: createAccountStore(join(dir, 'accounts.json')),
    openBrowser: async () => {},
    removeItems: async ({ id }) => {
      removedItems.push(id);
    },
    now: () => clock,
    log: (message) => logs.push(message),
    gh,
    // Each poll's wait: simulated, with the User entering the code at once; or, while nobody does,
    // a few real milliseconds with the clock stopped, so the code never runs out under the test.
    sleep: async (ms, signal) => {
      const code = accounts.deviceCode?.userCode;
      if (approver === 'nobody') await new Promise((resolve) => setTimeout(resolve, 5));
      else {
        clock += ms;
        if (code) github.enterCode(code, approver);
      }
      if (signal?.aborted) throw signal.reason;
    },
  });
  return accounts;
}

// The GitHub App tokens issued so far (access and refresh, in pairs), leaving out personal tokens.
const appTokens = () => github.secrets().filter((secret) => /^gh[ur]_/.test(secret));

const accountsFile = async () => JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-github-'));
  github = await startFakeGitHub();
  config = {
    clientId: github.clientId,
    appSlug: github.appSlug,
    webUrl: github.webUrl,
    apiUrl: github.apiUrl,
  };
  clock = 1_800_000_000_000;
  removedItems = [];
  logs = [];
  approver = OCTOCAT;
  secrets = createSecrets({
    safeStorage: fakeSafeStorage(),
    file: join(dir, 'secrets.json'),
    platform: 'linux',
  });
  ghToken = github.personalToken({ kind: 'oauth', scopes: ['gist', 'read:org', 'repo', 'workflow'] });
  gh = { installed: true, token: async () => ghToken };
});

afterEach(async () => {
  await github.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a build without Commander’s GitHub App', () => {
  it('offers only the token fallbacks, pointing to the README', async () => {
    const accounts = start({ config: { clientId: null, appSlug: null } });

    expect(accounts.oauthAvailable).toBe(false);
    expect(accounts.apiKeyAvailable).toBe(true);
    expect(accounts.cliAvailable).toBe(true);
    await expect(accounts.connectWithBrowser()).rejects.toMatchObject({
      reason: 'not-configured',
      message: expect.stringMatching(/token.*README/),
    });
    expect(github.deviceCodeRequests).toEqual([]);
  });

  it('connects with a classic token all the same', async () => {
    const accounts = start({ config: { clientId: null, appSlug: null } });

    const account = await accounts.connectWithApiKey(github.personalToken({ kind: 'classic' }));

    expect(account).toMatchObject({ id: octocatId, signedInWith: 'classic-token', installUrl: null });
  });
});

describe('connecting with the GitHub App (device flow)', () => {
  it('shows the code while waiting for it to be entered on GitHub, and nothing once done', async () => {
    approver = 'nobody';
    const accounts = start();
    const connecting = accounts.connectWithBrowser();
    await expect.poll(() => accounts.deviceCode).not.toBeNull();

    expect(accounts.deviceCode).toEqual({
      userCode: github.userCodes()[0],
      verificationUri: `${github.webUrl}/login/device`,
      expiresAt: expect.any(Number),
    });
    github.enterCode(accounts.deviceCode?.userCode ?? '');
    await connecting;
    expect(accounts.deviceCode).toBeNull();
  });

  it('names the Account by login and keys it by user id, keeping both, and where the app is installed', async () => {
    github.install({ login: 'octocat', type: 'User' });
    github.install({ login: 'acme-org', type: 'Organization' });
    const accounts = start();

    const account = await accounts.connectWithBrowser();

    const expected = {
      id: octocatId,
      source: 'github',
      name: 'octocat',
      login: 'octocat',
      signedInWith: 'github-app',
      installations: ['octocat', 'acme-org'],
      installUrl: `${github.webUrl}/apps/${github.appSlug}/installations/new`,
      method: 'oauth',
      status: 'connected',
      user: { id: String(OCTOCAT.id), name: 'The Octocat' },
    };
    expect(account).toEqual(expected);
    expect(await accounts.list()).toEqual([expected]);
  });

  it('survives a restart', async () => {
    await start().connectWithBrowser();
    const [accessToken] = appTokens();

    const restarted = start();

    expect(await restarted.list()).toMatchObject([{ id: octocatId, status: 'connected' }]);
    expect(await restarted.accessToken(octocatId)).toEqual({ token: accessToken, kind: 'oauth' });
  });

  it('keeps one Account per GitHub user: connecting again updates it', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [first] = await accountsFile();
    clock += HOUR;

    await accounts.connectWithBrowser();

    const records = await accountsFile();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: octocatId, connectedAt: first.connectedAt });
  });

  it('connects another GitHub user as a separate Account', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    approver = MONA;

    await accounts.connectWithBrowser();

    expect((await accounts.list()).map((account) => account.name)).toEqual(['octocat', 'mona']);
  });

  it('can be cancelled while the code waits, keeping nothing', async () => {
    approver = 'nobody';
    const accounts = start();
    const connecting = accounts.connectWithBrowser();
    await expect.poll(() => accounts.deviceCode).not.toBeNull();

    accounts.cancelSignIn();

    await expect(connecting).rejects.toMatchObject({ reason: 'cancelled' });
    expect(accounts.deviceCode).toBeNull();
    expect(await accounts.list()).toEqual([]);
  });

  it('keeps nothing when the User declines on GitHub', async () => {
    approver = 'nobody';
    const accounts = start();
    const connecting = accounts.connectWithBrowser();
    await expect.poll(() => accounts.deviceCode).not.toBeNull();

    github.deny();

    await expect(connecting).rejects.toMatchObject({ reason: 'declined' });
    expect(await accounts.list()).toEqual([]);
    expect(accounts.deviceCode).toBeNull();
  });
});

describe('where Commander’s GitHub App is installed', () => {
  it('is checked again on request, after the User installs it on another org', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    expect(await accounts.list()).toMatchObject([{ installations: [] }]);
    github.install({ login: 'acme-org', type: 'Organization' });

    await accounts.refreshDetails(octocatId);

    expect(await accounts.list()).toMatchObject([{ installations: ['acme-org'] }]);
  });

  it('lists every installation, however many pages GitHub takes', async () => {
    for (let i = 0; i < 130; i++) github.install({ login: `org-${i}`, type: 'Organization' });

    const account = await start().connectWithBrowser();

    expect(account).toMatchObject({ installations: expect.arrayContaining(['org-0', 'org-129']) });
    expect(account.source === 'github' && account.installations?.length).toBe(130);
  });

  it('is never asked of a token Account, which doesn’t go through the app', async () => {
    const accounts = start();
    await accounts.connectWithApiKey(github.personalToken({ kind: 'classic' }));

    await accounts.refreshDetails(octocatId);

    expect(github.apiRequests).not.toContain('GET /user/installations');
    expect(await accounts.list()).toMatchObject([{ installations: null }]);
  });
});

describe('access tokens for the Core', () => {
  it('hands over the current token while it is fresh, without refreshing', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [accessToken] = appTokens();
    clock += 7 * HOUR;

    expect(await accounts.accessToken(octocatId)).toEqual({ token: accessToken, kind: 'oauth' });
    expect(github.refreshes).toBe(0);
  });

  it('refreshes within 10 minutes of expiry with the client ID alone, saving the rotated refresh token before returning the access token', async () => {
    const events: string[] = [];
    const watched: Secrets = {
      ...secrets,
      save: async (key, value) => {
        await secrets.save(key, value);
        events.push(`saved ${JSON.parse(value).refreshToken}`);
      },
    };
    const accounts = start({ secrets: watched });
    await accounts.connectWithBrowser();
    events.length = 0;
    clock += 8 * HOUR - 9 * 60_000;

    const token = await accounts.accessToken(octocatId).then((result) => {
      events.push('returned');
      return result;
    });

    const [newAccess, newRefresh] = appTokens().slice(2, 4);
    expect(github.refreshes).toBe(1);
    expect(github.tokenRequests.at(-1)).toEqual({
      client_id: github.clientId,
      grant_type: 'refresh_token',
      refresh_token: expect.stringMatching(/^ghr_/),
    });
    expect(token).toEqual({ token: newAccess, kind: 'oauth' });
    expect(events).toEqual([`saved ${newRefresh}`, 'returned']);
  });

  it('refreshes only once when two requests arrive together', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    clock += 8 * HOUR - 60_000;
    github.delayRefreshes(50);

    const [first, second] = await Promise.all([
      accounts.accessToken(octocatId),
      accounts.accessToken(octocatId),
    ]);

    expect(github.refreshes).toBe(1);
    expect(first).toEqual(second);
  });

  it('marks the Account Reconnect when GitHub refuses a refresh for good, and says so after a restart', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    github.revoke(OCTOCAT.id);
    clock += 8 * HOUR;

    await expect(accounts.accessToken(octocatId)).rejects.toMatchObject({ reason: 'needs-reconnect' });

    expect(await start().list()).toMatchObject([{ id: octocatId, status: 'needs-reconnect' }]);
  });

  it('keeps using a still-valid token when GitHub can’t refresh just now', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [accessToken] = appTokens();
    clock += 8 * HOUR - 5 * 60_000;
    github.failRefreshesTemporarily(true);

    expect(await accounts.accessToken(octocatId)).toEqual({ token: accessToken, kind: 'oauth' });
    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
  });
});

describe('reconnecting a GitHub Account', () => {
  it('restores the Account under the same user', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    github.revoke(OCTOCAT.id);
    clock += 8 * HOUR;
    await accounts.accessToken(octocatId).catch(() => {});

    await accounts.connectWithBrowser({ reconnect: octocatId });

    expect(await accounts.list()).toMatchObject([{ id: octocatId, status: 'connected' }]);
  });

  it('refuses a reconnect that signs in as someone else, saying who', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    approver = MONA;

    await expect(accounts.connectWithBrowser({ reconnect: octocatId })).rejects.toMatchObject({
      reason: 'wrong-account',
      message: expect.stringMatching(/for mona, not octocat/),
    });
    expect((await accounts.list()).map((account) => account.name)).toEqual(['octocat']);
  });
});

describe('a classic personal access token', () => {
  it('connects, checked with GET /user, and is never refreshed', async () => {
    const token = github.personalToken({ kind: 'classic' });
    const accounts = start();

    const account = await accounts.connectWithApiKey(` ${token} `);

    expect(account).toMatchObject({
      id: octocatId,
      name: 'octocat',
      method: 'api-key',
      signedInWith: 'classic-token',
      installations: null,
    });
    clock += 365 * 24 * HOUR;
    expect(await start().accessToken(octocatId)).toEqual({ token, kind: 'api-key' });
    expect(github.tokenRequests).toEqual([]);
  });

  it('accepts a broader org scope in place of read:org', async () => {
    const token = github.personalToken({ kind: 'classic', scopes: ['repo', 'admin:org'] });

    await expect(start().connectWithApiKey(token)).resolves.toMatchObject({ id: octocatId });
  });

  it('says which scopes are missing, and keeps nothing', async () => {
    const token = github.personalToken({ kind: 'classic', scopes: ['public_repo'] });
    const accounts = start();

    await expect(accounts.connectWithApiKey(token)).rejects.toMatchObject({
      reason: 'invalid-credential',
      message: expect.stringMatching(/missing the repo and read:org scopes/),
    });
    expect(await accounts.list()).toEqual([]);
    expect(await secrets.read(credentialKey(octocatId))).toBeNull();
  });

  it('turns away a fine-grained token, saying why a classic one is needed', async () => {
    const token = github.personalToken({ kind: 'fine-grained' });

    await expect(start().connectWithApiKey(token)).rejects.toMatchObject({
      reason: 'invalid-credential',
      message: expect.stringMatching(/classic/),
    });
  });

  it('says so when GitHub doesn’t accept the token', async () => {
    await expect(start().connectWithApiKey('ghp_not_a_real_token')).rejects.toMatchObject({
      reason: 'invalid-credential',
      message: expect.stringMatching(/didn’t accept that token/),
    });
  });

  it('is marked Reconnect when GitHub refuses it during a sync, not refreshed', async () => {
    const accounts = start();
    await accounts.connectWithApiKey(github.personalToken({ kind: 'classic' }));

    await accounts.reportRefused(octocatId);

    expect(await accounts.list()).toMatchObject([{ status: 'needs-reconnect' }]);
    expect(github.tokenRequests).toEqual([]);
  });
});

describe('gh’s sign-in', () => {
  it('connects with the token gh holds, never refreshed', async () => {
    const accounts = start();

    const account = await accounts.connectWithCli();

    expect(account).toMatchObject({
      id: octocatId,
      method: 'api-key',
      signedInWith: 'gh',
      installations: null,
    });
    clock += 365 * 24 * HOUR;
    expect(await start().accessToken(octocatId)).toEqual({ token: ghToken, kind: 'api-key' });
    expect(github.tokenRequests).toEqual([]);
  });

  it('isn’t offered when gh isn’t installed', async () => {
    gh = { installed: false, token: async () => ghToken };
    const accounts = start();

    expect(accounts.cliAvailable).toBe(false);
    await expect(accounts.connectWithCli()).rejects.toMatchObject({ reason: 'not-configured' });
  });

  it('says how to give gh the missing scope', async () => {
    ghToken = github.personalToken({ kind: 'oauth', scopes: ['repo', 'gist'] });

    await expect(start().connectWithCli()).rejects.toMatchObject({
      reason: 'invalid-credential',
      message: expect.stringMatching(/gh auth refresh --scopes read:org/),
    });
  });
});

describe('removing a GitHub Account', () => {
  it('deletes its keyring entry and its Items, then forgets it', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();

    await accounts.remove(octocatId);

    expect(removedItems).toEqual([octocatId]);
    expect(await secrets.read(credentialKey(octocatId))).toBeNull();
    expect(await accounts.list()).toEqual([]);
  });
});

describe('keeping GitHub secrets secret', () => {
  it('never puts a token or device code in the Accounts file, the logs or what the window is shown', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    await accounts.connectWithCli().catch(() => {});
    github.revoke(OCTOCAT.id);
    clock += 8 * HOUR;
    await accounts.accessToken(octocatId).catch(() => {});

    const seen = [
      await readFile(join(dir, 'accounts.json'), 'utf8'),
      logs.join('\n'),
      JSON.stringify(await accounts.list()),
    ].join('\n');
    for (const secret of github.secrets()) expect(seen).not.toContain(secret);
  });
});
