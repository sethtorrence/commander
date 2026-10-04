import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for the Microsoft identity platform (a single-tenant app's authority) and Microsoft
// Graph, for tests only (unit and end-to-end). It behaves like Microsoft where Commander depends on
// it: authorization code with PKCE and no client secret for a public client whose redirect is
// http://localhost (any port, the path matched exactly), refresh tokens that rotate, an ID token
// carrying the tenant, the granted scopes in the token response (fewer than asked for, when an
// administrator approved only some), `GET /me`, and the AADSTS errors of a tenant that needs admin
// consent; and
// for Teams sync, the User's Chats: `GET /me/chats?$expand=lastMessagePreview`, a Chat's members, and
// its messages newest-modified first, filtered on `lastModifiedDateTime`, paged with nextLinks.
// Nothing here talks to the real Microsoft.

export type FakeMicrosoftUser = { id: string; displayName: string; userPrincipalName: string };

type Grant = { user: FakeMicrosoftUser; accessToken: string; refreshToken: string; scope: string };

// A Teams Chat the fake serves, with its messages (HTML bodies, as Teams sends them).
export type FakeChatMessage = {
  id: string;
  from: FakeMicrosoftUser;
  html: string;
  createdAt: number;
  modifiedAt: number;
  // Users it @mentions (each <at id="n"> in the HTML, in order).
  mentions: FakeMicrosoftUser[];
};
export type FakeChat = {
  id: string;
  topic: string | null;
  chatType: 'oneOnOne' | 'group' | 'meeting';
  members: FakeMicrosoftUser[];
  // When it was renamed or its members changed.
  updatedAt: number;
  messages: FakeChatMessage[];
};

// Microsoft's answers when a tenant won't let the User consent on their own.
export type AdminConsentCode = 'AADSTS90094' | 'AADSTS65001';

export type FakeMicrosoftOptions = {
  clientId?: string;
  tenantId?: string;
  // The user the next browser sign-in approves.
  user?: FakeMicrosoftUser;
  // Seconds until an access token expires, as Microsoft reports in expires_in.
  expiresIn?: number;
};

export type FakeMicrosoft = {
  // The identity platform's base (like https://login.microsoftonline.com).
  loginUrl: string;
  // Graph's base (like https://graph.microsoft.com/v1.0).
  graphUrl: string;
  clientId: string;
  tenantId: string;
  // Every authorize request the browser made, as its query parameters.
  authorizeRequests: Record<string, string>[];
  // Every token request, as its form fields.
  tokenRequests: Record<string, string>[];
  // Every Graph request, as its path and query (decoded).
  graphRequests: string[];
  // Adds a Chat every signed-in user is in.
  addChat(
    chat: Pick<FakeChat, 'id' | 'members'> & Partial<Pick<FakeChat, 'topic' | 'chatType' | 'updatedAt'>>,
  ): void;
  // Posts a message to a Chat, @mentioning `mentions` (<at id="0">…</at> and on); returns its id.
  postMessage(
    chatId: string,
    from: FakeMicrosoftUser,
    html: string,
    at?: number,
    mentions?: FakeMicrosoftUser[],
  ): string;
  // The next Graph requests are refused with this status and Retry-After (seconds), until switched back.
  throttleGraph(answer: { status: 429 | 503; retryAfter: number } | null): void;
  // How many refreshes Microsoft accepted.
  refreshes: number;
  // The user the next browser sign-in approves.
  approve(user: FakeMicrosoftUser): void;
  // The next browser sign-in is declined by the User.
  decline(): void;
  // Sign-ins need an administrator's approval: refused with this code at the redirect, or when the
  // code is exchanged. null lets the User consent again.
  requireAdminConsent(code: AdminConsentCode | null, where?: 'redirect' | 'token'): void;
  // Sign-ins are granted only these of the scopes asked for (as when an administrator approved only
  // some permissions for the tenant). null grants everything asked for again.
  limitGrantedScopes(scopes: string[] | null): void;
  // Revokes every token of a user: refreshes with their refresh tokens now fail for good.
  revoke(userId: string): void;
  // Refreshes answer 503 until switched back.
  failRefreshesTemporarily(failing: boolean): void;
  // Holds each refresh this long before answering, to expose overlapping refreshes.
  delayRefreshes(ms: number): void;
  // The tokens Microsoft issued, newest last (for asserting what reached disk, logs or the window).
  issuedTokens(): string[];
  close(): Promise<void>;
};

export const SAM: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a001',
  displayName: 'Sam Rivera',
  userPrincipalName: 'sam@contoso.test',
};

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

// Microsoft's token endpoint errors carry the AADSTS code in the description and in error_codes.
function tokenError(response: ServerResponse, status: number, error: string, aadsts: number, text: string) {
  json(response, status, {
    error,
    error_description: `AADSTS${aadsts}: ${text} Trace ID: fake.`,
    error_codes: [aadsts],
  });
}

const ADMIN_CONSENT_TEXT: Record<AdminConsentCode, string> = {
  AADSTS90094: 'The grant requires admin permission.',
  AADSTS65001: 'The user or administrator has not consented to use the application.',
};

// A redirect URI Entra accepts for a "Mobile and desktop applications" http://localhost: any port,
// no path (the registered one has none).
function isRegisteredRedirect(uri: string): boolean {
  const url = URL.parse(uri);
  return (
    url?.protocol === 'http:' && url.hostname === 'localhost' && url.pathname === '/' && !uri.endsWith('/')
  );
}

export async function startFakeMicrosoft(options: FakeMicrosoftOptions = {}): Promise<FakeMicrosoft> {
  const clientId = options.clientId ?? 'fake-microsoft-client-id';
  const tenantId = options.tenantId ?? 'fake-tenant-0001';
  const expiresIn = options.expiresIn ?? 3_599;
  let nextUser: FakeMicrosoftUser | 'decline' = options.user ?? SAM;
  let adminConsent: { code: AdminConsentCode; where: 'redirect' | 'token' } | null = null;
  let grantable: Set<string> | null = null;
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; user: FakeMicrosoftUser; scope: string }
  >();
  const grants: Grant[] = [];
  const issued: string[] = [];
  let refreshFailing = false;
  let refreshDelay = 0;
  const chats: FakeChat[] = [];
  let throttled: { status: 429 | 503; retryAfter: number } | null = null;

  const fake: FakeMicrosoft = {
    loginUrl: '',
    graphUrl: '',
    clientId,
    tenantId,
    authorizeRequests: [],
    tokenRequests: [],
    graphRequests: [],
    refreshes: 0,
    approve: (user) => {
      nextUser = user;
    },
    decline: () => {
      nextUser = 'decline';
    },
    requireAdminConsent: (code, where = 'redirect') => {
      adminConsent = code ? { code, where } : null;
    },
    limitGrantedScopes: (scopes) => {
      grantable = scopes && new Set(scopes);
    },
    revoke: (userId) => {
      for (let i = grants.length - 1; i >= 0; i--) if (grants[i]?.user.id === userId) grants.splice(i, 1);
    },
    failRefreshesTemporarily: (failing) => {
      refreshFailing = failing;
    },
    delayRefreshes: (ms) => {
      refreshDelay = ms;
    },
    issuedTokens: () => [...issued],
    addChat: ({ id, members, topic = null, chatType = 'group', updatedAt = Date.now() }) => {
      chats.push({ id, members, topic, chatType, updatedAt, messages: [] });
    },
    postMessage: (chatId, from, html, at = Date.now(), mentions = []) => {
      const chat = chats.find((each) => each.id === chatId);
      if (!chat) throw new Error(`No fake chat ${chatId}`);
      const id = String(at + chat.messages.length);
      chat.messages.push({ id, from, html, createdAt: at, modifiedAt: at, mentions });
      return id;
    },
    throttleGraph: (answer) => {
      throttled = answer;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  function grant(user: FakeMicrosoftUser, scope: string) {
    const accessToken = token('ms_access');
    const refreshToken = token('ms_refresh');
    grants.push({ user, accessToken, refreshToken, scope });
    issued.push(accessToken, refreshToken);
    // An unsigned stand-in for the ID token: Commander reads only its claims.
    const idToken = `${base64url({ alg: 'none' })}.${base64url({ tid: tenantId, oid: user.id, aud: clientId })}.`;
    return {
      token_type: 'Bearer',
      scope,
      expires_in: expiresIn,
      ext_expires_in: expiresIn,
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
    };
  }

  function authorize(url: URL, response: ServerResponse) {
    const params = Object.fromEntries(url.searchParams);
    fake.authorizeRequests.push(params);
    const redirectUri = params.redirect_uri ?? '';
    // Entra shows its own error page, never redirecting, for a wrong app or redirect URI.
    if (params.client_id !== clientId || !isRegisteredRedirect(redirectUri)) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('AADSTS50011: redirect URI mismatch');
      return;
    }
    const redirect = new URL(redirectUri);
    const reply = (fields: Record<string, string>) => {
      for (const [name, value] of Object.entries({ ...fields, state: params.state ?? '' }))
        redirect.searchParams.set(name, value);
      // Keep the redirect as Entra sends it: http://localhost:<port>?code=… (no added path).
      response.writeHead(302, { location: redirect.toString().replace(/\/\?/, '?') }).end();
    };
    if (adminConsent?.where === 'redirect') {
      return reply({
        error: adminConsent.code === 'AADSTS90094' ? 'access_denied' : 'consent_required',
        error_description: `${adminConsent.code}: ${ADMIN_CONSENT_TEXT[adminConsent.code]}`,
      });
    }
    if (nextUser === 'decline') {
      return reply({ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent.' });
    }
    if (params.response_type !== 'code' || params.code_challenge_method !== 'S256') {
      return reply({ error: 'invalid_request', error_description: 'AADSTS900144: PKCE required.' });
    }
    const code = token('code');
    const asked = (params.scope ?? '').split(' ').filter(Boolean);
    codes.set(code, {
      challenge: params.code_challenge ?? '',
      redirectUri,
      user: nextUser,
      scope: asked.filter((scope) => grantable?.has(scope) ?? true).join(' '),
    });
    reply({ code });
  }

  async function tokenEndpoint(request: IncomingMessage, response: ServerResponse) {
    if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') {
      return json(response, 400, { error: 'invalid_request' });
    }
    const form = Object.fromEntries(new URLSearchParams(await body(request)));
    fake.tokenRequests.push(form);
    if (form.client_id !== clientId)
      return tokenError(response, 400, 'unauthorized_client', 700016, 'Application not found.');
    // A public client sends no secret.
    if ('client_secret' in form)
      return tokenError(response, 401, 'invalid_client', 700025, 'Public clients send no secret.');

    if (form.grant_type === 'authorization_code') {
      const pending = codes.get(form.code ?? '');
      codes.delete(form.code ?? '');
      if (!pending || pending.redirectUri !== form.redirect_uri)
        return tokenError(
          response,
          400,
          'invalid_grant',
          70000,
          'The provided authorization code is invalid.',
        );
      const verifier = createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url');
      if (verifier !== pending.challenge)
        return tokenError(response, 400, 'invalid_grant', 501481, 'The Code_Verifier does not match.');
      if (adminConsent?.where === 'token') {
        return tokenError(
          response,
          400,
          'invalid_grant',
          Number(adminConsent.code.slice('AADSTS'.length)),
          ADMIN_CONSENT_TEXT[adminConsent.code],
        );
      }
      return json(response, 200, grant(pending.user, pending.scope));
    }

    if (form.grant_type === 'refresh_token') {
      if (refreshDelay) await new Promise((resolve) => setTimeout(resolve, refreshDelay));
      if (refreshFailing) return json(response, 503, { error: 'temporarily_unavailable' });
      if (!form.scope) return tokenError(response, 400, 'invalid_request', 900144, "'scope' is required.");
      const index = grants.findIndex((g) => g.refreshToken === form.refresh_token);
      const old = grants[index];
      if (!old)
        return tokenError(
          response,
          400,
          'invalid_grant',
          70008,
          'The refresh token has expired or was revoked.',
        );
      // Rotation: the fake spends the old refresh token the moment a new one is issued.
      grants.splice(index, 1);
      fake.refreshes += 1;
      return json(response, 200, grant(old.user, form.scope));
    }
    return json(response, 400, { error: 'unsupported_grant_type' });
  }

  const iso = (time: number) => new Date(time).toISOString();
  const identity = (user: FakeMicrosoftUser) => ({
    application: null,
    device: null,
    user: { id: user.id, displayName: user.displayName, userIdentityType: 'aadUser', tenantId },
  });
  const latest = (chat: FakeChat) =>
    chat.messages.reduce<FakeChatMessage | null>(
      (a, b) => (a === null || b.createdAt >= a.createdAt ? b : a),
      null,
    );

  function graphChat(chat: FakeChat) {
    const last = latest(chat);
    return {
      id: chat.id,
      topic: chat.topic,
      createdDateTime: iso(chat.updatedAt),
      lastUpdatedDateTime: iso(chat.updatedAt),
      chatType: chat.chatType,
      webUrl: `https://teams.microsoft.com/l/chat/${encodeURIComponent(chat.id)}/0?tenantId=${tenantId}`,
      tenantId,
      onlineMeetingInfo: null,
      viewpoint: { isHidden: false, lastMessageReadDateTime: null },
      lastMessagePreview: last && {
        id: last.id,
        createdDateTime: iso(last.createdAt),
        isDeleted: false,
        messageType: 'message',
        body: { contentType: 'text', content: last.html.replace(/<[^>]*>/g, '') },
        from: identity(last.from),
      },
    };
  }

  // One page of a collection: `$top` at a time, `$skiptoken` saying where the next page starts.
  function paged(response: ServerResponse, url: URL, all: unknown[]) {
    const top = Math.min(50, Number(url.searchParams.get('$top') ?? 50) || 50);
    const start = Number(url.searchParams.get('$skiptoken') ?? 0) || 0;
    const value = all.slice(start, start + top);
    const next = new URL(`${fake.graphUrl}${url.pathname.slice('/v1.0'.length)}`);
    for (const [name, each] of url.searchParams) if (name !== '$skiptoken') next.searchParams.set(name, each);
    next.searchParams.set('$top', String(top));
    next.searchParams.set('$skiptoken', String(start + top));
    return json(response, 200, {
      value,
      ...(start + top < all.length ? { '@odata.nextLink': next.toString() } : {}),
    });
  }

  function chatResource(url: URL, response: ServerResponse) {
    const match = /^\/v1\.0\/chats\/([^/]+)\/(members|messages)$/.exec(url.pathname);
    const chat = match && chats.find((each) => each.id === decodeURIComponent(match[1] ?? ''));
    if (!match || !chat) {
      return json(response, 404, { error: { code: 'NotFound', message: 'No such chat.' } });
    }
    if (match[2] === 'members') {
      return paged(
        response,
        url,
        chat.members.map((member) => ({
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          id: `member-${member.id}`,
          roles: ['owner'],
          displayName: member.displayName,
          userId: member.id,
          email: member.userPrincipalName,
          tenantId,
        })),
      );
    }
    const after = /lastModifiedDateTime gt (\S+)/.exec(url.searchParams.get('$filter') ?? '')?.[1];
    const since = after ? Date.parse(after) : Number.NEGATIVE_INFINITY;
    const messages = chat.messages
      .filter((message) => message.modifiedAt > since)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map((message) => ({
        id: message.id,
        replyToId: null,
        messageType: 'message',
        createdDateTime: iso(message.createdAt),
        lastModifiedDateTime: iso(message.modifiedAt),
        deletedDateTime: null,
        from: identity(message.from),
        body: { contentType: 'html', content: message.html },
        attachments: [],
        mentions: message.mentions.map((user, index) => ({
          id: index,
          mentionText: user.displayName,
          mentioned: { user: { id: user.id, displayName: user.displayName, userIdentityType: 'aadUser' } },
        })),
        reactions: [],
      }));
    return paged(response, url, messages);
  }

  function graph(request: IncomingMessage, url: URL, response: ServerResponse) {
    fake.graphRequests.push(decodeURIComponent(url.pathname + url.search));
    const authorization = request.headers.authorization ?? '';
    const user = authorization.startsWith('Bearer ')
      ? grants.find((g) => g.accessToken === authorization.slice('Bearer '.length))?.user
      : undefined;
    if (!user) {
      return json(response, 401, {
        error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty or invalid.' },
      });
    }
    if (throttled) {
      response
        .writeHead(throttled.status, {
          'content-type': 'application/json',
          'retry-after': String(throttled.retryAfter),
        })
        .end(JSON.stringify({ error: { code: 'TooManyRequests', message: 'Too many requests.' } }));
      return;
    }
    if (url.pathname === '/v1.0/me/chats') return paged(response, url, chats.map(graphChat));
    if (url.pathname.startsWith('/v1.0/chats/')) return chatResource(url, response);
    if (url.pathname === '/v1.0/me') {
      return json(response, 200, {
        '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
        ...user,
        mail: user.userPrincipalName,
      });
    }
    return json(response, 404, { error: { code: 'ResourceNotFound', message: 'Not in the fake.' } });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const authority = `/${tenantId}/oauth2/v2.0`;
    if (request.method === 'GET' && url.pathname === `${authority}/authorize`)
      return authorize(url, response);
    if (request.method === 'POST' && url.pathname === `${authority}/token`)
      return void tokenEndpoint(request, response);
    if (request.method === 'GET' && url.pathname.startsWith('/v1.0/')) return graph(request, url, response);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.loginUrl = `http://127.0.0.1:${port}`;
  fake.graphUrl = `http://127.0.0.1:${port}/v1.0`;
  return fake;
}
