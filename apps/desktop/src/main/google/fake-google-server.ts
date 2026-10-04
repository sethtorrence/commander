import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFakeGmail, type FakeGmail } from './fake-gmail';

// A stand-in for Google's OAuth 2.0 endpoints and its OpenID Connect userinfo, for tests only (unit
// and end-to-end). It behaves like Google where Commander depends on it, for a "Desktop app" client:
// authorization code with PKCE (S256) and the desktop client's secret, a loopback redirect on
// 127.0.0.1 at any port, `access_type=offline` and `prompt=consent` for a refresh token,
// `include_granted_scopes` adding earlier grants, permissions the User can untick on the consent
// screen (the token's `scope` says what was granted, with `email` and `profile` written as
// Google writes them), refresh tokens that don't rotate (a refresh brings no new one), an ID token
// carrying `sub` and `email`, and the errors of a Workspace whose admin has blocked the app.
//
// It also serves the Google Calendar API v3 as far as calendar sync reads it: each user's
// `calendarList`, and `events.list` per calendar (instances already expanded, as with
// `singleEvents=true`), paged by `maxResults`, with `timeMin`/`timeMax` on a full read and a
// `nextSyncToken` on the last page; a request with a sync token answers what changed since
// (cancelled events included). Tokens can be expired (410 Gone) and requests rate limited (403
// rateLimitExceeded). Answering invitations (#129): `events.get` for one event, and `events.patch` of
// the User's own attendee line (`attendeesOmitted`), on an instance or on a whole series (every
// instance of it follows), each recorded with its `sendUpdates`. And it serves each user's mailbox
// through the Gmail API (fake-gmail.ts), at `gmailUrl`, for the tokens it issued.
//
// And it takes the writes Commander makes for its own events (#131): `calendars.insert` (a new
// calendar the user owns, listed by `calendarList` from then on), and `events.insert` (honouring a
// client-supplied id, and answering 409 for an id the calendar already has, cancelled or not),
// `events.patch` of anything but an answer (merged into the event, null clearing a field) and
// `events.delete` (cancelling it, so incremental reads report it; 410 when already cancelled, 404 when
// unknown). An inserted event is stored as sent, so `extendedProperties`, `visibility` and
// `transparency` come back through `events.list` and incremental sync. Only owned and writable
// calendars take writes. And `freeBusy.query` for Ares's scheduler (#132): the busy times given for an
// address, and `notFound` for any other. Nothing here talks to the real Google.

export type FakeGoogleUser = { sub: string; email: string; name: string };

// An event as the Calendar API returns it (an instance, for a recurring one). `id` is required; the
// rest is passed through as given.
export type FakeCalendarEvent = { id: string; [field: string]: unknown };

export type FakeCalendar = {
  id: string;
  summary: string;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  backgroundColor: string;
  primary?: boolean;
  timeZone?: string;
};

export type FakeGoogle = {
  // Like https://accounts.google.com/o/oauth2/v2/auth, https://oauth2.googleapis.com/token and
  // https://openidconnect.googleapis.com/v1/userinfo.
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  // Like https://gmail.googleapis.com: the Gmail API, under /gmail/v1/users/me/….
  gmailUrl: string;
  // Each user's mailbox, by their address: deliver, relabel and delete mail; expire history; throttle.
  gmail: FakeGmail;
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
  // Like https://www.googleapis.com/calendar/v3.
  calendarUrl: string;
  // Every Calendar API request, as its path and query (decoded), oldest first.
  calendarRequests: string[];
  // Every Calendar API write (and `events.get`), as its method, decoded path and JSON body (null for
  // none), oldest first.
  calendarWrites: { method: string; path: string; body: unknown }[];
  // Gives a user these calendars (replacing any), each with these events.
  setCalendars(sub: string, calendars: { calendar: FakeCalendar; events: FakeCalendarEvent[] }[]): void;
  // Adds or changes an event on one of a user's calendars.
  putEvent(sub: string, calendarId: string, event: FakeCalendarEvent): void;
  // Cancels (deletes) an event: incremental reads report it as cancelled.
  cancelEvent(sub: string, calendarId: string, eventId: string): void;
  // A user's live (not cancelled) events on one of their calendars, as stored.
  eventsOn(sub: string, calendarId: string): FakeCalendarEvent[];
  // A user's calendars, those the app made included.
  calendarsOf(sub: string): FakeCalendar[];
  // Every sync token issued so far answers 410 Gone from now on.
  expireSyncTokens(): void;
  // The next `count` events requests (reads and writes) answer 403 rateLimitExceeded.
  rateLimitCalendar(count: number): void;
  // Every answer to an invitation Commander sent (events.patch), oldest first.
  rsvps: {
    sub: string;
    calendarId: string;
    eventId: string;
    responseStatus: string;
    sendUpdates: string | null;
  }[];
  // The next `count` answers fail with 503 (Google is having trouble).
  failRsvps(count: number): void;
  // What freeBusy.query answers for an address (#132): its busy times, epoch ms. Any address not set
  // answers notFound, as a calendar Google won't share does.
  setFreeBusy(email: string, busy: { start: number; end: number }[]): void;
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
  // Calendar API: each user's calendars, and each calendar's events with the change they were last
  // changed in (a counter per server). Sync tokens name the change they were issued at.
  type StoredEvent = { event: FakeCalendarEvent; changed: number; cancelled: boolean; updatedAt?: number };
  const userCalendars = new Map<string, { calendar: FakeCalendar; events: Map<string, StoredEvent> }[]>();
  let changes = 0;
  let expiredBefore = 0;
  let rateLimited = 0;
  let rsvpFailures = 0;
  const freeBusy = new Map<string, { start: number; end: number }[]>();
  const calendarOf = (sub: string, calendarId: string) => {
    const found = userCalendars.get(sub)?.find((each) => each.calendar.id === calendarId);
    if (!found) throw new Error(`The fake Google has no calendar ${calendarId} for ${sub}`);
    return found;
  };
  const gmail = createFakeGmail();

  const fake: FakeGoogle = {
    authorizeUrl: '',
    tokenUrl: '',
    userinfoUrl: '',
    gmailUrl: '',
    gmail,
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
    calendarUrl: '',
    calendarRequests: [],
    calendarWrites: [],
    setCalendars: (sub, calendars) => {
      changes += 1;
      userCalendars.set(
        sub,
        calendars.map(({ calendar, events }) => ({
          calendar,
          events: new Map(
            events.map((event) => [
              event.id,
              { event, changed: changes, cancelled: false, updatedAt: Date.now() },
            ]),
          ),
        })),
      );
    },
    putEvent: (sub, calendarId, event) => {
      changes += 1;
      calendarOf(sub, calendarId).events.set(event.id, {
        event,
        changed: changes,
        cancelled: false,
        updatedAt: Date.now(),
      });
    },
    cancelEvent: (sub, calendarId, eventId) => {
      changes += 1;
      const stored = calendarOf(sub, calendarId).events.get(eventId);
      if (stored) Object.assign(stored, { changed: changes, cancelled: true });
    },
    eventsOn: (sub, calendarId) =>
      [...calendarOf(sub, calendarId).events.values()]
        .filter((each) => !each.cancelled)
        .map((each) => each.event),
    calendarsOf: (sub) => (userCalendars.get(sub) ?? []).map(({ calendar }) => calendar),
    expireSyncTokens: () => {
      changes += 1;
      expiredBefore = changes;
    },
    rateLimitCalendar: (count) => {
      rateLimited = count;
    },
    rsvps: [],
    setFreeBusy: (email, busy) => {
      freeBusy.set(email.toLowerCase(), busy);
    },
    failRsvps: (count) => {
      rsvpFailures = count;
    },
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

  // When an event happens, for the window: [start, end) in epoch ms (all-day events by UTC days).
  function spanOf(event: FakeCalendarEvent): [number, number] {
    const at = (value: unknown) => {
      const time = value as { dateTime?: string; date?: string } | undefined;
      return Date.parse(time?.dateTime ?? `${time?.date}T00:00:00Z`);
    };
    return [at(event.start), at(event.end)];
  }

  const calendarError = (response: ServerResponse, status: number, message: string, reason: string) =>
    json(response, status, {
      error: { code: status, message, errors: [{ domain: 'global', reason, message }] },
    });

  // Google's ids for events: base32hex (a–v, 0–9), 5 to 1024 characters.
  const isEventId = (id: unknown): id is string => typeof id === 'string' && /^[a-v0-9]{5,1024}$/.test(id);

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  // A patch merged into an event as Google merges one: nested objects field by field, null clearing.
  function merge(target: Record<string, unknown>, patch: Record<string, unknown>) {
    for (const [field, value] of Object.entries(patch)) {
      if (field === 'id') continue;
      const current = target[field];
      if (value === null) delete target[field];
      else if (isRecord(value) && isRecord(current)) merge(current, value);
      else target[field] = structuredClone(value);
    }
  }

  // Calendar API writes, for the calendars and events Commander makes.
  async function calendarWrite(
    method: string,
    path: string,
    sent: unknown,
    user: FakeGoogleUser,
    response: ServerResponse,
  ) {
    const calendars = userCalendars.get(user.sub) ?? [];
    if (method === 'POST' && path === '/calendars') {
      const summary = isRecord(sent) && typeof sent.summary === 'string' ? sent.summary.trim() : '';
      if (!summary) return calendarError(response, 400, 'Missing title.', 'required');
      const calendar: FakeCalendar = {
        id: `c_${randomBytes(16).toString('hex')}@group.calendar.google.com`,
        summary,
        accessRole: 'owner',
        backgroundColor: '#7986cb',
        timeZone: 'UTC',
      };
      changes += 1;
      userCalendars.set(user.sub, [...calendars, { calendar, events: new Map() }]);
      return json(response, 200, {
        kind: 'calendar#calendar',
        etag: `"${changes}"`,
        id: calendar.id,
        summary,
        ...(isRecord(sent) && typeof sent.description === 'string' && { description: sent.description }),
        timeZone: calendar.timeZone,
      });
    }
    const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    const found = match && calendars.find((each) => each.calendar.id === decodeURIComponent(match[1] ?? ''));
    if (!match || !found) return calendarError(response, 404, 'Not Found', 'notFound');
    const eventId = match[2] === undefined ? null : decodeURIComponent(match[2]);
    if (method !== 'GET' && found.calendar.accessRole !== 'owner' && found.calendar.accessRole !== 'writer') {
      return calendarError(
        response,
        403,
        'You need to have writer access to this calendar.',
        'requiredAccessLevel',
      );
    }
    const answer = (stored: StoredEvent) =>
      json(response, 200, {
        kind: 'calendar#event',
        ...stored.event,
        status: stored.cancelled ? 'cancelled' : 'confirmed',
      });

    if (method === 'POST' && eventId === null) {
      if (!isRecord(sent)) return calendarError(response, 400, 'Bad Request', 'badRequest');
      const id = sent.id === undefined ? randomBytes(16).toString('hex') : sent.id;
      if (!isEventId(id)) return calendarError(response, 400, 'Invalid resource id value.', 'invalid');
      if (found.events.has(id)) {
        return calendarError(response, 409, 'The requested identifier already exists.', 'duplicate');
      }
      const now = new Date().toISOString();
      changes += 1;
      const stored: StoredEvent = {
        event: {
          ...structuredClone(sent),
          id,
          etag: `"${changes}"`,
          status: 'confirmed',
          htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${found.calendar.id}`).toString('base64url')}`,
          created: now,
          updated: now,
          creator: { email: user.email, self: true },
          organizer: found.calendar.primary
            ? { email: user.email, self: true }
            : { email: found.calendar.id, displayName: found.calendar.summary, self: true },
          iCalUID: `${id}@google.com`,
          sequence: 0,
        },
        changed: changes,
        cancelled: false,
      };
      found.events.set(id, stored);
      return answer(stored);
    }
    const stored = eventId === null ? undefined : found.events.get(eventId);
    if (eventId === null || !stored) return calendarError(response, 404, 'Not Found', 'notFound');
    if (method === 'GET') return answer(stored);
    if (stored.cancelled) return calendarError(response, 410, 'Resource has been deleted', 'deleted');
    if (method === 'PATCH') {
      if (!isRecord(sent)) return calendarError(response, 400, 'Bad Request', 'badRequest');
      changes += 1;
      merge(stored.event, sent);
      Object.assign(stored.event, {
        etag: `"${changes}"`,
        updated: new Date().toISOString(),
        sequence: Number(stored.event.sequence ?? 0) + 1,
      });
      stored.changed = changes;
      return answer(stored);
    }
    if (method === 'DELETE') {
      changes += 1;
      Object.assign(stored, { changed: changes, cancelled: true });
      return void response.writeHead(204).end();
    }
    return calendarError(response, 405, 'Method Not Allowed', 'methodNotAllowed');
  }

  async function calendarApi(request: IncomingMessage, url: URL, response: ServerResponse) {
    const method = request.method ?? 'GET';
    fake.calendarRequests.push(decodeURIComponent(`${url.pathname}${url.search}`));
    const path = url.pathname.slice('/calendar/v3'.length);
    const text = method === 'GET' ? '' : await body(request);
    let sent: unknown = null;
    try {
      sent = text ? JSON.parse(text) : null;
    } catch {
      return calendarError(response, 400, 'Parse Error', 'parseError');
    }
    const isEventRead = method === 'GET' && /^\/calendars\/[^/]+\/events\/[^/]+$/.test(path);
    if (method !== 'GET' || isEventRead) {
      fake.calendarWrites.push({ method, path: decodeURIComponent(path), body: sent });
    }
    const authorization = request.headers.authorization ?? '';
    const user = authorization.startsWith('Bearer ')
      ? accessTokens.get(authorization.slice('Bearer '.length))
      : undefined;
    if (!user) return json(response, 401, { error: { code: 401, message: 'Invalid Credentials' } });
    if (rateLimited > 0 && /^\/calendars\/[^/]+\/events/.test(path)) {
      rateLimited -= 1;
      return json(response, 403, {
        error: {
          code: 403,
          message: 'Rate Limit Exceeded',
          errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }],
        },
      });
    }
    const calendars = userCalendars.get(user.sub) ?? [];
    const one = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path);
    // Reading one event, and answering an invitation (#129); every other write is Commander's own event's.
    const answering = method === 'PATCH' && (sent as { attendeesOmitted?: unknown } | null)?.attendeesOmitted;
    if (one && (isEventRead || answering))
      return oneEvent(request, url, response, user, calendars, one, sent);
    if (method === 'POST' && path === '/freeBusy') {
      const asked = isRecord(sent) && Array.isArray(sent.items) ? sent.items : [];
      const min = Date.parse(String(isRecord(sent) ? sent.timeMin : ''));
      const max = Date.parse(String(isRecord(sent) ? sent.timeMax : ''));
      const answered: Record<string, unknown> = {};
      for (const item of asked) {
        const id = isRecord(item) && typeof item.id === 'string' ? item.id : '';
        const busy = freeBusy.get(id.toLowerCase());
        answered[id] = busy
          ? {
              busy: busy
                .filter((each) => each.end > min && each.start < max)
                .map((each) => ({
                  start: new Date(each.start).toISOString(),
                  end: new Date(each.end).toISOString(),
                })),
            }
          : { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] };
      }
      return json(response, 200, {
        kind: 'calendar#freeBusy',
        timeMin: isRecord(sent) ? sent.timeMin : null,
        timeMax: isRecord(sent) ? sent.timeMax : null,
        calendars: answered,
      });
    }
    if (method !== 'GET') return calendarWrite(method, path, sent, user, response);
    const max = Number(url.searchParams.get('maxResults') ?? 250);
    const offset = Number(url.searchParams.get('pageToken') ?? 0);
    const page = <T>(all: T[]) => ({
      items: all.slice(offset, offset + max),
      next: offset + max < all.length ? String(offset + max) : null,
    });
    if (path === '/users/me/calendarList') {
      const { items, next } = page(
        calendars.map(({ calendar }) => ({ kind: 'calendar#calendarListEntry', ...calendar })),
      );
      return json(response, 200, {
        kind: 'calendar#calendarList',
        items,
        ...(next ? { nextPageToken: next } : { nextSyncToken: `fake-list-${changes}` }),
      });
    }
    const match = /^\/calendars\/([^/]+)\/events$/.exec(path);
    const found = match && calendars.find((each) => each.calendar.id === decodeURIComponent(match[1] ?? ''));
    if (!found) return json(response, 404, { error: { code: 404, message: 'Not Found' } });
    const syncToken = url.searchParams.get('syncToken');
    let events: StoredEvent[] = [...found.events.values()];
    if (syncToken) {
      const since = Number(/^fake-sync-(\d+)$/.exec(syncToken)?.[1] ?? Number.NaN);
      if (!Number.isFinite(since) || since < expiredBefore) {
        return json(response, 410, {
          error: {
            code: 410,
            message: 'Sync token is no longer valid, a full sync is required.',
            errors: [{ domain: 'calendar', reason: 'fullSyncRequired' }],
          },
        });
      }
      events = events.filter((each) => each.changed > since);
    } else {
      const min = Date.parse(url.searchParams.get('timeMin') ?? '');
      const max = Date.parse(url.searchParams.get('timeMax') ?? '');
      events = events.filter((each) => {
        if (each.cancelled) return false;
        const [start, end] = spanOf(each.event);
        return (Number.isNaN(min) || end > min) && (Number.isNaN(max) || start < max);
      });
    }
    const listed = events.map((each) =>
      each.cancelled
        ? { kind: 'calendar#event', id: each.event.id, status: 'cancelled' }
        : { kind: 'calendar#event', status: 'confirmed', ...each.event },
    );
    const { items, next } = page(listed);
    return json(response, 200, {
      kind: 'calendar#events',
      summary: found.calendar.summary,
      timeZone: found.calendar.timeZone ?? 'UTC',
      items,
      ...(next ? { nextPageToken: next } : { nextSyncToken: `fake-sync-${changes}` }),
    });
  }

  // As Google shows an event: with when it last changed.
  const shown = (stored: StoredEvent) => ({
    kind: 'calendar#event',
    status: 'confirmed',
    updated: new Date(stored.updatedAt ?? 0).toISOString(),
    ...stored.event,
  });

  // events.get and events.patch (the User's own answer only) on one event, or a whole series.
  function oneEvent(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: FakeGoogleUser,
    calendars: { calendar: FakeCalendar; events: Map<string, StoredEvent> }[],
    [, calendarPart, eventPart]: RegExpExecArray,
    sent: unknown,
  ) {
    const calendarId = decodeURIComponent(calendarPart ?? '');
    const eventId = decodeURIComponent(eventPart ?? '');
    const found = calendars.find((each) => each.calendar.id === calendarId);
    const stored = found?.events.get(eventId);
    // A series Google holds as its instances here: the first of them stands for it.
    const instances = found
      ? [...found.events.values()].filter((each) => each.event.recurringEventId === eventId)
      : [];
    const target =
      stored ?? (instances[0] ? { ...instances[0], event: { ...instances[0].event, id: eventId } } : null);
    const gone = () =>
      json(response, 404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });
    if (!found || !target || target.cancelled) return gone();
    if (request.method === 'GET') return json(response, 200, shown(target));
    if (request.method !== 'PATCH')
      return json(response, 405, { error: { code: 405, message: 'Method not allowed' } });
    const patch = (sent ?? {}) as {
      attendeesOmitted?: boolean;
      attendees?: { email?: string; responseStatus?: string }[];
    };
    if (rsvpFailures > 0) {
      rsvpFailures -= 1;
      return json(response, 503, { error: { code: 503, message: 'Backend Error' } });
    }
    const [mine] = patch.attendees ?? [];
    if (!patch.attendeesOmitted || patch.attendees?.length !== 1 || !mine?.email || !mine.responseStatus) {
      return json(response, 400, {
        error: { code: 400, message: 'Commander may only change its own answer' },
      });
    }
    const answer = (each: StoredEvent) => {
      const attendees = (each.event.attendees as { email?: string; self?: boolean }[] | undefined) ?? [];
      const self = attendees.find((attendee) => attendee.self || attendee.email === mine.email);
      if (!self) return false;
      changes += 1;
      each.event = {
        ...each.event,
        attendees: attendees.map((attendee) =>
          attendee === self ? { ...attendee, responseStatus: mine.responseStatus } : attendee,
        ),
      };
      each.changed = changes;
      each.updatedAt = Date.now();
      return true;
    };
    const answered = stored ? answer(stored) : instances.map(answer).some(Boolean);
    if (!answered) return json(response, 403, { error: { code: 403, message: 'Not a guest of this event' } });
    fake.rsvps.push({
      sub: user.sub,
      calendarId,
      eventId,
      responseStatus: mine.responseStatus,
      sendUpdates: url.searchParams.get('sendUpdates'),
    });
    const now = stored ?? {
      ...(instances[0] as StoredEvent),
      event: { ...(instances[0] as StoredEvent).event, id: eventId },
    };
    return json(response, 200, shown(now));
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/calendar/v3/')) return void calendarApi(request, url, response);
    if (request.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') return authorize(url, response);
    if (request.method === 'POST' && url.pathname === '/token') return void tokenEndpoint(request, response);
    if (request.method === 'GET' && url.pathname === '/v1/userinfo') return userinfo(request, response);
    if (url.pathname.startsWith('/gmail/v1/users/me/')) {
      const authorization = request.headers.authorization ?? '';
      const user = authorization.startsWith('Bearer ')
        ? accessTokens.get(authorization.slice('Bearer '.length))
        : undefined;
      return void gmail.handle(request, response, url, user?.email ?? null);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  fake.authorizeUrl = `${base}/o/oauth2/v2/auth`;
  fake.tokenUrl = `${base}/token`;
  fake.userinfoUrl = `${base}/v1/userinfo`;
  fake.calendarUrl = `${base}/calendar/v3`;
  fake.gmailUrl = base;
  return fake;
}
