import type { LinearIssueDetail } from './linear';
import { localDay } from './ranking';

/*
  The code pre-filter for Ares's "Spot stuck Linear issues" job (#75). Among the issues assigned to
  the User or created by them, and still open, it picks those that may be stuck, and says why:

  - unchanged: started (not in review) and unchanged for 5 working days or more;
  - in-review: in a review state, with no change for 3 days or more;
  - blocked: blocked by another issue that is still open;
  - overdue: its due date has passed.

  Stuck means stalled: every reason needs the issue to have gone a while without a change (a comment
  counts), at least a day for blocked and overdue ones. So an issue that changes isn't picked again
  until it stalls again.

  The model then decides, for each one picked, whether it is really stuck. Pure, with the clock
  passed in, so tests use a fake one.
*/

/** Ares's job that spots stuck Linear issues, and the action it registers (Organise, in Linear). */
export const SPOT_STUCK_LINEAR = 'spot-stuck-linear';

export type StuckSignal =
  | { kind: 'unchanged'; since: number; workingDays: number }
  // `since` it went into review, `days` ago; no change for `quietDays`.
  | { kind: 'in-review'; since: number; days: number; quietDays: number }
  | { kind: 'blocked'; by: { identifier: string; title: string }[] }
  | { kind: 'overdue'; dueDate: string; days: number };

export type StuckContext = {
  // The User's Linear user id in the issue's Account; null while unknown (nothing is theirs then).
  me: string | null;
  now: number;
  // When the issue went into its review state, when Commander saw it happen; otherwise its last
  // change is used, which never makes it look stuck sooner than it is.
  reviewSince?: number | null;
  // A blocking issue's state type as Commander has it now (it may have been finished since this
  // issue last changed), or null when Commander doesn't hold it.
  blockerState?: (id: string) => string | null;
};

export const UNCHANGED_WORKING_DAYS = 5;
export const IN_REVIEW_DAYS = 3;
// Blocked and overdue issues count once they have gone this many days without a change.
export const QUIET_DAYS = 1;
const DAY = 86_400_000;
const CLOSED = new Set(['completed', 'canceled']);

/** Weekdays (Monday to Friday) after the day of `from`, up to and including the day of `to`. */
export function workingDaysBetween(from: number, to: number): number {
  const day = new Date(from);
  day.setHours(12, 0, 0, 0);
  const end = localDay(to);
  let count = 0;
  for (let guard = 0; guard < 3660; guard++) {
    day.setDate(day.getDate() + 1);
    if (localDay(day.getTime()) > end) break;
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

/** When the issue last changed: its own change, or its newest comment, whichever is later. */
export function lastChangedAt(detail: LinearIssueDetail): number {
  return detail.comments.reduce(
    (latest, comment) => Math.max(latest, comment.createdAt, comment.updatedAt),
    detail.updatedAt,
  );
}

/** Whether a workflow state is a review state: a started one named for review ("In Review"). */
export function isReviewState(state: LinearIssueDetail['state']): boolean {
  return state.type === 'started' && /review/i.test(state.name);
}

/** Whether the issue is the User's: assigned to them or created by them. */
export function isUsersIssue(detail: LinearIssueDetail, me: string | null): boolean {
  return me !== null && (detail.assignee?.id === me || detail.creator?.id === me);
}

/** Why the issue may be stuck, in the order above; empty when it isn't a candidate. */
export function stuckSignals(detail: LinearIssueDetail, context: StuckContext): StuckSignal[] {
  const { me, now } = context;
  if (!isUsersIssue(detail, me) || CLOSED.has(detail.state.type)) return [];
  const signals: StuckSignal[] = [];
  const changed = lastChangedAt(detail);
  const review = isReviewState(detail.state);

  if (detail.state.type === 'started' && !review) {
    const workingDays = workingDaysBetween(changed, now);
    if (workingDays >= UNCHANGED_WORKING_DAYS)
      signals.push({ kind: 'unchanged', since: changed, workingDays });
  }
  const quietDays = Math.floor((now - changed) / DAY);
  if (review && quietDays >= IN_REVIEW_DAYS) {
    const since = Math.min(context.reviewSince ?? changed, changed);
    signals.push({ kind: 'in-review', since, days: Math.floor((now - since) / DAY), quietDays });
  }
  if (quietDays < QUIET_DAYS) return signals;
  const blockers = (detail.blockedBy ?? []).filter(
    (blocker) => !CLOSED.has(context.blockerState?.(blocker.id) ?? blocker.stateType),
  );
  if (blockers.length) {
    signals.push({
      kind: 'blocked',
      by: blockers.map(({ identifier, title }) => ({ identifier, title })),
    });
  }
  if (detail.dueDate && detail.dueDate < localDay(now)) {
    const [year = 1970, month = 1, date = 1] = detail.dueDate.split('-').map(Number);
    const due = new Date(year, month - 1, date, 12).getTime();
    const today = new Date(now);
    today.setHours(12, 0, 0, 0);
    signals.push({
      kind: 'overdue',
      dueDate: detail.dueDate,
      days: Math.round((today.getTime() - due) / DAY),
    });
  }
  return signals;
}
