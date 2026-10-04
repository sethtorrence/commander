import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RefreshError } from '../oauth/authorization-code';
import { type DeviceCodePrompt, refreshGitHubTokens, signInWithDeviceFlow } from './device-flow';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from './fake-github-server';

// GitHub's device flow, against the fake GitHub: the code Commander shows, polling at GitHub's
// interval (slower when told), and every way it ends. Time is simulated: each wait moves the clock.

let github: FakeGitHub;
let clock: number;
let waits: number[];
let shown: DeviceCodePrompt[];
// Runs before each poll, after the wait: the User at github.com.
let meanwhile: (poll: number) => void;

beforeEach(async () => {
  github = await startFakeGitHub();
  clock = 1_800_000_000_000;
  waits = [];
  shown = [];
  meanwhile = () => {};
});

afterEach(async () => {
  await github.close();
});

function signIn(overrides: { signal?: AbortSignal; clientId?: string } = {}) {
  return signInWithDeviceFlow({
    clientId: overrides.clientId ?? github.clientId,
    webUrl: github.webUrl,
    showCode: (prompt) => shown.push(prompt),
    signal: overrides.signal,
    now: () => clock,
    sleep: async (ms, signal) => {
      waits.push(ms);
      clock += ms;
      meanwhile(waits.length);
      if (signal?.aborted) throw signal.reason;
    },
  });
}

// The User enters the shown code on GitHub before the `poll`th poll.
const approveBefore = (poll: number) => {
  meanwhile = (n) => {
    if (n === poll) github.enterCode(shown[0]?.userCode ?? '');
  };
};

describe('signing in with the device flow', () => {
  it('asks GitHub for a code with the client ID alone, and shows the User code with where to enter it', async () => {
    approveBefore(1);

    await signIn();

    expect(github.deviceCodeRequests).toEqual([{ client_id: github.clientId }]);
    expect(shown).toEqual([
      {
        userCode: github.userCodes()[0],
        verificationUri: `${github.webUrl}/login/device`,
        expiresAt: 1_800_000_000_000 + 900_000,
      },
    ]);
  });

  it('polls at GitHub’s interval until the User approves, then returns the tokens', async () => {
    approveBefore(3);

    const tokens = await signIn();

    expect(waits).toEqual([5_000, 5_000, 5_000]);
    expect(github.tokenRequests).toHaveLength(3);
    for (const request of github.tokenRequests) {
      expect(request).toEqual({
        client_id: github.clientId,
        device_code: expect.any(String),
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    }
    const [accessToken, refreshToken] = github.secrets();
    expect(tokens).toEqual({ accessToken, refreshToken, expiresAt: clock + 28_800_000 });
  });

  it('never sends a client secret', async () => {
    approveBefore(1);

    await signIn();

    for (const request of [...github.deviceCodeRequests, ...github.tokenRequests])
      expect(Object.keys(request)).not.toContain('client_secret');
  });

  it('slows down when GitHub says slow_down, and keeps the slower pace', async () => {
    github.slowDown(1);
    approveBefore(3);

    await signIn();

    expect(waits).toEqual([5_000, 10_000, 10_000]);
  });

  it('says so in plain words when the User declines on GitHub', async () => {
    meanwhile = (n) => {
      if (n === 2) github.deny();
    };

    await expect(signIn()).rejects.toMatchObject({
      reason: 'declined',
      message: expect.stringMatching(/declined.*on GitHub/),
    });
  });

  it('says the code expired when GitHub does', async () => {
    meanwhile = (n) => {
      if (n === 2) github.expire();
    };

    await expect(signIn()).rejects.toMatchObject({
      reason: 'timed-out',
      message: expect.stringMatching(/code expired/),
    });
  });

  it('stops polling once the code has run out, even if GitHub hasn’t said so', async () => {
    const failed = signIn();

    await expect(failed).rejects.toMatchObject({ reason: 'timed-out' });
    expect(waits.reduce((a, b) => a + b, 0)).toBe(900_000);
    expect(github.tokenRequests.length).toBe(179);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    meanwhile = (n) => {
      if (n === 2) controller.abort();
    };

    await expect(signIn({ signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled' });
    expect(github.tokenRequests).toHaveLength(1);
  });

  it('explains an app without device flow switched on', async () => {
    await github.close();
    github = await startFakeGitHub({ deviceFlow: false });

    await expect(signIn()).rejects.toMatchObject({
      reason: 'not-configured',
      message: expect.stringMatching(/Enable Device Flow/),
    });
  });

  it('explains a client ID GitHub doesn’t know', async () => {
    await expect(signIn({ clientId: 'Iv23liNotOurs' })).rejects.toMatchObject({
      reason: 'not-configured',
      message: expect.stringMatching(/client ID/),
    });
    expect(shown).toEqual([]);
  });

  it('never sends the User anywhere but GitHub to enter the code', async () => {
    await github.close();
    github = await startFakeGitHub({ verificationUri: 'https://github.example.net/login/device' });

    await expect(signIn()).rejects.toMatchObject({ reason: 'exchange-failed' });
    expect(shown).toEqual([]);
  });
});

describe('refreshing a GitHub sign-in', () => {
  async function signedIn() {
    approveBefore(1);
    return signIn();
  }

  it('trades the refresh token for new tokens with the client ID alone', async () => {
    const first = await signedIn();

    const next = await refreshGitHubTokens({
      clientId: github.clientId,
      webUrl: github.webUrl,
      refreshToken: first.refreshToken,
      now: () => clock,
    });

    expect(github.tokenRequests.at(-1)).toEqual({
      client_id: github.clientId,
      grant_type: 'refresh_token',
      refresh_token: first.refreshToken,
    });
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect(next.expiresAt).toBe(clock + 28_800_000);
  });

  it('fails for good when GitHub refuses the refresh token (GitHub answers 200 with an error)', async () => {
    await signedIn();
    github.revoke(OCTOCAT.id);

    const refused = refreshGitHubTokens({
      clientId: github.clientId,
      webUrl: github.webUrl,
      refreshToken: 'ghr_spent',
    });

    await expect(refused).rejects.toBeInstanceOf(RefreshError);
    await expect(refused).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/bad_refresh_token/),
    });
  });

  it('fails for now when GitHub is down', async () => {
    const first = await signedIn();
    github.failRefreshesTemporarily(true);

    await expect(
      refreshGitHubTokens({
        clientId: github.clientId,
        webUrl: github.webUrl,
        refreshToken: first.refreshToken,
      }),
    ).rejects.toMatchObject({ permanent: false });
  });

  it('never refreshes a token from an app whose tokens don’t expire, and never tries', async () => {
    await github.close();
    github = await startFakeGitHub({ tokenExpiresIn: null });
    const tokens = await signedIn();

    expect(tokens.refreshToken).toBe('');
    expect(tokens.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    await expect(
      refreshGitHubTokens({ clientId: github.clientId, webUrl: github.webUrl, refreshToken: '' }),
    ).rejects.toMatchObject({ permanent: true });
    expect(github.tokenRequests.filter((request) => request.grant_type === 'refresh_token')).toEqual([]);
  });
});
