import type { AccountSummary, AccountsRequest, AccountsState } from '@commander/domain/ipc';
import {
  Button,
  ButtonGroup,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Input,
  Led,
} from '@commander/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { AccountSync } from './AccountSync';
import { SettingRow, SettingsGroup } from './parts';

// Settings → Accounts: the User's signed-in Accounts, by Source. Only Linear so far. Tokens and
// keys stay in the main process: the window sees Account names and their state, nothing more.

type Busy = null | 'oauth' | 'api-key' | 'remove';
// The API key form, open for a new Account or to reconnect an existing one.
type KeyForm = null | { reconnect?: AccountSummary };

const methodNames = { oauth: 'Signed in with Linear', 'api-key': 'Personal API key' } as const;

function RemoveAccount({ account, onRemove }: { account: AccountSummary; onRemove: () => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>Remove</Button>
      <DialogContent aria-describedby={undefined} data-testid="remove-account-dialog">
        <DialogHeader>
          <DialogTitle>Remove Account</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogHeading>Remove {account.name}?</DialogHeading>
          <DialogDescription>
            Commander deletes this Linear Account’s sign-in from the keyring and removes its Linear issues.
            Your notes and Todos stay; Links to removed issues show them as gone.
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            onClick={async () => {
              // Closed either way: a failure is explained under the Accounts.
              await onRemove();
              setOpen(false);
            }}
          >
            Remove {account.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyForm({
  form,
  busy,
  canCancel,
  onSubmit,
  onCancel,
}: {
  form: NonNullable<KeyForm>;
  busy: boolean;
  canCancel: boolean;
  onSubmit: (apiKey: string) => void;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(apiKey);
  };
  return (
    <form onSubmit={submit} className="max-w-[560px]">
      <div className="flex">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="Linear personal API key"
          placeholder="lin_api_…"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={busy}
        />
        <ButtonGroup className="[&>*]:border-l-0">
          <Button type="submit" variant="primary" disabled={busy || !apiKey.trim()}>
            {busy ? 'Checking…' : form.reconnect ? `Reconnect ${form.reconnect.name}` : 'Connect'}
          </Button>
          {canCancel && (
            <Button onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
        </ButtonGroup>
      </div>
      <p className="m-0 mt-2 text-note leading-[19px] text-muted">
        Make one in Linear under Settings → Security &amp; access → Personal API keys. Commander keeps it in
        the system keyring.
      </p>
    </form>
  );
}

export function AccountsPanel({ no }: { no: string }) {
  const [state, setState] = useState<AccountsState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyForm, setKeyForm] = useState<KeyForm>(null);

  useEffect(() => {
    window.commander.accounts({ op: 'list' }).then((response) => setState(response.state));
    return window.commander.onAccountsChanged(setState);
  }, []);

  async function run(kind: Exclude<Busy, null>, request: AccountsRequest): Promise<boolean> {
    setBusy(kind);
    setError(null);
    try {
      const response = await window.commander.accounts(request);
      setState(response.state);
      if (!response.ok) setError(response.error);
      return response.ok;
    } finally {
      setBusy(null);
    }
  }

  const oauth = state?.linearOAuth ?? false;
  // Without an OAuth app in this build, the API key form is the way to connect.
  const form: KeyForm = keyForm ?? (state && !oauth ? {} : null);

  const connectWithBrowser = (reconnect?: AccountSummary) =>
    run('oauth', { op: 'connect-linear', method: 'oauth', reconnect: reconnect?.id });
  const connectWithKey = async (apiKey: string) => {
    const ok = await run('api-key', {
      op: 'connect-linear',
      method: 'api-key',
      apiKey,
      reconnect: form?.reconnect?.id,
    });
    if (ok) setKeyForm(null);
  };

  return (
    <SettingsGroup no={no} title="Accounts" note="Sources" data-testid="accounts-panel">
      {state?.accounts.map((account) => (
        <SettingRow
          key={account.id}
          label={<span data-testid="account-name">{account.name}</span>}
          description={`Linear workspace · linear.app/${account.urlKey} · ${methodNames[account.method]}`}
        >
          <div
            data-testid="account"
            data-account-id={account.id}
            className="flex flex-wrap items-center gap-4"
          >
            <span
              data-testid="account-status"
              className="flex min-w-[170px] items-center gap-2 font-mono text-label-lg leading-none font-semibold uppercase tracking-label text-ink"
            >
              <Led size="sm" state={account.status === 'connected' ? 'muted' : 'on'} />
              {account.status === 'connected' ? 'Connected' : 'Needs reconnecting'}
            </span>
            <ButtonGroup>
              {account.status === 'needs-reconnect' && (
                <Button
                  variant="signal"
                  disabled={busy !== null}
                  onClick={() =>
                    account.method === 'oauth' && oauth
                      ? connectWithBrowser(account)
                      : setKeyForm({ reconnect: account })
                  }
                >
                  Reconnect
                </Button>
              )}
              <RemoveAccount
                account={account}
                onRemove={() => run('remove', { op: 'remove', accountId: account.id })}
              />
            </ButtonGroup>
          </div>
          <AccountSync
            account={account}
            request={(request) =>
              window.commander.accounts(request).then((response) => setState(response.state))
            }
          />
        </SettingRow>
      ))}
      <SettingRow
        label="Linear"
        description="Connect a Linear workspace. Each workspace is its own Account; connect as many as you use."
      >
        {busy === 'oauth' ? (
          <div className="flex items-center gap-4">
            <span className="text-note text-ink" data-testid="waiting-for-browser">
              Approve Commander in your browser, then come back here.
            </span>
            <Button onClick={() => window.commander.accounts({ op: 'cancel-sign-in' })}>Cancel</Button>
          </div>
        ) : form ? (
          <>
            {!oauth && state && (
              <p className="m-0 mb-3 max-w-[560px] text-note leading-[19px] text-muted">
                This build has no Linear sign-in set up, so connect with a personal API key.
              </p>
            )}
            <ApiKeyForm
              key={form.reconnect?.id ?? 'new'}
              form={form}
              busy={busy === 'api-key'}
              canCancel={keyForm !== null && (oauth || form.reconnect !== undefined)}
              onSubmit={connectWithKey}
              onCancel={() => setKeyForm(null)}
            />
          </>
        ) : (
          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={!state || busy !== null} onClick={() => connectWithBrowser()}>
              Connect Linear
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setKeyForm({})}>
              Use an API key instead
            </Button>
          </div>
        )}
        {error && (
          <p
            data-testid="accounts-error"
            role="alert"
            className="m-0 mt-3 max-w-[560px] border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
          >
            {error}
          </p>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}
