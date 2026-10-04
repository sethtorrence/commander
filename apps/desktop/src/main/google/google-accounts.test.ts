import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountStore, credentialKey } from '../accounts/account-store';
import { fakeSafeStorage } from '../fake-safe-storage';
import { createSecrets, type Secrets } from '../secrets';
import { ALEX, type FakeGoogle, type FakeGoogleUser, startFakeGoogle } from './fake-google-server';
import { createGoogleAccounts, type GoogleAccounts } from './google-accounts';
import type { GoogleConfig } from './google-config';
import { GOOGLE_SCOPES, GOOGLE_SOURCE_SCOPES } from './google-sign-in';

const SAM: FakeGoogleUser = { sub: '109876543210987654321', email: 'sam@acme.test', name: 'Sam Rivera' };
const HOUR = 60 * 60_000;
const GMAIL = 'https://www.googleapis.com/auth/gmail.modify';
const CALENDAR_EVENTS = 'https://www.googleapis.com/auth/calendar.events';

let dir: string;
let google: FakeGoogle;
let config: GoogleConfig;
let clock: number;
let removedItems: string[];
let secrets: Secrets;
const alexId = `google:${ALEX.sub}`;

// The system browser: follows Google's consent page straight back to the loopback listener.
const browser = async (url: string) => {
  await fetch(url);
};

// Commander as it starts: a fresh instance over the same files, as after a restart.
function start(overrides: { secrets?: Secrets; config?: Partial<GoogleConfig> } = {}): GoogleAccounts {
  return createGoogleAccounts({
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
  dir = await mkdtemp(join(tmpdir(), 'commander-google-'));
  google = await startFakeGoogle();
  config = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    calendarUrl: google.calendarUrl,
    gmailUrl: google.gmailUrl,
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
  await google.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a build without Commander’s Google client', () => {
  it('does not offer Connect Google, and points to the README', async () => {
    const accounts = start({ config: { clientId: null, clientSecret: null } });

    expect(accounts.oauthAvailable).toBe(false);
    expect(accounts.apiKeyAvailable).toBe(false);
    await expect(accounts.connectWithBrowser()).rejects.toMatchObject({ reason: 'not-configured' });
    await expect(accounts.connectWithBrowser()).rejects.toThrow(/README/);
    expect(google.authorizeRequests).toEqual([]);
  });
});

describe('connecting Google through the browser', () => {
  it('signs in with PKCE on a 127.0.0.1 loopback, asking for offline access and every permission at once', async () => {
    await start().connectWithBrowser();

    const [authorize] = google.authorizeRequests;
    expect(authorize).toMatchObject({
      client_id: google.clientId,
      response_type: 'code',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });
    expect(authorize?.scope?.split(' ')).toEqual([...GOOGLE_SCOPES]);
    expect(google.tokenRequests[0]).toMatchObject({
      grant_type: 'authorization_code',
      client_secret: google.clientSecret,
      code_verifier: expect.stringMatching(/^[\w-]{43}$/),
    });
  });

  it('asks for the least Gmail and Calendar permissions M5 and M6 need, never full mail access', () => {
    expect(GOOGLE_SCOPES).toEqual([
      'openid',
      'email',
      'profile',
      GMAIL,
      CALENDAR_EVENTS,
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.app.created',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ]);
    expect(GOOGLE_SCOPES).not.toContain('https://mail.google.com/');
    expect(GOOGLE_SOURCE_SCOPES.gmail).toEqual([GMAIL]);
  });

  it('names the Account after its address and keys it by the ID token’s sub, with Gmail and Google Calendar on', async () => {
    const accounts = start();

    const account = await accounts.connectWithBrowser();

    const expected = {
      id: alexId,
      source: 'google',
      name: 'Google · alex@gmail.test',
      email: 'alex@gmail.test',
      method: 'oauth',
      status: 'connected',
      user: { id: ALEX.sub, name: 'Alex Kim' },
      sources: [
        { source: 'gmail', granted: true, enabled: true },
        { source: 'google-calendar', granted: true, enabled: true },
      ],
    };
    expect(account).toEqual(expected);
    expect(await accounts.list()).toEqual([expected]);
  });

  it('survives a restart', async () => {
    await start().connectWithBrowser();
    const [accessToken] = google.issuedTokens();

    const restarted = start();

    expect(await restarted.list()).toMatchObject([{ id: alexId, status: 'connected' }]);
    expect(await restarted.accessToken(alexId)).toEqual({ token: accessToken, kind: 'oauth' });
  });

  it('keeps one Account per Google identity: connecting it again updates it', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const first = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts[0];
    clock += HOUR;

    await accounts.connectWithBrowser();

    const records = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: alexId, connectedAt: first.connectedAt });
    const newAccess = google.issuedTokens().at(-2);
    expect(await accounts.accessToken(alexId)).toEqual({ token: newAccess, kind: 'oauth' });
  });

  it('connects another Google identity as a second Account', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    google.approve(SAM);

    await accounts.connectWithBrowser();

    expect((await accounts.list()).map((account) => account.name)).toEqual([
      'Google · alex@gmail.test',
      'Google · sam@acme.test',
    ]);
  });

  it('keeps nothing when the User declines', async () => {
    google.decline();
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
    expect(google.authorizeRequests).toEqual([]);
  });
});

describe('permissions the User unticked', () => {
  it('leave that Source off, needing access, while the rest of the Account works', async () => {
    google.untick([GMAIL]);
    const accounts = start();

    const account = await accounts.connectWithBrowser();

    expect(account).toMatchObject({
      status: 'connected',
      sources: [
        { source: 'gmail', granted: false, enabled: false },
        { source: 'google-calendar', granted: true, enabled: true },
      ],
    });
  });

  it('turn the Calendar off when any of its permissions is missing', async () => {
    google.untick([CALENDAR_EVENTS]);

    const account = await start().connectWithBrowser();

    expect(account).toMatchObject({
      sources: [
        { source: 'gmail', granted: true, enabled: true },
        { source: 'google-calendar', granted: false, enabled: false },
      ],
    });
  });

  it('switch on once granted by signing in again for the same Account', async () => {
    google.untick([GMAIL]);
    const accounts = start();
    await accounts.connectWithBrowser();
    google.untick([]);

    const account = await accounts.connectWithBrowser({ reconnect: alexId });

    expect(account).toMatchObject({
      id: alexId,
      sources: [
        { source: 'gmail', granted: true, enabled: true },
        { source: 'google-calendar', granted: true, enabled: true },
      ],
    });
    expect(await accounts.list()).toHaveLength(1);
  });

  it('refuse Grant access that signs in as someone else', async () => {
    google.untick([GMAIL]);
    const accounts = start();
    await accounts.connectWithBrowser();
    google.untick([]);
    google.approve(SAM);

    const granting = accounts.connectWithBrowser({ reconnect: alexId });

    await expect(granting).rejects.toMatchObject({ reason: 'wrong-account' });
    await expect(granting).rejects.toThrow(/sam@acme\.test.*alex@gmail\.test/);
  });
});

describe('switching a Source on and off', () => {
  it('keeps the User’s choice, also across a new sign-in', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();

    await accounts.setSourceEnabled(alexId, 'gmail', false);
    expect(await start().list()).toMatchObject([
      {
        sources: [
          { source: 'gmail', enabled: false },
          { source: 'google-calendar', enabled: true },
        ],
      },
    ]);

    await accounts.connectWithBrowser();
    expect(await accounts.list()).toMatchObject([
      {
        sources: [
          { source: 'gmail', enabled: false },
          { source: 'google-calendar', enabled: true },
        ],
      },
    ]);
  });

  it('won’t switch on a Source that hasn’t been granted', async () => {
    google.untick([GMAIL]);
    const accounts = start();
    await accounts.connectWithBrowser();

    await expect(accounts.setSourceEnabled(alexId, 'gmail', true)).rejects.toThrow(/Grant access/);
    expect(await accounts.list()).toMatchObject([{ sources: [{ source: 'gmail', enabled: false }, {}] }]);
  });
});

describe('a Workspace whose admin has blocked Commander', () => {
  for (const error of ['admin_policy_enforced', 'org_internal'] as const) {
    it(`says so plainly (${error}), and keeps nothing`, async () => {
      google.block(error);
      const accounts = start();

      const connecting = accounts.connectWithBrowser();

      await expect(connecting).rejects.toMatchObject({ reason: 'admin-blocked' });
      await expect(connecting).rejects.toThrow(
        'Your Google Workspace admin hasn’t allowed Commander. Ask them to allow it, or connect a personal account.',
      );
      expect(await accounts.list()).toEqual([]);
    });
  }
});

describe('access tokens for the Core', () => {
  it('hands over the current access token while it is fresh, without refreshing', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [accessToken] = google.issuedTokens();
    clock += 45 * 60_000;

    expect(await accounts.accessToken(alexId)).toEqual({ token: accessToken, kind: 'oauth' });
    expect(google.refreshes).toBe(0);
  });

  it('refreshes within 10 minutes of expiry with the client secret, keeping the refresh token Google doesn’t replace', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [, refreshToken] = google.issuedTokens();
    clock += HOUR - 9 * 60_000;

    const token = await accounts.accessToken(alexId);

    expect(google.refreshes).toBe(1);
    expect(google.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_secret: google.clientSecret,
    });
    expect(token).toEqual({ token: google.issuedTokens().at(-1), kind: 'oauth' });
    expect(JSON.parse((await secrets.read(credentialKey(alexId))) ?? '{}')).toMatchObject({ refreshToken });

    // And again, with the same refresh token.
    clock += HOUR;
    await accounts.accessToken(alexId);
    expect(google.refreshes).toBe(2);
  });

  it('refreshes only once when two requests arrive together', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    clock += HOUR - 60_000;

    const [first, second] = await Promise.all([accounts.accessToken(alexId), accounts.accessToken(alexId)]);

    expect(google.refreshes).toBe(1);
    expect(first).toEqual(second);
  });

  it('marks the Account Reconnect when Google refuses a refresh for good (invalid_grant)', async () => {
    const accounts = start();
    const changed = vi.fn();
    accounts.onChange(changed);
    await accounts.connectWithBrowser();
    google.revoke(ALEX.sub);
    clock += HOUR;

    await expect(accounts.accessToken(alexId)).rejects.toMatchObject({ reason: 'needs-reconnect' });

    expect(await accounts.list()).toMatchObject([{ id: alexId, status: 'needs-reconnect' }]);
    expect(changed).toHaveBeenCalled();
    await expect(start().accessToken(alexId)).rejects.toMatchObject({ reason: 'needs-reconnect' });

    const reconnected = await accounts.connectWithBrowser({ reconnect: alexId });
    expect(reconnected).toMatchObject({ id: alexId, status: 'connected' });
  });

  it('keeps using a still-valid token when Google can’t refresh just now', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    const [accessToken] = google.issuedTokens();
    clock += HOUR - 5 * 60_000;
    google.failRefreshesTemporarily(true);

    expect(await accounts.accessToken(alexId)).toEqual({ token: accessToken, kind: 'oauth' });
    expect(await accounts.list()).toMatchObject([{ status: 'connected' }]);
  });
});

describe('removing a Google Account', () => {
  it('deletes its keyring entry and its Items, then forgets it', async () => {
    const accounts = start();
    await accounts.connectWithBrowser();
    google.approve(SAM);
    await accounts.connectWithBrowser();
    const samId = `google:${SAM.sub}`;

    await accounts.remove(alexId);

    expect(removedItems).toEqual([alexId]);
    expect(await secrets.read(credentialKey(alexId))).toBeNull();
    expect(await secrets.read(credentialKey(samId))).not.toBeNull();
    expect((await accounts.list()).map((account) => account.id)).toEqual([samId]);
  });
});

describe('keeping Google secrets secret', () => {
  it('never puts a token or the client secret in the Accounts file, the logs or what the window is shown', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void logged.push(...args));
    }
    const accounts = start();
    const shown: unknown[] = [];
    shown.push(await accounts.connectWithBrowser());
    clock += HOUR;
    await accounts.accessToken(alexId);
    google.revoke(ALEX.sub);
    clock += HOUR;
    await accounts.accessToken(alexId).catch((error: unknown) => shown.push(String(error)));
    shown.push(await accounts.list());

    const accountsFile = await readFile(join(dir, 'accounts.json'), 'utf8');
    const secretsFile = await readFile(join(dir, 'secrets.json'), 'utf8');
    const everywhere = [accountsFile, secretsFile, JSON.stringify(logged), JSON.stringify(shown)].join('\n');
    expect(google.issuedTokens().length).toBeGreaterThanOrEqual(3);
    for (const secret of [...google.issuedTokens(), google.clientSecret])
      expect(everywhere).not.toContain(secret);
    vi.restoreAllMocks();
  });
});
