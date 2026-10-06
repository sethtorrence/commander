import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountStore, credentialKey } from '../accounts/account-store';
import { fakeSafeStorage } from '../fake-safe-storage';
import { createSecrets, type Secrets } from '../secrets';
import { type FakeMicrosoft, type FakeMicrosoftUser, SAM, startFakeMicrosoft } from './fake-microsoft-server';
import type { MicrosoftConfig } from './microsoft-sign-in';
import { createTeamsAccounts, TEAMS_SCOPES, type TeamsAccounts } from './teams-accounts';

const PRIYA: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a002',
  displayName: 'Priya Patel',
  userPrincipalName: 'priya@contoso.test',
};
const HOUR = 60 * 60_000;

let dir: string;
let microsoft: FakeMicrosoft;
let config: MicrosoftConfig;
let clock: number;
let removedItems: string[];
let secrets: Secrets;
let samId: string;

// The system browser: follows Microsoft's consent page straight back to the loopback listener.
const browser = async (url: string) => {
  await fetch(url);
};

// Commander as it starts: a fresh instance over the same files, as after a restart.
function start(overrides: { secrets?: Secrets; config?: Partial<MicrosoftConfig> } = {}): TeamsAccounts {
  return createTeamsAccounts({
    config: { ...config, ...overrides.config },
    secrets: overrides.secrets ?? secrets,
    store: createAccountStore(join(dir, 'accounts.json')),
    openBrowser: browser,
    removeItems: async ({ id }) => {
      removedItems.push(id);
    },
    now: () => clock,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commander-teams-'));
  microsoft = await startFakeMicrosoft();
  config = {
    clientId: microsoft.clientId,
    tenantId: microsoft.tenantId,
    loginUrl: microsoft.loginUrl,
    graphUrl: microsoft.graphUrl,
  };
  clock = 1_800_000_000_000;
  removedItems = [];
  secrets = createSecrets({
    safeStorage: fakeSafeStorage(),
    file: join(dir, 'secrets.json'),
    platform: 'linux',
  });
  samId = `teams:${microsoft.tenantId}:${SAM.id}`;
});

afterEach(async () => {
  await microsoft.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a build without Commander’s Microsoft app', () => {
  for (const missing of ['clientId', 'tenantId'] as const) {
    it(`does not offer Connect Teams without a ${missing}, and points to the README`, async () => {
      const accounts = start({ config: { [missing]: null } });

      expect(accounts.oauthAvailable).toBe(false);
      await expect(accounts.connectWithBrowser()).rejects.toMatchObject({ reason: 'not-configured' });
      await expect(accounts.connectWithBrowser()).rejects.toThrow(/README/);
      expect(microsoft.authorizeRequests).toEqual([]);
    });
  }

  it('never offers an API key', async () => {
    const accounts = start();

    expect(accounts.apiKeyAvailable).toBe(false);
    await expect(accounts.connectWithApiKey('anything')).rejects.toMatchObject({ reason: 'not-configured' });
  });
});

describe('Channel posts (#111)', () => {
  const channelScopes = 'ChannelMessage.Read.All ChannelMessage.Send';

  it('starts off and not granted, with the permissions to approve and the admin consent link', async () => {
    const account = await start().connectWithBrowser();
    expect(account).toMatchObject({
      channelPosts: {
        granted: false,
        enabled: false,
        permissions: ['ChannelMessage.Read.All', 'ChannelMessage.Send'],
      },
    });
  });

  it('Request access signs in again asking for the Channel post scopes too, granted but still off', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    await accounts.channelPosts?.request(samId);

    expect(microsoft.authorizeRequests.at(-1)?.scope).toBe(`${TEAMS_SCOPES.join(' ')} ${channelScopes}`);
    const [account] = await accounts.list();
    expect(account).toMatchObject({ channelPosts: { granted: true, enabled: false } });

    await accounts.channelPosts?.set(samId, true);
    expect((await accounts.list())[0]).toMatchObject({ channelPosts: { granted: true, enabled: true } });
  });

  it('shows the admin consent link when the tenant needs an administrator’s approval first', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    microsoft.requireAdminConsent('AADSTS65001');

    const refused = accounts.channelPosts?.request(samId);
    await expect(refused).rejects.toMatchObject({
      reason: 'admin-consent',
      adminConsent: {
        permissions: ['ChannelMessage.Read.All', 'ChannelMessage.Send'],
        url: `${microsoft.loginUrl}/${microsoft.tenantId}/adminconsent?client_id=${microsoft.clientId}`,
      },
    });
    expect((await accounts.list())[0]).toMatchObject({ channelPosts: { granted: false } });
  });

  it('stays not granted when Microsoft leaves out reading channels, saying an administrator must approve it', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    microsoft.limitGrantedScopes([...TEAMS_SCOPES, 'ChannelMessage.Send']);

    await expect(accounts.channelPosts?.request(samId)).rejects.toMatchObject({ reason: 'admin-consent' });
    expect((await accounts.list())[0]).toMatchObject({ channelPosts: { granted: false, enabled: false } });
    await expect(accounts.channelPosts?.set(samId, true)).rejects.toThrow(/Request access first/);
  });

  it('keeps them through a reconnect, and asks for them again on refresh', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    await accounts.channelPosts?.request(samId);
    await accounts.channelPosts?.set(samId, true);

    await accounts.connectWithBrowser({ reconnect: samId });
    expect(microsoft.authorizeRequests.at(-1)?.scope).toContain('ChannelMessage.Read.All');
    expect((await accounts.list())[0]).toMatchObject({ channelPosts: { granted: true, enabled: true } });

    clock += 2 * HOUR;
    await accounts.accessToken(samId);
    expect(microsoft.tokenRequests.at(-1)?.scope).toContain('ChannelMessage.Read.All');
  });

  it('still refreshes the Chats’ sign-in when Microsoft no longer consents to Channel posts', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    await accounts.channelPosts?.request(samId);
    microsoft.refuseRefreshScopes(['ChannelMessage.Read.All']);

    clock += 2 * HOUR;
    await expect(accounts.accessToken(samId)).resolves.toMatchObject({ kind: 'oauth' });
    expect(microsoft.tokenRequests.at(-1)?.scope).toBe(TEAMS_SCOPES.join(' '));
    expect((await accounts.list())[0]).toMatchObject({ status: 'connected' });
  });

  it('goes back to not granted and off when Microsoft refuses to share them', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    await accounts.channelPosts?.request(samId);
    await accounts.channelPosts?.set(samId, true);
    await accounts.channelPosts?.refused(samId);
    expect((await accounts.list())[0]).toMatchObject({ channelPosts: { granted: false, enabled: false } });
  });
});

describe('connecting Teams through the browser', () => {
  it('asks for the Teams scopes, and nothing that needs an admin', async () => {
    await start().connectWithBrowser();

    expect(microsoft.authorizeRequests[0]?.scope).toBe(
      'openid profile offline_access User.Read Chat.ReadWrite ChatMessage.Send Team.ReadBasic.All Channel.ReadBasic.All',
    );
    expect(TEAMS_SCOPES).not.toContain('ChannelMessage.Read.All');
  });

  it('names and keys the Account from /me, keeping the User’s Teams user id', async () => {
    const accounts = start();

    const account = await accounts.connectWithBrowser();

    const expected = {
      id: `teams:${microsoft.tenantId}:${SAM.id}`,
      source: 'teams',
      name: 'Teams · sam@contoso.test',
      userPrincipalName: 'sam@contoso.test',
      method: 'oauth',
      status: 'connected',
      user: { id: SAM.id, name: 'Sam Rivera' },
      channelPosts: {
        granted: false,
        enabled: false,
        permissions: ['ChannelMessage.Read.All', 'ChannelMessage.Send'],
        adminConsentUrl: `${microsoft.loginUrl}/${microsoft.tenantId}/adminconsent?client_id=${microsoft.clientId}`,
      },
    };
    expect(account).toEqual(expected);
    expect(await accounts.list()).toEqual([expected]);
    expect(microsoft.graphRequests).toEqual(['/v1.0/me?$select=id,displayName,userPrincipalName']);
  });

  it('survives a restart', async () => {
    await start().connectWithBrowser();
    const [accessToken] = microsoft.issuedTokens();

    const restarted = start();

    expect(await restarted.list()).toMatchObject([{ id: samId, status: 'connected' }]);
    expect(await restarted.accessToken(samId)).toEqual({ token: accessToken, kind: 'oauth' });
  });

  it('keeps one Account per user: connecting the same user again updates it', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const first = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts[0];
    clock += HOUR;

    await accounts.connectWithBrowser();

    const records = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: samId, connectedAt: first.connectedAt });
    const [, , secondAccess] = microsoft.issuedTokens();
    expect(await accounts.accessToken(samId)).toEqual({ token: secondAccess, kind: 'oauth' });
  });

  it('connects another user as a separate Account', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    microsoft.approve(PRIYA);

    await accounts.connectWithBrowser();

    expect((await accounts.list()).map((account) => account.name)).toEqual([
      'Teams · sam@contoso.test',
      'Teams · priya@contoso.test',
    ]);
  });

  it('refuses before opening the browser when there is no real keyring', async () => {
    const noKeyring = createSecrets({
      safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
      file: join(dir, 'secrets.json'),
      platform: 'linux',
    });

    await expect(start({ secrets: noKeyring }).connectWithBrowser()).rejects.toMatchObject({
      reason: 'keyring-unavailable',
    });
    expect(microsoft.authorizeRequests).toEqual([]);
  });

  it('keeps nothing when the User declines', async () => {
    microsoft.decline();
    const accounts = start();

    await expect(accounts.connectWithBrowser()).rejects.toMatchObject({ reason: 'declined' });

    expect(await accounts.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('can be cancelled while waiting for the browser', async () => {
    const accounts = createTeamsAccounts({
      config,
      secrets,
      store: createAccountStore(join(dir, 'accounts.json')),
      openBrowser: async () => {},
      removeItems: async () => {},
    });
    const connecting = accounts.connectWithBrowser();
    await expect.poll(() => accounts.signingIn).toBe(true);

    accounts.cancelSignIn();

    await expect(connecting).rejects.toMatchObject({ reason: 'cancelled' });
    expect(accounts.signingIn).toBe(false);
  });
});

describe('a tenant that needs an administrator to approve Commander', () => {
  it('explains, naming the Teams permissions and the admin consent link, and keeps nothing', async () => {
    microsoft.requireAdminConsent('AADSTS90094');
    const accounts = start();

    const connecting = accounts.connectWithBrowser();

    await expect(connecting).rejects.toMatchObject({
      reason: 'admin-consent',
      adminConsent: {
        permissions: [...TEAMS_SCOPES],
        url: `${microsoft.loginUrl}/${microsoft.tenantId}/adminconsent?client_id=${microsoft.clientId}`,
      },
    });
    await expect(connecting).rejects.toThrow(
      /administrator to approve Commander before you can connect Teams/,
    );
    expect(await accounts.list()).toEqual([]);
    expect(microsoft.authorizeRequests).toHaveLength(1);
  });
});

describe('access tokens for the Core', () => {
  it('hands over the current access token while it is fresh, without refreshing', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [accessToken] = microsoft.issuedTokens();
    clock += 45 * 60_000;

    expect(await accounts.accessToken(samId)).toEqual({ token: accessToken, kind: 'oauth' });
    expect(microsoft.refreshes).toBe(0);
  });

  it('refreshes within 10 minutes of expiry, saving the rotated refresh token before returning the access token', async () => {
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
    clock += HOUR - 9 * 60_000;

    const token = await accounts.accessToken(samId).then((result) => {
      events.push('returned');
      return result;
    });

    const [newAccess, newRefresh] = microsoft.issuedTokens().slice(-2);
    expect(microsoft.refreshes).toBe(1);
    expect(microsoft.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      scope: TEAMS_SCOPES.join(' '),
    });
    expect(token).toEqual({ token: newAccess, kind: 'oauth' });
    expect(events).toEqual([`saved ${newRefresh}`, 'returned']);
    expect(JSON.parse((await secrets.read(credentialKey(samId))) ?? '{}')).toMatchObject({
      refreshToken: newRefresh,
    });
  });

  it('refreshes only once when two requests arrive together', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    clock += HOUR - 60_000;
    microsoft.delayRefreshes(50);

    const [first, second] = await Promise.all([accounts.accessToken(samId), accounts.accessToken(samId)]);

    expect(microsoft.refreshes).toBe(1);
    expect(first).toEqual(second);
    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
  });

  it('keeps using a still-valid token when Microsoft can’t refresh just now', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [accessToken] = microsoft.issuedTokens();
    clock += HOUR - 5 * 60_000;
    microsoft.failRefreshesTemporarily(true);

    expect(await accounts.accessToken(samId)).toEqual({ token: accessToken, kind: 'oauth' });
    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
  });
});

describe('reconnecting Teams', () => {
  it('marks the Account Reconnect when Microsoft refuses a refresh for good, and says so across restarts', async () => {
    const accounts = start();
    const changed = vi.fn();
    accounts.onChange(changed);
    await accounts.connectWithBrowser();
    microsoft.revoke(SAM.id);
    clock += HOUR;

    await expect(accounts.accessToken(samId)).rejects.toMatchObject({ reason: 'needs-reconnect' });

    expect(await accounts.list()).toMatchObject([{ id: samId, status: 'needs-reconnect' }]);
    expect(changed).toHaveBeenCalled();
    await expect(start().accessToken(samId)).rejects.toMatchObject({ reason: 'needs-reconnect' });
  });

  it('restores the Account under the same identity when the User signs in again', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    microsoft.revoke(SAM.id);
    clock += HOUR;
    await accounts.accessToken(samId).catch(() => {});

    const account = await accounts.connectWithBrowser({ reconnect: samId });

    expect(account).toMatchObject({ id: samId, status: 'connected', user: { id: SAM.id } });
    expect(await accounts.list()).toHaveLength(1);
    const [newAccess] = microsoft.issuedTokens().slice(-2);
    expect(await accounts.accessToken(samId)).toEqual({ token: newAccess, kind: 'oauth' });
  });

  it('refuses a reconnect that signs in as someone else, leaving the Account as it was', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    microsoft.revoke(SAM.id);
    clock += HOUR;
    await accounts.accessToken(samId).catch(() => {});
    microsoft.approve(PRIYA);

    const reconnecting = accounts.connectWithBrowser({ reconnect: samId });

    await expect(reconnecting).rejects.toMatchObject({ reason: 'wrong-account' });
    await expect(reconnecting).rejects.toThrow(/priya@contoso\.test.*sam@contoso\.test/);
    expect(await accounts.list()).toMatchObject([{ id: samId, status: 'needs-reconnect' }]);
  });
});

describe('removing a Teams Account', () => {
  it('deletes its keyring entry and its Items, then forgets it', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    microsoft.approve(PRIYA);
    await accounts.connectWithBrowser();
    const priyaId = `teams:${microsoft.tenantId}:${PRIYA.id}`;

    await accounts.remove(samId);

    expect(removedItems).toEqual([samId]);
    expect(await secrets.read(credentialKey(samId))).toBeNull();
    expect(await secrets.read(credentialKey(priyaId))).not.toBeNull();
    expect((await accounts.list()).map((account) => account.id)).toEqual([priyaId]);
    await expect(accounts.accessToken(samId)).rejects.toMatchObject({ reason: 'unknown-account' });
  });
});

describe('keeping Teams secrets secret', () => {
  it('never puts a token in the Accounts file, the logs or what the window is shown', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void logged.push(...args));
    }
    const accounts = start();
    const shown: unknown[] = [];
    shown.push(await accounts.connectWithBrowser());
    clock += HOUR;
    await accounts.accessToken(samId);
    microsoft.revoke(SAM.id);
    clock += HOUR;
    await accounts.accessToken(samId).catch((error: unknown) => shown.push(String(error)));
    shown.push(await accounts.list());

    const accountsFile = await readFile(join(dir, 'accounts.json'), 'utf8');
    const secretsFile = await readFile(join(dir, 'secrets.json'), 'utf8');
    const everywhere = [accountsFile, secretsFile, JSON.stringify(logged), JSON.stringify(shown)].join('\n');
    expect(microsoft.issuedTokens().length).toBeGreaterThanOrEqual(4);
    for (const secret of microsoft.issuedTokens()) expect(everywhere).not.toContain(secret);
    vi.restoreAllMocks();
  });
});
