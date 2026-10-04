import type { GitHubAccountSummary } from '@commander/domain/ipc';
import type { AccountRecord } from '../accounts/account-store';
import {
  type AccountSourceDefinition,
  createSourceAccounts,
  type SourceAccounts,
  type SourceAccountsOptions,
  type SourceCredential,
} from '../accounts/source-accounts';
import { SignInError } from '../oauth/sign-in-error';
import { refreshGitHubTokens, type Sleep, signInWithDeviceFlow } from './device-flow';
import type { GhCli } from './gh-cli';
import { readInstallations, readUser } from './github-api';
import type { GitHubConfig } from './github-config';

// GitHub Accounts: one per GitHub user, keyed "github:<user id>" and shown by login. They connect
// with Commander's GitHub App through the device flow (8-hour tokens, refreshed), or, where an org
// won't install the app or this build has none, with a classic personal access token or gh's
// sign-in, stored like an API key and never refreshed. An app Account also keeps where the app is
// installed. Everything else is shared by every Source (accounts/source-accounts.ts).
//
// The details kept: { login, signedInWith, installations? } (installations: comma-separated logins,
// app Accounts only; GitHub logins never contain commas).

export type GitHubAccounts = SourceAccounts;

export type GitHubAccountsOptions = SourceAccountsOptions & {
  config: GitHubConfig;
  gh: GhCli;
  // The wait between device flow polls (simulated in tests).
  sleep?: Sleep;
};

type SignedInWith = GitHubAccountSummary['signedInWith'];

// What a token needs: read access to private repos, and to the User's orgs and teams. GitHub has no
// read-only form of `repo`; Commander only reads.
const REQUIRED_SCOPES: { scope: string; satisfiedBy: string[] }[] = [
  { scope: 'repo', satisfiedBy: ['repo'] },
  { scope: 'read:org', satisfiedBy: ['read:org', 'write:org', 'admin:org'] },
];

const listed = (words: string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');

function checkScopes(scopes: string[] | null, fromCli: boolean) {
  const what = fromCli ? 'gh’s sign-in' : 'That token';
  if (scopes === null) {
    throw new SignInError(
      'invalid-credential',
      `${what} isn’t a classic personal access token. Commander needs a classic one, with the repo and read:org scopes: a fine-grained token reaches only one account’s or organisation’s repositories, and GitHub doesn’t say what it may read.`,
    );
  }
  const missing = REQUIRED_SCOPES.filter(
    ({ satisfiedBy }) => !satisfiedBy.some((s) => scopes.includes(s)),
  ).map(({ scope }) => scope);
  if (missing.length === 0) return;
  const named = `the ${listed(missing)} ${missing.length > 1 ? 'scopes' : 'scope'}`;
  throw new SignInError(
    'invalid-credential',
    fromCli
      ? `gh’s sign-in is missing ${named}. Run gh auth refresh --scopes ${missing.join(',')} in a terminal, then try again.`
      : `That token is missing ${named}. Make a classic token with repo and read:org (Commander only reads), or add ${missing.length > 1 ? 'them' : 'it'} to this one on GitHub.`,
  );
}

function refusedMessage(credential: SourceCredential): string {
  if (credential.kind === 'oauth') return 'GitHub didn’t accept the sign-in. Try connecting again.';
  return credential.fromCli
    ? 'GitHub didn’t accept gh’s sign-in. Run gh auth login in a terminal, then try again.'
    : 'GitHub didn’t accept that token. Check it was copied whole and hasn’t expired or been revoked.';
}

const loginOf = (record: AccountRecord | null) => record?.details.login ?? record?.name ?? null;

export function githubSource(
  config: GitHubConfig,
  { gh, sleep }: { gh: GhCli; sleep?: Sleep },
): AccountSourceDefinition {
  const { clientId, webUrl, apiUrl } = config;
  const installUrl = config.appSlug ? `${webUrl}/apps/${config.appSlug}/installations/new` : null;
  return {
    source: 'github',
    label: 'GitHub',
    oauth: clientId
      ? {
          signIn: ({ signal, now, showCode }) =>
            signInWithDeviceFlow({ clientId, webUrl, showCode, signal, now, sleep }),
          refresh: (refreshToken, now) => refreshGitHubTokens({ clientId, webUrl, refreshToken, now }),
        }
      : null,
    notConfigured:
      'This build of Commander has no GitHub App set up, so connect with a token instead. See “Connecting GitHub” in the README.',
    apiKeys: true,
    cli: { available: gh.installed, token: () => gh.token() },
    async identify(credential) {
      const token = credential.kind === 'oauth' ? credential.accessToken : credential.apiKey;
      const { user, scopes } = await readUser(apiUrl, token, refusedMessage(credential));
      let signedInWith: SignedInWith = 'github-app';
      if (credential.kind === 'api-key') {
        checkScopes(scopes, credential.fromCli ?? false);
        signedInWith = credential.fromCli ? 'gh' : 'classic-token';
      }
      const details: Record<string, string> = { login: user.login, signedInWith };
      if (credential.kind === 'oauth')
        details.installations = (await readInstallations(apiUrl, token)).join(',');
      return {
        id: `github:${user.id}`,
        name: user.login,
        user: { id: String(user.id), name: user.name ?? user.login },
        details,
      };
    },
    async refreshDetails(record, credential) {
      if (credential.kind !== 'oauth') return record.details;
      return {
        ...record.details,
        installations: (await readInstallations(apiUrl, credential.accessToken)).join(','),
      };
    },
    summarize: ({ id, name, details, method, status, user }) => ({
      id,
      source: 'github',
      name,
      login: details.login ?? name,
      signedInWith:
        (details.signedInWith as SignedInWith | undefined) ??
        (method === 'oauth' ? 'github-app' : 'classic-token'),
      installations:
        details.installations === undefined ? null : details.installations.split(',').filter(Boolean),
      installUrl,
      method,
      status,
      user,
    }),
    describe: (record) => `the GitHub Account for ${loginOf(record)}`,
    wrongIdentity: (signedIn, expected) => {
      const wanted = loginOf(expected) ?? 'the account being reconnected';
      const got = signedIn.name;
      return new SignInError(
        'wrong-account',
        `That sign-in is for ${got}, not ${wanted}. Sign in to GitHub as ${wanted} to reconnect it, or use Connect GitHub to add ${got}.`,
      );
    },
  };
}

export function createGitHubAccounts({
  config,
  gh,
  sleep,
  ...options
}: GitHubAccountsOptions): GitHubAccounts {
  return createSourceAccounts(githubSource(config, { gh, sleep }), options);
}
