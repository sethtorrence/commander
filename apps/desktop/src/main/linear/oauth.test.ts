import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { challengeFor } from '../oauth/pkce';
import { ACME, type FakeLinear, startFakeLinear } from './fake-linear-server';
import { type OAuthClient, RefreshError, refreshTokens, signInWithBrowser } from './oauth';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The system browser, as far as the sign-in is concerned: it follows Linear's redirect back to
// Commander's loopback listener.
const browser = async (url: string) => {
  await fetch(url);
};

let linear: FakeLinear;
let client: OAuthClient;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  linear = await startFakeLinear();
  client = {
    clientId: linear.clientId,
    port: await freePort(),
    authorizeUrl: linear.authorizeUrl,
    tokenUrl: linear.tokenUrl,
  };
});

afterEach(async () => {
  await linear.close();
});

describe('signing in through the browser', () => {
  it('asks Linear for read and write with a PKCE S256 challenge and a fresh state, and no client secret', async () => {
    await signInWithBrowser({ client, openBrowser: browser, now: () => NOW });

    const [authorize] = linear.authorizeRequests;
    expect(authorize).toMatchObject({
      client_id: linear.clientId,
      redirect_uri: `http://localhost:${client.port}/callback`,
      response_type: 'code',
      scope: 'read,write',
      code_challenge_method: 'S256',
    });
    expect(authorize?.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const [exchange] = linear.tokenRequests;
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', client_id: linear.clientId });
    expect(exchange).not.toHaveProperty('client_secret');
    // The verifier went only to the token endpoint, and it matches the challenge the browser carried.
    expect(challengeFor(exchange?.code_verifier ?? '')).toBe(authorize?.code_challenge);
    expect(JSON.stringify(authorize)).not.toContain(exchange?.code_verifier);
  });

  it('exchanges the code for tokens that expire when Linear says', async () => {
    const tokens = await signInWithBrowser({ client, openBrowser: browser, now: () => NOW });

    const [accessToken, refreshToken] = linear.issuedTokens();
    expect(tokens).toEqual({ accessToken, refreshToken, expiresAt: NOW + 86_399_000 });
  });

  it('uses a different state and verifier for every sign-in', async () => {
    await signInWithBrowser({ client, openBrowser: browser });
    await signInWithBrowser({ client, openBrowser: browser });

    const [first, second] = linear.authorizeRequests;
    expect(first?.state).not.toBe(second?.state);
    expect(first?.code_challenge).not.toBe(second?.code_challenge);
  });

  it('refuses a browser reply carrying someone else’s state, without exchanging any code', async () => {
    const forger = async (url: string) => {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
      redirect.search = new URLSearchParams({ code: 'forged', state: 'not-ours' }).toString();
      await fetch(redirect);
    };

    await expect(signInWithBrowser({ client, openBrowser: forger })).rejects.toMatchObject({
      reason: 'state-mismatch',
    });
    expect(linear.tokenRequests).toEqual([]);
  });

  it('reports that the User declined', async () => {
    linear.decline();

    await expect(signInWithBrowser({ client, openBrowser: browser })).rejects.toMatchObject({
      reason: 'declined',
    });
  });

  it('closes the loopback listener once the sign-in is over', async () => {
    await signInWithBrowser({ client, openBrowser: browser });

    await expect(fetch(`http://127.0.0.1:${client.port}/callback`)).rejects.toThrow();
  });

  it('closes the listener when the browser cannot be opened', async () => {
    const broken = async () => {
      throw new Error('no browser');
    };

    await expect(signInWithBrowser({ client, openBrowser: broken })).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${client.port}/callback`)).rejects.toThrow();
  });

  it('fails clearly when Linear rejects the code exchange', async () => {
    const wrongClient = { ...client, clientId: 'someone-elses-app' };

    await expect(signInWithBrowser({ client: wrongClient, openBrowser: browser })).rejects.toMatchObject({
      reason: 'exchange-failed',
    });
  });

  it('can be cancelled while waiting for the browser', async () => {
    const controller = new AbortController();
    const signingIn = signInWithBrowser({ client, openBrowser: async () => {}, signal: controller.signal });

    controller.abort();

    await expect(signingIn).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(fetch(`http://127.0.0.1:${client.port}/callback`)).rejects.toThrow();
  });
});

describe('refreshing tokens', () => {
  it('trades the refresh token for a new pair, which Linear rotates', async () => {
    const first = await signInWithBrowser({ client, openBrowser: browser, now: () => NOW });

    const second = await refreshTokens({ client, refreshToken: first.refreshToken, now: () => NOW + 1000 });

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.expiresAt).toBe(NOW + 1000 + 86_399_000);
    expect(linear.tokenRequests.at(-1)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: first.refreshToken,
      client_id: linear.clientId,
    });
  });

  it('fails for good when Linear rejects the refresh token', async () => {
    const first = await signInWithBrowser({ client, openBrowser: browser });
    linear.revoke(ACME.id);

    const refreshing = refreshTokens({ client, refreshToken: first.refreshToken });

    await expect(refreshing).rejects.toBeInstanceOf(RefreshError);
    await expect(refreshing).rejects.toMatchObject({ permanent: true });
  });

  it('fails only for now when Linear is unavailable', async () => {
    const first = await signInWithBrowser({ client, openBrowser: browser });
    linear.failRefreshesTemporarily(true);

    await expect(refreshTokens({ client, refreshToken: first.refreshToken })).rejects.toMatchObject({
      permanent: false,
    });
  });

  it('fails only for now when Linear cannot be reached', async () => {
    const unreachable = { ...client, tokenUrl: `http://127.0.0.1:${await freePort()}/oauth/token` };

    await expect(refreshTokens({ client: unreachable, refreshToken: 'whatever' })).rejects.toMatchObject({
      permanent: false,
    });
  });
});
