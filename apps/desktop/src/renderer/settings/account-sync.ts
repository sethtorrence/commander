import type { AccountSyncStatus } from '@commander/domain/ipc';

// An Account's sync in plain words, for Settings → Accounts (and the Linear Section's status line).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

// 14:02 today, or 2 Oct 14:02 on another day.
export function clockTime(at: number, now: Date): string {
  const date = new Date(at);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = date.toDateString() === now.toDateString();
  return today ? time : `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

// What a Source's Items are called, for counting them.
const nouns: Record<AccountSyncStatus['source'], [string, string]> = {
  linear: ['issue', 'issues'],
  github: ['item', 'items'],
  gmail: ['email', 'emails'],
  outlook: ['email', 'emails'],
  'google-calendar': ['event', 'events'],
  teams: ['chat', 'chats'],
};

export function describeSync(
  status: AccountSyncStatus,
  now: Date,
): { synced: string; next: string; problem: string | null } {
  const [one, many] = nouns[status.source];
  const synced =
    status.lastSyncedAt === null
      ? 'Not synced yet'
      : `Synced ${clockTime(status.lastSyncedAt, now)} · ${status.itemCount} ${status.itemCount === 1 ? one : many}`;
  const at = status.nextSyncAt === null ? null : clockTime(status.nextSyncAt, now);
  const next = {
    idle: at ? `Next sync ${at}` : 'Waiting to sync',
    syncing: 'Syncing now…',
    'backing-off': at ? `Trying again at ${at}` : 'Waiting to try again',
    offline: 'Paused while offline',
    asleep: 'Paused while asleep',
    'needs-reconnect': 'Paused until reconnected',
  }[status.activity];
  return { synced, next, problem: status.problem?.message ?? null };
}
