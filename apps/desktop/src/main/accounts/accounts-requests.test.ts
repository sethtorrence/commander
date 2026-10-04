import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeSafeStorage } from '../fake-safe-storage';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../github/fake-github-server';
import { createGitHubAccounts, type GitHubAccounts } from '../github/github-accounts';
import { ACME, type FakeLinear, startFakeLinear } from '../linear/fake-linear-server';
import { createLinearAccounts, type LinearAccounts } from '../linear/linear-accounts';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../microsoft/fake-microsoft-server';
import { createTeamsAccounts, TEAMS_SCOPES } from '../microsoft/teams-accounts';
import { createSecrets, type Secrets } from '../secrets';
import { createAccountStore } from './account-store';
import { type Accounts, combineAccounts } from './accounts';
import { answerAccountsRequest } from './accounts-requests';

let dir: string;
let linear: FakeLinear;
let microsoft: FakeMicrosoft;
let linearAccounts: LinearAccounts;
let secrets: Secrets;
let accounts: Accounts;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Teams, signed in through the stand-in browser; `configured: false` for a build without the app.
function teams({ configured = true } = {}) {
  return createTeamsAccounts({
    config: {
      clientId: configured ? microsoft.clientId : null,
      tenantId: configured ? microsoft.tenantId : null,
      loginUrl: microsoft.loginUrl,
      graphUrl: microsoft.graphUrl,
    },
    secrets,
    store: createAccountStore(join(dir, 'accounts.json')),
    openBrowser: async (url) => {
      await fetch(url);
    },
    removeItems: async () => {},
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-accounts-requests-'));
  linear = await startFakeLinear();
  microsoft = await startFakeMicrosoft();
  secrets = createSecrets({
    safeStorage: fakeSafeStorage(),
    file: join(dir, 'secrets.json'),
    platform: 'linux',
  });
  linearAccounts = createLinearAccounts({
    config: {
      clientId: null,
      port: await freePort(),
      authorizeUrl: linear.authorizeUrl,
      tokenUrl: linear.tokenUrl,
      apiUrl: linear.apiUrl,
    },
    secrets,
    store: createAccountStore(join(dir, 'accounts.json')),
    openBrowser: async () => {},
    removeItems: async () => {},
  });
  accounts = combineAccounts([linearAccounts, teams()]);
});

afterEach(async () => {
  await linear.close();
  await microsoft.close();
  await rm(dir, { recursive: true, force: true });
});

describe('Settings → Accounts requests from the window', () => {
  it('lists the Accounts and how this build can connect each Source', async () => {
    expect(await answerAccountsRequest(accounts, { op: 'list' })).toEqual({
      ok: true,
      state: {
        accounts: [],
        sources: [
          { source: 'linear', oauth: false, apiKey: true },
          { source: 'teams', oauth: true, apiKey: false },
        ],
        deviceCode: null,
      },
    });
  });

  it('says Teams can’t connect in a build without Commander’s Microsoft app', async () => {
    const unconfigured = combineAccounts([linearAccounts, teams({ configured: false })]);

    const listed = await answerAccountsRequest(unconfigured, { op: 'list' });
    const connecting = await answerAccountsRequest(unconfigured, {
      op: 'connect',
      source: 'teams',
      method: 'oauth',
    });

    expect(listed.state.sources).toContainEqual({ source: 'teams', oauth: false, apiKey: false });
    expect(connecting).toMatchObject({ ok: false, source: 'teams', error: expect.stringMatching(/README/) });
  });

  it('connects an API key Account and answers with the new list, without the key', async () => {
    linear.addApiKey('lin_api_secret', ACME);

    const response = await answerAccountsRequest(accounts, {
      op: 'connect',
      source: 'linear',
      method: 'api-key',
      apiKey: 'lin_api_secret',
    });

    expect(response).toMatchObject({ ok: true, state: { accounts: [{ name: 'Acme', method: 'api-key' }] } });
    expect(JSON.stringify(response)).not.toContain('lin_api_secret');
  });

  it('answers a failure with its explanation and its Source, never echoing the key', async () => {
    const response = await answerAccountsRequest(accounts, {
      op: 'connect',
      source: 'linear',
      method: 'api-key',
      apiKey: 'lin_api_typo',
    });

    expect(response).toMatchObject({
      ok: false,
      source: 'linear',
      error: expect.stringMatching(/didn’t accept that API key/),
    });
    expect(JSON.stringify(response)).not.toContain('lin_api_typo');
  });

  it('says only API keys work when the build has no Linear OAuth app', async () => {
    expect(
      await answerAccountsRequest(accounts, { op: 'connect', source: 'linear', method: 'oauth' }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/API key/) });
  });

  it('connects Teams through the browser, listing its Account after Linear’s', async () => {
    linear.addApiKey('lin_api_secret', ACME);
    await linearAccounts.connectWithApiKey('lin_api_secret');

    const response = await answerAccountsRequest(accounts, {
      op: 'connect',
      source: 'teams',
      method: 'oauth',
    });

    expect(response).toMatchObject({
      ok: true,
      state: {
        accounts: [
          { source: 'linear', name: 'Acme' },
          { source: 'teams', name: 'Teams · sam@contoso.test', user: { id: SAM.id } },
        ],
      },
    });
    for (const token of microsoft.issuedTokens()) expect(JSON.stringify(response)).not.toContain(token);
  });

  it('answers a tenant needing admin consent with the permissions and the admin consent link', async () => {
    microsoft.requireAdminConsent('AADSTS65001');

    const response = await answerAccountsRequest(accounts, {
      op: 'connect',
      source: 'teams',
      method: 'oauth',
    });

    expect(response).toMatchObject({
      ok: false,
      source: 'teams',
      error: expect.stringMatching(/administrator/),
      adminConsent: {
        permissions: [...TEAMS_SCOPES],
        url: expect.stringContaining(`/${microsoft.tenantId}/adminconsent?client_id=`),
      },
    });
  });

  it('rejects an API key for a Source that has none', async () => {
    const response = await answerAccountsRequest(accounts, {
      op: 'connect',
      source: 'teams',
      method: 'api-key',
      apiKey: 'nope',
    });

    expect(response).toMatchObject({ ok: false, error: 'Commander did not understand that request.' });
  });

  it('removes an Account, whichever its Source', async () => {
    linear.addApiKey('lin_api_secret', ACME);
    await linearAccounts.connectWithApiKey('lin_api_secret');
    await answerAccountsRequest(accounts, { op: 'connect', source: 'teams', method: 'oauth' });

    await answerAccountsRequest(accounts, { op: 'remove', accountId: 'linear:org-acme' });
    const response = await answerAccountsRequest(accounts, {
      op: 'remove',
      accountId: `teams:${microsoft.tenantId}:${SAM.id}`,
    });

    expect(response).toMatchObject({ ok: true, state: { accounts: [] } });
  });

  it('shows each Account’s sync status, and passes Sync now and the cadence to the Core', async () => {
    linear.addApiKey('lin_api_secret', ACME);
    await linearAccounts.connectWithApiKey('lin_api_secret');
    const asked: string[] = [];
    const status = {
      account: 'linear:org-acme',
      source: 'linear' as const,
      activity: 'idle' as const,
      cadenceMinutes: 15,
      cadenceChoices: [15, 30, 60],
      lastSyncedAt: 1,
      nextSyncAt: 2,
      itemCount: 12,
      problem: null,
      outgoing: { pending: 0, failed: 0 },
    };
    const sync = {
      status: (id: string) => (id === 'linear:org-acme' ? status : null),
      refresh: (id: string) => asked.push(`refresh ${id}`),
      setCadence: (id: string, minutes: number) => asked.push(`cadence ${id} ${minutes}`),
    };

    const synced = await answerAccountsRequest(
      accounts,
      { op: 'sync-now', accountId: 'linear:org-acme' },
      sync,
    );
    await answerAccountsRequest(
      accounts,
      { op: 'set-sync-cadence', accountId: 'linear:org-acme', minutes: 30 },
      sync,
    );

    expect(asked).toEqual(['refresh linear:org-acme', 'cadence linear:org-acme 30']);
    expect(synced).toMatchObject({ ok: true, state: { accounts: [{ name: 'Acme', sync: status }] } });
  });

  it('rejects a malformed request without echoing it', async () => {
    const response = await answerAccountsRequest(accounts, {
      op: 'connect',
      source: 'linear',
      method: 'api-key',
      apiKey: 42,
    });

    expect(response).toMatchObject({ ok: false, error: 'Commander did not understand that request.' });
  });
});

describe('the Accounts of every Source together', () => {
  it('hands the Core an access token from the Account’s own Source', async () => {
    linear.addApiKey('lin_api_secret', ACME);
    await linearAccounts.connectWithApiKey('lin_api_secret');
    await answerAccountsRequest(accounts, { op: 'connect', source: 'teams', method: 'oauth' });
    const [teamsAccess] = microsoft.issuedTokens();

    expect(await accounts.accessToken('linear:org-acme')).toEqual({
      token: 'lin_api_secret',
      kind: 'api-key',
    });
    expect(await accounts.accessToken(`teams:${microsoft.tenantId}:${SAM.id}`)).toEqual({
      token: teamsAccess,
      kind: 'oauth',
    });
    await expect(accounts.accessToken('github:nobody')).rejects.toMatchObject({ reason: 'unknown-account' });
  });

  it('tells its listeners when any Source’s Accounts change', async () => {
    const changes: string[] = [];
    accounts.onChange(() => changes.push('changed'));

    await answerAccountsRequest(accounts, { op: 'connect', source: 'teams', method: 'oauth' });

    expect(changes).toEqual(['changed']);
  });
});

describe('GitHub Accounts from the window', () => {
  let github: FakeGitHub;
  let githubAccounts: GitHubAccounts;
  let withGitHub: Accounts;
  let ghToken: string;
  // Holds each device flow poll until released, so the window can be asked mid sign-in.
  let releasePoll: () => void;

  beforeEach(async () => {
    github = await startFakeGitHub();
    ghToken = github.personalToken({ kind: 'oauth' });
    githubAccounts = createGitHubAccounts({
      config: {
        clientId: github.clientId,
        appSlug: github.appSlug,
        webUrl: github.webUrl,
        apiUrl: github.apiUrl,
      },
      gh: { installed: true, token: async () => ghToken },
      sleep: () =>
        new Promise((resolve) => {
          releasePoll = resolve;
        }),
      secrets,
      store: createAccountStore(join(dir, 'accounts.json')),
      openBrowser: async () => {},
      removeItems: async () => {},
    });
    withGitHub = combineAccounts([linearAccounts, githubAccounts]);
  });

  afterEach(async () => {
    await github.close();
  });

  it('lists GitHub with its device sign-in, tokens and gh’s sign-in', async () => {
    const listed = await answerAccountsRequest(withGitHub, { op: 'list' });

    expect(listed.state.sources).toContainEqual({ source: 'github', oauth: true, apiKey: true, cli: true });
  });

  it('shows the code to enter while the device sign-in waits, never the device code', async () => {
    const connecting = answerAccountsRequest(withGitHub, {
      op: 'connect',
      source: 'github',
      method: 'oauth',
    });
    await expect.poll(() => withGitHub.deviceCode()).not.toBeNull();

    const waiting = await answerAccountsRequest(withGitHub, { op: 'list' });

    expect(waiting.state.deviceCode).toEqual({
      source: 'github',
      userCode: github.userCodes()[0],
      verificationUri: `${github.webUrl}/login/device`,
      expiresAt: expect.any(Number),
    });
    for (const secret of github.secrets()) expect(JSON.stringify(waiting)).not.toContain(secret);
    github.enterCode(github.userCodes()[0] ?? '');
    releasePoll();
    expect(await connecting).toMatchObject({
      ok: true,
      state: { accounts: [{ source: 'github', name: 'octocat' }], deviceCode: null },
    });
  });

  it('connects a classic token and gh’s sign-in, never answering with either', async () => {
    const token = github.personalToken({ kind: 'classic' });

    const pasted = await answerAccountsRequest(withGitHub, {
      op: 'connect',
      source: 'github',
      method: 'api-key',
      apiKey: token,
    });
    const reused = await answerAccountsRequest(withGitHub, {
      op: 'connect',
      source: 'github',
      method: 'cli',
    });

    expect(pasted).toMatchObject({ ok: true, state: { accounts: [{ signedInWith: 'classic-token' }] } });
    expect(reused).toMatchObject({ ok: true, state: { accounts: [{ signedInWith: 'gh' }] } });
    expect(JSON.stringify([pasted, reused])).not.toContain(token);
    expect(JSON.stringify([pasted, reused])).not.toContain(ghToken);
  });

  it('checks again where the app is installed', async () => {
    const connecting = answerAccountsRequest(withGitHub, {
      op: 'connect',
      source: 'github',
      method: 'oauth',
    });
    await expect.poll(() => withGitHub.deviceCode()).not.toBeNull();
    github.enterCode(github.userCodes()[0] ?? '');
    releasePoll();
    await connecting;
    github.install({ login: 'acme-org', type: 'Organization' });

    const response = await answerAccountsRequest(withGitHub, {
      op: 'refresh-details',
      accountId: `github:${OCTOCAT.id}`,
    });

    expect(response).toMatchObject({ ok: true, state: { accounts: [{ installations: ['acme-org'] }] } });
  });

  it('turns away gh’s sign-in for Linear', async () => {
    const response = await answerAccountsRequest(withGitHub, {
      op: 'connect',
      source: 'linear',
      method: 'cli',
    });

    expect(response).toMatchObject({ ok: false, error: 'Commander did not understand that request.' });
  });
});
