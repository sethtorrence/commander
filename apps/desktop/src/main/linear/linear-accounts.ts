import type { AccountRecord } from '../accounts/account-store';
import {
  type AccountIdentity,
  type AccountSourceDefinition,
  createSourceAccounts,
  type SourceAccounts,
  type SourceAccountsOptions,
} from '../accounts/source-accounts';
import { SignInError } from '../oauth/sign-in-error';
import { LINEAR_ENDPOINTS, type LinearConfig } from './linear-config';
import { refreshTokens, signInWithBrowser } from './oauth';
import { readWorkspace, type SignIn } from './workspace';

// Linear Accounts: one per workspace, connected through the browser (OAuth with Commander's Linear
// app) or with a personal API key. The workspace names and keys the Account; the Linear user signed
// in is who "assigned to me" means there. Everything else is shared by every Source
// (accounts/source-accounts.ts).

export { LINEAR_ENDPOINTS, type LinearConfig };

export type LinearAccounts = SourceAccounts;

export type LinearAccountsOptions = SourceAccountsOptions & { config: LinearConfig };

function identity({ workspace, user }: SignIn): AccountIdentity {
  return { id: `linear:${workspace.id}`, name: workspace.name, user, details: { urlKey: workspace.urlKey } };
}

export function linearSource(config: LinearConfig): AccountSourceDefinition {
  const { clientId } = config;
  return {
    source: 'linear',
    label: 'Linear',
    oauth: clientId
      ? {
          signIn: (options) =>
            signInWithBrowser({
              client: {
                clientId,
                port: config.port,
                authorizeUrl: config.authorizeUrl,
                tokenUrl: config.tokenUrl,
              },
              ...options,
            }),
          refresh: (refreshToken, now) =>
            refreshTokens({ client: { clientId, tokenUrl: config.tokenUrl }, refreshToken, now }),
        }
      : null,
    notConfigured:
      'This build of Commander has no Linear OAuth app configured. Use a personal API key instead.',
    apiKeys: true,
    identify: async (credential) => identity(await readWorkspace({ apiUrl: config.apiUrl, credential })),
    summarize: ({ id, name, details, method, status, user }: AccountRecord) => ({
      id,
      source: 'linear',
      name,
      urlKey: details.urlKey ?? '',
      method,
      status,
      user,
    }),
    describe: (record) => `the ${record.name} Linear Account`,
    wrongIdentity: (signedIn, expected) =>
      new SignInError(
        'wrong-workspace',
        `That sign-in is for the ${signedIn.name} workspace, not ${expected?.name ?? 'the one being reconnected'}. Sign in to ${expected?.name ?? 'that workspace'} to reconnect it, or use Connect Linear to add ${signedIn.name}.`,
      ),
  };
}

export function createLinearAccounts({ config, ...options }: LinearAccountsOptions): LinearAccounts {
  return createSourceAccounts(linearSource(config), options);
}
