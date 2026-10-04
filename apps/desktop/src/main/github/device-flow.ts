import type { DeviceCodePrompt } from '@commander/domain/ipc';
import { z } from 'zod';
import { RefreshError, type TokenSet } from '../oauth/authorization-code';
import { SignInError } from '../oauth/sign-in-error';

// Signing in to Commander's GitHub App with the OAuth device flow, which needs no loopback listener
// and no client secret: GitHub hands out a short User code, the User types it at
// github.com/login/device, and Commander polls GitHub's token endpoint at the interval GitHub asks
// for (slower each time it says slow_down) until the User approves, declines or the code runs out.
// User tokens last 8 hours; their refresh tokens (6 months) rotate on every refresh, which needs the
// client ID alone too. GitHub answers its OAuth errors with HTTP 200 and an `error` field.

export type { DeviceCodePrompt };

export type GitHubApp = { clientId: string; webUrl: string };

// Waits `ms`, or rejects with the signal's reason once it is aborted.
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// RFC 8628: poll every 5 seconds unless told otherwise, and 5 seconds slower after each slow_down.
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_S = 5;

const deviceCodeResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  expires_in: z.number().positive(),
  interval: z.number().nonnegative().optional(),
});

const tokenResponse = z.object({
  access_token: z.string().min(1),
  // Absent when the app has "Expire user authorization tokens" switched off.
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().optional(),
});

const errorResponse = z.object({ error: z.string().min(1), interval: z.number().positive().optional() });

const cancelled = () => new SignInError('cancelled', 'The GitHub sign-in was cancelled.');

const abortableSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });

async function post(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    signal,
  });
}

function readTokens(body: unknown, now: number): TokenSet | null {
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) return null;
  const { access_token, refresh_token, expires_in } = parsed.data;
  // Tokens that never expire are never refreshed.
  if (!refresh_token || !expires_in)
    return { accessToken: access_token, refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER };
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: now + expires_in * 1000 };
}

// What an OAuth error from GitHub means for the User, or null for "keep polling".
function failure(error: string): SignInError | null {
  switch (error) {
    case 'authorization_pending':
    case 'slow_down':
      return null;
    case 'expired_token':
      return new SignInError(
        'timed-out',
        'The code expired before it was entered on GitHub. Choose Connect GitHub again for a new one.',
      );
    case 'access_denied':
      return new SignInError(
        'declined',
        'You declined Commander on GitHub, so nothing was connected. Choose Connect GitHub to try again.',
      );
    case 'device_flow_disabled':
      return new SignInError(
        'not-configured',
        'Commander’s GitHub App doesn’t allow this kind of sign-in yet: tick “Enable Device Flow” in the app’s settings on GitHub (see “Connecting GitHub” in the README), or use a token instead.',
      );
    case 'incorrect_client_credentials':
    case 'unauthorized_client':
      return notOurApp();
    default:
      return new SignInError(
        'exchange-failed',
        `GitHub didn’t accept the sign-in (${error}). Choose Connect GitHub to try again.`,
      );
  }
}

const notOurApp = () =>
  new SignInError(
    'not-configured',
    'GitHub doesn’t recognise this build’s GitHub App client ID. Check github.clientId in config/local.json (see “Connecting GitHub” in the README), or use a token instead.',
  );

const unreachable = () =>
  new SignInError('unreachable', 'Commander couldn’t reach GitHub. Check your connection and try again.');

export async function signInWithDeviceFlow({
  clientId,
  webUrl,
  showCode,
  signal,
  now = Date.now,
  sleep = abortableSleep,
}: GitHubApp & {
  // Shows the User the code to enter, and where.
  showCode: (prompt: DeviceCodePrompt) => void;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: Sleep;
}): Promise<TokenSet> {
  const guarded = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw error;
    }
  };

  let response: Response;
  try {
    response = await guarded(() => post(`${webUrl}/login/device/code`, { client_id: clientId }, signal));
  } catch (error) {
    throw error instanceof SignInError ? error : unreachable();
  }
  const body: unknown = await response.json().catch(() => null);
  const code = deviceCodeResponse.safeParse(body);
  if (!code.success) {
    // GitHub answers an unknown client ID with 404.
    if (response.status === 404 || response.status === 401) throw notOurApp();
    const error = errorResponse.safeParse(body);
    if (error.success) throw failure(error.data.error) ?? notOurApp();
    throw new SignInError(
      'exchange-failed',
      `GitHub couldn’t start the sign-in (HTTP ${response.status}). Try again.`,
    );
  }
  const { device_code, user_code, verification_uri, expires_in } = code.data;
  // The User is sent to type the code on GitHub itself, never anywhere else.
  if (URL.parse(verification_uri)?.origin !== new URL(webUrl).origin) {
    throw new SignInError(
      'exchange-failed',
      'GitHub sent an unexpected sign-in page, so Commander stopped. Try again.',
    );
  }
  const deadline = now() + expires_in * 1000;
  let intervalMs = (code.data.interval ?? DEFAULT_INTERVAL_S) * 1000;
  showCode({ userCode: user_code, verificationUri: verification_uri, expiresAt: deadline });

  for (;;) {
    await guarded(() => sleep(intervalMs, signal));
    if (now() >= deadline) throw failure('expired_token') as SignInError;
    let polled: Response;
    try {
      polled = await guarded(() =>
        post(
          `${webUrl}/login/oauth/access_token`,
          { client_id: clientId, device_code, grant_type: DEVICE_GRANT },
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof SignInError) throw error;
      // Offline for a moment: keep polling until the code runs out.
      continue;
    }
    const answer: unknown = await polled.json().catch(() => null);
    const tokens = polled.ok ? readTokens(answer, now()) : null;
    if (tokens) return tokens;
    const error = errorResponse.safeParse(answer);
    if (!error.success) continue;
    if (error.data.error === 'slow_down') {
      intervalMs = error.data.interval ? error.data.interval * 1000 : intervalMs + SLOW_DOWN_S * 1000;
    }
    const failed = failure(error.data.error);
    if (failed) throw failed;
  }
}

// GitHub's refresh errors that mean the refresh token is no good any more.
const PERMANENT_REFRESH_ERRORS = new Set([
  'bad_refresh_token',
  'incorrect_client_credentials',
  'unauthorized_client',
  'invalid_grant',
]);

export async function refreshGitHubTokens({
  clientId,
  webUrl,
  refreshToken,
  now = Date.now,
}: GitHubApp & { refreshToken: string; now?: () => number }): Promise<TokenSet> {
  // A sign-in from an app whose tokens don't expire has nothing to refresh with.
  if (!refreshToken) throw new RefreshError(true, 'GitHub gave this sign-in no refresh token');
  let response: Response;
  try {
    response = await post(`${webUrl}/login/oauth/access_token`, {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } catch {
    throw new RefreshError(false, 'GitHub could not be reached to refresh the sign-in');
  }
  const body: unknown = await response.json().catch(() => null);
  const tokens = response.ok ? readTokens(body, now()) : null;
  if (tokens) return tokens;
  const error = errorResponse.safeParse(body);
  if (error.success && PERMANENT_REFRESH_ERRORS.has(error.data.error)) {
    throw new RefreshError(true, `GitHub refused to refresh the sign-in (${error.data.error})`);
  }
  throw new RefreshError(
    false,
    `GitHub could not refresh the sign-in (HTTP ${response.status}${error.success ? `, ${error.data.error}` : ''})`,
  );
}
