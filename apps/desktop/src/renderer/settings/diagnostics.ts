import type { CoreStatus, DatabaseHealth, SyncRunInfo } from '@commander/domain';
import { clockTime } from './account-sync';

// Settings → Diagnostics in plain words (#207): how the Core and the database are doing, and what
// each sync run did.

// The Core counts as not answering once its heartbeat (every second) is this late.
export const LATE_BEAT_MS = 5_000;

export type CoreHealth = {
  // One or two words: "Healthy", "Not answering".
  word: string;
  // Well: the lamp is lit. Otherwise `detail` says what is wrong and what happens next.
  well: boolean;
  detail: string | null;
};

/**
 * Whether the Core is healthy, from its status and when its heartbeat was last heard (null: not since
 * this page opened).
 */
export function coreHealth(status: CoreStatus | null, lastBeatAt: number | null, now: number): CoreHealth {
  if (!status) return { word: '…', well: false, detail: null };
  if (status.state === 'stopped')
    return {
      word: 'Stopped',
      well: false,
      detail:
        'It stopped several times in a few minutes, so Commander stopped starting it. Try again from the banner.',
    };
  if (status.state === 'restarting')
    return {
      word: 'Starting again',
      well: false,
      detail: status.restartAt
        ? `It stopped; a new one starts at ${clockTime(status.restartAt, new Date(now))}.`
        : 'It stopped; a new one is starting.',
    };
  if (status.database?.state === 'damaged' || status.database?.state === 'update-failed')
    return { word: 'Limited', well: false, detail: 'It couldn’t open the database, so only recovery runs.' };
  if (lastBeatAt === null) return { word: 'Starting', well: false, detail: null };
  if (now - lastBeatAt > LATE_BEAT_MS)
    return {
      word: 'Not answering',
      well: false,
      detail: `No heartbeat for ${Math.round((now - lastBeatAt) / 1000)} s. Commander ends a Core silent for 15 s and starts a new one.`,
    };
  return { word: 'Healthy', well: true, detail: null };
}

/** The database's health (#203), in words: "Healthy", "Disk full since 14:02", … */
export function databaseText(health: DatabaseHealth | null | undefined, now: Date): string {
  if (!health) return '…';
  switch (health.state) {
    case 'ok':
      return 'Healthy';
    case 'disk-full':
      return `Disk full since ${clockTime(health.since, now)}`;
    case 'damaged':
      return 'Damaged';
    case 'update-failed':
      return `Update failed (${health.migration})`;
  }
}

const OUTCOME_WORDS: Record<SyncRunInfo['outcome'], string> = {
  synced: 'Synced',
  failed: 'Failed',
  refused: 'Sign-in refused',
  'rate-limited': 'Rate limited',
};

const TRIGGER_WORDS: Record<SyncRunInfo['trigger'], string> = {
  scheduled: 'on schedule',
  refresh: 'asked for',
  alongside: 'alongside another',
  resync: 're-sync',
};

/** A sync run in words: "Synced on schedule · 3 new, 2 updated", or "Failed asked for · Linear didn’t answer". */
export function runText(run: SyncRunInfo): { outcome: string; what: string } {
  const changes = [
    run.created && `${run.created} new`,
    run.updated && `${run.updated} updated`,
    run.tombstoned && `${run.tombstoned} removed`,
  ].filter(Boolean);
  return {
    outcome: OUTCOME_WORDS[run.outcome],
    what: `${TRIGGER_WORDS[run.trigger]} · ${run.outcome === 'synced' ? changes.join(', ') || 'nothing new' : (run.error ?? 'no reason given')}`,
  };
}
