import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFakeIssues, type FakeIssues } from './fake-linear-issues';

// A stand-in for Linear's OAuth and GraphQL endpoints, for tests only (unit and end-to-end). It
// behaves like Linear where Commander depends on it: PKCE with no client secret, refresh tokens
// that rotate on every refresh, the `viewer { organization }` query, and the issue queries Linear
// sync sends (see fake-linear-issues.ts). Nothing here talks to the real Linear.

export type FakeWorkspace = { id: string; name: string; urlKey: string };

type Grant = { workspace: FakeWorkspace; accessToken: string; refreshToken: string };

export type FakeLinearOptions = {
  clientId?: string;
  // The workspace the next browser sign-in approves.
  workspace?: FakeWorkspace;
  // Seconds until an access token expires, as Linear reports in expires_in.
  expiresIn?: number;
};

export type FakeLinear = {
  url: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
  clientId: string;
  // Every authorize request the browser made, as its query parameters.
  authorizeRequests: Record<string, string>[];
  // Every token request, as its form fields.
  tokenRequests: Record<string, string>[];
  // How many refreshes Linear accepted.
  refreshes: number;
  // The workspace the next browser sign-in approves.
  approve(workspace: FakeWorkspace): void;
  // The next browser sign-in is declined by the User.
  decline(): void;
  // A personal API key Linear accepts, for the given workspace.
  addApiKey(key: string, workspace: FakeWorkspace): void;
  // Revokes every token of a workspace: refreshes with its refresh token now fail for good.
  revoke(workspaceId: string): void;
  // Refreshes answer 503 until switched back.
  failRefreshesTemporarily(failing: boolean): void;
  // Holds each refresh this long before answering, to expose overlapping refreshes.
  delayRefreshes(ms: number): void;
  // The tokens Linear issued, newest last (for asserting what reached disk, logs or the window).
  issuedTokens(): string[];
  // Each workspace's issues, which Linear sync reads.
  issues: FakeIssues;
  // Revokes a personal API key, as the User can in Linear: requests with it are refused from now on.
  revokeApiKey(key: string): void;
  // Every GraphQL request, by operation name.
  graphqlRequests: { operationName: string; variables: Record<string, unknown> }[];
  close(): Promise<void>;
};

export const ACME: FakeWorkspace = { id: 'org-acme', name: 'Acme', urlKey: 'acme' };

const token = (prefix: string) => `${prefix}_${randomBytes(18).toString('hex')}`;

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

export async function startFakeLinear(options: FakeLinearOptions = {}): Promise<FakeLinear> {
  const clientId = options.clientId ?? 'fake-client-id';
  const expiresIn = options.expiresIn ?? 86_399;
  let nextWorkspace: FakeWorkspace | 'decline' = options.workspace ?? ACME;
  const codes = new Map<string, { challenge: string; redirectUri: string; workspace: FakeWorkspace }>();
  const grants: Grant[] = [];
  const apiKeys = new Map<string, FakeWorkspace>();
  const issued: string[] = [];
  let refreshFailing = false;
  let refreshDelay = 0;

  const fake: FakeLinear = {
    url: '',
    authorizeUrl: '',
    tokenUrl: '',
    apiUrl: '',
    clientId,
    authorizeRequests: [],
    tokenRequests: [],
    refreshes: 0,
    approve: (workspace) => {
      nextWorkspace = workspace;
    },
    decline: () => {
      nextWorkspace = 'decline';
    },
    addApiKey: (key, workspace) => {
      apiKeys.set(key, workspace);
      issued.push(key);
    },
    revoke: (workspaceId) => {
      for (let i = grants.length - 1; i >= 0; i--)
        if (grants[i]?.workspace.id === workspaceId) grants.splice(i, 1);
    },
    failRefreshesTemporarily: (failing) => {
      refreshFailing = failing;
    },
    delayRefreshes: (ms) => {
      refreshDelay = ms;
    },
    issuedTokens: () => [...issued],
    issues: createFakeIssues(),
    revokeApiKey: (key) => {
      apiKeys.delete(key);
    },
    graphqlRequests: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  function grant(workspace: FakeWorkspace) {
    const accessToken = token('lin_oauth');
    const refreshToken = token('lin_refresh');
    grants.push({ workspace, accessToken, refreshToken });
    issued.push(accessToken, refreshToken);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: 'read write',
      refresh_token: refreshToken,
    };
  }

  function authorize(url: URL, response: ServerResponse) {
    const params = Object.fromEntries(url.searchParams);
    fake.authorizeRequests.push(params);
    const redirect = new URL(params.redirect_uri ?? '');
    redirect.searchParams.set('state', params.state ?? '');
    if (nextWorkspace === 'decline') {
      redirect.searchParams.set('error', 'access_denied');
    } else {
      const code = token('code');
      codes.set(code, {
        challenge: params.code_challenge ?? '',
        redirectUri: params.redirect_uri ?? '',
        workspace: nextWorkspace,
      });
      redirect.searchParams.set('code', code);
    }
    response.writeHead(302, { location: redirect.toString() }).end();
  }

  async function tokenEndpoint(request: IncomingMessage, response: ServerResponse) {
    if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') {
      return json(response, 400, { error: 'invalid_request' });
    }
    const form = Object.fromEntries(new URLSearchParams(await body(request)));
    fake.tokenRequests.push(form);
    if (form.client_id !== clientId || 'client_secret' in form)
      return json(response, 401, { error: 'invalid_client' });

    if (form.grant_type === 'authorization_code') {
      const pending = codes.get(form.code ?? '');
      codes.delete(form.code ?? '');
      const verified =
        pending &&
        pending.redirectUri === form.redirect_uri &&
        createHash('sha256')
          .update(form.code_verifier ?? '')
          .digest('base64url') === pending.challenge;
      if (!pending || !verified) return json(response, 400, { error: 'invalid_grant' });
      return json(response, 200, grant(pending.workspace));
    }

    if (form.grant_type === 'refresh_token') {
      if (refreshDelay) await new Promise((resolve) => setTimeout(resolve, refreshDelay));
      if (refreshFailing) return json(response, 503, { error: 'temporarily_unavailable' });
      const index = grants.findIndex((g) => g.refreshToken === form.refresh_token);
      const old = grants[index];
      if (!old) return json(response, 400, { error: 'invalid_grant' });
      // Rotation: the old refresh token is spent the moment a new one is issued.
      grants.splice(index, 1);
      fake.refreshes += 1;
      return json(response, 200, grant(old.workspace));
    }
    return json(response, 400, { error: 'unsupported_grant_type' });
  }

  async function graphql(request: IncomingMessage, response: ServerResponse) {
    const sent = JSON.parse(await body(request)) as {
      query?: string;
      operationName?: string;
      variables?: Record<string, unknown>;
    };
    const query = sent.query ?? '';
    fake.graphqlRequests.push({ operationName: sent.operationName ?? '', variables: sent.variables ?? {} });
    const authorization = request.headers.authorization ?? '';
    const workspace = authorization.startsWith('Bearer ')
      ? grants.find((g) => g.accessToken === authorization.slice('Bearer '.length))?.workspace
      : apiKeys.get(authorization);
    if (!workspace) {
      return json(response, 400, {
        errors: [
          {
            message: 'Authentication required, not authenticated',
            extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' },
          },
        ],
      });
    }
    const answer = fake.issues.answer(workspace.id, sent.operationName ?? '', sent.variables ?? {});
    if (answer !== null) return json(response, 200, { data: answer }, { 'x-complexity': '42' });
    if (!/viewer\s*{\s*organization\s*{/.test(query))
      return json(response, 400, { errors: [{ message: 'unknown' }] });
    return json(response, 200, { data: { viewer: { organization: workspace } } });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/oauth/authorize') return authorize(url, response);
    if (request.method === 'POST' && url.pathname === '/oauth/token')
      return void tokenEndpoint(request, response);
    if (request.method === 'POST' && url.pathname === '/graphql') return void graphql(request, response);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}`;
  fake.authorizeUrl = `${fake.url}/oauth/authorize`;
  fake.tokenUrl = `${fake.url}/oauth/token`;
  fake.apiUrl = `${fake.url}/graphql`;
  return fake;
}
