import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for GitHub, for tests only (unit and end-to-end). It behaves like GitHub where
// Commander depends on it: a GitHub App's device flow (no client secret; the token endpoint answers
// its errors with HTTP 200, as GitHub does; `slow_down` raising the interval), 8-hour user tokens
// with rotating refresh tokens, classic personal access tokens and gh's OAuth token with their
// scopes in X-OAuth-Scopes, `GET /user`, `GET /user/installations` (GitHub App tokens only) and a
// sliver of GraphQL (`viewer`). Nothing here talks to the real GitHub.

export type FakeGitHubUser = { id: number; login: string; name: string | null };

// A token GitHub issued, and what kind: a GitHub App user token (ghu_), a classic personal access
// token (ghp_), gh's OAuth token (gho_) or a fine-grained token (github_pat_).
type TokenKind = 'app' | 'classic' | 'oauth' | 'fine-grained';
type Grant = { user: FakeGitHubUser; accessToken: string; refreshToken: string | null; kind: TokenKind };
type Personal = { user: FakeGitHubUser; kind: TokenKind; scopes: string[] };

type DeviceCode = {
  deviceCode: string;
  userCode: string;
  // Who entered the code on github.com and approved, or declined it.
  answer: FakeGitHubUser | 'denied' | null;
  expired: boolean;
};

export type FakeGitHubInstallation = { login: string; type: 'User' | 'Organization' };

export type FakeGitHubOptions = {
  clientId?: string;
  appSlug?: string;
  // Seconds between polls the device flow asks for (GitHub says 5).
  interval?: number;
  // Seconds a device code lasts (GitHub: 900).
  codeExpiresIn?: number;
  // Seconds a user token lasts (GitHub: 28800), or null for an app with expiring tokens switched off.
  tokenExpiresIn?: number | null;
  // The app has "Enable Device Flow" ticked.
  deviceFlow?: boolean;
  // Overrides the verification URI the device flow sends the User to.
  verificationUri?: string;
};

export type FakeGitHub = {
  // Like https://github.com.
  webUrl: string;
  // Like https://api.github.com.
  apiUrl: string;
  clientId: string;
  appSlug: string;
  // Every device code request, as its form fields.
  deviceCodeRequests: Record<string, string>[];
  // Every token request (polls and refreshes), as its form fields.
  tokenRequests: Record<string, string>[];
  // Every API request, as its method and path ("GET /user").
  apiRequests: string[];
  // How many refreshes GitHub accepted.
  refreshes: number;
  // The device codes handed out, newest last (the User code only: what Commander shows).
  userCodes(): string[];
  // The User types the code at github.com/login/device and approves (as `user`). False when no such
  // code is waiting.
  enterCode(userCode: string, user?: FakeGitHubUser): boolean;
  // The User declines the newest code.
  deny(): void;
  // The newest code runs out.
  expire(): void;
  // The next `polls` token polls answer slow_down.
  slowDown(polls: number): void;
  // A classic personal access token (or gh's OAuth token, or a fine-grained one) for `user`.
  personalToken(options: {
    user?: FakeGitHubUser;
    kind: 'classic' | 'oauth' | 'fine-grained';
    scopes?: string[];
  }): string;
  // Where Commander's GitHub App is installed.
  install(installation: FakeGitHubInstallation): void;
  // Revokes every token of a user: refreshes with theirs now fail for good, and the API refuses them.
  revoke(userId: number): void;
  // Refreshes answer 503 until switched back.
  failRefreshesTemporarily(failing: boolean): void;
  // Holds each refresh this long before answering, to expose overlapping refreshes.
  delayRefreshes(ms: number): void;
  // Every token GitHub issued, and every device code (for asserting what reached disk, logs or the
  // window).
  secrets(): string[];
  close(): Promise<void>;
};

export const OCTOCAT: FakeGitHubUser = { id: 583231, login: 'octocat', name: 'The Octocat' };

const randomToken = (prefix: string) => `${prefix}_${randomBytes(18).toString('hex')}`;
const PREFIX: Record<TokenKind, string> = {
  app: 'ghu',
  classic: 'ghp',
  oauth: 'gho',
  'fine-grained': 'github_pat',
};

// GitHub's user codes: eight letters and digits, as XXXX-XXXX.
function userCode(): string {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ0123456789';
  const pick = () => letters[(randomBytes(1)[0] ?? 0) % letters.length];
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value));
}

// GitHub's OAuth endpoints answer errors with HTTP 200 and an `error` field.
function oauthError(response: ServerResponse, error: string, extra: Record<string, unknown> = {}) {
  json(response, 200, { error, error_description: `${error} (fake GitHub)`, ...extra });
}

async function form(request: IncomingMessage): Promise<Record<string, string>> {
  const text = await body(request);
  if (request.headers['content-type']?.startsWith('application/json')) return JSON.parse(text);
  return Object.fromEntries(new URLSearchParams(text));
}

export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const clientId = options.clientId ?? 'Iv23liFakeCommander';
  const appSlug = options.appSlug ?? 'fake-commander';
  const interval = options.interval ?? 5;
  const codeExpiresIn = options.codeExpiresIn ?? 900;
  const tokenExpiresIn = options.tokenExpiresIn === undefined ? 28_800 : options.tokenExpiresIn;
  const deviceFlow = options.deviceFlow ?? true;
  const codes: DeviceCode[] = [];
  const grants: Grant[] = [];
  const personal = new Map<string, Personal>();
  const installations: FakeGitHubInstallation[] = [];
  const issued: string[] = [];
  let slowDowns = 0;
  let refreshFailing = false;
  let refreshDelay = 0;

  const fake: FakeGitHub = {
    webUrl: '',
    apiUrl: '',
    clientId,
    appSlug,
    deviceCodeRequests: [],
    tokenRequests: [],
    apiRequests: [],
    refreshes: 0,
    userCodes: () => codes.map((code) => code.userCode),
    enterCode: (code, user = OCTOCAT) => {
      const waiting = codes.find((each) => each.userCode === code && !each.answer && !each.expired);
      if (!waiting) return false;
      waiting.answer = user;
      return true;
    },
    deny: () => {
      const newest = codes.at(-1);
      if (newest) newest.answer = 'denied';
    },
    expire: () => {
      const newest = codes.at(-1);
      if (newest) newest.expired = true;
    },
    slowDown: (polls) => {
      slowDowns = polls;
    },
    personalToken: ({ user = OCTOCAT, kind, scopes = ['repo', 'read:org'] }) => {
      const token = randomToken(PREFIX[kind]);
      personal.set(token, { user, kind, scopes });
      issued.push(token);
      return token;
    },
    install: (installation) => {
      installations.push(installation);
    },
    revoke: (userId) => {
      for (let i = grants.length - 1; i >= 0; i--) if (grants[i]?.user.id === userId) grants.splice(i, 1);
      for (const [token, each] of personal) if (each.user.id === userId) personal.delete(token);
    },
    failRefreshesTemporarily: (failing) => {
      refreshFailing = failing;
    },
    delayRefreshes: (ms) => {
      refreshDelay = ms;
    },
    secrets: () => [...issued, ...codes.map((code) => code.deviceCode)],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  function grant(user: FakeGitHubUser) {
    const accessToken = randomToken('ghu');
    const refreshToken = tokenExpiresIn === null ? null : randomToken('ghr');
    grants.push({ user, accessToken, refreshToken, kind: 'app' });
    issued.push(accessToken, ...(refreshToken ? [refreshToken] : []));
    return {
      access_token: accessToken,
      token_type: 'bearer',
      scope: '',
      ...(refreshToken
        ? { expires_in: tokenExpiresIn, refresh_token: refreshToken, refresh_token_expires_in: 15_897_600 }
        : {}),
    };
  }

  async function deviceCodeEndpoint(request: IncomingMessage, response: ServerResponse) {
    const fields = await form(request);
    fake.deviceCodeRequests.push(fields);
    if (fields.client_id !== clientId) return json(response, 404, { error: 'Not Found' });
    if (!deviceFlow) return oauthError(response, 'device_flow_disabled');
    const code: DeviceCode = {
      deviceCode: randomBytes(20).toString('hex'),
      userCode: userCode(),
      answer: null,
      expired: false,
    };
    codes.push(code);
    json(response, 200, {
      device_code: code.deviceCode,
      user_code: code.userCode,
      verification_uri: options.verificationUri ?? `${fake.webUrl}/login/device`,
      expires_in: codeExpiresIn,
      interval,
    });
  }

  async function tokenEndpoint(request: IncomingMessage, response: ServerResponse) {
    const fields = await form(request);
    fake.tokenRequests.push(fields);
    // A public GitHub App: no secret is sent, and none is wanted.
    if (fields.client_id !== clientId || 'client_secret' in fields)
      return oauthError(response, 'incorrect_client_credentials');

    if (fields.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (!deviceFlow) return oauthError(response, 'device_flow_disabled');
      const code = codes.find((each) => each.deviceCode === fields.device_code);
      if (!code) return oauthError(response, 'incorrect_device_code');
      if (slowDowns > 0) {
        slowDowns -= 1;
        return oauthError(response, 'slow_down', { interval: interval + 5 });
      }
      if (code.expired) return oauthError(response, 'expired_token');
      if (code.answer === 'denied') return oauthError(response, 'access_denied');
      if (!code.answer) return oauthError(response, 'authorization_pending');
      const user = code.answer;
      // A device code is good for one token.
      code.expired = true;
      return json(response, 200, grant(user));
    }

    if (fields.grant_type === 'refresh_token') {
      if (refreshDelay) await new Promise((resolve) => setTimeout(resolve, refreshDelay));
      if (refreshFailing) return json(response, 503, { message: 'Service Unavailable' });
      const index = grants.findIndex(
        (each) => each.refreshToken && each.refreshToken === fields.refresh_token,
      );
      const old = grants[index];
      if (!old) return oauthError(response, 'bad_refresh_token');
      // Rotation: the old refresh token (and its access token) are spent once a new one is issued.
      grants.splice(index, 1);
      fake.refreshes += 1;
      return json(response, 200, grant(old.user));
    }
    return oauthError(response, 'unsupported_grant_type');
  }

  // Who a request's token signs in as, and how.
  function caller(
    request: IncomingMessage,
  ): { user: FakeGitHubUser; kind: TokenKind; scopes: string[] | null } | null {
    const match = /^(?:Bearer|token) (.+)$/i.exec(request.headers.authorization ?? '');
    const token = match?.[1] ?? '';
    const app = grants.find((each) => each.accessToken === token);
    if (app) return { user: app.user, kind: 'app', scopes: null };
    const pat = personal.get(token);
    if (pat) return { ...pat, scopes: pat.kind === 'fine-grained' ? null : pat.scopes };
    return null;
  }

  async function api(request: IncomingMessage, url: URL, response: ServerResponse) {
    const path = url.pathname.slice('/api'.length) || '/';
    fake.apiRequests.push(`${request.method} ${path}`);
    // GitHub refuses requests without a User-Agent.
    if (!request.headers['user-agent'])
      return json(response, 403, { message: 'Request forbidden by administrative rules.' });
    const who = caller(request);
    if (!who) return json(response, 401, { message: 'Bad credentials', status: '401' });
    // Classic and OAuth tokens list their scopes; GitHub App and fine-grained tokens don't.
    const headers: Record<string, string> = who.scopes ? { 'x-oauth-scopes': who.scopes.join(', ') } : {};

    if (request.method === 'GET' && path === '/user') {
      const { id, login, name } = who.user;
      return json(response, 200, { login, id, node_id: `U_${id}`, type: 'User', name }, headers);
    }
    if (request.method === 'GET' && path === '/user/installations') {
      if (who.kind !== 'app') {
        return json(response, 403, {
          message:
            'You must authenticate with an access token authorized to a GitHub App in order to list installations',
        });
      }
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const listed = installations.slice((page - 1) * perPage, page * perPage);
      return json(response, 200, {
        total_count: installations.length,
        installations: listed.map((each, index) => ({
          id: 1000 + (page - 1) * perPage + index,
          app_slug: appSlug,
          account: { login: each.login, type: each.type },
          target_type: each.type,
        })),
      });
    }
    if (request.method === 'POST' && path === '/graphql') {
      const { query } = JSON.parse(await body(request)) as { query?: string };
      if (query?.includes('viewer'))
        return json(response, 200, { data: { viewer: { login: who.user.login, databaseId: who.user.id } } });
      return json(response, 200, { errors: [{ message: 'Not in the fake.' }] });
    }
    return json(response, 404, { message: 'Not Found' });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/login/device/code')
      return void deviceCodeEndpoint(request, response);
    if (request.method === 'POST' && url.pathname === '/login/oauth/access_token')
      return void tokenEndpoint(request, response);
    if (request.method === 'GET' && (url.pathname === '/login/device' || url.pathname.startsWith('/apps/')))
      return void response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Fake GitHub</h1>');
    if (url.pathname.startsWith('/api/')) return void api(request, url, response);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.webUrl = `http://127.0.0.1:${port}`;
  fake.apiUrl = `http://127.0.0.1:${port}/api`;
  return fake;
}
