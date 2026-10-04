import { z } from 'zod';
import type { AccountRecord } from '../accounts/account-store';
import {
  type AccountSourceDefinition,
  createSourceAccounts,
  type SourceAccounts,
  type SourceAccountsOptions,
  type SourceCredential,
} from '../accounts/source-accounts';
import { SignInError } from '../oauth/sign-in-error';
import type { GoogleConfig } from './google-config';
import {
  GOOGLE_SOURCES,
  type GoogleIdentity,
  type GoogleSignIn,
  googleApp,
  refreshGoogleTokens,
  signInWithGoogle,
} from './google-sign-in';

// Google Accounts: one per Google identity, keyed by its `sub` ("google:<sub>") and named after its
// address ("Google · <address>"), so connecting the same identity again updates it. One sign-in
// serves both Google Sources, Gmail and Google Calendar: each is on when its permissions were
// granted (and the User hasn't switched it off), and off with Grant access when they weren't.
// Everything else is shared by every Source (accounts/source-accounts.ts).

export type GoogleAccounts = SourceAccounts;

export type GoogleAccountsOptions = SourceAccountsOptions & { config: GoogleConfig };

const userinfo = z.object({ sub: z.string().min(1), email: z.string().min(1), name: z.string().optional() });

// Who an access token signs in as, when no ID token says (Accounts connected before, say).
async function readUserinfo(userinfoUrl: string, credential: SourceCredential): Promise<GoogleIdentity> {
  if (credential.kind !== 'oauth')
    throw new SignInError('invalid-credential', 'Google needs a Google sign-in.');
  let response: Response;
  try {
    response = await fetch(userinfoUrl, {
      headers: { authorization: `Bearer ${credential.accessToken}`, accept: 'application/json' },
    });
  } catch {
    throw new SignInError(
      'unreachable',
      'Commander couldn’t reach Google. Check your connection and try again.',
    );
  }
  const parsed = userinfo.safeParse(await response.json().catch(() => null));
  if (response.ok && parsed.success) return { ...parsed.data, name: parsed.data.name ?? null };
  if (response.status === 401 || response.status === 403) {
    throw new SignInError('invalid-credential', 'Google didn’t accept the sign-in. Try connecting again.');
  }
  throw new SignInError(
    'unreachable',
    `Google couldn’t answer just now (HTTP ${response.status}). Try again.`,
  );
}

const emailOf = (record: AccountRecord | null) => record?.details.email ?? null;

export function googleSource(config: GoogleConfig): AccountSourceDefinition<GoogleSignIn> {
  const app = googleApp(config);
  return {
    source: 'google',
    label: 'Google',
    oauth: app
      ? {
          signIn: (options) => signInWithGoogle({ app, ...options }),
          refresh: (refreshToken, now) => refreshGoogleTokens({ app, refreshToken, now }),
        }
      : null,
    notConfigured:
      'This build of Commander has no Google sign-in set up, so Google can’t be connected yet. See “Connecting Google” in the README.',
    apiKeys: false,
    async identify(credential, signIn) {
      const { sub, email, name } = signIn?.identity ?? (await readUserinfo(config.userinfoUrl, credential));
      return {
        id: `google:${sub}`,
        name: `Google · ${email}`,
        user: { id: sub, name: name ?? email },
        details: { email },
        ...(signIn
          ? {
              sources: GOOGLE_SOURCES.map((source) => ({ source, granted: signIn.granted.includes(source) })),
            }
          : {}),
      };
    },
    summarize: ({ id, name, details, method, status, user, sources }) => ({
      id,
      source: 'google',
      name,
      email: details.email ?? '',
      method,
      status,
      user,
      sources: sources ?? GOOGLE_SOURCES.map((source) => ({ source, granted: false, enabled: false })),
    }),
    describe: (record) => `the Google Account for ${emailOf(record) ?? record.name}`,
    wrongIdentity: (signedIn, expected) => {
      const wanted = emailOf(expected) ?? 'the account being reconnected';
      const got = signedIn.details.email;
      return new SignInError(
        'wrong-account',
        `That sign-in is for ${got}, not ${wanted}. Sign in as ${wanted} to reconnect it or grant access, or use Connect Google to add ${got}.`,
      );
    },
  };
}

export function createGoogleAccounts({ config, ...options }: GoogleAccountsOptions): GoogleAccounts {
  return createSourceAccounts(googleSource(config), options);
}
