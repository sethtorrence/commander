import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountStore, credentialKey } from '../accounts/account-store';
import { fakeSafeStorage } from '../fake-safe-storage';
import { createSecrets, type Secrets } from '../secrets';
import { type FakeMicrosoft, type FakeMicrosoftUser, SAM, startFakeMicrosoft } from './fake-microsoft-server';
import type { MicrosoftConfig } from './microsoft-sign-in';
import {
  createOutlookAccounts,
  grantedOutlookSources,
  OUTLOOK_SCOPES,
  type OutlookAccounts,
  PERSONAL_ACCOUNTS_TENANT,
} from './outlook-accounts';

const PRIYA: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a002',
  displayName: 'Priya Patel',
  userPrincipalName: 'priya@contoso.test',
};
const HOUR = 60 * 60_000;
const BOTH_ON = [
  { source: 'outlook', granted: true, enabled: true },
  { source: 'outlook-calendar', granted: true, enabled: true },
];

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
function start(overrides: { secrets?: Secrets; config?: Partial<MicrosoftConfig> } = {}): OutlookAccounts {
  return createOutlookAccounts({
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
  dir = await mkdtemp(join(tmpdir(), 'commander-outlook-'));
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
  samId = `outlook:${microsoft.tenantId}:${SAM.id}`;
});

afterEach(async () => {
  await microsoft.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a build without Commander’s Microsoft app', () => {
  for (const missing of ['clientId', 'tenantId'] as const) {
    it(`does not offer Connect Outlook without a ${missing}, and points to the README`, async () => {
      const accounts = start({ config: { [missing]: null } });

      expect(accounts.oauthAvailable).toBe(false);
      expect(accounts.apiKeyAvailable).toBe(false);
      await expect(accounts.connectWithBrowser()).rejects.toMatchObject({ reason: 'not-configured' });
      await expect(accounts.connectWithBrowser()).rejects.toThrow(/“Connecting Outlook” in the README/);
      expect(microsoft.authorizeRequests).toEqual([]);
    });
  }
});

describe('connecting Outlook through the browser', () => {
  it('signs in with PKCE on the localhost loopback, asking for mail and calendar together', async () => {
    await start().connectWithBrowser();

    expect(microsoft.authorizeRequests).toMatchObject([
      {
        client_id: microsoft.clientId,
        code_challenge_method: 'S256',
        redirect_uri: expect.stringMatching(/^http:\/\/localhost:\d+$/),
        scope: 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite',
      },
    ]);
  });

  it('never asks for MailboxSettings.ReadWrite at sign-in (Bucket mirroring asks for it later)', () => {
    expect(OUTLOOK_SCOPES.some((scope) => /MailboxSettings/i.test(scope))).toBe(false);
  });

  it('names and keys the Account from /me, with Outlook and Outlook Calendar on', async () => {
    const accounts = start();

    const account = await accounts.connectWithBrowser();

    const expected = {
      id: samId,
      source: 'outlook',
      name: 'Outlook · sam@contoso.test',
      userPrincipalName: 'sam@contoso.test',
      method: 'oauth',
      status: 'connected',
      user: { id: SAM.id, name: 'Sam Rivera' },
      sources: BOTH_ON,
      // A work account: Outlook on the web is outlook.office.com.
      personal: false,
    };
    expect(account).toEqual(expected);
    expect(await accounts.list()).toEqual([expected]);
    expect(microsoft.graphRequests).toEqual(['/v1.0/me?$select=id,displayName,userPrincipalName']);
  });

  it('marks a personal Microsoft account (signed in through the consumer tenant) as personal', async () => {
    await microsoft.close();
    microsoft = await startFakeMicrosoft({ tenantId: PERSONAL_ACCOUNTS_TENANT });
    config = {
      ...config,
      tenantId: microsoft.tenantId,
      loginUrl: microsoft.loginUrl,
      graphUrl: microsoft.graphUrl,
    };
    const account = await start().connectWithBrowser();
    expect(account).toMatchObject({ source: 'outlook', personal: true });
  });

  it('survives a restart', async () => {
    await start().connectWithBrowser();
    const [accessToken] = microsoft.issuedTokens();

    const restarted = start();

    expect(await restarted.list()).toMatchObject([{ id: samId, status: 'connected', sources: BOTH_ON }]);
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
      'Outlook · sam@contoso.test',
      'Outlook · priya@contoso.test',
    ]);
  });

  it('keeps nothing when the User declines', async () => {
    microsoft.decline();
    const accounts = start();

    await expect(accounts.connectWithBrowser()).rejects.toMatchObject({ reason: 'declined' });

    expect(await accounts.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
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
});

describe('which Sources a sign-in covers', () => {
  it('reads the token’s scope as Microsoft writes it, in any case and with or without Graph’s address', () => {
    expect(
      grantedOutlookSources('Calendars.ReadWrite Mail.ReadWrite Mail.Send User.Read profile openid'),
    ).toEqual(['outlook', 'outlook-calendar']);
    expect(
      grantedOutlookSources(
        'https://graph.microsoft.com/mail.readwrite https://graph.microsoft.com/mail.send https://graph.microsoft.com/User.Read',
      ),
    ).toEqual(['outlook']);
    expect(grantedOutlookSources('Mail.ReadWrite Calendars.ReadWrite')).toEqual(['outlook-calendar']);
  });

  it('takes every Source as granted when Microsoft doesn’t say', () => {
    expect(grantedOutlookSources(undefined)).toEqual(['outlook', 'outlook-calendar']);
  });

  it('leaves a Source Microsoft didn’t grant off, with Grant access, while the other works', async () => {
    microsoft.limitGrantedScopes(['openid', 'profile', 'offline_access', 'User.Read', 'Calendars.ReadWrite']);
    const accounts = start();

    const account = await accounts.connectWithBrowser();

    expect(account).toMatchObject({
      sources: [
        { source: 'outlook', granted: false, enabled: false },
        { source: 'outlook-calendar', granted: true, enabled: true },
      ],
    });
    await expect(accounts.setSourceEnabled(samId, 'outlook', true)).rejects.toThrow(/Grant access/);

    microsoft.limitGrantedScopes(null);
    await accounts.connectWithBrowser({ reconnect: samId });

    expect(await accounts.list()).toMatchObject([{ id: samId, sources: BOTH_ON }]);
  });
});

describe('switching Outlook mail and calendar on and off', () => {
  it('keeps the User’s choice, also across a new sign-in', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();

    await accounts.setSourceEnabled(samId, 'outlook-calendar', false);
    await accounts.connectWithBrowser();

    expect(await start().list()).toMatchObject([
      {
        sources: [
          { source: 'outlook', granted: true, enabled: true },
          { source: 'outlook-calendar', granted: true, enabled: false },
        ],
      },
    ]);
  });
});

describe('a tenant that needs an administrator to approve Commander', () => {
  for (const [code, where] of [
    ['AADSTS90094', 'redirect'],
    ['AADSTS65001', 'token'],
  ] as const) {
    it(`explains ${code} (at the ${where}), naming the mail and calendar permissions and the admin consent link, and keeps nothing`, async () => {
      microsoft.requireAdminConsent(code, where);
      const accounts = start();

      const connecting = accounts.connectWithBrowser();

      await expect(connecting).rejects.toMatchObject({
        reason: 'admin-consent',
        adminConsent: {
          permissions: expect.arrayContaining(['Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite']),
          url: `${microsoft.loginUrl}/${microsoft.tenantId}/adminconsent?client_id=${microsoft.clientId}`,
        },
      });
      await expect(connecting).rejects.toThrow(
        /administrator to approve Commander before you can connect Outlook mail and calendar/,
      );
      expect(await accounts.list()).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
    });
  }
});

describe('access tokens for the Core', () => {
  it('refreshes within 10 minutes of expiry with the mail and calendar scopes, saving the rotated refresh token first', async () => {
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
    expect(microsoft.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      scope: OUTLOOK_SCOPES.join(' '),
    });
    expect(token).toEqual({ token: newAccess, kind: 'oauth' });
    expect(events).toEqual([`saved ${newRefresh}`, 'returned']);
  });

  it('refreshes only once when two requests arrive together', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    clock += HOUR - 60_000;
    microsoft.delayRefreshes(50);

    const [first, second] = await Promise.all([accounts.accessToken(samId), accounts.accessToken(samId)]);

    expect(microsoft.refreshes).toBe(1);
    expect(first).toEqual(second);
  });
});

describe('reconnecting Outlook', () => {
  it('marks the Account Reconnect when Microsoft refuses a refresh for good, keeping both Sources as they were', async () => {
    const accounts = start();
    const changed = vi.fn();
    accounts.onChange(changed);
    await accounts.connectWithBrowser();
    microsoft.revoke(SAM.id);
    clock += HOUR;

    await expect(accounts.accessToken(samId)).rejects.toMatchObject({ reason: 'needs-reconnect' });

    expect(await accounts.list()).toMatchObject([{ id: samId, status: 'needs-reconnect', sources: BOTH_ON }]);
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

    expect(account).toMatchObject({ id: samId, status: 'connected', user: { id: SAM.id }, sources: BOTH_ON });
    expect(await accounts.list()).toHaveLength(1);
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
    await expect(reconnecting).rejects.toThrow(/priya@contoso\.test.*sam@contoso\.test.*Connect Outlook/);
    expect(await accounts.list()).toMatchObject([{ id: samId, status: 'needs-reconnect' }]);
  });
});

describe('removing an Outlook Account', () => {
  it('deletes its keyring entry and its Items, then forgets it', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    microsoft.approve(PRIYA);
    await accounts.connectWithBrowser();
    const priyaId = `outlook:${microsoft.tenantId}:${PRIYA.id}`;

    await accounts.remove(samId);

    expect(removedItems).toEqual([samId]);
    expect(await secrets.read(credentialKey(samId))).toBeNull();
    expect(await secrets.read(credentialKey(priyaId))).not.toBeNull();
    expect((await accounts.list()).map((account) => account.id)).toEqual([priyaId]);
  });
});

describe('keeping Outlook secrets secret', () => {
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
