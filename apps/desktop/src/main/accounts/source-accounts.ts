import type {
  AccountSource,
  DeviceCodePrompt,
  AccountSummary as WindowAccountSummary,
} from '@commander/domain/ipc';
import type { TokenSet } from '../oauth/authorization-code';
import { RefreshError } from '../oauth/authorization-code';
import { SignInError } from '../oauth/sign-in-error';
import type { Secrets } from '../secrets';
import { type AccountRecord, type AccountStore, credentialKey } from './account-store';

// One Source's Accounts: connecting (OAuth in the browser or with a device code, a personal API key
// or token where the Source has them, or a command-line tool's sign-in), reconnecting, removing, and
// handing the Core a current access token. The same for every Source; what differs (how to sign in,
// refresh, name an Account and show it) comes from the Source's AccountSourceDefinition
// (linear/linear-accounts.ts, microsoft/teams-accounts.ts, github/github-accounts.ts).
//
// Runs in the main process only. Tokens and keys go to the keyring through the secrets module and
// nowhere else: what leaves this module for the window is an AccountSummary, and errors never carry
// a secret.

// An Account as the window sees it, before its sync status (which the Core reports) is added.
export type AccountSummary = WindowAccountSummary extends infer Summary
  ? Summary extends WindowAccountSummary
    ? Omit<Summary, 'sync'>
    : never
  : never;

// What the keyring holds for each Account, as JSON under credentialKey(accountId).
export type StoredCredential = ({ kind: 'oauth' } & TokenSet) | { kind: 'api-key'; apiKey: string };

// A credential to ask the Source who it signs in as. `fromCli`: a command-line tool's sign-in.
export type SourceCredential =
  | { kind: 'oauth'; accessToken: string }
  | { kind: 'api-key'; apiKey: string; fromCli?: boolean };

// Who a credential signs in as, which names and keys the Account.
export type AccountIdentity = {
  // The Account's id, "<source>:…": signing in as the same identity again updates that Account.
  id: string;
  name: string;
  // Who the User is at the Source.
  user: { id: string; name: string };
  // What only the Source needs (see AccountRecord.details).
  details: Record<string, string>;
};

// What one Source brings to its Accounts. `S` is what its browser sign-in hands back: the tokens,
// and anything else it learned on the way (Microsoft: the tenant).
export type AccountSourceDefinition<S extends TokenSet = TokenSet> = {
  source: AccountSource;
  // The Source, as messages name it ("Linear", "Teams").
  label: string;
  // Signing in through the browser, and refreshing what it gave; null when this build has no app
  // registration for the Source (`notConfigured` then explains).
  oauth: {
    signIn(options: {
      openBrowser: (url: string) => Promise<void>;
      signal: AbortSignal;
      now: () => number;
      // For a device sign-in (GitHub): shows the User the code to enter at the Source.
      showCode: (prompt: DeviceCodePrompt) => void;
    }): Promise<S>;
    refresh(refreshToken: string, now: () => number): Promise<TokenSet>;
  } | null;
  notConfigured: string;
  // Whether a personal API key can connect an Account instead.
  apiKeys: boolean;
  // A command-line tool on this machine whose sign-in can connect an Account (GitHub: gh), when the
  // Source has one; `available` when it is installed. Its token is stored like an API key.
  cli?: { available: boolean; token(): Promise<string> };
  // Asks the Source again for what the Account's details hold that changes (GitHub: where its app is
  // installed), returning the new details.
  refreshDetails?(record: AccountRecord, credential: SourceCredential): Promise<Record<string, string>>;
  // Asks the Source who the credential signs in as. `signIn` is the browser sign-in it came from,
  // when it did. Rejects with a SignInError.
  identify(credential: SourceCredential, signIn?: S): Promise<AccountIdentity>;
  // The Account as the window sees it.
  summarize(record: AccountRecord): AccountSummary;
  // The Account, in a sentence: "the Acme Linear Account".
  describe(record: AccountRecord): string;
  // Why a reconnect was refused: it signed in as someone else than `expected`.
  wrongIdentity(signedIn: AccountIdentity, expected: AccountRecord | null): SignInError;
};

export type AccessToken = { token: string; kind: 'oauth' | 'api-key' };

export type AccessTokenFailure = 'unknown-account' | 'needs-reconnect' | 'unavailable';

export class AccessTokenError extends Error {
  override name = 'AccessTokenError';
  constructor(
    readonly reason: AccessTokenFailure,
    message: string,
  ) {
    super(message);
  }
}

export type SourceAccounts = {
  readonly source: AccountSource;
  // Whether this build can sign in through the browser (it has the Source's app registration).
  readonly oauthAvailable: boolean;
  // Whether a personal API key can connect an Account.
  readonly apiKeyAvailable: boolean;
  // Whether a command-line tool's sign-in can connect an Account (it is installed).
  readonly cliAvailable: boolean;
  // Whether a browser sign-in is waiting for the User.
  readonly signingIn: boolean;
  // The code a device sign-in waits for the User to enter, while it does.
  readonly deviceCode: DeviceCodePrompt | null;
  list(): Promise<AccountSummary[]>;
  // `reconnect`: the Account being reconnected; the sign-in must be for the same identity.
  connectWithBrowser(options?: { reconnect?: string }): Promise<AccountSummary>;
  connectWithApiKey(apiKey: string, options?: { reconnect?: string }): Promise<AccountSummary>;
  connectWithCli(options?: { reconnect?: string }): Promise<AccountSummary>;
  cancelSignIn(): void;
  // Deletes the Account's Items (through `removeItems`), its keyring entry, then the Account.
  remove(accountId: string): Promise<void>;
  // A current access token, refreshed first when it is near expiry. Rejects with AccessTokenError.
  accessToken(accountId: string): Promise<AccessToken>;
  // Finds out who the User is in each Account that doesn't know yet (Accounts connected before
  // Commander kept it). An Account the Source can't be asked about now is left to the next start.
  identifyUsers(): Promise<void>;
  // Asks the Source again about one Account (rejecting if it can't), or about every connected one
  // (leaving those it can't ask about now). Only for Sources with details that change.
  refreshDetails(accountId?: string): Promise<void>;
  // The Source refused the Account's token during a sync (e.g. an API key revoked). An API key
  // Account is marked Reconnect; an OAuth one is refreshed, and marked Reconnect if that fails for good.
  reportRefused(accountId: string): Promise<void>;
  // Called whenever the list of Accounts or their status changes.
  onChange(listener: () => void): () => void;
};

export type SourceAccountsOptions = {
  secrets: Secrets;
  store: AccountStore;
  // Opens the system browser on the Source's consent page.
  openBrowser: (url: string) => Promise<void>;
  // Removes (tombstones) every Item that came from the Account; the Core does this.
  removeItems: (account: { id: string; name: string }) => Promise<unknown>;
  now?: () => number;
  log?: (message: string) => void;
};

// Refresh when the access token has less than this left.
const REFRESH_MARGIN_MS = 10 * 60_000;

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function createSourceAccounts<S extends TokenSet>(
  definition: AccountSourceDefinition<S>,
  {
    secrets,
    store,
    openBrowser,
    removeItems,
    now = Date.now,
    log = (message) => console.warn(message),
  }: SourceAccountsOptions,
): SourceAccounts {
  const { source, label, oauth } = definition;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  // One refresh at a time per Account: refresh tokens rotate, so a second refresh with the same
  // token would spend it and lose the Account.
  const refreshing = new Map<string, Promise<AccessToken>>();
  // The browser sign-in waiting for the User, if any, and its end (once its listener is closed).
  let signIn: AbortController | null = null;
  let signInEnded: Promise<unknown> = Promise.resolve();
  let deviceCode: DeviceCodePrompt | null = null;

  const needsReconnect = (record: AccountRecord) =>
    new AccessTokenError('needs-reconnect', `${capitalised(definition.describe(record))} needs reconnecting`);

  function requireKeyring() {
    const { problem } = secrets.status();
    if (problem !== null) throw new SignInError('keyring-unavailable', problem);
  }

  async function readCredential(id: string): Promise<StoredCredential | null> {
    let text: string | null;
    try {
      text = await secrets.read(credentialKey(id));
    } catch (error) {
      throw new AccessTokenError('unavailable', error instanceof Error ? error.message : String(error));
    }
    return text === null ? null : (JSON.parse(text) as StoredCredential);
  }

  async function markNeedsReconnect(record: AccountRecord) {
    await store.put({ ...record, status: 'needs-reconnect' });
    changed();
  }

  // Saves the credential (keyring first), then the Account, for an identity the Source confirmed.
  async function connect(
    identity: AccountIdentity,
    credential: StoredCredential,
    reconnect: string | undefined,
  ): Promise<AccountSummary> {
    const { id } = identity;
    if (reconnect !== undefined && reconnect !== id) {
      throw definition.wrongIdentity(identity, await store.get(reconnect));
    }
    await refreshing.get(id)?.catch(() => {});
    try {
      await secrets.save(credentialKey(id), JSON.stringify(credential));
    } catch (error) {
      throw new SignInError('keyring-unavailable', error instanceof Error ? error.message : String(error));
    }
    const existing = await store.get(id);
    const record: AccountRecord = {
      id,
      source,
      name: identity.name,
      method: credential.kind,
      status: 'connected',
      connectedAt: existing?.connectedAt ?? now(),
      user: identity.user,
      details: identity.details,
    };
    await store.put(record);
    changed();
    return definition.summarize(record);
  }

  // `force`: refresh even a token that looks fresh, because the Source refused it.
  async function refresh(record: AccountRecord, force = false): Promise<AccessToken> {
    const credential = await readCredential(record.id);
    if (!credential) {
      await markNeedsReconnect(record);
      throw needsReconnect(record);
    }
    if (credential.kind === 'api-key') return { token: credential.apiKey, kind: 'api-key' };
    if (!force && credential.expiresAt - now() > REFRESH_MARGIN_MS)
      return { token: credential.accessToken, kind: 'oauth' };
    if (!oauth) {
      throw new AccessTokenError(
        'unavailable',
        `This build has no ${label} app registration to refresh the sign-in with`,
      );
    }
    let tokens: TokenSet;
    try {
      tokens = await oauth.refresh(credential.refreshToken, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RefreshError && error.permanent) {
        log(`${capitalised(definition.describe(record))} needs reconnecting: ${message}`);
        await markNeedsReconnect(record);
        throw needsReconnect(record);
      }
      log(`${capitalised(definition.describe(record))} could not refresh its sign-in yet: ${message}`);
      if (!force && credential.expiresAt > now()) return { token: credential.accessToken, kind: 'oauth' };
      throw new AccessTokenError(
        'unavailable',
        `${label} couldn’t refresh the sign-in of ${definition.describe(record)} just now`,
      );
    }
    // The old refresh token is already spent: keep the new one before anything uses the access token.
    const { accessToken, refreshToken, expiresAt } = tokens;
    try {
      await secrets.save(
        credentialKey(record.id),
        JSON.stringify({ kind: 'oauth', accessToken, refreshToken, expiresAt }),
      );
    } catch (error) {
      throw new AccessTokenError('unavailable', error instanceof Error ? error.message : String(error));
    }
    return { token: accessToken, kind: 'oauth' };
  }

  // A refresh, unless one is already running for the Account.
  function refreshOnce(record: AccountRecord, force = false): Promise<AccessToken> {
    const running = refreshing.get(record.id);
    if (running) return running;
    const run = refresh(record, force).finally(() => refreshing.delete(record.id));
    refreshing.set(record.id, run);
    return run;
  }

  const credentialOf = (token: AccessToken): SourceCredential =>
    token.kind === 'oauth'
      ? { kind: 'oauth', accessToken: token.token }
      : { kind: 'api-key', apiKey: token.token };

  async function connectWithToken(raw: string, fromCli: boolean, reconnect: string | undefined) {
    const apiKey = raw.trim();
    if (!apiKey) throw new SignInError('invalid-credential', `Paste a ${label} personal API key first.`);
    requireKeyring();
    const identity = await definition.identify({ kind: 'api-key', apiKey, ...(fromCli ? { fromCli } : {}) });
    return connect(identity, { kind: 'api-key', apiKey }, reconnect);
  }

  async function accessToken(id: string): Promise<AccessToken> {
    const record = await store.get(id);
    if (!record || record.source !== source)
      throw new AccessTokenError('unknown-account', `No ${label} Account ${id}`);
    if (record.status === 'needs-reconnect') throw needsReconnect(record);
    return refreshOnce(record);
  }

  return {
    source,
    oauthAvailable: oauth !== null,
    apiKeyAvailable: definition.apiKeys,
    cliAvailable: definition.cli?.available ?? false,

    get signingIn() {
      return signIn !== null;
    },

    get deviceCode() {
      return deviceCode;
    },

    async list() {
      return (await store.list()).filter((record) => record.source === source).map(definition.summarize);
    },

    async connectWithBrowser({ reconnect } = {}) {
      if (!oauth) throw new SignInError('not-configured', definition.notConfigured);
      requireKeyring();
      // A new sign-in replaces one still waiting (a fixed port can only listen for one).
      signIn?.abort();
      await signInEnded;
      const controller = new AbortController();
      signIn = controller;
      deviceCode = null;
      const showCode = (prompt: DeviceCodePrompt) => {
        if (signIn !== controller) return;
        deviceCode = prompt;
        changed();
      };
      try {
        const signingIn = oauth.signIn({ openBrowser, signal: controller.signal, now, showCode });
        signInEnded = signingIn.catch(() => {});
        const signedIn = await signingIn;
        const { accessToken, refreshToken, expiresAt } = signedIn;
        const identity = await definition.identify({ kind: 'oauth', accessToken }, signedIn);
        return await connect(identity, { kind: 'oauth', accessToken, refreshToken, expiresAt }, reconnect);
      } finally {
        if (signIn === controller) {
          signIn = null;
          if (deviceCode) {
            deviceCode = null;
            changed();
          }
        }
      }
    },

    async connectWithApiKey(raw, { reconnect } = {}) {
      if (!definition.apiKeys) {
        throw new SignInError('not-configured', `${label} Accounts can’t be connected with an API key.`);
      }
      return connectWithToken(raw, false, reconnect);
    },

    async connectWithCli({ reconnect } = {}) {
      if (!definition.cli?.available) {
        throw new SignInError(
          'not-configured',
          `There is no ${label} command-line sign-in on this machine to use.`,
        );
      }
      requireKeyring();
      return connectWithToken(await definition.cli.token(), true, reconnect);
    },

    cancelSignIn() {
      signIn?.abort();
    },

    async remove(id) {
      const record = await store.get(id);
      if (!record || record.source !== source) return;
      await refreshing.get(id)?.catch(() => {});
      await removeItems({ id, name: record.name });
      await secrets.delete(credentialKey(id));
      await store.remove(id);
      changed();
    },

    accessToken,

    async identifyUsers() {
      const unknown = (await store.list()).filter(
        (record) => record.source === source && !record.user && record.status === 'connected',
      );
      let found = false;
      for (const record of unknown) {
        try {
          const identity = await definition.identify(credentialOf(await accessToken(record.id)));
          if (identity.id !== record.id) continue;
          const latest = await store.get(record.id);
          if (!latest) continue;
          await store.put({ ...latest, user: identity.user });
          found = true;
        } catch (error) {
          log(`Couldn't find out who signed in to ${definition.describe(record)} yet: ${String(error)}`);
        }
      }
      if (found) changed();
    },

    async refreshDetails(id) {
      const { refreshDetails } = definition;
      if (!refreshDetails) return;
      const records = (await store.list()).filter(
        (record) =>
          record.source === source && record.status === 'connected' && (id === undefined || record.id === id),
      );
      let found = false;
      for (const record of records) {
        try {
          const details = await refreshDetails(record, credentialOf(await accessToken(record.id)));
          const latest = await store.get(record.id);
          if (!latest) continue;
          await store.put({ ...latest, details });
          found = true;
        } catch (error) {
          if (id !== undefined) throw error;
          log(`Couldn't check ${definition.describe(record)} again yet: ${String(error)}`);
        }
      }
      if (found) changed();
    },

    async reportRefused(id) {
      await refreshing.get(id)?.catch(() => {});
      const record = await store.get(id);
      if (!record || record.source !== source || record.status === 'needs-reconnect') return;
      if (record.method === 'api-key') {
        log(`${label} refused the API key of ${definition.describe(record)}; it needs reconnecting`);
        await markNeedsReconnect(record);
        return;
      }
      // A refused OAuth token may only have been revoked early: a refresh tells. A refresh refused
      // for good marks the Account Reconnect inside refresh().
      await refreshOnce(record, true).catch(() => {});
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
