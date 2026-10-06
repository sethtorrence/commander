import { z } from 'zod';
import {
  type AuthorizationCodeClient,
  RefreshError,
  refreshTokens,
  signInWithBrowser,
  type TokenSet,
} from '../oauth/authorization-code';
import { SignInError } from '../oauth/sign-in-error';
import type { MicrosoftConfig } from './microsoft-config';

// Signing in with the Microsoft identity platform, for every Microsoft Source (Teams; Outlook mail
// and calendar), each with its own scopes. Commander's Entra app is a public client in one tenant:
// authorization code with PKCE (S256), no client secret, the single-tenant authority
// https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/, and http://localhost:<any port> as the
// redirect (registered as http://localhost under "Mobile and desktop applications"; Entra ignores
// its port, and the path must match exactly, so there is none).

export { type MicrosoftConfig, RefreshError };

// The app to sign in with, or null when the build config lacks its client or tenant ID.
export function microsoftApp({ clientId, tenantId, loginUrl }: MicrosoftConfig): MicrosoftApp | null {
  return clientId && tenantId ? { clientId, tenantId, loginUrl } : null;
}

export type MicrosoftApp = {
  clientId: string;
  tenantId: string;
  // The identity platform's base: https://login.microsoftonline.com (a fake one in tests).
  loginUrl: string;
};

export type MicrosoftSignIn = TokenSet & {
  // The tenant signed in to, from the ID token's `tid` (the app's tenant, for a single-tenant app).
  tenantId: string;
  // The scopes the access token covers, when Microsoft says (never stored).
  scope?: string;
};

// Microsoft's answers when the tenant requires an administrator to approve the app first.
const ADMIN_CONSENT_CODES = /\bAADSTS(90094|65001)\b/;

const idTokenClaims = z.object({ tid: z.string().min(1) });

function authority(app: MicrosoftApp): string {
  return `${app.loginUrl}/${encodeURIComponent(app.tenantId)}/oauth2/v2.0`;
}

function client(app: MicrosoftApp, scopes: readonly string[]): AuthorizationCodeClient {
  const scope = scopes.join(' ');
  return {
    sourceName: 'Microsoft',
    clientId: app.clientId,
    authorizeUrl: `${authority(app)}/authorize`,
    tokenUrl: `${authority(app)}/token`,
    port: 0,
    callbackPath: '/',
    scope,
    refreshScope: scope,
  };
}

// The tenant's page where an administrator approves every permission the app registration lists.
export function adminConsentUrl(app: MicrosoftApp): string {
  const url = new URL(`${app.loginUrl}/${encodeURIComponent(app.tenantId)}/adminconsent`);
  url.searchParams.set('client_id', app.clientId);
  return url.toString();
}

// The tenant a sign-in is for. Only the claims are read: the token came straight from Microsoft's
// token endpoint over TLS, not through the browser.
function tenantOf(idToken: string | undefined, fallback: string): string {
  const payload = idToken?.split('.')[1];
  if (!payload) return fallback;
  try {
    const claims = idTokenClaims.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return claims.success ? claims.data.tid : fallback;
  } catch {
    return fallback;
  }
}

export async function signInWithMicrosoft({
  app,
  scopes,
  sourceName,
  adminPermissions,
  ...options
}: {
  app: MicrosoftApp;
  // The Source's scopes, e.g. Teams' Chat permissions.
  scopes: readonly string[];
  // The Source being connected, for the admin consent explanation ("Teams").
  sourceName: string;
  // The permissions an administrator is asked to approve, when not every scope (Channel posts' own).
  adminPermissions?: readonly string[];
  openBrowser: (url: string) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}): Promise<MicrosoftSignIn> {
  try {
    const { idToken, ...tokens } = await signInWithBrowser({ client: client(app, scopes), ...options });
    return { ...tokens, tenantId: tenantOf(idToken, app.tenantId) };
  } catch (error) {
    if (error instanceof SignInError && ADMIN_CONSENT_CODES.test(error.sourceError?.description ?? '')) {
      throw new SignInError(
        'admin-consent',
        `Your organisation needs an administrator to approve Commander before you can connect ${sourceName}. Ask your Microsoft 365 administrator to grant these permissions, using the admin consent link, then connect again.`,
        {
          sourceError: error.sourceError,
          adminConsent: { permissions: [...(adminPermissions ?? scopes)], url: adminConsentUrl(app) },
        },
      );
    }
    throw error;
  }
}

// Microsoft's answers when a refresh asks for a permission no longer consented to.
export const CONSENT_REFUSED = /\bAADSTS(65001|90094|65004|70011)\b/;

export function refreshMicrosoftTokens({
  app,
  scopes,
  refreshToken,
  now,
}: {
  app: MicrosoftApp;
  scopes: readonly string[];
  refreshToken: string;
  now?: () => number;
}): Promise<TokenSet> {
  return refreshTokens({ client: client(app, scopes), refreshToken, now });
}
