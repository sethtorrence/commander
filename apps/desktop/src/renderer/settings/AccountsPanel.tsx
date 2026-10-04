import type {
  AccountSource,
  AccountSummary,
  AccountsRequest,
  AccountsState,
  AdminConsentNeeded,
  CarriedSource,
  GoogleAccountSummary,
  OutlookAccountSummary,
  SourceSignIn,
} from '@commander/domain/ipc';
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
  Switch,
  toast,
} from '@commander/ui';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarSwitches } from '../sections/calendar/CalendarSwitches';
import { calendarSwitchesIn } from '../sections/calendar/calendar-events';
import { AccountSync } from './AccountSync';
import {
  describeGitHubAccount,
  GitHubConnectRow,
  GitHubInstallations,
  type GitHubTokenForm,
} from './GitHubAccounts';
import { SettingRow, SettingsGroup } from './parts';

// Settings → Accounts: the User's signed-in Accounts, grouped by Source, each Source with its own
// Connect. Tokens and keys stay in the main process: the window sees Account names and their state,
// nothing more.

type Busy = null | { source: AccountSource; kind: 'oauth' | 'api-key' | 'cli' | 'remove' | 'refresh' };
// What went wrong, under the Source it's about.
type Problem = null | { source: AccountSource | null; message: string; adminConsent?: AdminConsentNeeded };
// The Linear API key form, open for a new Account or to reconnect an existing one.
type KeyForm = null | { reconnect?: AccountSummary };

// How each Source is named, and what removing one of its Accounts takes away.
const SOURCES: Record<AccountSource, { name: string; items: string }> = {
  linear: { name: 'Linear', items: 'Linear issues' },
  teams: { name: 'Microsoft Teams', items: 'Teams Chats' },
  github: { name: 'GitHub', items: 'GitHub pull requests and issues' },
  google: { name: 'Google', items: 'emails and calendar events' },
  outlook: { name: 'Outlook', items: 'emails and calendar events' },
};

// The Sources an Account can carry, as the User knows them.
const CARRIED_NAMES: Partial<Record<CarriedSource['source'], string>> = {
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  outlook: 'Outlook',
  'outlook-calendar': 'Outlook Calendar',
};

// Where the User gives the permissions of an Account carrying several Sources.
const GRANTED_IN = { google: 'Google', outlook: 'Microsoft' } as const;

const linearMethods = { oauth: 'Signed in with Linear', 'api-key': 'Personal API key' } as const;

function describeAccount(account: AccountSummary): string {
  switch (account.source) {
    case 'github':
      return describeGitHubAccount(account);
    case 'linear':
      return `Linear workspace · linear.app/${account.urlKey} · ${linearMethods[account.method]}`;
    case 'teams':
      return `Microsoft work account · ${account.user?.name ?? account.userPrincipalName} · Signed in with Microsoft`;
    case 'google':
      return `Google account · ${account.user?.name ?? account.email} · Signed in with Google`;
    case 'outlook':
      return `Microsoft account · ${account.user?.name ?? account.userPrincipalName} · Signed in with Microsoft`;
  }
}

// The Sources a Google or Outlook Account carries: each switchable, and Grant access for one whose
// permissions weren't given (signing in again for this Account asks for them). Google Calendar and
// Outlook Calendar, when on, list the Account's calendars, each with its own switch.
function CarriedSources({
  account,
  busy,
  onGrant,
  request,
}: {
  account: GoogleAccountSummary | OutlookAccountSummary;
  busy: boolean;
  onGrant: (() => void) | null;
  request: (request: AccountsRequest) => void;
}) {
  // Read at call time: the calendars live in the Item store, which the Core holds.
  const switches = useMemo(() => calendarSwitchesIn((query) => window.commander.itemStore(query)), []);
  return (
    <ul data-testid="carried-sources" className="m-0 mt-3 flex max-w-[560px] list-none flex-col gap-2 p-0">
      {account.sources.map((carried) => {
        const name = CARRIED_NAMES[carried.source] ?? carried.source;
        return (
          <li
            key={carried.source}
            data-testid={`carried-source-${carried.source}`}
            className="flex min-h-8 flex-wrap items-center gap-3"
          >
            <Switch
              aria-label={name}
              checked={carried.enabled}
              disabled={!carried.granted || busy}
              onCheckedChange={(enabled) =>
                request({ op: 'set-source-enabled', accountId: account.id, source: carried.source, enabled })
              }
            />
            <span className="min-w-[140px] text-note text-ink">{name}</span>
            {carried.granted ? (
              <span className="text-note text-muted">{carried.enabled ? 'On' : 'Off'}</span>
            ) : (
              <>
                <span className="text-note text-muted">Not allowed in {GRANTED_IN[account.source]}</span>
                <Button disabled={busy || !onGrant} onClick={() => onGrant?.()}>
                  Grant access
                </Button>
              </>
            )}
            {(carried.source === 'google-calendar' || carried.source === 'outlook-calendar') &&
              carried.enabled && (
                <CalendarSwitches
                  account={account.id}
                  switches={switches}
                  syncedAt={carried.sync?.lastSyncedAt ?? null}
                />
              )}
          </li>
        );
      })}
    </ul>
  );
}

function RemoveAccount({ account, onRemove }: { account: AccountSummary; onRemove: () => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const source = SOURCES[account.source];
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
            Commander deletes this {source.name} Account’s sign-in from the keyring and removes its{' '}
            {source.items}. Your notes and Todos stay; Links to removed {source.items} show them as gone.
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            onClick={async () => {
              // Closed either way: a failure is explained under the Source.
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

function AccountRow({
  account,
  busy,
  onReconnect,
  onRemove,
  request,
  children,
}: {
  account: AccountSummary;
  busy: boolean;
  // null: this build can't reconnect it (no app registration for its Source). Also grants access
  // to a Source the Account carries but wasn't allowed.
  onReconnect: (() => void) | null;
  onRemove: () => Promise<boolean>;
  request: (request: AccountsRequest) => void;
  // What only the Account's Source shows (GitHub: where its app is installed).
  children?: ReactNode;
}) {
  return (
    <SettingRow
      label={<span data-testid="account-name">{account.name}</span>}
      description={describeAccount(account)}
    >
      <div data-testid="account" data-account-id={account.id} className="flex flex-wrap items-center gap-4">
        <span
          data-testid="account-status"
          className="flex min-w-[170px] items-center gap-2 font-mono text-label-lg leading-none font-semibold uppercase tracking-label text-ink"
        >
          <Led size="sm" state={account.status === 'connected' ? 'muted' : 'on'} />
          {account.status === 'connected' ? 'Connected' : 'Needs reconnecting'}
        </span>
        <ButtonGroup>
          {account.status === 'needs-reconnect' && (
            <Button variant="signal" disabled={busy || !onReconnect} onClick={() => onReconnect?.()}>
              Reconnect
            </Button>
          )}
          <RemoveAccount account={account} onRemove={onRemove} />
        </ButtonGroup>
      </div>
      {children}
      {(account.source === 'google' || account.source === 'outlook') && (
        <CarriedSources account={account} busy={busy} onGrant={onReconnect} request={request} />
      )}
      <AccountSync account={account} request={request} />
    </SettingRow>
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

function WaitingForBrowser() {
  return (
    <div className="flex items-center gap-4">
      <span className="text-note text-ink" data-testid="waiting-for-browser">
        Approve Commander in your browser, then come back here.
      </span>
      <Button onClick={() => window.commander.accounts({ op: 'cancel-sign-in' })}>Cancel</Button>
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="m-0 mt-2 max-w-[560px] text-note leading-[19px] text-muted">{children}</p>
);

// The organisation needs an administrator to approve Commander: the permissions, and the link.
function AdminConsent({ needed }: { needed: AdminConsentNeeded }) {
  const link = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(needed.url);
      toast('Admin consent link copied');
    } catch {
      // No clipboard here: select it, for the User to copy.
      link.current?.select();
    }
  };
  return (
    <div data-testid="admin-consent" className="mt-3 max-w-[560px]">
      <p className="m-0 text-note leading-[19px] text-ink">Permissions to approve:</p>
      <ul
        data-testid="admin-consent-permissions"
        className="m-0 mt-1 pl-5 font-mono text-note leading-[19px]"
      >
        {needed.permissions.map((permission) => (
          <li key={permission}>{permission}</li>
        ))}
      </ul>
      <div className="mt-2 flex">
        <Input
          ref={link}
          readOnly
          aria-label="Admin consent link"
          value={needed.url}
          onFocus={(event) => event.target.select()}
        />
        <ButtonGroup className="[&>*]:border-l-0">
          <Button onClick={copy}>Copy link</Button>
        </ButtonGroup>
      </div>
    </div>
  );
}

function ProblemNote({ problem }: { problem: NonNullable<Problem> }) {
  return (
    <div
      data-testid="accounts-error"
      role="alert"
      className="m-0 mt-3 max-w-[560px] border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
    >
      {problem.message}
      {problem.adminConsent && <AdminConsent needed={problem.adminConsent} />}
    </div>
  );
}

export function AccountsPanel({ no }: { no: string }) {
  const [state, setState] = useState<AccountsState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [keyForm, setKeyForm] = useState<KeyForm>(null);
  const [githubForm, setGitHubForm] = useState<GitHubTokenForm>(null);

  useEffect(() => {
    window.commander.accounts({ op: 'list' }).then((response) => setState(response.state));
    return window.commander.onAccountsChanged(setState);
  }, []);

  async function run(source: AccountSource, kind: NonNullable<Busy>['kind'], request: AccountsRequest) {
    setBusy({ source, kind });
    setProblem(null);
    try {
      const response = await window.commander.accounts(request);
      setState(response.state);
      if (!response.ok) {
        setProblem({
          source: response.source ?? source,
          message: response.error,
          adminConsent: response.adminConsent,
        });
      }
      return response.ok;
    } finally {
      setBusy(null);
    }
  }

  const signInOf = (source: AccountSource): SourceSignIn | undefined =>
    state?.sources.find((each) => each.source === source);
  const linearOAuth = signInOf('linear')?.oauth ?? false;
  // Without an OAuth app in this build, the API key form is the way to connect Linear.
  const form: KeyForm = keyForm ?? (state && !linearOAuth ? {} : null);

  const connectWithBrowser = (source: AccountSource, reconnect?: AccountSummary) =>
    run(source, 'oauth', { op: 'connect', source, method: 'oauth', reconnect: reconnect?.id });
  const connectWithKey = async (apiKey: string) => {
    const ok = await run('linear', 'api-key', {
      op: 'connect',
      source: 'linear',
      method: 'api-key',
      apiKey,
      reconnect: form?.reconnect?.id,
    });
    if (ok) setKeyForm(null);
  };

  // Without the GitHub App in this build, the token form is the way to connect GitHub.
  const githubOAuth = signInOf('github')?.oauth ?? false;
  const githubTokenForm: GitHubTokenForm = githubForm ?? (state && !githubOAuth ? {} : null);
  const connectGitHubWith = async (method: 'api-key' | 'cli', apiKey = '') => {
    const reconnect = githubTokenForm?.reconnect?.id;
    const ok = await run(
      'github',
      method,
      method === 'cli'
        ? { op: 'connect', source: 'github', method, reconnect }
        : { op: 'connect', source: 'github', method, apiKey, reconnect },
    );
    if (ok) setGitHubForm(null);
    return ok;
  };

  const reconnectOf = (account: AccountSummary): (() => void) | null => {
    const oauth = signInOf(account.source)?.oauth ?? false;
    if (account.source === 'github' && !(account.method === 'oauth' && oauth)) {
      return () => setGitHubForm({ reconnect: account });
    }
    if (account.source === 'linear' && !(account.method === 'oauth' && oauth)) {
      return () => setKeyForm({ reconnect: account });
    }
    return oauth ? () => connectWithBrowser(account.source, account) : null;
  };

  const problemFor = (source: AccountSource) =>
    problem && (problem.source === source || (problem.source === null && source === 'linear')) ? (
      <ProblemNote problem={problem} />
    ) : null;
  const waiting = (source: AccountSource) => busy?.source === source && busy.kind === 'oauth';

  const connectRows: Record<AccountSource, (signIn: SourceSignIn) => ReactNode> = {
    linear: () => (
      <SettingRow
        label="Linear"
        description="Connect a Linear workspace. Each workspace is its own Account; connect as many as you use."
      >
        {waiting('linear') ? (
          <WaitingForBrowser />
        ) : form ? (
          <>
            {!linearOAuth && state && (
              <p className="m-0 mb-3 max-w-[560px] text-note leading-[19px] text-muted">
                This build has no Linear sign-in set up, so connect with a personal API key.
              </p>
            )}
            <ApiKeyForm
              key={form.reconnect?.id ?? 'new'}
              form={form}
              busy={busy?.kind === 'api-key'}
              canCancel={keyForm !== null && (linearOAuth || form.reconnect !== undefined)}
              onSubmit={connectWithKey}
              onCancel={() => setKeyForm(null)}
            />
          </>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              disabled={!state || busy !== null}
              onClick={() => connectWithBrowser('linear')}
            >
              Connect Linear
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setKeyForm({})}>
              Use an API key instead
            </Button>
          </div>
        )}
        {problemFor('linear')}
      </SettingRow>
    ),
    teams: (signIn) => (
      <SettingRow
        label="Microsoft Teams"
        description="Connect your Microsoft work account to bring in your Teams Chats. Each account is its own Account."
      >
        {waiting('teams') ? (
          <WaitingForBrowser />
        ) : (
          <>
            <Button
              variant="primary"
              disabled={!signIn.oauth || busy !== null}
              onClick={() => connectWithBrowser('teams')}
            >
              Connect Teams
            </Button>
            {!signIn.oauth && (
              <Note>This build has no Microsoft app set up. See “Connecting Teams” in the README.</Note>
            )}
          </>
        )}
        {problemFor('teams')}
      </SettingRow>
    ),
    github: (signIn) => (
      <GitHubConnectRow
        signIn={signIn}
        ready={state !== null}
        busy={busy !== null}
        waiting={waiting('github')}
        checking={busy?.source === 'github' && (busy.kind === 'api-key' || busy.kind === 'cli')}
        deviceCode={state?.deviceCode?.source === 'github' ? state.deviceCode : null}
        form={githubTokenForm}
        problem={problemFor('github')}
        onConnect={() => connectWithBrowser('github')}
        onCancelSignIn={() => window.commander.accounts({ op: 'cancel-sign-in' })}
        onToken={(token) => connectGitHubWith('api-key', token)}
        onCli={() => connectGitHubWith('cli')}
        onOpenForm={() => setGitHubForm({})}
        onCloseForm={() => setGitHubForm(null)}
      />
    ),
    google: (signIn) => (
      <SettingRow
        label="Google"
        description="Connect a Google account once for both Gmail and Google Calendar. Each Google account is its own Account; connect as many as you use."
      >
        {waiting('google') ? (
          <WaitingForBrowser />
        ) : signIn.oauth ? (
          <Button variant="primary" disabled={busy !== null} onClick={() => connectWithBrowser('google')}>
            Connect Google
          </Button>
        ) : (
          <Note>This build has no Google sign-in set up. See “Connecting Google” in the README.</Note>
        )}
        {problemFor('google')}
      </SettingRow>
    ),
    outlook: (signIn) => (
      <SettingRow
        label="Outlook"
        description="Connect a Microsoft account once for both Outlook mail and Outlook Calendar. Each account is its own Account; connect as many as you use."
      >
        {waiting('outlook') ? (
          <WaitingForBrowser />
        ) : signIn.oauth ? (
          <Button variant="primary" disabled={busy !== null} onClick={() => connectWithBrowser('outlook')}>
            Connect Outlook
          </Button>
        ) : (
          <Note>This build has no Microsoft app set up. See “Connecting Outlook” in the README.</Note>
        )}
        {problemFor('outlook')}
      </SettingRow>
    ),
  };

  return (
    <SettingsGroup no={no} title="Accounts" note="Sources" data-testid="accounts-panel">
      {state?.sources.map((signIn) => (
        <div key={signIn.source} data-testid={`source-${signIn.source}`} className="contents">
          {state.accounts
            .filter((account) => account.source === signIn.source)
            .map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                busy={busy !== null}
                onReconnect={reconnectOf(account)}
                onRemove={() => run(account.source, 'remove', { op: 'remove', accountId: account.id })}
                request={(request) =>
                  window.commander.accounts(request).then((response) => setState(response.state))
                }
              >
                {account.source === 'github' && (
                  <GitHubInstallations
                    account={account}
                    busy={busy !== null}
                    onCheck={() => run('github', 'refresh', { op: 'refresh-details', accountId: account.id })}
                  />
                )}
              </AccountRow>
            ))}
          {connectRows[signIn.source](signIn)}
        </div>
      ))}
    </SettingsGroup>
  );
}
