// What the Core's log lines say (#207), for the events that have a shape: ids, counts, times and
// plain reasons, never what an Item says.
import type { DatabaseRecovery } from '@commander/domain';
import type { SyncRun } from '../item-store';

const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

/**
 * A sync run: "gmail sync of google:1 (scheduled): synced in 1.4 s · 3 new, 2 updated, 0 removed,
 * 40 unchanged · 5 requests", or "… (refresh): failed after 0.3 s · Gmail didn’t answer".
 */
export function syncRunLine(run: Omit<SyncRun, 'id'>): string {
  const took = seconds(run.finishedAt - run.startedAt);
  const head = `${run.source} sync of ${run.account} (${run.trigger})`;
  const counts = `${run.created} new, ${run.updated} updated, ${run.tombstoned} removed, ${run.unchanged} unchanged`;
  const requests = `${run.requests} request${run.requests === 1 ? '' : 's'}`;
  if (run.outcome === 'synced') return `${head}: synced in ${took} · ${counts} · ${requests}`;
  return `${head}: ${run.outcome} after ${took} · ${counts} · ${requests}${run.error ? ` · ${run.error}` : ''}`;
}

/** Migrations by name, a long run shortened: "0054_setting_changes, 0055_conversation_made". */
export const migrationsText = (names: readonly string[]): string =>
  names.length <= 4 ? names.join(', ') : `${names.length} migrations, ${names[0]} to ${names.at(-1)}`;

/** Why the Core stayed in its limited state (#203), in one line. */
export function recoveryLine(health: DatabaseRecovery): string {
  if (health.state === 'damaged')
    return `The database is damaged (${health.problem}); the recovery screen offers ${health.snapshot ? `the snapshot ${health.snapshot.name}` : 'no snapshot that passes the check'}`;
  return `The migration ${health.migration} failed (${health.reason}); the database is as the previous version left it, and the recovery screen offers ${health.snapshot ? `the snapshot ${health.snapshot.name}` : `no snapshot${health.snapshotProblem ? ` (${health.snapshotProblem})` : ''}`}`;
}
