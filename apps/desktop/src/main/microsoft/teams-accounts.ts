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

// Teams Accounts: one per Microsoft work account, signed in with Commander's Entra app. `GET /me`
// names the Account ("Teams · <user principal name>") and keys it by tenant and user, so connecting
// the same user again updates it; the User's Teams user id is kept for "mentions me" and "my last
// message". Everything else is shared by every Source (accounts/source-accounts.ts).

// Chats on the User's own consent (no admin needed): read and write Chats, send messages, and see
// teams and channels by name. Reading Channel posts (ChannelMessage.Read.All) needs an admin and is
// asked for separately, later.
export const TEAMS_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'Chat.ReadWrite',
  'ChatMessage.Send',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
] as const;

export type TeamsAccounts = SourceAccounts;

export type TeamsAccountsOptions = SourceAccountsOptions & { config: MicrosoftConfig };

const upnOf = (record: AccountRecord | null) => record?.details.userPrincipalName ?? null;

export function teamsSource(config: MicrosoftConfig): AccountSourceDefinition<MicrosoftSignIn> {
  const app = microsoftApp(config);
  return {
    source: 'teams',
    label: 'Teams',
    oauth: app
      ? {
          signIn: (options) =>
            signInWithMicrosoft({ app, scopes: TEAMS_SCOPES, sourceName: 'Teams', ...options }),
          refresh: (refreshToken, now) =>
            refreshMicrosoftTokens({ app, scopes: TEAMS_SCOPES, refreshToken, now }),
        }
      : null,
    notConfigured:
      'This build of Commander has no Microsoft app set up, so Teams can’t be connected yet. See “Connecting Teams” in the README.',
    apiKeys: false,
    async identify(credential, signIn) {
      const user = await readMicrosoftUser(config.graphUrl, credential, 'Teams');
      const tenantId = signIn?.tenantId ?? config.tenantId;
      if (!tenantId)
        throw new SignInError('not-configured', 'This build of Commander has no Microsoft tenant set up.');
      return {
        id: `teams:${tenantId}:${user.id}`,
        name: `Teams · ${user.userPrincipalName}`,
        user: { id: user.id, name: user.displayName ?? user.userPrincipalName },
        details: { tenantId, userPrincipalName: user.userPrincipalName },
      };
    },
    summarize: ({ id, name, details, method, status, user }) => ({
      id,
      source: 'teams',
      name,
      userPrincipalName: details.userPrincipalName ?? '',
      method,
      status,
      user,
    }),
    describe: (record) => `the Teams Account for ${upnOf(record) ?? record.name}`,
    wrongIdentity: (signedIn, expected) => {
      const wanted = upnOf(expected) ?? 'the account being reconnected';
      const got = signedIn.details.userPrincipalName;
      return new SignInError(
        'wrong-account',
        `That sign-in is for ${got}, not ${wanted}. Sign in as ${wanted} to reconnect it, or use Connect Teams to add ${got}.`,
      );
    },
  };
}

export function createTeamsAccounts({ config, ...options }: TeamsAccountsOptions): TeamsAccounts {
  return createSourceAccounts(teamsSource(config), options);
}
