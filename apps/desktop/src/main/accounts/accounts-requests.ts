// Answers Settings → Accounts. Requests are validated here; answers carry Account summaries and
// User-facing explanations only, never a token or a key (not even the one the User just pasted).
import { accountsRequest } from '@commander/domain';
import type {
  AccountSource,
  AccountSyncStatus,
  AccountsResponse,
  AccountsState,
} from '@commander/domain/ipc';
import { SignInError } from '../oauth/sign-in-error';
import type { Accounts } from './accounts';

// Each Account's syncing, which runs in the Core (see sync/core-sync-channel.ts).
export type AccountsSync = {
  status(accountId: string): AccountSyncStatus | null;
  refresh(accountId: string): void;
  setCadence(accountId: string, minutes: number): void;
};

const noSync: AccountsSync = { status: () => null, refresh: () => {}, setCadence: () => {} };

export async function accountsState(accounts: Accounts, sync: AccountsSync = noSync): Promise<AccountsState> {
  const listed = (await accounts.list()).map((account) => ({ ...account, sync: sync.status(account.id) }));
  return { accounts: listed, sources: accounts.signIns() };
}

// The Source an Account id belongs to ("<source>:…"), if it is one of the Accounts' Sources.
function sourceOf(accounts: Accounts, accountId: string): AccountSource | undefined {
  const prefix = accountId.slice(0, accountId.indexOf(':'));
  return accounts.sources.find(({ source }) => source === prefix)?.source;
}

export async function answerAccountsRequest(
  accounts: Accounts,
  raw: unknown,
  sync: AccountsSync = noSync,
): Promise<AccountsResponse> {
  const state = () => accountsState(accounts, sync);
  const parsed = accountsRequest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Commander did not understand that request.', state: await state() };
  }
  const request = parsed.data;
  // The Source a failure is about, so the window explains it in the right place.
  let source: AccountSource | undefined;
  try {
    switch (request.op) {
      case 'list':
        break;
      case 'connect': {
        source = request.source;
        const of = accounts.of(request.source);
        if (request.method === 'oauth') await of.connectWithBrowser({ reconnect: request.reconnect });
        else await of.connectWithApiKey(request.apiKey, { reconnect: request.reconnect });
        break;
      }
      case 'cancel-sign-in':
        accounts.cancelSignIn();
        break;
      case 'remove':
        source = sourceOf(accounts, request.accountId);
        await accounts.remove(request.accountId);
        break;
      case 'set-source-enabled':
        source = sourceOf(accounts, request.accountId);
        await accounts.setSourceEnabled(request.accountId, request.source, request.enabled);
        break;
      case 'sync-now':
        sync.refresh(request.accountId);
        break;
      case 'set-sync-cadence':
        sync.setCadence(request.accountId, request.minutes);
        break;
    }
  } catch (error) {
    // Cancelling is the User's own choice, not a failure to explain.
    if (error instanceof SignInError && error.reason === 'cancelled') {
      return { ok: true, state: await state() };
    }
    const message = error instanceof Error ? error.message : 'Something went wrong. Try again.';
    const adminConsent = error instanceof SignInError ? error.adminConsent : undefined;
    return {
      ok: false,
      error: message,
      ...(source ? { source } : {}),
      ...(adminConsent ? { adminConsent } : {}),
      state: await state(),
    };
  }
  return { ok: true, state: await state() };
}
