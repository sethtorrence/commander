import {
  type GitHubOrgAccess,
  type GitHubRepo,
  type GitHubRepoRef,
  type GitHubUnwatchConfirm,
  type GitHubWatch,
  type GitHubWatchView,
  isWatched,
  orgWatchedWhole,
  setOrgWatched,
  setRepoWatched,
  unreachableWatched,
  watchSummary,
} from '@commander/domain';
import type { AccountSummary, GitHubAccountSummary } from '@commander/domain/ipc';
import {
  Button,
  buttonVariants,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@commander/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { SettingRow, SettingsGroup } from '../parts';
import { SettingsLink } from '../SettingsLink';
import { OversightSettings } from './OversightSettings';
import { RepoProjectsCell, RepoProjectsProvider } from './RepoProjects';

// Settings → GitHub (#113): per GitHub Account, the orgs and repos it can reach, and which of them
// Commander watches. Orgs come as groups with Watch whole org (repos made there later included),
// each repo with a checkbox; personal repos have their own group. Changes save at once; unwatching
// repos that have Items in Commander asks first. Each watched repo shows the Project its own Rule
// files it into, with Map to Project… (#118, RepoProjects.tsx). The Core does the asking of GitHub
// and the keeping (see apps/core/src/github-watch); the selection model is the domain's
// github-watch.ts.

const isGitHub = (account: AccountSummary): account is GitHubAccountSummary => account.source === 'github';

const DAY = 86_400_000;

function pushedLabel(pushedAt: number | null, now: number): string {
  if (pushedAt === null) return 'empty';
  const days = Math.floor((now - pushedAt) / DAY);
  if (days < 1) return 'pushed today';
  if (days === 1) return 'pushed yesterday';
  if (days < 30) return `pushed ${days} days ago`;
  const date = new Date(pushedAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `pushed ${date}`;
}

const fullName = (repo: GitHubRepoRef) => `${repo.owner}/${repo.name}`;

function RepoRow({
  repo,
  watched,
  busy,
  now,
  onChange,
}: {
  repo: GitHubRepo;
  watched: boolean;
  busy: boolean;
  now: number;
  onChange: (watched: boolean) => void;
}) {
  return (
    <li
      data-testid={`github-repo-${fullName(repo)}`}
      className="flex items-center gap-3 border-b border-line2 py-1.5 last:border-b-0"
    >
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
        <input
          type="checkbox"
          aria-label={fullName(repo)}
          checked={watched}
          disabled={busy}
          onChange={(event) => onChange(event.target.checked)}
          className="size-3.5 shrink-0 accent-signal"
        />
        <span className="truncate font-mono text-label-lg text-ink">{repo.name}</span>
      </label>
      {watched && <RepoProjectsCell repo={repo} />}
      <span className="shrink-0 font-mono text-label uppercase tracking-tag text-muted">
        {repo.visibility}
      </span>
      <span className="w-36 shrink-0 text-right text-note text-muted">{pushedLabel(repo.pushedAt, now)}</span>
    </li>
  );
}

function OrgGroup({
  org,
  repos,
  watch,
  installUrl,
  busy,
  now,
  onWatch,
}: {
  org: GitHubOrgAccess;
  // Its repos that match the search.
  repos: GitHubRepo[];
  watch: GitHubWatch;
  installUrl: string | null;
  busy: boolean;
  now: number;
  onWatch: (next: GitHubWatch) => void;
}) {
  const whole = orgWatchedWhole(watch, org.login);
  const installHere =
    installUrl && org.id !== null ? `${installUrl}/permissions?target_id=${org.id}` : installUrl;
  return (
    <section data-testid={`github-org-${org.login}`} className="mt-4 first:mt-0">
      <div className="flex items-center gap-3 border-b border-line pb-1.5">
        <h3 className="m-0 font-sans text-row font-semibold text-ink">{org.login}</h3>
        {org.reach !== 'not-installed' && (
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-note text-ink">
            <input
              type="checkbox"
              aria-label="Watch whole org"
              checked={whole}
              disabled={busy}
              onChange={(event) => onWatch(setOrgWatched(watch, org.login, event.target.checked))}
              className="size-3.5 accent-signal"
            />
            Watch whole org
          </label>
        )}
      </div>
      {whole && (
        <p className="m-0 mt-1.5 text-note text-muted">
          Watching every repo here, repos made here later too, except those you uncheck.
        </p>
      )}
      {org.reach === 'not-installed' && (
        <div className="mt-2 flex items-center gap-3 text-note text-muted">
          <span>Commander isn’t installed here.</span>
          {installHere && (
            <a className={buttonVariants({ size: 'sm' })} href={installHere} target="_blank" rel="noreferrer">
              Install or request…
            </a>
          )}
        </div>
      )}
      {org.problem && <p className="m-0 mt-1.5 text-note text-signal-ink">{org.problem}</p>}
      {repos.length > 0 && (
        <ul className="m-0 mt-1 list-none p-0">
          {repos.map((repo) => (
            <RepoRow
              key={repo.nodeId}
              repo={repo}
              watched={isWatched(watch, repo)}
              busy={busy}
              now={now}
              onChange={(watched) => onWatch(setRepoWatched(watch, repo, watched))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConfirmUnwatch({
  confirm,
  onCancel,
  onConfirm,
}: {
  confirm: GitHubUnwatchConfirm;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const names = confirm.repos.map(fullName);
  const which =
    names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  const items = `${confirm.items} ${confirm.items === 1 ? 'Item' : 'Items'}`;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="github-unwatch-confirm">
        <DialogHeader>
          <DialogTitle>Stop watching {which}?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            This removes {items} from Commander. Your notes and Todos stay; their Links will show these Items
            as gone.
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onCancel}>Keep watching</Button>
          <Button variant="primary" onClick={onConfirm}>
            Remove {items}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddOrg({ busy, onAdd }: { busy: boolean; onAdd: (login: string) => Promise<boolean> }) {
  const [login, setLogin] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onAdd(login.trim())) setLogin('');
  };
  return (
    <form onSubmit={submit} className="mt-4 max-w-[420px]">
      <div className="flex">
        <Input
          aria-label="Org name"
          placeholder="An org that isn’t listed"
          spellCheck={false}
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          disabled={busy}
        />
        <Button type="submit" className="border-l-0" disabled={busy || !login.trim()}>
          Add org
        </Button>
      </div>
      <p className="m-0 mt-1.5 text-note text-muted">
        Add an org GitHub didn’t list, such as one where Commander isn’t installed yet.
      </p>
    </form>
  );
}

function AccountWatch({ account, now }: { account: GitHubAccountSummary; now: () => number }) {
  const [view, setView] = useState<GitHubWatchView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<{ watch: GitHubWatch; confirm: GitHubUnwatchConfirm } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const response = await window.commander.githubWatch({ op: 'load', account: account.id });
    setBusy(false);
    if (response.view) setView(response.view);
    setProblem(response.ok ? null : response.error);
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (watch: GitHubWatch, confirmed = false) => {
    setBusy(true);
    // Shown at once; the Core's answer (the old selection, when it asks first) replaces it.
    setView((current) => current && { ...current, watch });
    const response = await window.commander.githubWatch({
      op: 'save',
      account: account.id,
      watch,
      ...(confirmed ? { confirmed } : {}),
    });
    setBusy(false);
    if (response.view) setView(response.view);
    if (!response.ok) return setProblem(response.error);
    setProblem(null);
    if (response.confirm) setPending({ watch, confirm: response.confirm });
  };

  const addOrg = async (login: string) => {
    setBusy(true);
    const response = await window.commander.githubWatch({ op: 'add-org', account: account.id, login });
    setBusy(false);
    if (response.view) setView(response.view);
    setProblem(response.ok ? null : response.error);
    return response.ok;
  };

  const access = view?.access ?? null;
  // While unwatching waits to be confirmed, the page shows the change asked for.
  const watch = pending?.watch ?? view?.watch ?? { orgs: [], repos: [] };
  const query = search.trim().toLowerCase();
  const matching = (repos: GitHubRepo[]) =>
    query ? repos.filter((repo) => fullName(repo).toLowerCase().includes(query)) : repos;
  const lost = access ? unreachableWatched(watch, access) : { repos: [], orgs: [] };
  const shownProblem = problem ?? view?.problem ?? null;

  return (
    <SettingRow
      label={account.login}
      description={
        account.signedInWith === 'github-app'
          ? 'Through Commander’s GitHub App: the orgs it is installed on, and your own repos.'
          : 'Through your token: every org and repo it can reach.'
      }
    >
      <div data-testid="github-watch-account" className="max-w-[820px]">
        {view === null && !shownProblem && (
          <p className="m-0 text-note text-muted">Asking GitHub what this Account can reach…</p>
        )}
        {shownProblem && <p className="m-0 mb-2 text-note text-signal-ink">{shownProblem}</p>}
        {access && (
          <>
            <div className="flex items-center gap-3">
              <p data-testid="github-watch-summary" className="m-0 flex-1 text-row font-semibold text-ink">
                {watchSummary(watch, access)}
              </p>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
                Check again
              </Button>
            </div>
            {view?.fromDefault && (
              <p className="m-0 mt-1 text-note text-muted">
                Commander started with the repos you pushed to, opened pull requests in or reviewed in the
                last 90 days. Change anything below; it saves at once.
              </p>
            )}
            <Input
              type="search"
              aria-label="Search repos"
              placeholder="Search repos"
              className="mt-3 max-w-[420px]"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="mt-3">
              {access.orgs.map((org) => {
                const repos = matching(org.repos);
                const nameMatches = !query || org.login.toLowerCase().includes(query);
                if (query && repos.length === 0 && !nameMatches) return null;
                return (
                  <OrgGroup
                    key={org.login}
                    org={org}
                    repos={repos}
                    watch={watch}
                    installUrl={account.installUrl}
                    busy={busy}
                    now={now()}
                    onWatch={(next) => void save(next)}
                  />
                );
              })}
              {matching(access.personal).length > 0 && (
                <section data-testid="github-personal" className="mt-4">
                  <h3 className="m-0 border-b border-line pb-1.5 font-sans text-row font-semibold text-ink">
                    Personal repos
                  </h3>
                  <ul className="m-0 mt-1 list-none p-0">
                    {matching(access.personal).map((repo) => (
                      <RepoRow
                        key={repo.nodeId}
                        repo={repo}
                        watched={isWatched(watch, repo)}
                        busy={busy}
                        now={now()}
                        onChange={(watched) => void save(setRepoWatched(watch, repo, watched))}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </div>
            {(lost.repos.length > 0 || lost.orgs.length > 0) && (
              <section data-testid="github-unreachable" className="mt-4">
                <h3 className="m-0 border-b border-line pb-1.5 font-sans text-row font-semibold text-ink">
                  Watched, but out of reach
                </h3>
                <p className="m-0 mt-1.5 text-note text-muted">
                  Commander can’t reach these now: the app was uninstalled, your access ended, or the repo was
                  archived. They stay watched in case access comes back; their Items stay until you unwatch
                  them.
                </p>
                <ul className="m-0 mt-1 list-none p-0">
                  {lost.orgs.map((login) => (
                    <li key={login} className="flex items-center gap-3 border-b border-line2 py-1.5">
                      <span className="flex-1 font-mono text-label-lg text-ink">{login} (whole org)</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Unwatch ${login}`}
                        onClick={() => void save(setOrgWatched(watch, login, false))}
                      >
                        Unwatch
                      </Button>
                    </li>
                  ))}
                  {lost.repos.map((repo) => (
                    <li key={repo.nodeId} className="flex items-center gap-3 border-b border-line2 py-1.5">
                      <span className="flex-1 font-mono text-label-lg text-ink">{fullName(repo)}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Unwatch ${fullName(repo)}`}
                        onClick={() => void save(setRepoWatched(watch, repo, false))}
                      >
                        Unwatch
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        {view && <AddOrg busy={busy} onAdd={addOrg} />}
      </div>
      {pending && (
        <ConfirmUnwatch
          confirm={pending.confirm}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { watch: next } = pending;
            setPending(null);
            void save(next, true);
          }}
        />
      )}
    </SettingRow>
  );
}

/** Settings → GitHub: what Commander watches, per GitHub Account, and the Project each repo maps to. */
export function GitHubWatchPanel({
  no,
  now = Date.now,
  itemStore = window.commander.itemStore,
}: {
  no: string;
  now?: () => number;
  itemStore?: ItemStoreClient;
}) {
  const [accounts, setAccounts] = useState<GitHubAccountSummary[] | null>(null);

  useEffect(() => {
    let live = true;
    const show = (all: AccountSummary[]) => live && setAccounts(all.filter(isGitHub));
    void window.commander.accounts({ op: 'list' }).then((response) => show(response.state.accounts));
    const stop = window.commander.onAccountsChanged((state) => show(state.accounts));
    return () => {
      live = false;
      stop();
    };
  }, []);

  return (
    <SettingsGroup no={no} title="GitHub" note="What Commander watches" data-testid="github-watch">
      {accounts !== null && accounts.length === 0 && (
        <SettingRow label="Repositories" description="Orgs and repos Commander watches for you.">
          <p className="m-0 text-note text-muted">
            Connect a GitHub Account in <SettingsLink to={{ group: 'accounts' }}>Accounts</SettingsLink>, then
            choose the orgs and repos to watch here.
          </p>
        </SettingRow>
      )}
      <RepoProjectsProvider itemStore={itemStore}>
        {accounts?.map((account) => (
          <AccountWatch key={account.id} account={account} now={now} />
        ))}
      </RepoProjectsProvider>
      <OversightSettings />
    </SettingsGroup>
  );
}
