import { PERSONAL_MICROSOFT_TENANT } from '@commander/domain';
import type { AccountRecord } from '../accounts/account-store';
import {
  type AccountSourceDefinition,
  createSourceAccounts,
  type SourceAccounts,
  type SourceAccountsOptions,
} from '../accounts/source-accounts';
import { RefreshError } from '../oauth/authorization-code';
import { SignInError } from '../oauth/sign-in-error';
import {
  CONSENT_REFUSED,
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

// Mirror Buckets (#142): making "Commander: <Bucket>" categories in the mailbox's master list. Asked for
// with incremental consent (Grant access) when the User switches mirroring on, never at sign-in.
export const MAILBOX_SETTINGS_SCOPE = 'MailboxSettings.ReadWrite';

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

/**
 * Whether a sign-in's token carries MailboxSettings.ReadWrite. A token response that doesn't say covers
 * what was asked for.
 */
export function mailboxSettingsGranted(scope: string | undefined, asked: boolean): boolean {
  if (scope === undefined) return asked;
  return scope.split(/\s+/).some((each) => normalised(each) === normalised(MAILBOX_SETTINGS_SCOPE));
}

// What a sign-in or refresh asks for: mail and calendar, and MailboxSettings once asked for (or granted).
const scopesFor = (withMailboxSettings: boolean): readonly string[] =>
  withMailboxSettings ? [...OUTLOOK_SCOPES, MAILBOX_SETTINGS_SCOPE] : OUTLOOK_SCOPES;

export type OutlookAccounts = SourceAccounts;

type OutlookSignIn = MicrosoftSignIn & { askedForMailboxSettings: boolean };

export type OutlookAccountsOptions = SourceAccountsOptions & { config: MicrosoftConfig };

// The tenant every personal Microsoft account (outlook.com, hotmail.com) signs in through (send later
// tells work and personal Accounts apart by it too, #139).
export const PERSONAL_ACCOUNTS_TENANT = PERSONAL_MICROSOFT_TENANT;

const upnOf = (record: AccountRecord | null) => record?.details.userPrincipalName ?? null;

export function outlookSource(config: MicrosoftConfig): AccountSourceDefinition<OutlookSignIn> {
  const app = microsoftApp(config);
  return {
    source: 'outlook',
    label: 'Outlook',
    oauth: app
      ? {
          // Grant access (`extra`) asks for MailboxSettings.ReadWrite too, and so does reconnecting an
          // Account that has it, so a reconnect never takes it away.
          async signIn({ record, extra, ...options }) {
            const askedForMailboxSettings = extra || !!record?.mailboxSettings?.granted;
            const signedIn = await signInWithMicrosoft({
              app,
              scopes: scopesFor(askedForMailboxSettings),
              sourceName: extra ? 'Bucket categories in Outlook' : 'Outlook mail and calendar',
              ...options,
            });
            return { ...signedIn, askedForMailboxSettings };
          },
          // An Account with MailboxSettings asks for it again; if Microsoft no longer consents to it,
          // mail and calendar still refresh (and Commander's categories show without colours).
          async refresh(refreshToken, now, record) {
            if (!record.mailboxSettings?.granted)
              return refreshMicrosoftTokens({ app, scopes: OUTLOOK_SCOPES, refreshToken, now });
            try {
              return await refreshMicrosoftTokens({ app, scopes: scopesFor(true), refreshToken, now });
            } catch (error) {
              if (
                !(error instanceof RefreshError && CONSENT_REFUSED.test(error.sourceError?.description ?? ''))
              )
                throw error;
              return refreshMicrosoftTokens({ app, scopes: OUTLOOK_SCOPES, refreshToken, now });
            }
          },
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
        ...(signIn
          ? {
              mailboxSettings: {
                granted: mailboxSettingsGranted(signIn.scope, signIn.askedForMailboxSettings),
              },
            }
          : {}),
      };
    },
    summarize: ({ id, name, details, method, status, user, sources, mailboxSettings }) => ({
      id,
      source: 'outlook',
      name,
      userPrincipalName: details.userPrincipalName ?? '',
      method,
      status,
      user,
      sources: sources ?? OUTLOOK_SOURCES.map((source) => ({ source, granted: false, enabled: false })),
      personal: details.tenantId === PERSONAL_ACCOUNTS_TENANT,
      ...(mailboxSettings?.granted ? { mailboxSettings: { granted: true } } : {}),
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
  const accounts = createSourceAccounts(outlookSource(config), options);
  return {
    ...accounts,
    // The getters of the Source's Accounts stay live.
    get signingIn() {
      return accounts.signingIn;
    },
    get deviceCode() {
      return accounts.deviceCode;
    },
    mailboxSettings: {
      async request(accountId) {
        await accounts.connectWithBrowser({ reconnect: accountId, extra: true });
        const record = await options.store.get(accountId);
        if (record?.mailboxSettings?.granted) return;
        throw new SignInError(
          'admin-consent',
          `Microsoft didn’t grant ${MAILBOX_SETTINGS_SCOPE}, so Commander can’t make its categories in Outlook. If your organisation needs an administrator to approve it, ask them, then choose Grant access again.`,
        );
      },
    },
  };
}
