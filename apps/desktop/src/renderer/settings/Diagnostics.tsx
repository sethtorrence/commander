import type {
  AccountSummary,
  AccountSyncStatus,
  Diagnostics as DiagnosticsInfo,
  DiagnosticsReport,
} from '@commander/domain';
import { Button, cn, Led } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useCoreStatus } from '../frame/CoreBanner';
import { useNow } from '../frame/use-now';
import { clockTime, describeSync } from './account-sync';
import { dayLabel, problemText, useBackups } from './DataSettings';
import { coreHealth, databaseText, runText } from './diagnostics';
import { Readout, ReadoutRow, SettingRow, SettingsGroup } from './parts';

/*
  Settings → Diagnostics (#207): how Commander is doing, in plain words. Whether the Core is healthy
  (from its status and heartbeat) and its restarts (#200); the database (#203); each Account's last
  successful sync and next one, with any changes that couldn't sync (#206); recent sync runs and their errors; snapshots (#202); versions and how
  the window reaches the screen. Export diagnostics writes the log, versions and the settings that
  aren't secret to a file the User picks, to attach to an issue.
*/

const SOURCE_NAMES: Record<AccountSyncStatus['source'], string> = {
  linear: 'Linear',
  github: 'GitHub',
  teams: 'Teams',
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  outlook: 'Outlook',
  'outlook-calendar': 'Outlook Calendar',
};

// Recent runs the page lists (the export has more).
const RUNS_SHOWN = 10;

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

// How the Core's restarts read (#200): how many, and when and why it last stopped.
function restartsText(status: ReturnType<typeof useCoreStatus>): string {
  if (!status) return '…';
  const { restarts, lastStop } = status;
  if (!lastStop) return 'None';
  const why =
    lastStop.reason === 'unresponsive'
      ? 'stopped answering'
      : `exited${lastStop.code !== null ? ` (code ${lastStop.code})` : ''}`;
  return `${restarts} · last ${why} at ${hhmm(lastStop.at)}`;
}

// Each Source an Account syncs, with the Account's name.
function syncRows(accounts: AccountSummary[]): { key: string; name: string; status: AccountSyncStatus }[] {
  return accounts.flatMap((account) => {
    const statuses =
      'sources' in account
        ? account.sources.flatMap((carried) => (carried.enabled && carried.sync ? [carried.sync] : []))
        : account.sync
          ? [account.sync]
          : [];
    return statuses.map((status) => ({ key: `${account.id}:${status.source}`, name: account.name, status }));
  });
}

/** The Accounts, as Settings → Accounts has them, kept up to date. */
function useAccounts(): AccountSummary[] | null {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  useEffect(() => {
    let current = true;
    window.commander.accounts({ op: 'list' }).then(
      (response) => current && setAccounts(response.state.accounts),
      () => {},
    );
    const stop = window.commander.onAccountsChanged((state) => current && setAccounts(state.accounts));
    return () => {
      current = false;
      stop();
    };
  }, []);
  return accounts;
}

/** The Core's report (recent sync runs, the database's version), asked again as syncs finish. */
function useReport() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const ask = useCallback(async () => {
    const response = await window.commander.diagnosticsReport({ op: 'report' }).catch(() => null);
    if (response?.report) setReport(response.report);
  }, []);

  useEffect(() => {
    void ask();
    const stopAccounts = window.commander.onAccountsChanged(() => void ask());
    const stopCore = window.commander.onCoreMessage((message) => {
      if (message.type === 'core-restarted') void ask();
    });
    return () => {
      stopAccounts();
      stopCore();
    };
  }, [ask]);

  const exportDiagnostics = useCallback(async () => {
    setExporting(true);
    setFailed(null);
    try {
      const response = await window.commander.diagnosticsReport({ op: 'export' });
      if (response.report) setReport(response.report);
      if (!response.ok) setFailed(response.error);
      else if (response.exported) setExported(response.exported);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }, []);

  return { report, exporting, exported, failed, exportDiagnostics };
}

/** When the Core's heartbeat was last heard, and how many it has sent. */
function useHeartbeat() {
  const [beat, setBeat] = useState<{ at: number; beats: number } | null>(null);
  useEffect(
    () =>
      window.commander.onCoreMessage((message) => {
        if (message.type === 'heartbeat') setBeat({ at: Date.now(), beats: message.beats });
      }),
    [],
  );
  return beat;
}

function Notice({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      data-testid={testId}
      role="alert"
      className="m-0 mt-3 max-w-[560px] border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
    >
      {children}
    </p>
  );
}

function Empty({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p data-testid={testId} className="m-0 text-note text-muted">
      {children}
    </p>
  );
}

export function Diagnostics({ no }: { no: string }) {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const core = useCoreStatus(window.commander);
  const beat = useHeartbeat();
  const now = useNow(1_000);
  const accounts = useAccounts();
  const { report, exporting, exported, failed, exportDiagnostics } = useReport();
  const backups = useBackups().status;
  const latestDaily = backups?.snapshots.find((snapshot) => snapshot.kind === 'daily') ?? null;
  const snapshotProblem = backups?.problems[0] ?? null;
  const health = coreHealth(core, beat?.at ?? null, now.getTime());
  const rows = accounts ? syncRows(accounts) : null;
  const names = new Map((accounts ?? []).map((account) => [account.id, account.name]));
  const runs = report?.runs.slice(0, RUNS_SHOWN) ?? null;

  useEffect(() => {
    window.commander.diagnostics().then(setInfo, () => {});
  }, []);

  return (
    <SettingsGroup
      no={no}
      title="Diagnostics"
      note={info ? `Commander ${info.version}` : '…'}
      data-testid="diagnostics"
    >
      <SettingRow
        label="Core"
        description="The background process that keeps Commander running behind the window, and the database it keeps."
      >
        <Readout>
          <ReadoutRow label="Health" live={health.well}>
            {health.well && <Led size="sm" />}
            <span
              data-testid="core-health"
              data-beats={beat?.beats ?? ''}
              className="normal-case tracking-normal"
            >
              {health.word}
            </span>
          </ReadoutRow>
          <ReadoutRow label="Restarts">
            <span data-testid="core-restarts">{restartsText(core)}</span>
          </ReadoutRow>
          <ReadoutRow label="Database">
            <span data-testid="diagnostics-database" className="normal-case tracking-normal">
              {databaseText(core?.database, now)}
            </span>
          </ReadoutRow>
          <ReadoutRow label="Database version">
            <span data-testid="diagnostics-migration" className="normal-case tracking-normal">
              {report?.database.migration ?? '…'}
            </span>
          </ReadoutRow>
        </Readout>
        {health.detail && <Notice testId="core-health-detail">{health.detail}</Notice>}
      </SettingRow>

      <SettingRow
        label="Accounts"
        description="Each Account’s last successful sync and its next one, and changes that couldn’t sync (Settings → Accounts lists them)."
      >
        <div className="max-w-[560px]">
          {!rows ? (
            <Empty testId="diagnostics-accounts-loading">…</Empty>
          ) : rows.length === 0 ? (
            <Empty testId="diagnostics-no-accounts">No Accounts yet.</Empty>
          ) : (
            <ul className="m-0 list-none border-t border-line p-0" aria-label="Accounts’ syncing">
              {rows.map(({ key, name, status }) => {
                const said = describeSync(status, now);
                const stuck = report?.couldntSync.find(
                  (each) => each.account === status.account && each.source === status.source,
                );
                return (
                  <li
                    key={key}
                    data-testid="diagnostics-account"
                    data-account={status.account}
                    data-source={status.source}
                    className="border-b border-line2 py-[7px] text-note leading-[19px]"
                  >
                    <div className="flex gap-3">
                      <span className="min-w-0 flex-1 truncate font-semibold text-ink">
                        {name} · {SOURCE_NAMES[status.source]}
                      </span>
                      <span data-testid="diagnostics-account-synced" className="text-muted tabular-nums">
                        {said.synced}
                      </span>
                    </div>
                    <div className="flex gap-3">
                      <span data-testid="diagnostics-account-next" className="flex-1 text-muted tabular-nums">
                        {said.next}
                      </span>
                      {said.problem && (
                        <span data-testid="diagnostics-account-problem" className="text-signal-ink">
                          {said.problem}
                        </span>
                      )}
                    </div>
                    {stuck && (
                      <div data-testid="diagnostics-account-couldnt-sync" className="text-signal-ink">
                        Couldn’t sync: {stuck.count} change{stuck.count === 1 ? '' : 's'}
                        {stuck.error ? ` · ${stuck.error}` : ''}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SettingRow>

      <SettingRow
        label="Recent syncs"
        description="What the latest sync runs did, and why any didn’t finish."
      >
        <div className="max-w-[560px]">
          {!runs ? (
            <Empty testId="diagnostics-runs-loading">…</Empty>
          ) : runs.length === 0 ? (
            <Empty testId="diagnostics-no-runs">None yet.</Empty>
          ) : (
            <ul className="m-0 list-none border-t border-line p-0" aria-label="Recent syncs">
              {runs.map((run, index) => {
                const said = runText(run);
                const failedRun = run.outcome !== 'synced';
                return (
                  <li
                    // Runs have no id here; the list is newest first and replaced whole.
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above
                    key={index}
                    data-testid="diagnostics-run"
                    data-outcome={run.outcome}
                    className="flex gap-3 border-b border-line2 py-[7px] text-note leading-[19px]"
                  >
                    <span className="w-[86px] shrink-0 text-muted tabular-nums">
                      {clockTime(run.startedAt, now)}
                    </span>
                    <span className="w-[150px] shrink-0 truncate text-ink">
                      {names.get(run.account) ?? run.account} · {SOURCE_NAMES[run.source]}
                    </span>
                    <span className={cn('min-w-0 flex-1', failedRun ? 'text-signal-ink' : 'text-muted')}>
                      <span className="font-semibold">{said.outcome}</span> {said.what}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SettingRow>

      <SettingRow label="Snapshots" description="The daily copies of the database (Settings → Data).">
        <Readout>
          <ReadoutRow label="Latest daily" live={!!snapshotProblem}>
            {snapshotProblem && <Led size="sm" />}
            <span data-testid="diagnostics-snapshot" className="normal-case tracking-normal">
              {!backups
                ? '…'
                : snapshotProblem
                  ? 'Failed'
                  : latestDaily
                    ? dayLabel(latestDaily.day)
                    : 'None yet'}
            </span>
          </ReadoutRow>
          <ReadoutRow label="Kept">
            <span data-testid="diagnostics-snapshots-kept">{backups ? backups.snapshots.length : '…'}</span>
          </ReadoutRow>
        </Readout>
        {snapshotProblem && (
          <Notice testId="diagnostics-snapshot-problem">{problemText(snapshotProblem)}</Notice>
        )}
      </SettingRow>

      <SettingRow
        label="Versions"
        description="Commander and what it runs on, and how the window reaches the screen."
      >
        <Readout>
          <ReadoutRow label="Commander">
            <span data-testid="diagnostics-version">{info?.version ?? '…'}</span>
          </ReadoutRow>
          <ReadoutRow label="Electron">{info?.electron ?? '…'}</ReadoutRow>
          <ReadoutRow label="Chrome · Node">{info ? `${info.chrome} · ${info.node}` : '…'}</ReadoutRow>
          <ReadoutRow label="System">
            <span className="normal-case tracking-normal">{info?.os ?? '…'}</span>
          </ReadoutRow>
          <ReadoutRow label="Display">
            <span data-testid="display-server">{info?.displayServer ?? '…'}</span>
            <span className="font-medium text-muted">
              (<span data-testid="display-source">{info?.displaySource ?? '…'}</span>)
            </span>
          </ReadoutRow>
          <ReadoutRow label="Password store">
            <span data-testid="password-store">{info?.passwordStore ?? '…'}</span>
          </ReadoutRow>
        </Readout>
      </SettingRow>

      <SettingRow
        label="Export diagnostics"
        description="The log, versions and the settings that aren’t secret, in a file you choose, to attach to an issue. Never your sign-ins, tokens or keys, your email or what your Items say."
      >
        <div data-testid="diagnostics-export" className="max-w-[560px]">
          <Button disabled={exporting} onClick={() => void exportDiagnostics()}>
            Export diagnostics…
          </Button>
          {exported && (
            <p
              data-testid="diagnostics-exported"
              className="m-0 mt-3 border-l-2 border-line py-0.5 pl-3.5 text-note leading-[19px] text-muted"
            >
              Exported to <code className="font-mono break-all text-ink">{exported}</code>
            </p>
          )}
          {failed && <Notice testId="diagnostics-export-failed">{failed}</Notice>}
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}
