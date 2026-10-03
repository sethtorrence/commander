import type { AccountSummary } from '@commander/domain/ipc';
import { type AccountRecord, type AccountStore, credentialKey } from '../accounts/account-store';
import type { Secrets } from '../secrets';
import { RefreshError, refreshTokens, signInWithBrowser, type TokenSet } from './oauth';
import { SignInError } from './sign-in-error';
import { type LinearCredential, readWorkspace, type Workspace } from './workspace';

// Linear Accounts: connecting (OAuth in the browser, or a personal API key), reconnecting,
// removing, and handing the Core a current access token. Runs in the main process only. Tokens
// and keys go to the keyring through the secrets module and nowhere else: what leaves this
// module for the window is an AccountSummary, and errors never carry a secret.

export type LinearConfig = {
  // Commander's OAuth app client ID, from the private build config. null: only API keys work.
  clientId: string | null;
  // The fixed loopback port registered with the OAuth app.
  port: number;
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
};

export const LINEAR_ENDPOINTS = {
  authorizeUrl: 'https://linear.app/oauth/authorize',
  tokenUrl: 'https://api.linear.app/oauth/token',
  apiUrl: 'https://api.linear.app/graphql',
} as const;

// Refresh when the access token has less than this left.
const REFRESH_MARGIN_MS = 10 * 60_000;

// What the keyring holds for each Linear Account, as JSON under credentialKey(accountId).
type StoredCredential = ({ kind: 'oauth' } & TokenSet) | { kind: 'api-key'; apiKey: string };

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

export type LinearAccounts = {
  // Whether this build can sign in with OAuth (it has a client ID).
  readonly oauthAvailable: boolean;
  // Whether a browser sign-in is waiting for the User.
  readonly signingIn: boolean;
  list(): Promise<AccountSummary[]>;
  // `reconnect`: the Account being reconnected; the sign-in must be for its workspace.
  connectWithBrowser(options?: { reconnect?: string }): Promise<AccountSummary>;
  connectWithApiKey(apiKey: string, options?: { reconnect?: string }): Promise<AccountSummary>;
  cancelSignIn(): void;
  // Deletes the Account's Items (through `removeItems`), its keyring entry, then the Account.
  remove(accountId: string): Promise<void>;
  // A current access token, refreshed first when it is near expiry. Rejects with AccessTokenError.
  accessToken(accountId: string): Promise<AccessToken>;
  // Called whenever the list of Accounts or their status changes.
  onChange(listener: () => void): () => void;
};

export type LinearAccountsOptions = {
  config: LinearConfig;
  secrets: Secrets;
  store: AccountStore;
  // Opens the system browser on Linear's consent page.
  openBrowser: (url: string) => Promise<void>;
  // Removes (tombstones) every Item that came from the Account; the Core does this.
  removeItems: (account: { id: string; name: string }) => Promise<unknown>;
  now?: () => number;
  log?: (message: string) => void;
};

const accountId = (workspace: Workspace) => `linear:${workspace.id}`;

function summary({ id, source, name, urlKey, method, status }: AccountRecord): AccountSummary {
  return { id, source, name, urlKey, method, status };
}

export function createLinearAccounts({
  config,
  secrets,
  store,
  openBrowser,
  removeItems,
  now = Date.now,
  log = (message) => console.warn(message),
}: LinearAccountsOptions): LinearAccounts {
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

  // Saves the credential (keyring first), then the Account, for a workspace Linear confirmed.
  async function connect(
    workspace: Workspace,
    credential: StoredCredential,
    reconnect: string | undefined,
  ): Promise<AccountSummary> {
    const id = accountId(workspace);
    if (reconnect !== undefined && reconnect !== id) {
      const expected = await store.get(reconnect);
      throw new SignInError(
        'wrong-workspace',
        `That sign-in is for the ${workspace.name} workspace, not ${expected?.name ?? 'the one being reconnected'}. Sign in to ${expected?.name ?? 'that workspace'} to reconnect it, or use Connect Linear to add ${workspace.name}.`,
      );
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
      source: 'linear',
      name: workspace.name,
      urlKey: workspace.urlKey,
      method: credential.kind,
      status: 'connected',
      connectedAt: existing?.connectedAt ?? now(),
    };
    await store.put(record);
    changed();
    return summary(record);
  }

  async function refresh(record: AccountRecord): Promise<AccessToken> {
    const credential = await readCredential(record.id);
    if (!credential) {
      await markNeedsReconnect(record);
      throw new AccessTokenError('needs-reconnect', `The ${record.name} Linear Account needs reconnecting`);
    }
    if (credential.kind === 'api-key') return { token: credential.apiKey, kind: 'api-key' };
    if (credential.expiresAt - now() > REFRESH_MARGIN_MS)
      return { token: credential.accessToken, kind: 'oauth' };
    if (!config.clientId) {
      throw new AccessTokenError(
        'unavailable',
        'This build has no Linear client ID to refresh the sign-in with',
      );
    }
    let tokens: TokenSet;
    try {
      tokens = await refreshTokens({
        client: { clientId: config.clientId, tokenUrl: config.tokenUrl },
        refreshToken: credential.refreshToken,
        now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RefreshError && error.permanent) {
        log(`Linear Account ${record.id} needs reconnecting: ${message}`);
        await markNeedsReconnect(record);
        throw new AccessTokenError('needs-reconnect', `The ${record.name} Linear Account needs reconnecting`);
      }
      log(`Linear Account ${record.id} could not refresh its sign-in yet: ${message}`);
      if (credential.expiresAt > now()) return { token: credential.accessToken, kind: 'oauth' };
      throw new AccessTokenError(
        'unavailable',
        `Linear couldn't refresh the ${record.name} sign-in just now`,
      );
    }
    // The old refresh token is already spent: keep the new one before anything uses the access token.
    try {
      await secrets.save(credentialKey(record.id), JSON.stringify({ kind: 'oauth', ...tokens }));
    } catch (error) {
      throw new AccessTokenError('unavailable', error instanceof Error ? error.message : String(error));
    }
    return { token: tokens.accessToken, kind: 'oauth' };
  }

  return {
    oauthAvailable: Boolean(config.clientId),

    get signingIn() {
      return signIn !== null;
    },

    async list() {
      return (await store.list()).filter((record) => record.source === 'linear').map(summary);
    },

    async connectWithBrowser({ reconnect } = {}) {
      if (!config.clientId) {
        throw new SignInError(
          'not-configured',
          'This build of Commander has no Linear OAuth app configured. Use a personal API key instead.',
        );
      }
      requireKeyring();
      // A new sign-in replaces one still waiting: the fixed port can only listen for one.
      signIn?.abort();
      await signInEnded;
      const controller = new AbortController();
      signIn = controller;
      try {
        const signingIn = signInWithBrowser({
          client: {
            clientId: config.clientId,
            port: config.port,
            authorizeUrl: config.authorizeUrl,
            tokenUrl: config.tokenUrl,
          },
          openBrowser,
          signal: controller.signal,
          now,
        });
        signInEnded = signingIn.catch(() => {});
        const tokens = await signingIn;
        const credential: LinearCredential = { kind: 'oauth', accessToken: tokens.accessToken };
        const workspace = await readWorkspace({ apiUrl: config.apiUrl, credential });
        return await connect(workspace, { kind: 'oauth', ...tokens }, reconnect);
      } finally {
        if (signIn === controller) signIn = null;
      }
    },

    async connectWithApiKey(raw, { reconnect } = {}) {
      const apiKey = raw.trim();
      if (!apiKey) throw new SignInError('invalid-credential', 'Paste a Linear personal API key first.');
      requireKeyring();
      const workspace = await readWorkspace({
        apiUrl: config.apiUrl,
        credential: { kind: 'api-key', apiKey },
      });
      return connect(workspace, { kind: 'api-key', apiKey }, reconnect);
    },

    cancelSignIn() {
      signIn?.abort();
    },

    async remove(id) {
      const record = await store.get(id);
      if (!record) return;
      await refreshing.get(id)?.catch(() => {});
      await removeItems({ id, name: record.name });
      await secrets.delete(credentialKey(id));
      await store.remove(id);
      changed();
    },

    async accessToken(id) {
      const record = await store.get(id);
      if (!record) throw new AccessTokenError('unknown-account', `No Linear Account ${id}`);
      if (record.status === 'needs-reconnect') {
        throw new AccessTokenError('needs-reconnect', `The ${record.name} Linear Account needs reconnecting`);
      }
      const running = refreshing.get(id);
      if (running) return running;
      const run = refresh(record).finally(() => refreshing.delete(id));
      refreshing.set(id, run);
      return run;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
