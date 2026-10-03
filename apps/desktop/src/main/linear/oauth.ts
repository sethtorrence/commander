import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { listenForRedirect } from './loopback';
import { createPkce } from './pkce';
import { SignInError } from './sign-in-error';

// Linear's OAuth 2.0 for a public desktop client: authorization code with PKCE (S256) and no
// client secret, 24-hour access tokens, and refresh tokens that rotate on every refresh.

// What Commander needs to sign in with its own registered OAuth app.
export type OAuthClient = {
  clientId: string;
  // The fixed loopback port registered with the app (http://localhost:<port>/callback).
  port: number;
  authorizeUrl: string;
  tokenUrl: string;
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  // Epoch milliseconds.
  expiresAt: number;
};

// "read,write": issue edits, comments and new issues. Linear separates scopes with commas.
const SCOPES = 'read,write';

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});

// A refresh that failed. `permanent` means the refresh token is no good any more (revoked, or
// spent outside the replay window), so the Account needs reconnecting; otherwise try again later.
export class RefreshError extends Error {
  override name = 'RefreshError';
  constructor(
    readonly permanent: boolean,
    message: string,
  ) {
    super(message);
  }
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
}

async function readTokens(response: Response, now: number): Promise<TokenSet | null> {
  const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;
  const { access_token, refresh_token, expires_in } = parsed.data;
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: now + expires_in * 1000 };
}

// Opens the system browser on Linear's consent page and waits for its redirect to the loopback
// listener, then exchanges the code. The listener is closed when this settles, however it ends.
export async function signInWithBrowser({
  client,
  openBrowser,
  signal,
  timeoutMs,
  now = Date.now,
}: {
  client: OAuthClient;
  openBrowser: (url: string) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}): Promise<TokenSet> {
  const pkce = createPkce();
  const state = randomBytes(24).toString('base64url');
  const listener = await listenForRedirect({ port: client.port, state, timeoutMs });
  const cancel = () => listener.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    const authorize = new URL(client.authorizeUrl);
    authorize.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: listener.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
    }).toString();
    await openBrowser(authorize.toString());
    const { code } = await listener.result;

    let response: Response;
    try {
      response = await postForm(client.tokenUrl, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: listener.redirectUri,
        client_id: client.clientId,
        code_verifier: pkce.verifier,
      });
    } catch {
      throw new SignInError(
        'unreachable',
        'Commander couldn’t reach Linear to finish signing in. Try again.',
      );
    }
    const tokens = response.ok ? await readTokens(response, now()) : null;
    if (!tokens) {
      throw new SignInError(
        'exchange-failed',
        `Linear didn’t accept the sign-in (HTTP ${response.status}). Check the OAuth app’s client ID and callback URL, then try again.`,
      );
    }
    return tokens;
  } finally {
    signal?.removeEventListener('abort', cancel);
    // However it ended, return only once the port is free again.
    listener.close();
    await listener.result.catch(() => {});
  }
}

export async function refreshTokens({
  client,
  refreshToken,
  now = Date.now,
}: {
  client: Pick<OAuthClient, 'clientId' | 'tokenUrl'>;
  refreshToken: string;
  now?: () => number;
}): Promise<TokenSet> {
  let response: Response;
  try {
    response = await postForm(client.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
    });
  } catch {
    throw new RefreshError(false, 'Linear could not be reached to refresh the sign-in');
  }
  if (response.status === 400 || response.status === 401) {
    throw new RefreshError(true, `Linear refused to refresh the sign-in (HTTP ${response.status})`);
  }
  const tokens = response.ok ? await readTokens(response, now()) : null;
  if (!tokens)
    throw new RefreshError(false, `Linear could not refresh the sign-in (HTTP ${response.status})`);
  return tokens;
}
