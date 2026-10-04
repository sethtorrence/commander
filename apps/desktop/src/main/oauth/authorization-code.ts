import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { listenForRedirect } from './loopback';
import { createPkce } from './pkce';
import { SignInError, type SourceError } from './sign-in-error';

// OAuth 2.0 for a public desktop client, as every Source with a browser sign-in uses it:
// authorization code with PKCE (S256) and no client secret, the browser coming back to a loopback
// listener, and refresh tokens that may rotate on every refresh. Each Source supplies its endpoints,
// scopes and redirect (see linear/oauth.ts and microsoft/microsoft-sign-in.ts).

export type AuthorizationCodeClient = {
  // The Source, as messages name it ("Linear", "Microsoft").
  sourceName: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  // The loopback port registered with the app, or 0 for any free one.
  port: number;
  // The redirect's path on the loopback port: '/callback', or '/' for a bare http://localhost:<port>.
  callbackPath: string;
  // The scope parameter, as the Source writes it (Linear: "read,write"; Microsoft: space-separated).
  scope: string;
  // Sent again with each refresh, for Sources that want it (Microsoft).
  refreshScope?: string;
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  // Epoch milliseconds.
  expiresAt: number;
};

// A sign-in's tokens, with the OpenID Connect ID token when the Source sent one (never stored).
export type SignedInTokens = TokenSet & { idToken?: string };

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
  id_token: z.string().min(1).optional(),
});

const errorResponse = z.object({ error: z.string(), error_description: z.string().optional() });

// A refresh that failed. `permanent` means the refresh token is no good any more (revoked, expired,
// or spent outside the replay window), so the Account needs reconnecting; otherwise try again later.
export class RefreshError extends Error {
  override name = 'RefreshError';
  constructor(
    readonly permanent: boolean,
    message: string,
  ) {
    super(message);
  }
}

// OAuth errors that say "not now" even on a 400.
const TEMPORARY_ERRORS = new Set(['temporarily_unavailable', 'server_error']);

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
}

async function readBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function readTokens(body: unknown, now: number): SignedInTokens | null {
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) return null;
  const { access_token, refresh_token, expires_in, id_token } = parsed.data;
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: now + expires_in * 1000,
    ...(id_token ? { idToken: id_token } : {}),
  };
}

function readError(body: unknown): SourceError | undefined {
  const parsed = errorResponse.safeParse(body);
  return parsed.success
    ? { code: parsed.data.error, description: parsed.data.error_description ?? '' }
    : undefined;
}

// Opens the system browser on the Source's consent page and waits for its redirect to the loopback
// listener, then exchanges the code. The listener is closed when this settles, however it ends.
export async function signInWithBrowser({
  client,
  openBrowser,
  signal,
  timeoutMs,
  now = Date.now,
}: {
  client: AuthorizationCodeClient;
  openBrowser: (url: string) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}): Promise<SignedInTokens> {
  const pkce = createPkce();
  const state = randomBytes(24).toString('base64url');
  const listener = await listenForRedirect({
    port: client.port,
    path: client.callbackPath,
    state,
    sourceName: client.sourceName,
    timeoutMs,
  });
  const cancel = () => listener.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    const authorize = new URL(client.authorizeUrl);
    authorize.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: listener.redirectUri,
      response_type: 'code',
      scope: client.scope,
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
        `Commander couldn’t reach ${client.sourceName} to finish signing in. Try again.`,
      );
    }
    const body = await readBody(response);
    const tokens = response.ok ? readTokens(body, now()) : null;
    if (!tokens) {
      const sourceError = readError(body);
      throw new SignInError(
        'exchange-failed',
        `${client.sourceName} didn’t accept the sign-in (HTTP ${response.status}). Check the app’s client ID and redirect URL, then try again.`,
        sourceError ? { sourceError } : {},
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
  client: Pick<AuthorizationCodeClient, 'sourceName' | 'clientId' | 'tokenUrl' | 'refreshScope'>;
  refreshToken: string;
  now?: () => number;
}): Promise<TokenSet> {
  let response: Response;
  try {
    response = await postForm(client.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      ...(client.refreshScope ? { scope: client.refreshScope } : {}),
    });
  } catch {
    throw new RefreshError(false, `${client.sourceName} could not be reached to refresh the sign-in`);
  }
  const body = await readBody(response);
  if (response.status === 400 || response.status === 401) {
    const error = readError(body)?.code;
    if (!error || !TEMPORARY_ERRORS.has(error)) {
      throw new RefreshError(
        true,
        `${client.sourceName} refused to refresh the sign-in (HTTP ${response.status}${error ? `, ${error}` : ''})`,
      );
    }
  }
  const tokens = response.ok ? readTokens(body, now()) : null;
  if (!tokens)
    throw new RefreshError(
      false,
      `${client.sourceName} could not refresh the sign-in (HTTP ${response.status})`,
    );
  // The ID token isn't kept: only a sign-in's names an Account.
  const { idToken: _idToken, ...tokenSet } = tokens;
  return tokenSet;
}
