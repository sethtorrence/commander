// Update lines about Commander's backups (#202): a snapshot of the database that failed, or a restore
// that couldn't be made. Facts about the User's data, so they stay in Commander's own words.
import type { LineKind } from './types';
import { clock, dayWord, sentence } from './words';

const WHAT = {
  'daily-snapshot': 'Today’s snapshot of the database',
  'update-snapshot': 'The snapshot before this update',
  restore: 'The restore you asked for',
} as const;

export const backupLines: LineKind<'backup-failed'> = {
  name: 'a backup that failed',
  template({ about }, context) {
    const when = `${clock(about.at)} ${dayWord(about.at, context.now)}`;
    const reason = sentence(about.reason);
    if (about.what === 'restore')
      return `${WHAT.restore} couldn’t be made at ${when}, so your database is as it was. ${reason} See Settings → Data.`;
    const next =
      about.what === 'daily-snapshot'
        ? 'Commander tries again every hour'
        : 'the update went ahead, and the daily snapshots carry on';
    return `${WHAT[about.what]} failed at ${when} and was discarded; the older snapshots are all kept. ${reason} ${next[0]?.toUpperCase()}${next.slice(1)}. See Settings → Data.`;
  },
  facts: ({ about }, context) => [
    `What failed: ${WHAT[about.what]}`,
    `When: ${clock(about.at)} ${dayWord(about.at, context.now)}`,
    `Why: ${about.reason}`,
    'What to do: look at Settings → Data; nothing was lost.',
  ],
  row: () => null,
  apart: true,
  guidance: '',
};
