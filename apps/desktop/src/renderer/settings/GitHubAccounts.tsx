import type { DeviceCodePrompt, GitHubAccountSummary, SourceSignIn } from '@commander/domain/ipc';
import {
  Button,
  ButtonGroup,
  buttonVariants,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Input,
  toast,
} from '@commander/ui';
import { type FormEvent, type ReactNode, useState } from 'react';
import { SettingRow } from './parts';

// GitHub in Settings → Accounts: Connect GitHub (a code to enter on GitHub, for Commander's GitHub
// App), the token fallbacks (a classic personal access token, or gh's sign-in), and where the app
// is installed under each app Account. Links leave for the system browser (external-links.ts).

const signedInWith: Record<GitHubAccountSummary['signedInWith'], string> = {
  'github-app': 'Signed in with the GitHub App',
  'classic-token': 'Classic personal access token',
  gh: 'Signed in with gh',
};

export function describeGitHubAccount(account: GitHubAccountSummary): string {
  return `GitHub user · ${account.user?.name ?? account.login} · ${signedInWith[account.signedInWith]}`;
}

// A classic token with the scopes Commander needs, ready to make on GitHub.
const NEW_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Commander';

const linkButton = (variant: 'default' | 'primary' = 'default', size: 'sm' | 'default' = 'default') =>
  buttonVariants({ variant, size });

// Where Commander's GitHub App is installed, under an app Account.
export function GitHubInstallations({
  account,
  busy,
  onCheck,
}: {
  account: GitHubAccountSummary;
  busy: boolean;
  onCheck: () => void;
}) {
  if (account.installations === null) return null;
  return (
    <div
      data-testid="github-installations"
      className="mt-3 max-w-[560px] text-note leading-[19px] text-muted"
    >
      <p className="m-0">
        {account.installations.length > 0
          ? `Installed on ${account.installations.join(', ')}.`
          : 'Commander’s GitHub App isn’t installed anywhere yet, so it sees only public repositories.'}{' '}
        An org’s private repositories show once the app is installed there; if you can’t install it, an org
        owner can approve your request.
      </p>
      <div className="mt-2 flex items-center gap-3">
        {account.installUrl && (
          <a
            className={linkButton('default', 'sm')}
            href={account.installUrl}
            target="_blank"
            rel="noreferrer"
          >
            Install on another org…
          </a>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCheck}>
          Check again
        </Button>
      </div>
    </div>
  );
}

// The code to type at github.com/login/device, while Commander waits for it.
function DeviceCodeDialog({ prompt, onCancel }: { prompt: DeviceCodePrompt | null; onCancel: () => void }) {
  const copy = async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt.userCode);
      toast('Code copied');
    } catch {
      // No clipboard here: the code is on screen to type.
    }
  };
  const where = prompt ? URL.parse(prompt.verificationUri) : null;
  const until = prompt
    ? new Date(prompt.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent aria-describedby={undefined} data-testid="github-device-code">
        <DialogHeader>
          <DialogTitle>Connect GitHub</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {prompt ? (
            <>
              <DialogHeading>
                <span data-testid="github-user-code" className="font-mono tracking-[0.2em] select-all">
                  {prompt.userCode}
                </span>
              </DialogHeading>
              <DialogDescription>
                Enter this code at {where ? `${where.host}${where.pathname}` : 'GitHub'}, then approve
                Commander. It works until {until}. Commander checks with GitHub until you do.
              </DialogDescription>
            </>
          ) : (
            <DialogDescription>Asking GitHub for a code…</DialogDescription>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onCancel}>Cancel</Button>
          {prompt && (
            <>
              <Button onClick={copy}>Copy code</Button>
              <a
                className={linkButton('primary')}
                href={prompt.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                Open GitHub
              </a>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TokenForm({
  reconnect,
  busy,
  cli,
  canCancel,
  onToken,
  onCli,
  onCancel,
}: {
  reconnect?: { name: string };
  busy: boolean;
  cli: boolean;
  canCancel: boolean;
  // Resolves whether the token connected.
  onToken: (token: string) => Promise<boolean>;
  onCli: () => void;
  onCancel: () => void;
}) {
  const [token, setToken] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Once connected, the token is in the keyring: it doesn't stay on screen.
    if (await onToken(token)) setToken('');
  };
  return (
    <form onSubmit={submit} className="max-w-[560px]">
      <div className="flex">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="GitHub classic personal access token"
          placeholder="ghp_…"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={busy}
        />
        <ButtonGroup className="[&>*]:border-l-0">
          <Button type="submit" variant="primary" disabled={busy || !token.trim()}>
            {busy ? 'Checking…' : reconnect ? `Reconnect ${reconnect.name}` : 'Connect with token'}
          </Button>
          {canCancel && (
            <Button onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
        </ButtonGroup>
      </div>
      <p className="m-0 mt-2 text-note leading-[19px] text-muted">
        <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer" className="text-ink underline">
          Make a classic token
        </a>{' '}
        with the repo and read:org scopes. Commander only reads, though GitHub’s repo scope also allows
        writing. Commander keeps it in the system keyring.
      </p>
      {cli && (
        <div className="mt-3 flex items-center gap-3">
          <Button disabled={busy} onClick={onCli}>
            Use my gh sign-in
          </Button>
          <span className="text-note text-muted">Uses the token gh already holds (gh auth token).</span>
        </div>
      )}
    </form>
  );
}

// The token form, open for a new Account or to reconnect one.
export type GitHubTokenForm = null | { reconnect?: GitHubAccountSummary };

export function GitHubConnectRow({
  signIn,
  ready,
  busy,
  waiting,
  checking,
  deviceCode,
  form,
  problem,
  onConnect,
  onCancelSignIn,
  onToken,
  onCli,
  onOpenForm,
  onCloseForm,
}: {
  signIn: SourceSignIn;
  // The Accounts have loaded.
  ready: boolean;
  // Something is under way in Settings → Accounts.
  busy: boolean;
  // Connect GitHub is waiting for the code to be entered.
  waiting: boolean;
  // A token or gh's sign-in is being checked.
  checking: boolean;
  deviceCode: DeviceCodePrompt | null;
  form: GitHubTokenForm;
  problem: ReactNode;
  onConnect: () => void;
  onCancelSignIn: () => void;
  // Resolves whether the token connected.
  onToken: (token: string) => Promise<boolean>;
  onCli: () => void;
  onOpenForm: () => void;
  onCloseForm: () => void;
}) {
  return (
    <SettingRow
      label="GitHub"
      description="Connect your GitHub user to watch repositories, pull requests and issues across your orgs. Each GitHub user is its own Account."
    >
      {waiting && <DeviceCodeDialog prompt={deviceCode} onCancel={onCancelSignIn} />}
      {form ? (
        <>
          {!signIn.oauth && ready && (
            <p className="m-0 mb-3 max-w-[560px] text-note leading-[19px] text-muted">
              This build has no GitHub App set up, so connect with a token. See “Connecting GitHub” in the
              README.
            </p>
          )}
          <TokenForm
            key={form.reconnect?.id ?? 'new'}
            reconnect={form.reconnect}
            busy={checking}
            cli={signIn.cli ?? false}
            canCancel={signIn.oauth || form.reconnect !== undefined}
            onToken={onToken}
            onCli={onCli}
            onCancel={onCloseForm}
          />
        </>
      ) : (
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!ready || busy} onClick={onConnect}>
            Connect GitHub
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onOpenForm}>
            Use a token instead
          </Button>
        </div>
      )}
      {problem}
    </SettingRow>
  );
}
