import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountStore, credentialKey } from '../accounts/account-store';
import { fakeSafeStorage } from '../fake-safe-storage';
import { createSecrets, type Secrets } from '../secrets';
import { ACME, type FakeLinear, type FakeWorkspace, startFakeLinear } from './fake-linear-server';
import { createLinearAccounts, type LinearAccounts, type LinearConfig } from './linear-accounts';

const GLOBEX: FakeWorkspace = { id: 'org-globex', name: 'Globex', urlKey: 'globex' };
const HOUR = 60 * 60_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let dir: string;
let linear: FakeLinear;
let config: LinearConfig;
let clock: number;
let removedItems: string[];
let secrets: Secrets;

// The system browser: follows Linear's consent page straight back to the loopback listener.
const browser = async (url: string) => {
  await fetch(url);
};

// Commander as it starts: a fresh instance over the same files, as after a restart.
function start(overrides: { secrets?: Secrets; config?: Partial<LinearConfig> } = {}): LinearAccounts {
  return createLinearAccounts({
    config: { ...config, ...overrides.config },
    secrets: overrides.secrets ?? secrets,
    store: createAccountStore(join(dir, 'accounts.json')),
    openBrowser: browser,
    removeItems: async ({ id: accountId }) => {
      removedItems.push(accountId);
    },
    now: () => clock,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-linear-'));
  linear = await startFakeLinear();
  config = {
    clientId: linear.clientId,
    port: await freePort(),
    authorizeUrl: linear.authorizeUrl,
    tokenUrl: linear.tokenUrl,
    apiUrl: linear.apiUrl,
  };
  clock = 1_800_000_000_000;
  removedItems = [];
  secrets = createSecrets({
    safeStorage: fakeSafeStorage(),
    file: join(dir, 'secrets.json'),
    platform: 'linux',
  });
});

afterEach(async () => {
  await linear.close();
  await rm(dir, { recursive: true, force: true });
});

describe('connecting with a personal API key', () => {
  it('connects an Account named after the key’s workspace', async () => {
    linear.addApiKey('lin_api_acme', ACME);
    const accounts = start();

    const account = await accounts.connectWithApiKey('lin_api_acme');

    const expected = {
      id: 'linear:org-acme',
      source: 'linear',
      name: 'Acme',
      urlKey: 'acme',
      method: 'api-key',
      status: 'connected',
    };
    expect(account).toEqual(expected);
    expect(await accounts.list()).toEqual([expected]);
  });

  it('survives a restart', async () => {
    linear.addApiKey('lin_api_acme', ACME);
    await start().connectWithApiKey('lin_api_acme');

    const restarted = start();

    expect(await restarted.list()).toMatchObject([
      { id: 'linear:org-acme', name: 'Acme', status: 'connected' },
    ]);
    expect(await restarted.accessToken('linear:org-acme')).toEqual({
      token: 'lin_api_acme',
      kind: 'api-key',
    });
  });

  it('refuses a key Linear does not accept, and keeps nothing', async () => {
    const accounts = start();

    await expect(accounts.connectWithApiKey('lin_api_typo')).rejects.toMatchObject({
      reason: 'invalid-credential',
    });

    expect(await accounts.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses an empty key without asking Linear', async () => {
    await expect(start().connectWithApiKey('   ')).rejects.toMatchObject({ reason: 'invalid-credential' });
  });

  it('refuses when there is no real keyring, with the secrets module’s explanation', async () => {
    linear.addApiKey('lin_api_acme', ACME);
    const noKeyring = createSecrets({
      safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
      file: join(dir, 'secrets.json'),
      platform: 'linux',
    });
    const accounts = start({ secrets: noKeyring });

    const connecting = accounts.connectWithApiKey('lin_api_acme');

    await expect(connecting).rejects.toMatchObject({ reason: 'keyring-unavailable' });
    await expect(connecting).rejects.toThrow(/gnome-keyring/);
    expect(await accounts.list()).toEqual([]);
  });

  it('keeps one Account per workspace: connecting the same workspace again updates it', async () => {
    linear.addApiKey('lin_api_old', ACME);
    linear.addApiKey('lin_api_new', ACME);
    const accounts = start();
    await accounts.connectWithApiKey('lin_api_old');

    await accounts.connectWithApiKey('lin_api_new');

    expect(await accounts.list()).toHaveLength(1);
    expect(await accounts.accessToken('linear:org-acme')).toEqual({ token: 'lin_api_new', kind: 'api-key' });
  });

  it('connects several workspaces as separate Accounts', async () => {
    linear.addApiKey('lin_api_acme', ACME);
    linear.addApiKey('lin_api_globex', GLOBEX);
    const accounts = start();

    await accounts.connectWithApiKey('lin_api_acme');
    await accounts.connectWithApiKey('lin_api_globex');

    expect((await accounts.list()).map((account) => account.name)).toEqual(['Acme', 'Globex']);
  });
});

describe('connecting through the browser (OAuth)', () => {
  it('is not offered when the build has no client ID', async () => {
    const accounts = start({ config: { clientId: null } });

    expect(accounts.oauthAvailable).toBe(false);
    await expect(accounts.connectWithBrowser()).rejects.toMatchObject({ reason: 'not-configured' });
    expect(linear.authorizeRequests).toEqual([]);
  });

  it('connects an Account named after the approved workspace', async () => {
    const accounts = start();

    const account = await accounts.connectWithBrowser();

    expect(accounts.oauthAvailable).toBe(true);
    expect(account).toEqual({
      id: 'linear:org-acme',
      source: 'linear',
      name: 'Acme',
      urlKey: 'acme',
      method: 'oauth',
      status: 'connected',
    });
  });

  it('refuses before opening the browser when there is no real keyring', async () => {
    const noKeyring = createSecrets({
      safeStorage: fakeSafeStorage({ available: false }),
      file: join(dir, 'secrets.json'),
      platform: 'linux',
    });

    await expect(start({ secrets: noKeyring }).connectWithBrowser()).rejects.toMatchObject({
      reason: 'keyring-unavailable',
    });
    expect(linear.authorizeRequests).toEqual([]);
  });

  it('can be cancelled while waiting for the browser', async () => {
    const accounts = createLinearAccounts({
      config,
      secrets,
      store: createAccountStore(join(dir, 'accounts.json')),
      openBrowser: async () => {},
      removeItems: async () => {},
    });
    const connecting = accounts.connectWithBrowser();
    await vi.waitFor(() => expect(accounts.signingIn).toBe(true));

    accounts.cancelSignIn();

    await expect(connecting).rejects.toMatchObject({ reason: 'cancelled' });
    expect(accounts.signingIn).toBe(false);
  });

  it('replaces a sign-in still waiting for the browser when the User starts another', async () => {
    let opened = 0;
    const accounts = createLinearAccounts({
      config,
      secrets,
      store: createAccountStore(join(dir, 'accounts.json')),
      // The first time, the User never comes back from the browser.
      openBrowser: async (url) => {
        if (opened++ > 0) await fetch(url);
      },
      removeItems: async () => {},
    });
    const abandoned = accounts.connectWithBrowser();
    await vi.waitFor(() => expect(opened).toBe(1));

    const second = accounts.connectWithBrowser();

    await expect(abandoned).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(second).resolves.toMatchObject({ name: 'Acme', status: 'connected' });
  });
});

describe('access tokens for the Core', () => {
  it('hands over the current access token while it is fresh, without refreshing', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [accessToken] = linear.issuedTokens();
    clock += 23 * HOUR;

    expect(await accounts.accessToken('linear:org-acme')).toEqual({ token: accessToken, kind: 'oauth' });
    expect(linear.refreshes).toBe(0);
  });

  it('refreshes within 10 minutes of expiry, saving the new refresh token before returning the access token', async () => {
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
    clock += 24 * HOUR - 9 * 60_000;

    const token = await accounts.accessToken('linear:org-acme').then((result) => {
      events.push('returned');
      return result;
    });

    const [newAccess, newRefresh] = linear.issuedTokens().slice(-2);
    expect(linear.refreshes).toBe(1);
    expect(token).toEqual({ token: newAccess, kind: 'oauth' });
    expect(events).toEqual([`saved ${newRefresh}`, 'returned']);
    expect(JSON.parse((await secrets.read(credentialKey('linear:org-acme'))) ?? '{}')).toMatchObject({
      refreshToken: newRefresh,
    });
  });

  it('refreshes only once when two requests arrive together', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    clock += 24 * HOUR - 60_000;
    linear.delayRefreshes(50);

    const [first, second] = await Promise.all([
      accounts.accessToken('linear:org-acme'),
      accounts.accessToken('linear:org-acme'),
    ]);

    expect(linear.refreshes).toBe(1);
    expect(first).toEqual(second);
    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
  });

  it('keeps using a still-valid token when Linear can’t refresh just now', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [accessToken] = linear.issuedTokens();
    clock += 24 * HOUR - 5 * 60_000;
    linear.failRefreshesTemporarily(true);

    expect(await accounts.accessToken('linear:org-acme')).toEqual({ token: accessToken, kind: 'oauth' });
    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
  });

  it('reports a temporary problem once the token has expired and Linear still can’t refresh', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    clock += 25 * HOUR;
    linear.failRefreshesTemporarily(true);

    await expect(accounts.accessToken('linear:org-acme')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
  });

  it('knows no token for an Account that was never connected', async () => {
    await expect(start().accessToken('linear:org-nope')).rejects.toMatchObject({ reason: 'unknown-account' });
  });
});

describe('reconnecting', () => {
  it('marks the Account Reconnect when a refresh fails for good, and says so across restarts', async () => {
    const accounts = start();
    const changed = vi.fn();
    accounts.onChange(changed);
    await accounts.connectWithBrowser();
    linear.revoke(ACME.id);
    clock += 24 * HOUR;

    await expect(accounts.accessToken('linear:org-acme')).rejects.toMatchObject({
      reason: 'needs-reconnect',
    });

    expect(await accounts.list()).toMatchObject([{ id: 'linear:org-acme', status: 'needs-reconnect' }]);
    expect(changed).toHaveBeenCalled();
    await expect(start().accessToken('linear:org-acme')).rejects.toMatchObject({ reason: 'needs-reconnect' });
  });

  it('restores the Account under the same identity when the User signs in again', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    linear.revoke(ACME.id);
    clock += 24 * HOUR;
    await accounts.accessToken('linear:org-acme').catch(() => {});

    const account = await accounts.connectWithBrowser({ reconnect: 'linear:org-acme' });

    expect(account).toMatchObject({ id: 'linear:org-acme', status: 'connected' });
    expect(await accounts.list()).toHaveLength(1);
    const [newAccess] = linear.issuedTokens().slice(-2);
    expect(await accounts.accessToken('linear:org-acme')).toEqual({ token: newAccess, kind: 'oauth' });
  });

  it('refuses a reconnect that signs in to a different workspace, leaving the Account as it was', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    linear.revoke(ACME.id);
    clock += 24 * HOUR;
    await accounts.accessToken('linear:org-acme').catch(() => {});
    linear.approve(GLOBEX);

    await expect(accounts.connectWithBrowser({ reconnect: 'linear:org-acme' })).rejects.toMatchObject({
      reason: 'wrong-workspace',
    });

    expect(await accounts.list()).toMatchObject([{ id: 'linear:org-acme', status: 'needs-reconnect' }]);
  });

  it('marks an API key Account Reconnect when Linear refuses its key during a sync', async () => {
    linear.addApiKey('lin_api_revoked', ACME);
    const accounts = start();
    const changed = vi.fn();
    accounts.onChange(changed);
    await accounts.connectWithApiKey('lin_api_revoked');

    await accounts.reportRefused('linear:org-acme');

    expect(await accounts.list()).toMatchObject([{ status: 'needs-reconnect' }]);
    expect(changed).toHaveBeenCalled();
    await expect(accounts.accessToken('linear:org-acme')).rejects.toMatchObject({
      reason: 'needs-reconnect',
    });
  });

  it('refreshes a refused OAuth token, keeping the Account when Linear issues a new one', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();

    await accounts.reportRefused('linear:org-acme');

    const [newAccess] = linear.issuedTokens().slice(-2);
    expect(linear.refreshes).toBe(1);
    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
    expect(await accounts.accessToken('linear:org-acme')).toEqual({ token: newAccess, kind: 'oauth' });
  });

  it('marks an OAuth Account Reconnect when its refused token can’t be refreshed either', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    linear.revoke(ACME.id);

    await accounts.reportRefused('linear:org-acme');

    expect(await accounts.list()).toMatchObject([{ status: 'needs-reconnect' }]);
  });

  it('keeps an OAuth Account when Linear can’t refresh its refused token just now', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    linear.failRefreshesTemporarily(true);

    await accounts.reportRefused('linear:org-acme');

    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
  });

  it('reconnects an API key Account with a new key', async () => {
    linear.addApiKey('lin_api_new', ACME);
    linear.addApiKey('lin_api_old', ACME);
    const accounts = start();
    await accounts.connectWithApiKey('lin_api_old');

    const account = await accounts.connectWithApiKey('lin_api_new', { reconnect: 'linear:org-acme' });

    expect(account).toMatchObject({ id: 'linear:org-acme', status: 'connected', method: 'api-key' });
  });
});

describe('removing an Account', () => {
  it('deletes its keyring entry and its Items, then forgets it', async () => {
    linear.addApiKey('lin_api_acme', ACME);
    linear.addApiKey('lin_api_globex', GLOBEX);
    const accounts = start();
    await accounts.connectWithApiKey('lin_api_acme');
    await accounts.connectWithApiKey('lin_api_globex');

    await accounts.remove('linear:org-acme');

    expect(removedItems).toEqual(['linear:org-acme']);
    expect(await secrets.read(credentialKey('linear:org-acme'))).toBeNull();
    expect(await secrets.read(credentialKey('linear:org-globex'))).not.toBeNull();
    expect((await accounts.list()).map((account) => account.id)).toEqual(['linear:org-globex']);
    await expect(accounts.accessToken('linear:org-acme')).rejects.toMatchObject({
      reason: 'unknown-account',
    });
  });

  it('keeps the Account, and its sign-in, when its Items could not be removed', async () => {
    linear.addApiKey('lin_api_acme', ACME);
    const accounts = createLinearAccounts({
      config,
      secrets,
      store: createAccountStore(join(dir, 'accounts.json')),
      openBrowser: browser,
      removeItems: async () => {
        throw new Error('The Core did not answer in time');
      },
    });
    await accounts.connectWithApiKey('lin_api_acme');

    await expect(accounts.remove('linear:org-acme')).rejects.toThrow(/did not answer/);

    expect(await accounts.list()).toHaveLength(1);
    expect(await secrets.read(credentialKey('linear:org-acme'))).toBe(
      JSON.stringify({ kind: 'api-key', apiKey: 'lin_api_acme' }),
    );
  });
});

describe('keeping secrets secret', () => {
  it('never puts a token or key in the Accounts file, the logs or what the window is shown', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void logged.push(...args));
    }
    linear.addApiKey('lin_api_acme', GLOBEX);
    const accounts = start();
    const shown: unknown[] = [];
    shown.push(await accounts.connectWithBrowser());
    shown.push(await accounts.connectWithApiKey('lin_api_acme'));
    clock += 24 * HOUR;
    await accounts.accessToken('linear:org-acme');
    linear.revoke(ACME.id);
    clock += 24 * HOUR;
    await accounts.accessToken('linear:org-acme').catch((error: unknown) => shown.push(String(error)));
    shown.push(await accounts.list());

    const accountsFile = await readFile(join(dir, 'accounts.json'), 'utf8');
    const secretsFile = await readFile(join(dir, 'secrets.json'), 'utf8');
    const everywhere = [accountsFile, secretsFile, JSON.stringify(logged), JSON.stringify(shown)].join('\n');
    expect(linear.issuedTokens().length).toBeGreaterThanOrEqual(5);
    for (const secret of linear.issuedTokens()) expect(everywhere).not.toContain(secret);
    vi.restoreAllMocks();
  });
});
