import { describe, expect, it } from 'vitest';
import type { LinearIssueDetail } from './linear';
import {
  isReviewState,
  lastChangedAt,
  type StuckContext,
  stuckSignals,
  workingDaysBetween,
} from './linear-stuck';

// The code pre-filter for "Spot stuck Linear issues": fixture issues and a fake clock.

const at = (day: number, hour = 10) => new Date(2026, 9, day, hour).getTime();
// Thursday 8 October 2026, 10:00.
const NOW = at(8);
const DAY = 86_400_000;
const me = { id: 'user-sam', name: 'Sam Rivera', displayName: 'sam', email: null };
const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: null };
const states = {
  todo: { id: 's-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  progress: { id: 's-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  review: { id: 's-review', name: 'In Review', type: 'started', color: '#0f783c' },
  done: { id: 's-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
};

function issue(detail: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    kind: 'linear-issue',
    identifier: 'ENG-1',
    url: 'https://linear.app/acme/issue/ENG-1',
    team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    state: states.progress,
    priority: 0,
    assignee: me,
    creator: priya,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: at(1),
    updatedAt: NOW - DAY,
    startedAt: at(1),
    completedAt: null,
    canceledAt: null,
    ...detail,
  };
}

const kinds = (detail: LinearIssueDetail, extra: Partial<StuckContext> = {}) =>
  stuckSignals(detail, { me: me.id, now: NOW, ...extra }).map((signal) => signal.kind);

describe('working days', () => {
  it('counts the weekdays after a moment up to now, skipping the weekend', () => {
    // Thursday 1 October to Thursday 8 October: Fri, Mon, Tue, Wed, Thu.
    expect(workingDaysBetween(at(1), NOW)).toBe(5);
    // From Friday: Mon, Tue, Wed, Thu.
    expect(workingDaysBetween(at(2), NOW)).toBe(4);
    // From Saturday or Sunday the same.
    expect(workingDaysBetween(at(3), NOW)).toBe(4);
    expect(workingDaysBetween(at(4, 23), NOW)).toBe(4);
    expect(workingDaysBetween(NOW - 3_600_000, NOW)).toBe(0);
    expect(workingDaysBetween(NOW + DAY, NOW)).toBe(0);
  });
});

describe('what counts as a change', () => {
  it('is the issue’s own change or its newest comment, whichever is later', () => {
    const comment = {
      id: 'c1',
      author: priya,
      body: 'Any news?',
      createdAt: NOW - 2 * DAY,
      updatedAt: NOW - DAY,
    };
    expect(lastChangedAt(issue({ updatedAt: at(1) }))).toBe(at(1));
    expect(lastChangedAt(issue({ updatedAt: at(1), comments: [comment] }))).toBe(NOW - DAY);
  });

  it('knows a review state by its name, among the started ones', () => {
    expect(isReviewState(states.review)).toBe(true);
    expect(isReviewState({ ...states.review, name: 'Code review' })).toBe(true);
    expect(isReviewState(states.progress)).toBe(false);
    expect(isReviewState({ ...states.todo, name: 'Review later' })).toBe(false);
  });
});

describe('stuck candidates', () => {
  it('picks a started issue unchanged for 5 working days, not 4', () => {
    expect(kinds(issue({ updatedAt: at(1) }))).toEqual(['unchanged']);
    expect(kinds(issue({ updatedAt: at(2) }))).toEqual([]);
    const [signal] = stuckSignals(issue({ updatedAt: at(1) }), { me: me.id, now: NOW });
    expect(signal).toEqual({ kind: 'unchanged', since: at(1), workingDays: 5 });
  });

  it('a comment counts as a change', () => {
    const comment = { id: 'c1', author: priya, body: 'Looking now', createdAt: at(6), updatedAt: at(6) };
    expect(kinds(issue({ updatedAt: at(1), comments: [comment] }))).toEqual([]);
  });

  it('picks an issue in review with no change for 3 days, saying since when it has been in review', () => {
    expect(kinds(issue({ state: states.review, updatedAt: at(5) }), { reviewSince: at(4) })).toEqual([
      'in-review',
    ]);
    expect(kinds(issue({ state: states.review, updatedAt: at(6) }), { reviewSince: at(4) })).toEqual([]);
    // A comment two days ago: it hasn't stalled (yet).
    const comment = { id: 'c1', author: priya, body: 'Looking', createdAt: at(6), updatedAt: at(6) };
    expect(kinds(issue({ state: states.review, updatedAt: at(4), comments: [comment] }))).toEqual([]);
    const [signal] = stuckSignals(issue({ state: states.review, updatedAt: at(5) }), {
      me: me.id,
      now: NOW,
      reviewSince: at(4),
    });
    expect(signal).toEqual({ kind: 'in-review', since: at(4), days: 4, quietDays: 3 });
    // When it went into review isn't known: its last change.
    const [guess] = stuckSignals(issue({ state: states.review, updatedAt: at(4) }), { me: me.id, now: NOW });
    expect(guess).toEqual({ kind: 'in-review', since: at(4), days: 4, quietDays: 4 });
  });

  it('picks an issue blocked by another that is still open', () => {
    const quiet = { updatedAt: NOW - DAY };
    const blocker = { id: 'issue-9', identifier: 'ENG-9', title: 'Migrate the schema', stateType: 'started' };
    expect(kinds(issue({ ...quiet, state: states.todo, blockedBy: [blocker] }))).toEqual(['blocked']);
    expect(
      kinds(issue({ ...quiet, state: states.todo, blockedBy: [{ ...blocker, stateType: 'completed' }] })),
    ).toEqual([]);
    expect(
      kinds(issue({ ...quiet, state: states.todo, blockedBy: [{ ...blocker, stateType: 'canceled' }] })),
    ).toEqual([]);
    // The blocker as Commander has it now wins over what the issue said when it last changed.
    expect(
      kinds(issue({ ...quiet, state: states.todo, blockedBy: [blocker] }), {
        blockerState: () => 'completed',
      }),
    ).toEqual([]);
    const [signal] = stuckSignals(issue({ ...quiet, state: states.todo, blockedBy: [blocker] }), {
      me: me.id,
      now: NOW,
    });
    expect(signal).toEqual({ kind: 'blocked', by: [{ identifier: 'ENG-9', title: 'Migrate the schema' }] });
  });

  it('blocked or overdue, it must have gone a day without a change: just changed, it isn’t stalled', () => {
    const blocker = { id: 'issue-9', identifier: 'ENG-9', title: 'Migrate the schema', stateType: 'started' };
    const fresh = { updatedAt: NOW - 3_600_000, state: states.todo };
    expect(kinds(issue({ ...fresh, blockedBy: [blocker] }))).toEqual([]);
    expect(kinds(issue({ ...fresh, dueDate: '2026-10-07' }))).toEqual([]);
  });

  it('picks an overdue issue, not one due today', () => {
    expect(kinds(issue({ state: states.todo, dueDate: '2026-10-07' }))).toEqual(['overdue']);
    expect(kinds(issue({ state: states.todo, dueDate: '2026-10-08' }))).toEqual([]);
    const [signal] = stuckSignals(issue({ state: states.todo, dueDate: '2026-10-05' }), {
      me: me.id,
      now: NOW,
    });
    expect(signal).toEqual({ kind: 'overdue', dueDate: '2026-10-05', days: 3 });
  });

  it('gives every reason that applies', () => {
    expect(kinds(issue({ updatedAt: at(1), dueDate: '2026-10-01' }))).toEqual(['unchanged', 'overdue']);
  });

  it('only among the User’s own issues: assigned to them or created by them', () => {
    const stale = { updatedAt: at(1) };
    expect(kinds(issue({ ...stale, assignee: priya, creator: me }))).toEqual(['unchanged']);
    expect(kinds(issue({ ...stale, assignee: priya, creator: priya }))).toEqual([]);
    expect(kinds(issue({ ...stale, assignee: null, creator: null }))).toEqual([]);
    // Who the User is isn't known yet: nothing is theirs.
    expect(stuckSignals(issue(stale), { me: null, now: NOW })).toEqual([]);
  });

  it('never a finished issue, or one not started that is only old', () => {
    expect(kinds(issue({ state: states.done, updatedAt: at(1), dueDate: '2026-10-01' }))).toEqual([]);
    expect(kinds(issue({ state: { ...states.done, type: 'canceled' }, updatedAt: at(1) }))).toEqual([]);
    expect(kinds(issue({ state: states.todo, updatedAt: at(1) }))).toEqual([]);
  });
});
