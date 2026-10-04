// Ares keeps an eye on Linear (#75): what goes in his queue from the Linear side, found whenever the
// producers look (after every sync, whenever the gate acts, and every minute). These are plain
// For your information lines, apart from Reconnect; none of them proposes a change to Linear.
//
// - Taken off the User's list: when a sync finds an issue reassigned, unassigned, cancelled, moved
//   out of the Todo states or deleted, its Linear Todo goes with an activity entry saying why
//   (linear-todos.ts). Those entries become one line, merged while it waits ("3 of your Linear
//   issues were reassigned"), each issue opening from it. The newest entry a line holds is where
//   the next look starts, so nothing is queued twice; the first look ever goes back a week only. An
//   issue assigned back to the User before they asked leaves the line again.
// - Stuck issues: the "Spot stuck Linear issues" job queues them (agent/spot-stuck-linear.ts),
//   merged by team; here an issue leaves its line once it changes (or closes), and a line left
//   with none expires.
// - Reconnect: an Account whose sign-in needs reconnecting queues one line ("Linear (Acme) needs
//   you to sign in again; syncing is paused") that resolves itself once it is reconnected or
//   removed. Dismissed, it stays dismissed until the Account has been reconnected and needs it again.
import {
  type ActivityEntry,
  lastChangedAt,
  type QueuedLine,
  type Source,
  type UpdateSection,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import type { UpdateQueue } from './queue';

// An Account as the producers see it: its Sources, its name ("Acme") and whether it needs
// reconnecting.
export type WatchedAccount = {
  account: string;
  sources: readonly Source[];
  name: string | null;
  needsReconnect: boolean;
};

export const LINEAR_LEFT_KEY = 'linear-left';
export const reconnectKey = (account: string) => `reconnect:${account}`;
const WEEK = 7 * 24 * 60 * 60_000;
const IMPORTANCE = { left: 0.4, reconnect: 0.9 } as const;

const SECTION_OF_SOURCE: Record<Source, UpdateSection> = {
  linear: 'linear',
  gmail: 'email',
  outlook: 'email',
  'google-calendar': 'calendar',
  'outlook-calendar': 'calendar',
  teams: 'teams',
  github: 'github',
};

const SOURCE_NAMES: Record<Source, string> = {
  linear: 'Linear',
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook',
  teams: 'Teams',
  github: 'GitHub',
};

// The Source as the User knows the Account: a Google Account carries Gmail and Google Calendar, an
// Outlook one its mail and calendar.
function sourceNameOf(sources: readonly Source[]): string {
  if (sources.some((source) => source === 'gmail' || source === 'google-calendar')) return 'Google';
  const [first] = sources;
  return first ? SOURCE_NAMES[first] : 'Account';
}

const REASSIGNED = / was reassigned to /;

export function createLinearWatch({
  itemStore,
  queue,
  now,
  accounts,
}: {
  itemStore: ItemStore;
  queue: UpdateQueue;
  now: () => number;
  accounts?: () => readonly WatchedAccount[];
}) {
  const store = itemStore.updates;
  // When each Account was last seen not needing reconnecting, since Commander started.
  const healthyAt = new Map<string, number>();

  const queuedOf = <K extends QueuedLine['about']['kind']>(kind: K) =>
    store
      .lines(['queued'])
      .filter(
        (line): line is QueuedLine & { about: Extract<QueuedLine['about'], { kind: K }> } =>
          line.about.kind === kind,
      );

  // The issue each entry's Todo followed, as the line names it.
  function issueOf(entry: ActivityEntry) {
    const issueId = entry.causedBy?.itemId;
    const issue = issueId ? itemStore.get(issueId)?.item : undefined;
    if (issue?.detail?.kind !== 'linear-issue') return [];
    const { identifier } = issue.detail;
    const why = entry.why?.trim() || `${identifier} left your list`;
    return [{ itemId: issue.id, identifier, todoId: entry.itemId, why, reassigned: REASSIGNED.test(why) }];
  }

  function left() {
    const last = store.lastWithKey(LINEAR_LEFT_KEY);
    const cursor = last?.about.kind === 'linear-left' ? Math.max(...last.about.entryIds) : null;
    const since = now() - WEEK;
    const entries = itemStore.linearTodosLeft(cursor).filter((entry) => cursor !== null || entry.at >= since);
    const issues = entries.flatMap(issueOf);
    if (!issues.length) return;
    queue.enqueue({
      group: 'fyi',
      mergeKey: LINEAR_LEFT_KEY,
      about: { kind: 'linear-left', entryIds: entries.map((entry) => entry.id), issues },
      itemIds: issues.map((issue) => issue.itemId),
      section: 'linear',
      importance: IMPORTANCE.left,
    });
  }

  // Issues whose Linear Todo is back (assigned to the User again) leave their line.
  function back() {
    for (const line of queuedOf('linear-left')) {
      const issues = line.about.issues.filter(
        (issue) => itemStore.get(issue.todoId)?.item.deletedAt !== null,
      );
      if (!issues.length) queue.resolve(line.id);
      else if (issues.length < line.about.issues.length) {
        queue.revise(line.id, {
          about: { ...line.about, issues },
          itemIds: [...new Set(issues.map((issue) => issue.itemId))],
        });
      }
    }
  }

  // Stuck issues that changed (or closed, or went) since Ares judged them leave their line.
  function stuck() {
    for (const line of queuedOf('linear-stuck')) {
      const issues = line.about.issues.filter((issue) => {
        const item = itemStore.get(issue.itemId)?.item;
        return (
          item?.detail?.kind === 'linear-issue' &&
          item.deletedAt === null &&
          item.status === 'open' &&
          lastChangedAt(item.detail) === issue.changedAt
        );
      });
      if (!issues.length) queue.expire(line.id);
      else if (issues.length < line.about.issues.length) {
        queue.revise(line.id, {
          about: { ...line.about, issues },
          itemIds: issues.map((issue) => issue.itemId),
        });
      }
    }
  }

  function reconnects() {
    if (!accounts) return;
    const at = now();
    const all = accounts();
    for (const account of all) if (!account.needsReconnect) healthyAt.set(account.account, at);
    const needing = new Map(
      all.filter((account) => account.needsReconnect).map((each) => [each.account, each]),
    );
    for (const line of queuedOf('reconnect')) {
      if (!needing.has(line.about.account)) queue.resolve(line.id);
    }
    for (const account of needing.values()) {
      const mergeKey = reconnectKey(account.account);
      const last = store.lastWithKey(mergeKey);
      if (last?.status === 'queued') continue;
      // Done or dismissed while it still needs reconnecting: not again until it was reconnected.
      const actedOn = last?.status === 'done' || last?.status === 'dismissed';
      if (actedOn && (healthyAt.get(account.account) ?? 0) < (last.settledAt ?? 0)) continue;
      const [first] = account.sources;
      queue.enqueue({
        group: 'now',
        mergeKey,
        about: {
          kind: 'reconnect',
          account: account.account,
          sourceName: sourceNameOf(account.sources),
          name: account.name,
        },
        itemIds: [],
        section: first ? SECTION_OF_SOURCE[first] : 'ares',
        importance: IMPORTANCE.reconnect,
      });
    }
  }

  return {
    sweep() {
      left();
      back();
      stuck();
      reconnects();
    },
  };
}
