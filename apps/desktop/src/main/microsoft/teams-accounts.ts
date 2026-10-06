import { CHANNEL_POST_PERMISSIONS, CHANNEL_READ_PERMISSION } from '@commander/domain';
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
  adminConsentUrl,
  CONSENT_REFUSED,
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
// asked for separately (CHANNEL_SCOPES), when the User chooses Request access.
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

// Channel posts (#111), asked for with incremental consent on top of TEAMS_SCOPES: reading channel
// messages (an administrator must approve it for the tenant first) and replying in channels.
export const CHANNEL_SCOPES: readonly string[] = CHANNEL_POST_PERMISSIONS;

// Graph's scopes may come back in full ("https://graph.microsoft.com/Chat.Read") and in any case.
const GRAPH_RESOURCE = 'https://graph.microsoft.com/';
const normalised = (scope: string) => {
  const lower = scope.toLowerCase();
  return lower.startsWith(GRAPH_RESOURCE) ? lower.slice(GRAPH_RESOURCE.length) : lower;
};

/**
 * Whether a sign-in's token can read Channel posts: its granted scopes include
 * ChannelMessage.Read.All. A token response that doesn't say covers what was asked for.
 */
export function channelPostsGranted(scope: string | undefined, asked: boolean): boolean {
  if (scope === undefined) return asked;
  return scope.split(/\s+/).some((each) => normalised(each) === normalised(CHANNEL_READ_PERMISSION));
}

export type TeamsAccounts = SourceAccounts;

export type TeamsAccountsOptions = SourceAccountsOptions & { config: MicrosoftConfig };

const upnOf = (record: AccountRecord | null) => record?.details.userPrincipalName ?? null;

// What a sign-in or refresh asks for: Chats, and Channel posts once asked for (or still granted).
const scopesFor = (withChannels: boolean): readonly string[] =>
  withChannels ? [...TEAMS_SCOPES, ...CHANNEL_SCOPES] : TEAMS_SCOPES;

type TeamsSignIn = MicrosoftSignIn & { askedForChannels: boolean };

export function teamsSource(config: MicrosoftConfig): AccountSourceDefinition<TeamsSignIn> {
  const app = microsoftApp(config);
  return {
    source: 'teams',
    label: 'Teams',
    oauth: app
      ? {
          // Request access (`extra`) asks for Channel posts too, and so does reconnecting an Account
          // that has them, so a reconnect never takes them away.
          async signIn({ record, extra, ...options }) {
            const askedForChannels = extra || !!record?.channelPosts?.granted;
            const signedIn = await signInWithMicrosoft({
              app,
              scopes: scopesFor(askedForChannels),
              sourceName: extra ? 'Channel posts' : 'Teams',
              ...(extra ? { adminPermissions: CHANNEL_SCOPES } : {}),
              ...options,
            });
            return { ...signedIn, askedForChannels };
          },
          // An Account with Channel posts asks for them again; if Microsoft no longer consents to them,
          // the Chats' own scopes still refresh (and the next channel sync finds them refused).
          async refresh(refreshToken, now, record) {
            if (!record.channelPosts?.granted)
              return refreshMicrosoftTokens({ app, scopes: TEAMS_SCOPES, refreshToken, now });
            try {
              return await refreshMicrosoftTokens({ app, scopes: scopesFor(true), refreshToken, now });
            } catch (error) {
              if (
                !(error instanceof RefreshError && CONSENT_REFUSED.test(error.sourceError?.description ?? ''))
              )
                throw error;
              return refreshMicrosoftTokens({ app, scopes: TEAMS_SCOPES, refreshToken, now });
            }
          },
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
        ...(signIn
          ? { channelPosts: { granted: channelPostsGranted(signIn.scope, signIn.askedForChannels) } }
          : {}),
      };
    },
    summarize: ({ id, name, details, method, status, user, channelPosts }) => ({
      id,
      source: 'teams',
      name,
      userPrincipalName: details.userPrincipalName ?? '',
      method,
      status,
      user,
      channelPosts: {
        granted: channelPosts?.granted ?? false,
        enabled: !!channelPosts?.granted && channelPosts.enabled,
        permissions: [...CHANNEL_SCOPES],
        adminConsentUrl: app ? adminConsentUrl(app) : null,
      },
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
  const accounts = createSourceAccounts(teamsSource(config), options);
  const app = microsoftApp(config);
  return {
    ...accounts,
    // The getters of the Source's Accounts stay live.
    get signingIn() {
      return accounts.signingIn;
    },
    get deviceCode() {
      return accounts.deviceCode;
    },
    channelPosts: {
      async request(accountId) {
        await accounts.connectWithBrowser({ reconnect: accountId, extra: true });
        const record = await options.store.get(accountId);
        if (record?.channelPosts?.granted) return;
        // Signed in, but Microsoft didn't grant reading channels: an administrator hasn't approved it.
        throw new SignInError(
          'admin-consent',
          `Microsoft didn’t grant ${CHANNEL_READ_PERMISSION} yet. An administrator of your organisation needs to approve it for Commander, using the admin consent link, then choose Request access again.`,
          app ? { adminConsent: { permissions: [...CHANNEL_SCOPES], url: adminConsentUrl(app) } } : {},
        );
      },
      async set(accountId, enabled) {
        await accounts.updateRecord(accountId, (record) => {
          if (enabled && !record.channelPosts?.granted)
            throw new Error('Commander can’t read Channel posts yet. Use Request access first.');
          if (!!record.channelPosts?.enabled === enabled) return null;
          return { ...record, channelPosts: { granted: !!record.channelPosts?.granted, enabled } };
        });
      },
      async refused(accountId) {
        await accounts.updateRecord(accountId, (record) =>
          record.channelPosts?.granted
            ? { ...record, channelPosts: { granted: false, enabled: false } }
            : null,
        );
      },
    },
  };
}
