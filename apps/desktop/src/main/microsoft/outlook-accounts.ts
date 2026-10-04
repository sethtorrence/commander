import type { AccountRecord } from '../accounts/account-store';
import {
  type AccountSourceDefinition,
  createSourceAccounts,
  type SourceAccounts,
  type SourceAccountsOptions,
} from '../accounts/source-accounts';
import { SignInError } from '../oauth/sign-in-error';
import {
  type MicrosoftConfig,
  type MicrosoftSignIn,
  microsoftApp,
  refreshMicrosoftTokens,
  signInWithMicrosoft,
} from './microsoft-sign-in';
import { readMicrosoftUser } from './microsoft-user';

// Outlook Accounts: one per Microsoft account, signed in once with Commander's Entra app (the one
// Teams uses) for both Outlook Sources, mail ("outlook") and calendar ("outlook-calendar"). `GET /me`
// names the Account ("Outlook · <user principal name>") and keys it by tenant and user, so connecting
// the same user again updates it. Each Source is on when the sign-in covers its permissions (and the
// User hasn't switched it off), and off with Grant access when it doesn't. Everything else is shared
// by every Source (accounts/source-accounts.ts).

export type OutlookSource = 'outlook' | 'outlook-calendar';

// What each Source needs. Mail: read, move, flag and delete mail, and send it. Calendar: read and
// write events (replies to invitations, focus blocks). MailboxSettings.ReadWrite (for mirroring
// Buckets as Outlook categories) is asked for separately, only when the User switches mirroring on.
export const OUTLOOK_SOURCE_SCOPES: Record<OutlookSource, readonly string[]> = {
  outlook: ['Mail.ReadWrite', 'Mail.Send'],
  'outlook-calendar': ['Calendars.ReadWrite'],
};

export const OUTLOOK_SOURCES = Object.keys(OUTLOOK_SOURCE_SCOPES) as OutlookSource[];

// Who signed in (`GET /me`), and a refresh token.
export const OUTLOOK_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  ...OUTLOOK_SOURCES.flatMap((source) => OUTLOOK_SOURCE_SCOPES[source]),
];

// Graph's scopes may come back in full ("https://graph.microsoft.com/Mail.Send") and in any case.
const GRAPH_RESOURCE = 'https://graph.microsoft.com/';
const normalised = (scope: string) => {
  const lower = scope.toLowerCase();
  return lower.startsWith(GRAPH_RESOURCE) ? lower.slice(GRAPH_RESOURCE.length) : lower;
};

// The Sources whose every scope the token covers. Microsoft asks for every permission at once (the
// User can't untick one), so a missing scope means an administrator approved only some; a token
// response that doesn't say covers them all.
export function grantedOutlookSources(scope: string | undefined): OutlookSource[] {
  if (scope === undefined) return [...OUTLOOK_SOURCES];
  const granted = new Set(scope.split(/\s+/).filter(Boolean).map(normalised));
  return OUTLOOK_SOURCES.filter((source) =>
    OUTLOOK_SOURCE_SCOPES[source].every((each) => granted.has(normalised(each))),
  );
}

export type OutlookAccounts = SourceAccounts;

export type OutlookAccountsOptions = SourceAccountsOptions & { config: MicrosoftConfig };

// The tenant every personal Microsoft account (outlook.com, hotmail.com) signs in through.
export const PERSONAL_ACCOUNTS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const upnOf = (record: AccountRecord | null) => record?.details.userPrincipalName ?? null;

export function outlookSource(config: MicrosoftConfig): AccountSourceDefinition<MicrosoftSignIn> {
  const app = microsoftApp(config);
  return {
    source: 'outlook',
    label: 'Outlook',
    oauth: app
      ? {
          signIn: (options) =>
            signInWithMicrosoft({
              app,
              scopes: OUTLOOK_SCOPES,
              sourceName: 'Outlook mail and calendar',
              ...options,
            }),
          refresh: (refreshToken, now) =>
            refreshMicrosoftTokens({ app, scopes: OUTLOOK_SCOPES, refreshToken, now }),
        }
      : null,
    notConfigured:
      'This build of Commander has no Microsoft app set up, so Outlook can’t be connected yet. See “Connecting Outlook” in the README.',
    apiKeys: false,
    async identify(credential, signIn) {
      const user = await readMicrosoftUser(config.graphUrl, credential, 'Outlook');
      const tenantId = signIn?.tenantId ?? config.tenantId;
      if (!tenantId)
        throw new SignInError('not-configured', 'This build of Commander has no Microsoft tenant set up.');
      const granted = signIn ? grantedOutlookSources(signIn.scope) : null;
      return {
        id: `outlook:${tenantId}:${user.id}`,
        name: `Outlook · ${user.userPrincipalName}`,
        user: { id: user.id, name: user.displayName ?? user.userPrincipalName },
        details: { tenantId, userPrincipalName: user.userPrincipalName },
        ...(granted
          ? { sources: OUTLOOK_SOURCES.map((source) => ({ source, granted: granted.includes(source) })) }
          : {}),
      };
    },
    summarize: ({ id, name, details, method, status, user, sources }) => ({
      id,
      source: 'outlook',
      name,
      userPrincipalName: details.userPrincipalName ?? '',
      method,
      status,
      user,
      sources: sources ?? OUTLOOK_SOURCES.map((source) => ({ source, granted: false, enabled: false })),
      personal: details.tenantId === PERSONAL_ACCOUNTS_TENANT,
    }),
    describe: (record) => `the Outlook Account for ${upnOf(record) ?? record.name}`,
    wrongIdentity: (signedIn, expected) => {
      const wanted = upnOf(expected) ?? 'the account being reconnected';
      const got = signedIn.details.userPrincipalName;
      return new SignInError(
        'wrong-account',
        `That sign-in is for ${got}, not ${wanted}. Sign in as ${wanted} to reconnect it or grant access, or use Connect Outlook to add ${got}.`,
      );
    },
  };
}

export function createOutlookAccounts({ config, ...options }: OutlookAccountsOptions): OutlookAccounts {
  return createSourceAccounts(outlookSource(config), options);
}
