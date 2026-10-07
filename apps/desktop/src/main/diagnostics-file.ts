// Export diagnostics (#207): the file the User attaches to an issue, in Markdown. Versions, how the
// Core and the database are doing, each Account's syncing, changes that couldn't sync (counted),
// recent sync runs, snapshots, the settings that aren't secret and the log's newest lines.
//
// Never a token, a key, email text or Item content: nothing here reads an Item (the Core's report
// holds ids, counts, times and plain reasons), the log was blanked as it was written, and the whole
// file is blanked again line by line (blankExport) before the Core checks it for any token or key it
// holds (diagnostics-channel.ts).

import { migrationsText } from '@commander/core/src/logs/lines';
import { withoutHome } from '@commander/core/src/logs/log-file';
import { blankCredentials } from '@commander/core/src/safety/credentials';
import type { CoreStatus, Diagnostics, DiagnosticsReport } from '@commander/domain';

// The log's newest lines the export carries.
export const EXPORTED_LOG_LINES = 2000;

const iso = (at: number | null) => (at === null ? '—' : new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'));

// A table cell: one line, no pipes to break the table.
const cell = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? '—' : String(value).replace(/[|\r\n]+/g, ' ');

function table(head: string[], rows: (string | number | null | undefined)[][]): string[] {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
}

function coreLines(core: CoreStatus | null): string[] {
  if (!core) return ['- State: unknown'];
  const stop = core.lastStop
    ? `${core.lastStop.reason === 'unresponsive' ? 'stopped answering' : `exited (code ${core.lastStop.code ?? '?'})`} at ${iso(core.lastStop.at)}`
    : 'none';
  const database = core.database;
  const health = !database
    ? 'not reported yet'
    : database.state === 'ok'
      ? 'ok'
      : database.state === 'disk-full'
        ? `disk full since ${iso(database.since)}`
        : database.state === 'damaged'
          ? `damaged: ${database.problem}`
          : `update failed: ${database.migration}: ${database.reason}`;
  return [
    `- State: ${core.state}${core.restartAt ? ` (next start ${iso(core.restartAt)})` : ''}`,
    `- Restarts since Commander started: ${core.restarts}`,
    `- Last stop: ${stop}`,
    `- Database: ${health}`,
  ];
}

/** The export's text, before blankExport. `logs`: the log's lines, oldest first. */
export function diagnosticsFile({
  at,
  about,
  core,
  report,
  logs,
}: {
  at: number;
  about: Diagnostics;
  core: CoreStatus | null;
  // Null while the Core is down or didn't answer: the export says so and carries the rest.
  report: DiagnosticsReport | null;
  logs: readonly string[];
}): string {
  const lines: string[] = [
    '# Commander diagnostics',
    '',
    `Exported ${iso(at)}. No sign-in tokens, API keys, email text or Item content: Accounts and Items appear by id, and anything shaped like a credential is blanked as [removed].`,
    '',
    '## Versions',
    '',
    `- Commander ${about.version}`,
    `- Electron ${about.electron} · Chrome ${about.chrome} · Node ${about.node}`,
    `- ${about.os}`,
    `- Display: ${about.displayServer} (${about.displaySource}) · Password store: ${about.passwordStore}`,
    `- Database: ${report?.database.migration ?? 'unknown'}${report?.database.migrated.length ? ` (this start ran ${migrationsText(report.database.migrated)})` : ''}`,
    '',
    '## Core',
    '',
    ...coreLines(core),
    '',
  ];
  if (!report) {
    lines.push('The Core didn’t answer, so Accounts, sync runs, snapshots and settings are missing.', '');
  } else {
    lines.push('## Accounts', '');
    if (!report.syncs.length) lines.push('No Accounts.');
    else
      lines.push(
        ...table(
          ['Account', 'Source', 'Doing', 'Every', 'Last synced', 'Next sync', 'Waiting / failed', 'Problem'],
          report.syncs.map((sync) => [
            sync.account,
            sync.source,
            sync.activity,
            `${sync.cadenceMinutes} min`,
            iso(sync.lastSyncedAt),
            iso(sync.nextSyncAt),
            `${sync.outgoing.pending} / ${sync.outgoing.failed}`,
            sync.problem ? `${sync.problem.kind}: ${sync.problem.message}` : null,
          ]),
        ),
      );
    lines.push('', '## Couldn’t sync', '');
    if (!report.couldntSync.length) lines.push('Nothing.');
    for (const stuck of report.couldntSync)
      lines.push(
        `- ${stuck.account} (${stuck.source}): ${stuck.count} change${stuck.count === 1 ? '' : 's'}${stuck.error ? `; the latest: ${stuck.error}` : ''}`,
      );
    lines.push('', '## Recent sync runs', '');
    if (!report.runs.length) lines.push('None yet.');
    else
      lines.push(
        ...table(
          [
            'Started',
            'Account',
            'Source',
            'Why',
            'Outcome',
            'Took',
            'New',
            'Updated',
            'Removed',
            'Requests',
            'Error',
          ],
          report.runs.map((run) => [
            iso(run.startedAt),
            run.account,
            run.source,
            run.trigger,
            run.outcome,
            `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)} s`,
            run.created,
            run.updated,
            run.tombstoned,
            run.requests,
            run.error,
          ]),
        ),
      );
    lines.push('', '## Snapshots', '');
    if (!report.snapshots.length) lines.push('None yet.');
    for (const snapshot of report.snapshots)
      lines.push(
        `- ${snapshot.name} (${snapshot.kind}, ${Math.max(1, Math.round(snapshot.size / 1024))} KB)`,
      );
    for (const problem of report.snapshotProblems)
      lines.push(`- Failed: the ${problem.kind} snapshot at ${iso(problem.at)}: ${problem.reason}`);
    lines.push('', '## Settings', '', '```json', JSON.stringify(report.settings, null, 2), '```');
  }
  lines.push(
    '',
    `## Log (the newest ${EXPORTED_LOG_LINES} lines)`,
    '',
    '```',
    ...(logs.length ? logs.slice(-EXPORTED_LOG_LINES) : ['(empty)']),
    '```',
    '',
  );
  return lines.join('\n');
}

/** The export's lines, each with anything shaped like a credential blanked, the home folder as ~. */
export const blankExport = (text: string): string[] =>
  text.split('\n').map((line) => withoutHome(blankCredentials(line)));
