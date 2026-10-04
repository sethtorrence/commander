import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for Google's OAuth 2.0 endpoints and its OpenID Connect userinfo, for tests only (unit
// and end-to-end). It behaves like Google where Commander depends on it, for a "Desktop app" client:
// authorization code with PKCE (S256) and the desktop client's secret, a loopback redirect on
// 127.0.0.1 at any port, `access_type=offline` and `prompt=consent` for a refresh token,
// `include_granted_scopes` adding earlier grants, permissions the User can untick on the consent
// screen (the token's `scope` says what was granted, with `email` and `profile` written as
// Google writes them), refresh tokens that don't rotate (a refresh brings no new one), an ID token
// carrying `sub` and `email`, and the errors of a Workspace whose admin has blocked the app.
// Nothing here talks to the real Google.

export type FakeGoogleUser = { sub: string; email: string; name: string };

export type FakeGoogle = {
  // Like https://accounts.google.com/o/oauth2/v2/auth, https://oauth2.googleapis.com/token and
  // https://openidconnect.googleapis.com/v1/userinfo.
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string;
  clientSecret: string;
  // Every authorize request the browser made, as its query parameters.
  authorizeRequests: Record<string, string>[];
  // Every token request, as its form fields.
  tokenRequests: Record<string, string>[];
  // How many refreshes Google accepted.
  refreshes: number;
  // The user the next browser sign-ins approve.
  approve(user: FakeGoogleUser): void;
  // The User unticks these permissions on the consent screens that follow (empty: grants all).
  untick(scopes: string[]): void;
  // The next browser sign-in is declined by the User.
  decline(): void;
  // The user's Workspace admin blocks the app ('admin_policy_enforced' or 'org_internal'); null lifts it.
  block(error: 'admin_policy_enforced' | 'org_internal' | null): void;
  // Revokes every token of a user: refreshes with them now fail for good (invalid_grant).
  revoke(sub: string): void;
  // Refreshes answer 503 until switched back.
  failRefreshesTemporarily(failing: boolean): void;
  // The tokens Google issued, newest last (for asserting what reached disk, logs or the window).
  issuedTokens(): string[];
  close(): Promise<void>;
};

export const ALEX: FakeGoogleUser = {
  sub: '104512345678901234567',
  email: 'alex@gmail.test',
  name: 'Alex Kim',
};

// How Google writes the short identity scopes back in a token's `scope`.
const LONG_NAMES: Record<string, string> = {
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
};
// What the consent screen never lets the User untick.
const ALWAYS_GRANTED = new Set(['openid', 'email', 'profile']);

const token = (prefix: string) => `${prefix}_${randomBytes(18).toString('hex')}`;
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

// A loopback redirect a Desktop app client accepts: http on 127.0.0.1 or [::1], any port.
function isLoopbackRedirect(uri: string): boolean {
  const url = URL.parse(uri);
  return url?.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.port !== '';
}

export async function startFakeGoogle(
  options: { clientId?: string; clientSecret?: string; expiresIn?: number } = {},
): Promise<FakeGoogle> {
  const clientId = options.clientId ?? '123456789012-fake.apps.googleusercontent.com';
  const clientSecret = options.clientSecret ?? 'GOCSPX-fake-desktop-secret';
  const expiresIn = options.expiresIn ?? 3_599;
  let nextUser: FakeGoogleUser = ALEX;
  let declining = false;
  let unticked = new Set<string>();
  let blocked: 'admin_policy_enforced' | 'org_internal' | null = null;
  let refreshFailing = false;
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; user: FakeGoogleUser; scopes: string[] }
  >();
  // What each user has granted Commander so far, for include_granted_scopes.
  const consented = new Map<string, Set<string>>();
  const refreshTokens = new Map<string, { user: FakeGoogleUser; scopes: string[] }>();
  const accessTokens = new Map<string, FakeGoogleUser>();
  const issued: string[] = [];

  const fake: FakeGoogle = {
    authorizeUrl: '',
    tokenUrl: '',
    userinfoUrl: '',
    clientId,
    clientSecret,
    authorizeRequests: [],
    tokenRequests: [],
    refreshes: 0,
    approve: (user) => {
      nextUser = user;
    },
    untick: (scopes) => {
      unticked = new Set(scopes);
    },
    decline: () => {
      declining = true;
    },
    block: (error) => {
      blocked = error;
    },
    revoke: (sub) => {
      for (const [refresh, grant] of refreshTokens) if (grant.user.sub === sub) refreshTokens.delete(refresh);
      for (const [access, user] of accessTokens) if (user.sub === sub) accessTokens.delete(access);
      consented.delete(sub);
    },
    failRefreshesTemporarily: (failing) => {
      refreshFailing = failing;
    },
    issuedTokens: () => [...issued],
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  const scopeField = (scopes: string[]) => scopes.map((scope) => LONG_NAMES[scope] ?? scope).join(' ');

  function accessToken(user: FakeGoogleUser) {
    const access = token('ya29.fake');
    accessTokens.set(access, user);
    issued.push(access);
    return access;
  }

  function authorize(url: URL, response: ServerResponse) {
    const params = Object.fromEntries(url.searchParams);
    fake.authorizeRequests.push(params);
    const redirectUri = params.redirect_uri ?? '';
    // Google shows its own error page, never redirecting, for an unknown client or redirect.
    if (params.client_id !== clientId || !isLoopbackRedirect(redirectUri)) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Error 400: redirect_uri_mismatch');
      return;
    }
    const reply = (fields: Record<string, string>) => {
      const redirect = new URL(redirectUri);
      for (const [name, value] of Object.entries({ ...fields, state: params.state ?? '' }))
        redirect.searchParams.set(name, value);
      response.writeHead(302, { location: redirect.toString() }).end();
    };
    if (blocked) return reply({ error: blocked });
    if (declining) {
      declining = false;
      return reply({ error: 'access_denied' });
    }
    if (
      params.response_type !== 'code' ||
      params.code_challenge_method !== 'S256' ||
      !params.code_challenge
    ) {
      return reply({ error: 'invalid_request' });
    }
    const requested = (params.scope ?? '').split(' ').filter(Boolean);
    let scopes = requested.filter((scope) => ALWAYS_GRANTED.has(scope) || !unticked.has(scope));
    if (params.include_granted_scopes === 'true') {
      scopes = [...new Set([...(consented.get(nextUser.sub) ?? []), ...scopes])];
    }
    consented.set(nextUser.sub, new Set(scopes));
    const code = token('4/fake-code');
    // Without offline access and a fresh consent, Google sends no refresh token after the first.
    const offline = params.access_type === 'offline' && params.prompt === 'consent';
    codes.set(code, {
      challenge: params.code_challenge,
      redirectUri,
      user: nextUser,
      scopes: offline ? scopes : [],
    });
    reply({ code, scope: scopeField(scopes) });
  }

  async function tokenEndpoint(request: IncomingMessage, response: ServerResponse) {
    if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') {
      return json(response, 400, { error: 'invalid_request' });
    }
    const form = Object.fromEntries(new URLSearchParams(await body(request)));
    fake.tokenRequests.push(form);
    // A Desktop app client must send its (not really secret) secret.
    if (form.client_id !== clientId || form.client_secret !== clientSecret) {
      return json(response, 401, { error: 'invalid_client', error_description: 'Unauthorized' });
    }
    if (form.grant_type === 'authorization_code') {
      const pending = codes.get(form.code ?? '');
      codes.delete(form.code ?? '');
      if (!pending || pending.redirectUri !== form.redirect_uri)
        return json(response, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
      const challenge = createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url');
      if (challenge !== pending.challenge)
        return json(response, 400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
      if (pending.scopes.length === 0)
        return json(response, 200, { access_token: accessToken(pending.user), expires_in: expiresIn });
      const access = accessToken(pending.user);
      const refresh = token('1//fake-refresh');
      refreshTokens.set(refresh, { user: pending.user, scopes: pending.scopes });
      issued.push(refresh);
      const { sub, email, name } = pending.user;
      // An unsigned stand-in for the ID token: Commander reads only its claims.
      const idToken = `${base64url({ alg: 'none' })}.${base64url({
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub,
        email,
        email_verified: true,
        name,
      })}.`;
      return json(response, 200, {
        access_token: access,
        expires_in: expiresIn,
        refresh_token: refresh,
        scope: scopeField(pending.scopes),
        token_type: 'Bearer',
        id_token: idToken,
      });
    }
    if (form.grant_type === 'refresh_token') {
      if (refreshFailing) return json(response, 503, { error: 'temporarily_unavailable' });
      const grant = refreshTokens.get(form.refresh_token ?? '');
      if (!grant)
        return json(response, 400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        });
      fake.refreshes += 1;
      // No new refresh token: Google's don't rotate.
      return json(response, 200, {
        access_token: accessToken(grant.user),
        expires_in: expiresIn,
        scope: scopeField(grant.scopes),
        token_type: 'Bearer',
      });
    }
    return json(response, 400, { error: 'unsupported_grant_type' });
  }

  function userinfo(request: IncomingMessage, response: ServerResponse) {
    const authorization = request.headers.authorization ?? '';
    const user = authorization.startsWith('Bearer ')
      ? accessTokens.get(authorization.slice('Bearer '.length))
      : undefined;
    if (!user) return json(response, 401, { error: 'invalid_token' });
    return json(response, 200, { sub: user.sub, email: user.email, email_verified: true, name: user.name });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') return authorize(url, response);
    if (request.method === 'POST' && url.pathname === '/token') return void tokenEndpoint(request, response);
    if (request.method === 'GET' && url.pathname === '/v1/userinfo') return userinfo(request, response);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  fake.authorizeUrl = `${base}/o/oauth2/v2/auth`;
  fake.tokenUrl = `${base}/token`;
  fake.userinfoUrl = `${base}/v1/userinfo`;
  return fake;
}
