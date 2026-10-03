// Answers Settings → Accounts. Requests are validated here; answers carry Account summaries and
// User-facing explanations only, never a token or a key (not even the one the User just pasted).
import { accountsRequest } from '@commander/domain';
import type { AccountsResponse, AccountsState } from '@commander/domain/ipc';
import type { LinearAccounts } from '../linear/linear-accounts';
import { SignInError } from '../linear/sign-in-error';

export async function accountsState(linear: LinearAccounts): Promise<AccountsState> {
  return { accounts: await linear.list(), linearOAuth: linear.oauthAvailable };
}

export async function answerAccountsRequest(linear: LinearAccounts, raw: unknown): Promise<AccountsResponse> {
  const parsed = accountsRequest.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Commander did not understand that request.',
      state: await accountsState(linear),
    };
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
    }
  } catch (error) {
    // Cancelling is the User's own choice, not a failure to explain.
    if (error instanceof SignInError && error.reason === 'cancelled') {
      return { ok: true, state: await accountsState(linear) };
    }
    const message =
      error instanceof SignInError || error instanceof Error
        ? error.message
        : 'Something went wrong. Try again.';
    return { ok: false, error: message, state: await accountsState(linear) };
  }
  return { ok: true, state: await accountsState(linear) };
}
