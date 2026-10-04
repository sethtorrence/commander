import { z } from 'zod';
import {
  type AuthorizationCodeClient,
  refreshTokens,
  signInWithBrowser,
  type TokenSet,
} from '../oauth/authorization-code';
import { SignInError } from '../oauth/sign-in-error';
import type { GoogleConfig } from './google-config';

// Signing in with Google, once for both Google Sources (Gmail and Google Calendar), through
// Commander's "Desktop app" OAuth client: authorization code with PKCE (S256) in the system browser,
// a loopback redirect on http://127.0.0.1:<a port chosen at sign-in> (Google takes any port for
// desktop clients), the client's secret (which Google says isn't treated as a secret for desktop
// clients), and `access_type=offline` with `prompt=consent` so a refresh token always comes back.
// Google lets the User untick permissions on its consent screen, so the token's `scope` says which
// Sources the Account can use; `include_granted_scopes` keeps earlier grants when signing in again
// for one that was missing.

export type GoogleSource = 'gmail' | 'google-calendar';

// The least each Source needs, checked against Google's scope lists (2026-10). Gmail: read, label,
// archive, send and trash, never delete forever, and never https://mail.google.com/ (IMAP and full
// access). Calendar: read and write events (replies to invitations, events with guests); which
// calendars exist; the "Commander" calendar for focus blocks; and colleagues' free/busy.
export const GOOGLE_SOURCE_SCOPES: Record<GoogleSource, readonly string[]> = {
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  'google-calendar': [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.app.created',
    'https://www.googleapis.com/auth/calendar.freebusy',
  ],
};

export const GOOGLE_SOURCES = Object.keys(GOOGLE_SOURCE_SCOPES) as GoogleSource[];

// Who signed in: the ID token's `sub`, address and name.
const IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

export const GOOGLE_SCOPES: readonly string[] = [
  ...IDENTITY_SCOPES,
  ...GOOGLE_SOURCES.flatMap((source) => GOOGLE_SOURCE_SCOPES[source]),
];

// A Workspace admin hasn't allowed Commander: Google's own page says so, and may send it back.
const ADMIN_BLOCKED = new Set(['admin_policy_enforced', 'org_internal']);
export const ADMIN_BLOCKED_MESSAGE =
  'Your Google Workspace admin hasn’t allowed Commander. Ask them to allow it, or connect a personal account.';

export type GoogleIdentity = { sub: string; email: string; name: string | null };

export type GoogleSignIn = TokenSet & {
  // From the ID token, when Google sent one.
  identity: GoogleIdentity | null;
  // Which Sources the granted scopes cover in full.
  granted: GoogleSource[];
};

export type GoogleApp = { clientId: string; clientSecret: string | null } & Pick<
  GoogleConfig,
  'authorizeUrl' | 'tokenUrl'
>;

// The client to sign in with, or null when the build config has no client ID.
export function googleApp({
  clientId,
  clientSecret,
  authorizeUrl,
  tokenUrl,
}: GoogleConfig): GoogleApp | null {
  return clientId ? { clientId, clientSecret, authorizeUrl, tokenUrl } : null;
}

function client(app: GoogleApp): AuthorizationCodeClient {
  return {
    sourceName: 'Google',
    clientId: app.clientId,
    ...(app.clientSecret ? { clientSecret: app.clientSecret } : {}),
    authorizeUrl: app.authorizeUrl,
    tokenUrl: app.tokenUrl,
    port: 0,
    callbackPath: '/',
    redirectHost: '127.0.0.1',
    scope: GOOGLE_SCOPES.join(' '),
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  };
}

// The Sources whose every scope was granted. Google writes `email` and `profile` back long-hand.
export function grantedSources(scope: string | undefined): GoogleSource[] {
  const granted = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  return GOOGLE_SOURCES.filter((source) => GOOGLE_SOURCE_SCOPES[source].every((each) => granted.has(each)));
}

const idTokenClaims = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  name: z.string().optional(),
});

// Who the sign-in is for. Only the claims are read: the token came straight from Google's token
// endpoint over TLS, not through the browser, which Google allows without checking the signature.
function identityOf(idToken: string | undefined): GoogleIdentity | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = idTokenClaims.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return claims.success ? { ...claims.data, name: claims.data.name ?? null } : null;
  } catch {
    return null;
  }
}

const isAdminBlocked = (error: unknown) =>
  error instanceof SignInError && ADMIN_BLOCKED.has(error.sourceError?.code ?? '');

export async function signInWithGoogle({
  app,
  ...options
}: {
  app: GoogleApp;
  openBrowser: (url: string) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}): Promise<GoogleSignIn> {
  try {
    const { idToken, scope, ...tokens } = await signInWithBrowser({ client: client(app), ...options });
    return { ...tokens, identity: identityOf(idToken), granted: grantedSources(scope) };
  } catch (error) {
    if (isAdminBlocked(error)) {
      throw new SignInError('admin-blocked', ADMIN_BLOCKED_MESSAGE, {
        sourceError: (error as SignInError).sourceError,
      });
    }
    throw error;
  }
}

export function refreshGoogleTokens({
  app,
  refreshToken,
  now,
}: {
  app: GoogleApp;
  refreshToken: string;
  now?: () => number;
}): Promise<TokenSet> {
  return refreshTokens({ client: client(app), refreshToken, now });
}
