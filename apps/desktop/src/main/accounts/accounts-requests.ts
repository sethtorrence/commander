// Answers Settings → Accounts. Requests are validated here; answers carry Account summaries and
// User-facing explanations only, never a token or a key (not even the one the User just pasted).
import { accountsRequest } from '@commander/domain';
import type { AccountSyncStatus, AccountsResponse, AccountsState } from '@commander/domain/ipc';
import type { LinearAccounts } from '../linear/linear-accounts';
import { SignInError } from '../linear/sign-in-error';

// Each Account's syncing, which runs in the Core (see sync/core-sync-channel.ts).
export type AccountsSync = {
  status(accountId: string): AccountSyncStatus | null;
  refresh(accountId: string): void;
  setCadence(accountId: string, minutes: number): void;
};

const noSync: AccountsSync = { status: () => null, refresh: () => {}, setCadence: () => {} };

export async function accountsState(
  linear: LinearAccounts,
  sync: AccountsSync = noSync,
): Promise<AccountsState> {
  const accounts = (await linear.list()).map((account) => ({ ...account, sync: sync.status(account.id) }));
  return { accounts, linearOAuth: linear.oauthAvailable };
}

export async function answerAccountsRequest(
  linear: LinearAccounts,
  raw: unknown,
  sync: AccountsSync = noSync,
): Promise<AccountsResponse> {
  const state = () => accountsState(linear, sync);
  const parsed = accountsRequest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Commander did not understand that request.', state: await state() };
  }
  const request = parsed.data;
  try {
    switch (request.op) {
      case 'list':
        break;
      case 'connect-linear':
        if (request.method === 'oauth') await linear.connectWithBrowser({ reconnect: request.reconnect });
        else await linear.connectWithApiKey(request.apiKey, { reconnect: request.reconnect });
        break;
      case 'cancel-sign-in':
        linear.cancelSignIn();
        break;
      case 'remove':
        await linear.remove(request.accountId);
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
    const message =
      error instanceof SignInError || error instanceof Error
        ? error.message
        : 'Something went wrong. Try again.';
    return { ok: false, error: message, state: await state() };
  }
  return { ok: true, state: await state() };
}
