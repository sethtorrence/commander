import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { challengeFor } from '../oauth/pkce';
import { type FakeMicrosoft, startFakeMicrosoft } from './fake-microsoft-server';
import {
  adminConsentUrl,
  type MicrosoftApp,
  RefreshError,
  refreshMicrosoftTokens,
  signInWithMicrosoft,
} from './microsoft-sign-in';

// The system browser, as far as the sign-in is concerned: it follows Microsoft's redirect back to
// Commander's loopback listener.
const browser = async (url: string) => {
  await fetch(url);
};

const SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'Chat.ReadWrite'];
const NOW = 1_800_000_000_000;

let microsoft: FakeMicrosoft;
let app: MicrosoftApp;

async function isListening(redirectUri: string): Promise<boolean> {
  try {
    await fetch(redirectUri.replace('localhost', '127.0.0.1'));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  microsoft = await startFakeMicrosoft();
  app = { clientId: microsoft.clientId, tenantId: microsoft.tenantId, loginUrl: microsoft.loginUrl };
});

afterEach(async () => {
  await microsoft.close();
});

const signIn = (overrides: Partial<Parameters<typeof signInWithMicrosoft>[0]> = {}) =>
  signInWithMicrosoft({
    app,
    scopes: SCOPES,
    sourceName: 'Teams',
    openBrowser: browser,
    now: () => NOW,
    ...overrides,
  });

describe('signing in with Microsoft through the browser', () => {
  it('asks the tenant’s authority for the Source’s scopes, with a PKCE S256 challenge, a fresh state and no secret', async () => {
    await signIn();

    const [authorize] = microsoft.authorizeRequests;
    expect(authorize).toMatchObject({
      client_id: microsoft.clientId,
      response_type: 'code',
      scope: SCOPES.join(' '),
      code_challenge_method: 'S256',
    });
    expect(authorize?.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const [exchange] = microsoft.tokenRequests;
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', client_id: microsoft.clientId });
    expect(exchange).not.toHaveProperty('client_secret');
    expect(challengeFor(exchange?.code_verifier ?? '')).toBe(authorize?.code_challenge);
    expect(JSON.stringify(authorize)).not.toContain(exchange?.code_verifier);
  });

  it('redirects to http://localhost on a port the system picked, with no path, for both the browser and the exchange', async () => {
    await signIn();

    const [authorize] = microsoft.authorizeRequests;
    expect(authorize?.redirect_uri).toMatch(/^http:\/\/localhost:\d+$/);
    expect(microsoft.tokenRequests[0]?.redirect_uri).toBe(authorize?.redirect_uri);
  });

  it('uses a new port, state and verifier for every sign-in', async () => {
    await signIn();
    await signIn();

    const [first, second] = microsoft.authorizeRequests;
    expect(first?.state).not.toBe(second?.state);
    expect(first?.code_challenge).not.toBe(second?.code_challenge);
  });

  it('exchanges the code for tokens that expire when Microsoft says, and learns the tenant from the ID token and the scopes granted', async () => {
    const signedIn = await signIn();

    const [accessToken, refreshToken] = microsoft.issuedTokens();
    expect(signedIn).toEqual({
      accessToken,
      refreshToken,
      expiresAt: NOW + 3_599_000,
      tenantId: microsoft.tenantId,
      scope: SCOPES.join(' '),
    });
  });

  it('closes the loopback listener once the sign-in is over', async () => {
    await signIn();

    expect(await isListening(microsoft.authorizeRequests[0]?.redirect_uri ?? '')).toBe(false);
  });

  it('refuses a browser reply carrying someone else’s state, without exchanging any code', async () => {
    const forger = async (url: string) => {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
      redirect.search = new URLSearchParams({ code: 'forged', state: 'not-ours' }).toString();
      await fetch(redirect);
    };

    await expect(signIn({ openBrowser: forger })).rejects.toMatchObject({ reason: 'state-mismatch' });
    expect(microsoft.tokenRequests).toEqual([]);
    expect(await isListening(microsoft.authorizeRequests[0]?.redirect_uri ?? '')).toBe(false);
  });

  it('reports that the User declined', async () => {
    microsoft.decline();

    await expect(signIn()).rejects.toMatchObject({ reason: 'declined' });
  });

  it('can be cancelled while waiting for the browser, closing the listener', async () => {
    const controller = new AbortController();
    let redirectUri = '';
    const opened = async (url: string) => {
      redirectUri = new URL(url).searchParams.get('redirect_uri') ?? '';
    };
    const signingIn = signIn({ openBrowser: opened, signal: controller.signal });
    await expect.poll(() => redirectUri).not.toBe('');

    controller.abort();

    await expect(signingIn).rejects.toMatchObject({ reason: 'cancelled' });
    expect(await isListening(redirectUri)).toBe(false);
  });

  it('fails clearly when Microsoft rejects the code exchange', async () => {
    await expect(
      signIn({
        app: { ...app, clientId: 'someone-elses-app' },
        openBrowser: async (url) => {
          // Microsoft would show its own error page; the browser never comes back.
          const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
          redirect.search = new URLSearchParams({
            code: 'stolen',
            state: new URL(url).searchParams.get('state') ?? '',
          }).toString();
          await fetch(redirect);
        },
      }),
    ).rejects.toMatchObject({ reason: 'exchange-failed' });
  });
});

describe('a tenant that needs an administrator to approve Commander', () => {
  for (const [code, where] of [
    ['AADSTS90094', 'redirect'],
    ['AADSTS65001', 'redirect'],
    ['AADSTS65001', 'token'],
  ] as const) {
    it(`explains ${code} (at the ${where}), naming the permissions and the tenant’s admin consent link`, async () => {
      microsoft.requireAdminConsent(code, where);

      const signingIn = signIn();

      await expect(signingIn).rejects.toMatchObject({
        reason: 'admin-consent',
        adminConsent: { permissions: SCOPES, url: adminConsentUrl(app) },
      });
      await expect(signingIn).rejects.toThrow(/administrator/);
    });
  }

  it('links to the tenant’s admin consent page for this app', () => {
    const url = new URL(adminConsentUrl(app));

    expect(`${url.origin}${url.pathname}`).toBe(`${microsoft.loginUrl}/${microsoft.tenantId}/adminconsent`);
    expect(url.searchParams.get('client_id')).toBe(microsoft.clientId);
  });
});

describe('refreshing Microsoft tokens', () => {
  it('trades the refresh token for a new pair, asking for the same scopes', async () => {
    const first = await signIn();

    const second = await refreshMicrosoftTokens({
      app,
      scopes: SCOPES,
      refreshToken: first.refreshToken,
      now: () => NOW + 1000,
    });

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.expiresAt).toBe(NOW + 1000 + 3_599_000);
    expect(microsoft.tokenRequests.at(-1)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: first.refreshToken,
      client_id: microsoft.clientId,
      scope: SCOPES.join(' '),
    });
  });

  it('fails for good when Microsoft answers invalid_grant', async () => {
    const first = await signIn();
    microsoft.revoke('6f1c2a40-0000-4000-8000-00000000a001');

    const refreshing = refreshMicrosoftTokens({ app, scopes: SCOPES, refreshToken: first.refreshToken });

    await expect(refreshing).rejects.toBeInstanceOf(RefreshError);
    await expect(refreshing).rejects.toMatchObject({ permanent: true });
  });

  it('fails only for now when Microsoft is unavailable', async () => {
    const first = await signIn();
    microsoft.failRefreshesTemporarily(true);

    await expect(
      refreshMicrosoftTokens({ app, scopes: SCOPES, refreshToken: first.refreshToken }),
    ).rejects.toMatchObject({ permanent: false });
  });
});
