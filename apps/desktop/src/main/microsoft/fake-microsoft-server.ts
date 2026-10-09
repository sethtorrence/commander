import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFakeOutlookMail, type FakeOutlookMail } from './fake-outlook-mail';
import { createFakeTeamsChannels, type FakeTeamsChannels } from './fake-teams-channels';

// A stand-in for the Microsoft identity platform (a single-tenant app's authority) and Microsoft
// Graph, for tests only (unit and end-to-end). It behaves like Microsoft where Commander depends on
// it: authorization code with PKCE and no client secret for a public client whose redirect is
// http://localhost (any port, the path matched exactly), refresh tokens that rotate, an ID token
// carrying the tenant, the granted scopes in the token response (fewer than asked for, when an
// administrator approved only some), `GET /me`, and the AADSTS errors of a tenant that needs admin
// consent; and
// for Teams sync, the User's Chats: `GET /me/chats?$expand=lastMessagePreview` (and one Chat), a
// Chat's members, and its messages newest-modified first, filtered on `lastModifiedDateTime`, paged
// with nextLinks; for Teams write-back (#106), posting a message as the signed-in user and
// `markChatReadForUser` / `markChatUnreadForUser`, each user's read time showing in the Chat's
// viewpoint (a post can be taken and its answer dropped, as when a connection fails at the wrong
// moment); for Outlook Calendar, `GET /me/calendars` and each calendar's `calendarView/delta` over
// a window, paged by `Prefer: odata.maxpagesize`, ending in a delta link that later returns only
// changes (deleted events as `@removed`), 410 SyncStateNotFound once delta links expire, and
// throttling; its events bare, as Graph's per-calendar delta gave a work account's (#241: an id, the
// type, series and times, nothing else) unless switched to full ones, and each event in full by its id
// (`GET /me/events/{id}` or `/me/calendars/{id}/events/{id}`, with `$select`), alone or in a JSON
// batch; answering invitations (#129): `GET /me/events/{id}` (a series master stands for
// its instances) and `POST /me/events/{id}/accept`, `/tentativelyAccept` or `/decline`, each recorded
// with its `sendResponse`, after which the event (or every instance of the series) carries the
// answer; and for the events Commander writes (#131), `POST /me/calendars` (an owned calendar the
// User can edit), `POST /me/calendars/{id}/events` (which hands back the event it already made for a
// `transactionId` it has seen, as Graph does for a retried create), `GET /me/events` filtered on an
// extended property's value (Commander's marker), `GET /me/events/{id}/calendar`, and `PATCH` and
// `DELETE /me/events/{id}`, each change returned by the next delta (with `transactionId`, but never
// extended properties, which delta can't expand); and for Outlook mail (#136), each user's mailbox
// (fake-outlook-mail.ts); and for Channel posts (#111), teams, channels, posts and replies, readable
// only with ChannelMessage.Read.All (fake-teams-channels.ts). Nothing here talks to the real Microsoft.

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
  // When each user (by id) last read it, as `viewpoint.lastMessageReadDateTime` shows them.
  readBy: Record<string, number>;
};

// An Outlook calendar the fake serves (as `GET /me/calendars` lists it), with its events: Graph event
// objects as calendarView returns them (instances of recurring events each their own, with times in
// UTC), at least an `id`, `start` and `end`.
export type FakeOutlookEvent = {
  id: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  [field: string]: unknown;
};
export type FakeOutlookCalendar = {
  calendar: {
    id: string;
    name: string;
    color?: string;
    hexColor?: string;
    isDefaultCalendar?: boolean;
    canEdit?: boolean;
    owner?: { name: string; address: string };
  };
  events: FakeOutlookEvent[];
};

// A calendar write the fake received.
export type FakeCalendarWrite = { method: string; path: string; body: unknown };

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
  // Every Graph GET, as its path and query (decoded).
  graphRequests: string[];
  // Every Graph POST: its path (decoded) and JSON body.
  graphPosts: { path: string; body: Record<string, unknown> }[];
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
  // A Chat as the fake holds it (its messages, and who read it when).
  chat(chatId: string): FakeChat;
  // A user reads the Chat in Teams (now, or `at`).
  readChat(chatId: string, userId: string, at?: number): void;
  // The next message posted is taken, but the connection drops before Graph answers.
  dropNextPostAnswer(): void;
  // Posted messages are refused with this status until switched back (null).
  refusePosts(status: 400 | 403 | 500 | null): void;
  // The next Graph requests are refused with this status and Retry-After (seconds), until switched back.
  throttleGraph(answer: { status: 429 | 503; retryAfter: number } | null): void;
  // Outlook Calendar: a user's calendars and their events (replacing any before).
  setCalendars(userId: string, calendars: FakeOutlookCalendar[]): void;
  // Adds an event to a calendar, or changes it (the next delta returns it).
  putEvent(userId: string, calendarId: string, event: FakeOutlookEvent): void;
  // Deletes an event (the next delta returns it as @removed).
  removeEvent(userId: string, calendarId: string, eventId: string): void;
  // Every delta link handed out so far stops working (410 SyncStateNotFound), mail's too.
  expireDeltaLinks(): void;
  // Calendar delta answers events bare (true, from the start, as Graph's per-calendar delta did) or
  // in full (false, as the primary calendar's delta does).
  bareDeltaEvents(bare: boolean): void;
  // Outlook mail (#136): each user's mailbox, its folders and messages (fake-outlook-mail.ts).
  mail: FakeOutlookMail;
  // Channel posts (#111): teams, channels, posts and replies (fake-teams-channels.ts).
  channels: FakeTeamsChannels;
  // Refreshes asking for any of these scopes are refused as not consented to (AADSTS65001), as after
  // an administrator withdrew them. null accepts every scope again.
  refuseRefreshScopes(scopes: string[] | null): void;
  // The Prefer header of every calendar request.
  calendarPrefers: string[];
  // Every answer to an invitation Commander sent, oldest first.
  rsvps: { userId: string; eventId: string; action: string; sendResponse: boolean | null }[];
  // Every calendar write (POST, PATCH and DELETE), its path and query decoded, and its JSON body.
  calendarWrites: FakeCalendarWrite[];
  // A user's live events on a calendar, with the extended properties they were made with.
  eventsOn(userId: string, calendarId: string): FakeOutlookEvent[];
  // A user's calendars, as `GET /me/calendars` lists them.
  calendarsOf(userId: string): FakeOutlookCalendar['calendar'][];
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
  let unconsented: Set<string> | null = null;
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; user: FakeMicrosoftUser; scope: string }
  >();
  const grants: Grant[] = [];
  const issued: string[] = [];
  let refreshFailing = false;
  let refreshDelay = 0;
  const chats: FakeChat[] = [];
  let dropPostAnswer = false;
  let refusingPosts: 400 | 403 | 500 | null = null;
  let throttled: { status: 429 | 503; retryAfter: number } | null = null;
  // Outlook Calendar: each user's calendars, every change numbered (`version`), deleted events kept
  // with the change that deleted them, and the delta and page tokens handed out.
  type CalendarState = {
    calendar: FakeOutlookCalendar['calendar'];
    events: Map<string, { event: FakeOutlookEvent; version: number }>;
    removed: Map<string, number>;
  };
  type Window = { min: number; max: number };
  const calendarsByUser = new Map<string, CalendarState[]>();
  let version = 0;
  let deltaGeneration = 0;
  let bareDelta = true;
  const deltaTokens = new Map<
    string,
    { calendarId: string; since: number; window: Window; generation: number }
  >();
  const pageTokens = new Map<string, { calendarId: string; rest: unknown[]; upTo: number; window: Window }>();
  const calendarOf = (userId: string, calendarId: string) => {
    const found = calendarsByUser.get(userId)?.find((each) => each.calendar.id === calendarId);
    if (!found) throw new Error(`No fake calendar ${calendarId} for ${userId}`);
    return found;
  };
  // Calendar writes: the extended properties each event was made with, kept apart from the event as
  // delta never returns them, and a count of the events and calendars made, for their ids.
  const extendedProperties = new Map<string, unknown[]>();
  let madeCount = 0;

  const fake: FakeMicrosoft = {
    loginUrl: '',
    graphUrl: '',
    clientId,
    tenantId,
    authorizeRequests: [],
    tokenRequests: [],
    graphRequests: [],
    graphPosts: [],
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
    refuseRefreshScopes: (scopes) => {
      unconsented = scopes && new Set(scopes);
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
      chats.push({ id, members, topic, chatType, updatedAt, messages: [], readBy: {} });
    },
    chat: (chatId) => {
      const chat = chats.find((each) => each.id === chatId);
      if (!chat) throw new Error(`No fake chat ${chatId}`);
      return chat;
    },
    readChat: (chatId, userId, at = Date.now()) => {
      fake.chat(chatId).readBy[userId] = at;
    },
    dropNextPostAnswer: () => {
      dropPostAnswer = true;
    },
    refusePosts: (status) => {
      refusingPosts = status;
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
    setCalendars: (userId, calendars) => {
      calendarsByUser.set(
        userId,
        calendars.map(({ calendar, events }) => ({
          calendar,
          events: new Map(events.map((event) => [event.id, { event, version: ++version }])),
          removed: new Map(),
        })),
      );
    },
    putEvent: (userId, calendarId, event) => {
      const calendar = calendarOf(userId, calendarId);
      calendar.events.set(event.id, { event, version: ++version });
      calendar.removed.delete(event.id);
    },
    removeEvent: (userId, calendarId, eventId) => {
      const calendar = calendarOf(userId, calendarId);
      calendar.events.delete(eventId);
      calendar.removed.set(eventId, ++version);
    },
    expireDeltaLinks: () => {
      deltaGeneration += 1;
      fake.mail.expireDeltaLinks();
    },
    bareDeltaEvents: (bare) => {
      bareDelta = bare;
    },
    mail: createFakeOutlookMail(
      () => fake.graphUrl,
      (url, user) => {
        const read = eventRead(user, url);
        if (read) fake.graphRequests.push(decodeURIComponent(url.pathname + url.search));
        return read;
      },
    ),
    channels: createFakeTeamsChannels(() => fake.graphUrl, tenantId),
    calendarPrefers: [],
    rsvps: [],
    calendarWrites: [],
    eventsOn: (userId, calendarId) =>
      [...calendarOf(userId, calendarId).events.values()].map(({ event }) => withProperties(event)),
    calendarsOf: (userId) =>
      (calendarsByUser.get(userId) ?? []).map(({ calendar }) => listedCalendar(calendar, userNamed(userId))),
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
      if (form.scope.split(' ').some((scope) => unconsented?.has(scope)))
        return tokenError(response, 400, 'invalid_grant', 65001, ADMIN_CONSENT_TEXT.AADSTS65001);
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

  function graphChat(chat: FakeChat, user: FakeMicrosoftUser) {
    const last = latest(chat);
    const readAt = chat.readBy[user.id];
    return {
      id: chat.id,
      topic: chat.topic,
      createdDateTime: iso(chat.updatedAt),
      lastUpdatedDateTime: iso(chat.updatedAt),
      chatType: chat.chatType,
      webUrl: `https://teams.microsoft.com/l/chat/${encodeURIComponent(chat.id)}/0?tenantId=${tenantId}`,
      tenantId,
      onlineMeetingInfo: null,
      viewpoint: { isHidden: false, lastMessageReadDateTime: readAt === undefined ? null : iso(readAt) },
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

  function toGraphMessage(message: FakeChatMessage) {
    return {
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
    };
  }

  // The Chat a /chats/{id}[/part] path names, and the part (null for the Chat itself).
  function chatIn(url: URL): { chat: FakeChat; part: string | null } | null {
    const match = /^\/v1\.0\/chats\/([^/]+)(?:\/([A-Za-z]+))?$/.exec(url.pathname);
    const chat = match && chats.find((each) => each.id === decodeURIComponent(match[1] ?? ''));
    return match && chat ? { chat, part: match[2] ?? null } : null;
  }

  function chatResource(url: URL, response: ServerResponse, user: FakeMicrosoftUser) {
    const found = chatIn(url);
    if (!found || (found.part !== null && found.part !== 'members' && found.part !== 'messages')) {
      return json(response, 404, { error: { code: 'NotFound', message: 'No such chat.' } });
    }
    const { chat, part } = found;
    if (part === null) return json(response, 200, graphChat(chat, user));
    if (part === 'members') {
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
      .map(toGraphMessage);
    return paged(response, url, messages);
  }

  // Graph writes calendarView times in UTC without an offset, to seven decimals.
  const utc = (time: { dateTime: string }) => Date.parse(`${time.dateTime.slice(0, 19)}Z`);
  const inWindow = (event: FakeOutlookEvent, window: Window) =>
    utc(event.end) > window.min && utc(event.start) < window.max;

  function calendarList(user: FakeMicrosoftUser, url: URL, response: ServerResponse) {
    const calendars = (calendarsByUser.get(user.id) ?? []).map(({ calendar }) => ({
      color: 'auto',
      hexColor: '',
      isDefaultCalendar: false,
      canEdit: true,
      owner: { name: user.displayName, address: user.userPrincipalName },
      ...calendar,
    }));
    return paged(response, url, calendars);
  }

  // `/me/calendars/{id}/calendarView/delta`: a window read in full, a page of one, or the changes
  // since a delta link, a page at a time (`Prefer: odata.maxpagesize`), ending in a new delta link.
  function calendarView(
    user: FakeMicrosoftUser,
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
  ) {
    const match = /^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView\/delta$/.exec(url.pathname);
    const calendarId = decodeURIComponent(match?.[1] ?? '');
    const calendar = calendarsByUser.get(user.id)?.find((each) => each.calendar.id === calendarId);
    if (!match || !calendar) {
      return json(response, 404, {
        error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' },
      });
    }
    const prefer = String(request.headers.prefer ?? '');
    fake.calendarPrefers.push(prefer);
    const pageSize = Number(/odata\.maxpagesize=(\d+)/.exec(prefer)?.[1] ?? 10) || 10;
    const asEvent = (event: FakeOutlookEvent) =>
      bareDelta
        ? {
            '@odata.type': '#microsoft.graph.event',
            '@odata.etag': `W/"${event.id}"`,
            id: event.id,
            ...(event.type !== undefined && { type: event.type }),
            ...(event.seriesMasterId ? { seriesMasterId: event.seriesMasterId } : {}),
            start: event.start,
            end: event.end,
          }
        : { '@odata.type': '#microsoft.graph.event', ...event };
    let all: unknown[];
    let upTo = version;
    let window: Window;
    const skip = url.searchParams.get('$skiptoken');
    const delta = url.searchParams.get('$deltatoken');
    if (skip !== null) {
      const page = pageTokens.get(skip);
      if (!page || page.calendarId !== calendarId) {
        return json(response, 410, {
          error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' },
        });
      }
      pageTokens.delete(skip);
      ({ rest: all, upTo, window } = page);
    } else if (delta !== null) {
      const mark = deltaTokens.get(delta);
      if (!mark || mark.calendarId !== calendarId || mark.generation < deltaGeneration) {
        return json(response, 410, {
          error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' },
        });
      }
      window = mark.window;
      all = [
        ...[...calendar.events.values()]
          .filter((each) => each.version > mark.since && inWindow(each.event, window))
          .map((each) => asEvent(each.event)),
        ...[...calendar.removed.entries()]
          .filter(([, removedAt]) => removedAt > mark.since)
          .map(([id]) => ({
            '@odata.type': '#microsoft.graph.event',
            id,
            '@removed': { reason: 'deleted' },
          })),
      ];
    } else {
      window = {
        min: Date.parse(url.searchParams.get('startDateTime') ?? ''),
        max: Date.parse(url.searchParams.get('endDateTime') ?? ''),
      };
      if (!Number.isFinite(window.min) || !Number.isFinite(window.max)) {
        return json(response, 400, {
          error: { code: 'ErrorInvalidParameter', message: 'startDateTime and endDateTime are required.' },
        });
      }
      all = [...calendar.events.values()]
        .filter((each) => inWindow(each.event, window))
        .map((each) => asEvent(each.event));
    }
    const link = `${fake.graphUrl}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta`;
    const value = all.slice(0, pageSize);
    const rest = all.slice(pageSize);
    if (rest.length) {
      const next = token('skip');
      pageTokens.set(next, { calendarId, rest, upTo, window });
      return json(response, 200, { value, '@odata.nextLink': `${link}?$skiptoken=${next}` });
    }
    const next = token('delta');
    deltaTokens.set(next, { calendarId, since: upTo, window, generation: deltaGeneration });
    return json(response, 200, { value, '@odata.deltaLink': `${link}?$deltatoken=${next}` });
  }

  // A message posted as the signed-in user, or the Chat marked read or unread for them.
  async function chatAction(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: FakeMicrosoftUser,
  ) {
    let sent: Record<string, unknown> | null = null;
    try {
      sent = JSON.parse(await body(request)) as Record<string, unknown>;
    } catch {
      sent = null;
    }
    fake.graphPosts.push({ path: decodeURIComponent(url.pathname), body: sent ?? {} });
    const found = chatIn(url);
    if (!found) return json(response, 404, { error: { code: 'NotFound', message: 'No such chat.' } });
    if (!sent) return json(response, 400, { error: { code: 'BadRequest', message: 'Not JSON.' } });
    const { chat, part } = found;
    if (part === 'messages') {
      if (refusingPosts) {
        return json(response, refusingPosts, { error: { code: 'Refused', message: 'Refused by the fake.' } });
      }
      const content = (sent.body ?? {}) as { contentType?: unknown; content?: unknown };
      if (content.contentType !== 'html' || typeof content.content !== 'string' || !content.content) {
        return json(response, 400, { error: { code: 'BadRequest', message: 'Missing body.' } });
      }
      const at = Date.now();
      const message: FakeChatMessage = {
        id: String(at + chat.messages.length),
        from: user,
        html: content.content,
        createdAt: at,
        modifiedAt: at,
        mentions: [],
      };
      chat.messages.push(message);
      if (dropPostAnswer) {
        // Taken, but the answer never arrives.
        dropPostAnswer = false;
        response.socket?.destroy();
        return;
      }
      return json(response, 201, toGraphMessage(message));
    }
    if (part === 'markChatReadForUser' || part === 'markChatUnreadForUser') {
      const who = (sent.user ?? {}) as { id?: unknown; tenantId?: unknown };
      if (who.id !== user.id || who.tenantId !== tenantId) {
        return json(response, 403, { error: { code: 'Forbidden', message: 'Not this user.' } });
      }
      if (part === 'markChatReadForUser') chat.readBy[user.id] = Date.now();
      else {
        const readAt = Date.parse(String(sent.lastMessageReadDateTime));
        if (Number.isNaN(readAt)) return json(response, 400, { error: { code: 'BadRequest' } });
        chat.readBy[user.id] = readAt;
      }
      response.writeHead(204).end();
      return;
    }
    return json(response, 404, { error: { code: 'NotFound', message: 'Not in the fake.' } });
  }

  // ---------------------------------------------------------------------------------------------
  // Calendar writes (#131): the calendars and events Commander makes, moves and deletes.

  type ExtendedProperty = { id?: unknown; value?: unknown };

  const itemNotFound = (response: ServerResponse) =>
    json(response, 404, {
      error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' },
    });

  const userNamed = (userId: string) =>
    grants.find((each) => each.user.id === userId)?.user ??
    (typeof nextUser === 'object' && nextUser.id === userId ? nextUser : undefined);

  // A calendar as `GET /me/calendars` lists it, with the fields Graph fills in.
  function listedCalendar(calendar: FakeOutlookCalendar['calendar'], user: FakeMicrosoftUser | undefined) {
    return {
      color: 'auto',
      hexColor: '',
      isDefaultCalendar: false,
      canEdit: true,
      ...(user && { owner: { name: user.displayName, address: user.userPrincipalName } }),
      ...calendar,
    };
  }

  // One event in full by its id (a series master by its instances, as eventResource), through the
  // user's events or a calendar's, with the properties `$select` names (null when it has none, as Graph
  // answers them); null for a path that isn't one.
  function eventRead(user: FakeMicrosoftUser, url: URL): { status: number; body: unknown } | null {
    const mine = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(url.pathname);
    const onCalendar = /^\/v1\.0\/me\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname);
    if (!mine && !onCalendar) return null;
    const eventId = decodeURIComponent((mine?.[1] ?? onCalendar?.[2]) as string);
    const calendars = (calendarsByUser.get(user.id) ?? []).filter(
      (each) => !onCalendar || each.calendar.id === decodeURIComponent(onCalendar[1] as string),
    );
    const held = calendars.flatMap((calendar) => [...calendar.events.values()]);
    const own = held.find((each) => each.event.id === eventId)?.event;
    const instance = held.find((each) => each.event.seriesMasterId === eventId)?.event;
    const shown = own ?? (instance ? { ...instance, id: eventId, type: 'seriesMaster' } : null);
    if (!shown) {
      return {
        status: 404,
        body: {
          error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' },
        },
      };
    }
    const select = url.searchParams.get('$select')?.split(',').filter(Boolean);
    const body = select
      ? Object.fromEntries(
          ['id', ...select].map((key) => [key, (shown as Record<string, unknown>)[key] ?? null]),
        )
      : shown;
    return { status: 200, body: { '@odata.etag': `W/"${eventId}"`, ...body } };
  }

  // An event with the extended properties it was made with: answers to writes, never delta.
  const withProperties = (event: FakeOutlookEvent): FakeOutlookEvent => {
    const properties = extendedProperties.get(event.id);
    return properties ? { ...event, singleValueExtendedProperties: properties } : event;
  };

  const liveEvents = (userId: string) =>
    (calendarsByUser.get(userId) ?? []).flatMap((each) =>
      [...each.events.values()].map(({ event }) => event),
    );

  const zoneOf = (time: unknown) => String((time as { timeZone?: unknown } | null)?.timeZone ?? 'UTC');

  // Graph takes a time as a wall clock in a zone (IANA, or UTC); calendarView writes it in UTC.
  function inUtc(time: unknown): { dateTime: string; timeZone: string } {
    const dateTime = String((time as { dateTime?: unknown } | null)?.dateTime ?? '');
    const timeZone = zoneOf(time);
    const wall = Date.parse(`${dateTime.slice(0, 19)}Z`);
    if (!Number.isFinite(wall)) return { dateTime, timeZone };
    // How far the zone's clocks are ahead of UTC at an instant; a zone Intl doesn't know counts as UTC.
    const offset = (at: number) => {
      try {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(at);
        const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
        const shown = Date.UTC(
          part('year'),
          part('month') - 1,
          part('day'),
          part('hour'),
          part('minute'),
          part('second'),
        );
        return shown - Math.floor(at / 1000) * 1000;
      } catch {
        return 0;
      }
    };
    // The wall clock less the zone's offset, checked again at the instant found (clock changes).
    const at = wall - offset(wall - offset(wall));
    return { dateTime: `${new Date(at).toISOString().slice(0, 19)}.0000000`, timeZone: 'UTC' };
  }

  // The requests answered here: everything under /me/events but reading one event and answering an
  // invitation (#129, eventResource), and POSTs making calendars and events.
  function isCalendarWrite(request: IncomingMessage, url: URL) {
    const path = url.pathname;
    const one = /^\/v1\.0\/me\/events\/[^/]+(\/[^/]+)?$/.exec(path);
    if (one && request.method === 'GET' && !one[1]) return false;
    if (one && request.method === 'POST' && /^\/(accept|tentativelyAccept|decline)$/.test(one[1] ?? ''))
      return false;
    if (path === '/v1.0/me/events' || path.startsWith('/v1.0/me/events/')) return true;
    return (
      request.method === 'POST' &&
      (path === '/v1.0/me/calendars' || /^\/v1\.0\/me\/calendars\/[^/]+\/events$/.test(path))
    );
  }

  async function calendarWrite(
    user: FakeMicrosoftUser,
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
  ) {
    const method = request.method ?? 'GET';
    const text = method === 'POST' || method === 'PATCH' ? await body(request) : '';
    let payload: Record<string, unknown> = {};
    try {
      if (text) payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return json(response, 400, {
        error: { code: 'BadRequest', message: 'Unable to read JSON request payload.' },
      });
    }
    if (method !== 'GET') {
      fake.calendarWrites.push({
        method,
        path: decodeURIComponent(url.pathname + url.search),
        body: text ? payload : null,
      });
    }
    const path = url.pathname;
    if (method === 'POST' && path === '/v1.0/me/calendars') return makeCalendar(user, payload, response);
    const events = /^\/v1\.0\/me\/calendars\/([^/]+)\/events$/.exec(path);
    if (method === 'POST' && events) {
      return makeEvent(user, decodeURIComponent(events[1] ?? ''), payload, response);
    }
    if (method === 'GET' && path === '/v1.0/me/events') return markedEvents(user, url, response);
    const one = /^\/v1\.0\/me\/events\/([^/]+)(\/calendar)?$/.exec(path);
    const eventId = decodeURIComponent(one?.[1] ?? '');
    const calendar = (calendarsByUser.get(user.id) ?? []).find((each) => each.events.has(eventId));
    const held = calendar?.events.get(eventId);
    if (!one || !calendar || !held) return itemNotFound(response);
    if (one[2]) {
      return method === 'GET'
        ? json(response, 200, listedCalendar(calendar.calendar, user))
        : itemNotFound(response);
    }
    if (method === 'GET') return json(response, 200, withProperties(held.event));
    if (method === 'PATCH') {
      // A merge: the fields sent replace the event's, times stored in UTC as calendarView answers them.
      const { singleValueExtendedProperties: _, id: __, ...fields } = payload;
      const event: FakeOutlookEvent = {
        ...held.event,
        ...fields,
        id: eventId,
        start: fields.start ? inUtc(fields.start) : held.event.start,
        end: fields.end ? inUtc(fields.end) : held.event.end,
        ...(fields.start ? { originalStartTimeZone: zoneOf(fields.start) } : {}),
        ...(fields.end ? { originalEndTimeZone: zoneOf(fields.end) } : {}),
        lastModifiedDateTime: new Date().toISOString(),
      };
      calendar.events.set(eventId, { event, version: ++version });
      return json(response, 200, withProperties(event));
    }
    if (method === 'DELETE') {
      calendar.events.delete(eventId);
      calendar.removed.set(eventId, ++version);
      extendedProperties.delete(eventId);
      response.writeHead(204).end();
      return;
    }
    return json(response, 405, { error: { code: 'MethodNotAllowed', message: 'Not in the fake.' } });
  }

  // `POST /me/calendars`: a calendar the User owns and can edit, listed from then on.
  function makeCalendar(user: FakeMicrosoftUser, payload: Record<string, unknown>, response: ServerResponse) {
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      return json(response, 400, {
        error: { code: 'ErrorInvalidRequest', message: 'A calendar needs a name.' },
      });
    }
    const calendar = { id: `AAMkFake-cal-${++madeCount}=`, name, canEdit: true, isDefaultCalendar: false };
    const calendars = calendarsByUser.get(user.id) ?? [];
    calendars.push({ calendar, events: new Map(), removed: new Map() });
    calendarsByUser.set(user.id, calendars);
    return json(response, 201, listedCalendar(calendar, user));
  }

  // `POST /me/calendars/{id}/events`. A transactionId the user's mailbox has already seen gets the
  // event made for it back, as Graph answers a retried create, rather than a second one.
  function makeEvent(
    user: FakeMicrosoftUser,
    calendarId: string,
    payload: Record<string, unknown>,
    response: ServerResponse,
  ) {
    const calendar = calendarsByUser.get(user.id)?.find((each) => each.calendar.id === calendarId);
    if (!calendar) return itemNotFound(response);
    const transactionId = typeof payload.transactionId === 'string' ? payload.transactionId : null;
    const already = transactionId && liveEvents(user.id).find((each) => each.transactionId === transactionId);
    if (already) return json(response, 201, withProperties(already));
    const { singleValueExtendedProperties, id: _, ...fields } = payload;
    const id = `AAMkFake-evt-${++madeCount}=`;
    const now = new Date().toISOString();
    const event: FakeOutlookEvent = {
      type: 'singleInstance',
      isAllDay: false,
      isCancelled: false,
      isOrganizer: true,
      showAs: 'busy',
      sensitivity: 'normal',
      attendees: [],
      responseStatus: { response: 'organizer', time: '0001-01-01T00:00:00Z' },
      organizer: { emailAddress: { name: user.displayName, address: user.userPrincipalName } },
      createdDateTime: now,
      lastModifiedDateTime: now,
      ...fields,
      transactionId,
      originalStartTimeZone: zoneOf(fields.start),
      originalEndTimeZone: zoneOf(fields.end),
      id,
      start: inUtc(fields.start),
      end: inUtc(fields.end),
    };
    calendar.events.set(id, { event, version: ++version });
    calendar.removed.delete(id);
    if (Array.isArray(singleValueExtendedProperties))
      extendedProperties.set(id, singleValueExtendedProperties);
    return json(response, 201, withProperties(event));
  }

  // `GET /me/events?$filter=singleValueExtendedProperties/Any(ep: ep/id eq '…' and ep/value eq '…')`:
  // the user's live events carrying that property (just their ids, as Commander $selects).
  function markedEvents(user: FakeMicrosoftUser, url: URL, response: ServerResponse) {
    const filter = url.searchParams.get('$filter') ?? '';
    const quoted = (name: string) =>
      new RegExp(`ep/${name} eq '((?:[^']|'')*)'`).exec(filter)?.[1]?.replaceAll("''", "'");
    const id = quoted('id')?.toLowerCase();
    const value = quoted('value');
    const matching = liveEvents(user.id).filter(
      (event) =>
        value === undefined ||
        (extendedProperties.get(event.id) ?? []).some((property) => {
          const { id: propertyId, value: propertyValue } = property as ExtendedProperty;
          return propertyValue === value && (!id || String(propertyId).toLowerCase() === id);
        }),
    );
    return json(response, 200, { value: matching.map((event) => ({ id: event.id })) });
  }

  function graph(request: IncomingMessage, url: URL, response: ServerResponse) {
    if (request.method === 'GET') fake.graphRequests.push(decodeURIComponent(url.pathname + url.search));
    const authorization = request.headers.authorization ?? '';
    const granted = authorization.startsWith('Bearer ')
      ? grants.find((g) => g.accessToken === authorization.slice('Bearer '.length))
      : undefined;
    const user = granted?.user;
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
    if (fake.mail.handles(request, url)) return void fake.mail.handle(request, url, response, user);
    if (fake.channels.handles(url)) return fake.channels.handle(request, url, response, user, granted.scope);
    if (isCalendarWrite(request, url)) return void calendarWrite(user, request, url, response);
    if (request.method === 'POST') {
      if (url.pathname.startsWith('/v1.0/chats/')) return void chatAction(request, url, response, user);
      if (url.pathname.startsWith('/v1.0/me/events/'))
        return void eventResource(user, request, url, response);
      return json(response, 404, { error: { code: 'ResourceNotFound', message: 'Not in the fake.' } });
    }
    if (url.pathname === '/v1.0/me/chats') {
      return paged(
        response,
        url,
        chats.map((chat) => graphChat(chat, user)),
      );
    }
    if (url.pathname.startsWith('/v1.0/chats/')) return chatResource(url, response, user);
    if (url.pathname === '/v1.0/me/calendars') return calendarList(user, url, response);
    if (/^\/v1\.0\/me\/calendars\/[^/]+\/events\/[^/]+$/.test(url.pathname)) {
      const read = eventRead(user, url);
      if (read) return json(response, read.status, read.body);
    }
    if (url.pathname.startsWith('/v1.0/me/calendars/')) return calendarView(user, request, url, response);
    if (url.pathname.startsWith('/v1.0/me/events/')) return void eventResource(user, request, url, response);
    if (url.pathname === '/v1.0/me') {
      return json(response, 200, {
        '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
        ...user,
        mail: user.userPrincipalName,
      });
    }
    return json(response, 404, { error: { code: 'ResourceNotFound', message: 'Not in the fake.' } });
  }

  const RSVP_ANSWERS: Record<string, string> = {
    accept: 'accepted',
    tentativelyAccept: 'tentativelyAccepted',
    decline: 'declined',
  };

  // One event, or a series by its master's id (its instances stand for it), and answering it.
  async function eventResource(
    user: FakeMicrosoftUser,
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
  ) {
    const [, id = '', action] = /^\/v1\.0\/me\/events\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname) ?? [];
    const eventId = decodeURIComponent(id);
    const held = (calendarsByUser.get(user.id) ?? []).flatMap((calendar) => [...calendar.events.values()]);
    const own = held.find((each) => each.event.id === eventId);
    const instances = held.filter((each) => each.event.seriesMasterId === eventId);
    const shown =
      own?.event ?? (instances[0] ? { ...instances[0].event, id: eventId, type: 'seriesMaster' } : null);
    if (!shown) {
      return json(response, 404, {
        error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' },
      });
    }
    if (request.method === 'GET' && !action) return json(response, 200, shown);
    const answer = action ? RSVP_ANSWERS[action] : undefined;
    if (request.method !== 'POST' || !answer) {
      return json(response, 400, { error: { code: 'BadRequest', message: 'Not in the fake.' } });
    }
    const sent = JSON.parse((await body(request)) || '{}') as { sendResponse?: boolean };
    if (shown.isOrganizer === true) {
      return json(response, 400, {
        error: {
          code: 'ErrorInvalidRequest',
          message: "Your request can't be completed. You are the organizer.",
        },
      });
    }
    const time = new Date().toISOString();
    for (const each of own ? [own] : instances) {
      const attendees = (each.event.attendees as { emailAddress?: { address?: string } }[] | undefined) ?? [];
      each.event = {
        ...each.event,
        responseStatus: { response: answer, time },
        lastModifiedDateTime: time,
        attendees: attendees.map((attendee) =>
          attendee.emailAddress?.address?.toLowerCase() === user.userPrincipalName.toLowerCase()
            ? { ...attendee, status: { response: answer, time } }
            : attendee,
        ),
      };
      each.version = ++version;
    }
    fake.rsvps.push({
      userId: user.id,
      eventId,
      action: action ?? '',
      sendResponse: sent.sendResponse ?? null,
    });
    response.writeHead(202).end();
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const authority = `/${tenantId}/oauth2/v2.0`;
    if (request.method === 'GET' && url.pathname === `${authority}/authorize`)
      return authorize(url, response);
    if (request.method === 'POST' && url.pathname === `${authority}/token`)
      return void tokenEndpoint(request, response);
    // An attachment's upload session (#138): its URL is its own authorisation, as Graph's are.
    if (fake.mail.handlesUpload(request, url)) return void fake.mail.upload(request, url, response);
    if (isCalendarWrite(request, url) || fake.mail.handles(request, url))
      return graph(request, url, response);
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname.startsWith('/v1.0/'))
      return graph(request, url, response);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.loginUrl = `http://127.0.0.1:${port}`;
  fake.graphUrl = `http://127.0.0.1:${port}/v1.0`;
  return fake;
}
