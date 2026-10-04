import type { AccountSource, CarriedSource, DeviceCodePrompt, SourceSignIn } from '@commander/domain/ipc';
import {
  type AccessToken,
  AccessTokenError,
  type AccountSummary,
  type SourceAccounts,
} from './source-accounts';

// The Accounts of every Source together, as Settings → Accounts, the Core and sync see them. Each
// Source's own SourceAccounts does the work; this finds the right one, by the Source or by the
// Account's id ("<source>:…").

export type Accounts = {
  // Each Source's Accounts, in the order Settings → Accounts shows them.
  readonly sources: readonly SourceAccounts[];
  // How this build can connect each Source.
  signIns(): SourceSignIn[];
  // Rejects for a Source Commander has no Accounts for.
  of(source: AccountSource): SourceAccounts;
  // Every Account, Source by Source.
  list(): Promise<AccountSummary[]>;
  accessToken(accountId: string): Promise<AccessToken>;
  remove(accountId: string): Promise<void>;
  setSourceEnabled(accountId: string, source: CarriedSource['source'], enabled: boolean): Promise<void>;
  reportRefused(accountId: string): Promise<void>;
  identifyUsers(): Promise<void>;
  // Asks the Source again about one Account, or every Account of every Source that has details that
  // change (GitHub: where its app is installed).
  refreshDetails(accountId?: string): Promise<void>;
  // The device sign-in waiting for the User to enter its code, if any.
  deviceCode(): (DeviceCodePrompt & { source: AccountSource }) | null;
  // Cancels any browser sign-in waiting for the User.
  cancelSignIn(): void;
  onChange(listener: () => void): () => void;
};

export function combineAccounts(sources: readonly SourceAccounts[]): Accounts {
  const bySource = new Map(sources.map((accounts) => [accounts.source, accounts]));
  const owner = (accountId: string) =>
    bySource.get(accountId.slice(0, accountId.indexOf(':')) as AccountSource);

  return {
    sources,

    signIns: () =>
      sources.map(({ source, oauthAvailable, apiKeyAvailable, cliAvailable }) => ({
        source,
        oauth: oauthAvailable,
        apiKey: apiKeyAvailable,
        ...(cliAvailable ? { cli: true } : {}),
      })),

    of(source) {
      const accounts = bySource.get(source);
      if (!accounts) throw new Error(`Commander can’t connect ${source} Accounts yet.`);
      return accounts;
    },

    list: async () => (await Promise.all(sources.map((accounts) => accounts.list()))).flat(),

    accessToken(accountId) {
      const accounts = owner(accountId);
      if (!accounts)
        return Promise.reject(new AccessTokenError('unknown-account', `No Account ${accountId}`));
      return accounts.accessToken(accountId);
    },

    async remove(accountId) {
      await owner(accountId)?.remove(accountId);
    },

    async setSourceEnabled(accountId, source, enabled) {
      const accounts = owner(accountId);
      if (!accounts) throw new Error(`No Account ${accountId}`);
      await accounts.setSourceEnabled(accountId, source, enabled);
    },

    async reportRefused(accountId) {
      await owner(accountId)?.reportRefused(accountId);
    },

    async identifyUsers() {
      await Promise.all(sources.map((accounts) => accounts.identifyUsers()));
    },

    async refreshDetails(accountId) {
      if (accountId === undefined) await Promise.all(sources.map((accounts) => accounts.refreshDetails()));
      else await owner(accountId)?.refreshDetails(accountId);
    },

    deviceCode() {
      for (const { source, deviceCode } of sources) if (deviceCode) return { ...deviceCode, source };
      return null;
    },

    cancelSignIn() {
      for (const accounts of sources) accounts.cancelSignIn();
    },

    onChange(listener) {
      const stops = sources.map((accounts) => accounts.onChange(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
