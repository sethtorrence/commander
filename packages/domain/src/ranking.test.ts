import { describe, expect, it } from 'vitest';
import type { Item } from './items';
import type { LinearIssueDetail, LinearUser } from './linear';
import { type RankingContext, rankByBandRules } from './ranking';

// The Dashboard's band rules, over fixture Items, at a fixed local time: Thursday 1 October 2026,
// 11:40. Dates are local, as the User sees them.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACCOUNT = 'linear:org-acme';

const ME: LinearUser = { id: 'user-sam', name: 'Sam Rivera', displayName: 'sam', email: null };
const PRIYA: LinearUser = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: null };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const STATES = {
  todo: { id: 's-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  backlog: { id: 's-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  progress: { id: 's-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  review: { id: 's-review', name: 'In Review', type: 'started', color: '#0f783c' },
  done: { id: 's-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
};
const CURRENT_CYCLE = { id: 'c-41', number: 41, name: null, startsAt: NOW - 3 * DAY, endsAt: NOW + 5 * DAY };
const NEXT_CYCLE = { id: 'c-42', number: 42, name: null, startsAt: NOW + 5 * DAY, endsAt: NOW + 12 * DAY };

const context: RankingContext = { now: NOW, users: { [ACCOUNT]: ME.id } };

function base(id: string, title: string): Omit<Item, 'kind' | 'detail'> {
  return {
    id,
    source: null,
    account: null,
    externalId: null,
    title,
    people: [],
    filing: null,
    status: 'open',
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
  };
}

function todo(id: string, { dueOn = null, ...rest }: { dueOn?: string | null } & Partial<Item> = {}): Item {
  return {
    ...base(id, `Todo ${id}`),
    kind: 'todo',
    detail: { kind: 'todo', origin: 'manual', dueOn, backedBy: null },
    ...rest,
  };
}

function issue(
  id: string,
  detail: Partial<LinearIssueDetail> = {},
  rest: Partial<Omit<Item, 'detail'>> = {},
): Item & { detail: LinearIssueDetail } {
  const state = detail.state ?? STATES.todo;
  return {
    ...base(id, `Issue ${id}`),
    kind: 'linear-issue',
    source: 'linear',
    account: ACCOUNT,
    externalId: `ext-${id}`,
    status: state.type === 'completed' || state.type === 'canceled' ? 'done' : 'open',
    detail: {
      kind: 'linear-issue',
      identifier: id,
      url: `https://linear.app/acme/issue/${id}`,
      team: ENG,
      state,
      priority: 0,
      assignee: ME,
      creator: PRIYA,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 2 * DAY,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      ...detail,
    },
    ...rest,
  };
}

const rank = (items: Item[], at: RankingContext = context) => rankByBandRules(items, at);
const bandOf = (items: Item[], id: string) => rank(items).find((ranking) => ranking.itemId === id)?.band;

describe('the Now band', () => {
  it('holds overdue Todos, saying since when', () => {
    const rankings = rank([
      todo('yesterday', { dueOn: '2026-09-30' }),
      todo('tuesday', { dueOn: '2026-09-29' }),
    ]);
    expect(rankings).toEqual([
      { itemId: 'tuesday', band: 'now', reason: 'Overdue since Tuesday', rank: 1 },
      { itemId: 'yesterday', band: 'now', reason: 'Overdue since yesterday', rank: 2 },
    ]);
  });

  it('names the date of a Todo overdue for more than a week', () => {
    expect(rank([todo('old', { dueOn: '2026-09-12' })])[0]?.reason).toBe('Overdue since 12 Sep');
  });

  it('holds Linear Todos past their due date', () => {
    expect(rank([issue('ENG-1', { dueDate: '2026-09-30' })])[0]).toMatchObject({
      band: 'now',
      reason: 'Overdue since yesterday',
    });
  });

  it('holds Linear Todos with Urgent priority', () => {
    expect(rank([issue('ENG-2', { priority: 1 })])[0]).toMatchObject({ band: 'now', reason: 'Urgent · ENG' });
  });
});

describe('the Today band', () => {
  it('holds Todos due today', () => {
    expect(rank([todo('today', { dueOn: '2026-10-01' })])[0]).toMatchObject({
      band: 'today',
      reason: 'Due today',
    });
  });

  it('holds Linear Todos that are in progress', () => {
    expect(rank([issue('ENG-3', { state: STATES.progress })])[0]).toMatchObject({
      band: 'today',
      reason: 'In Progress · ENG',
    });
  });

  it('holds Linear Todos in their team’s current cycle', () => {
    expect(rank([issue('ENG-4', { cycle: CURRENT_CYCLE })])[0]).toMatchObject({
      band: 'today',
      reason: 'In ENG Cycle 41, ends Tuesday',
    });
  });

  it('holds Linear Todos due today', () => {
    expect(rank([issue('ENG-5', { dueDate: '2026-10-01' })])[0]).toMatchObject({
      band: 'today',
      reason: 'Due today',
    });
  });
});

describe('the Waiting on others band', () => {
  it('holds Linear Todos in review, waiting on someone else', () => {
    expect(rank([issue('ENG-6', { state: STATES.review, cycle: CURRENT_CYCLE })])[0]).toMatchObject({
      band: 'waiting',
      reason: 'In review, waiting on reviewers',
    });
  });

  it('gives way to Now: an urgent issue in review stays in Now', () => {
    expect(bandOf([issue('ENG-7', { state: STATES.review, priority: 1 })], 'ENG-7')).toBe('now');
  });
});

describe('the FYI band', () => {
  it('holds issues the User created, assigned to someone else, that changed in the last 24 hours', () => {
    const changed = issue('ENG-8', { creator: ME, assignee: PRIYA, updatedAt: NOW - 2 * HOUR });
    expect(rank([changed])[0]).toMatchObject({
      band: 'fyi',
      reason: 'Priya Patel has it · changed 2h ago',
    });
  });

  it('leaves off those that changed longer ago, are unassigned, or were created by someone else', () => {
    const stale = issue('ENG-9', { creator: ME, assignee: PRIYA, updatedAt: NOW - 25 * HOUR });
    const unassigned = issue('ENG-10', { creator: ME, assignee: null, updatedAt: NOW - HOUR });
    const theirs = issue('ENG-11', { creator: PRIYA, assignee: PRIYA, updatedAt: NOW - HOUR });
    expect(rank([stale, unassigned, theirs])).toEqual([]);
  });
});

describe('Items left off the Dashboard', () => {
  it('leaves off open Todos with no due date, and those due later', () => {
    expect(rank([todo('someday'), todo('friday', { dueOn: '2026-10-02' })])).toEqual([]);
  });

  it('leaves off Linear Todos with no due date, no cycle, not started and not urgent', () => {
    const later = issue('ENG-12', { priority: 2, cycle: NEXT_CYCLE, state: STATES.backlog });
    expect(rank([later])).toEqual([]);
  });

  it('leaves off issues assigned to someone else that the User did not create', () => {
    expect(rank([issue('ENG-13', { assignee: PRIYA, priority: 1, state: STATES.progress })])).toEqual([]);
  });

  it('leaves off ticked, closed and deleted Items', () => {
    const ticked = todo('ticked', { dueOn: '2026-09-30', status: 'done' });
    const closed = issue('ENG-14', { state: STATES.done, priority: 1 });
    const deleted = todo('deleted', { dueOn: '2026-09-30', deletedAt: NOW - HOUR });
    expect(rank([ticked, closed, deleted])).toEqual([]);
  });

  it('knows no Linear Todos in an Account where it doesn’t know who the User is', () => {
    expect(rank([issue('ENG-15', { priority: 1 })], { now: NOW, users: {} })).toEqual([]);
  });

  it('shows a Todo backed by another Item once: the Item behind it stands for both', () => {
    const behind = issue('ENG-16', { priority: 1 });
    const backed = todo('backed', { dueOn: '2026-09-30' });
    backed.detail = { kind: 'todo', origin: 'linear', dueOn: '2026-09-30', backedBy: behind.id };
    expect(rank([behind, backed]).map((ranking) => ranking.itemId)).toEqual(['ENG-16']);
  });
});

describe('the order within a band', () => {
  it('goes by priority, then due date, then the most recent change', () => {
    const items = [
      todo('manual-due-tuesday', { dueOn: '2026-09-29', updatedAt: NOW - HOUR }),
      issue('low', { priority: 4, dueDate: '2026-09-30' }),
      issue('urgent-older', { priority: 1, updatedAt: NOW - 3 * DAY }),
      issue('urgent-newer', { priority: 1, updatedAt: NOW - DAY }),
      issue('urgent-due-earlier', { priority: 1, dueDate: '2026-09-20' }),
      issue('high', { priority: 2, dueDate: '2026-09-28' }),
      todo('manual-due-monday', { dueOn: '2026-09-28', updatedAt: NOW - 5 * DAY }),
      todo('manual-due-monday-newer', { dueOn: '2026-09-28', updatedAt: NOW - 2 * DAY }),
    ];
    expect(rank(items).map(({ itemId, rank }) => [itemId, rank])).toEqual([
      ['urgent-due-earlier', 1],
      ['urgent-newer', 2],
      ['urgent-older', 3],
      ['high', 4],
      ['low', 5],
      ['manual-due-monday-newer', 6],
      ['manual-due-monday', 7],
      ['manual-due-tuesday', 8],
    ]);
  });

  it('lists the bands in order, Now first, each ranked from 1', () => {
    const items = [
      issue('fyi', { creator: ME, assignee: PRIYA, updatedAt: NOW - HOUR }),
      issue('waiting', { state: STATES.review }),
      todo('today', { dueOn: '2026-10-01' }),
      todo('now', { dueOn: '2026-09-30' }),
      issue('today-too', { state: STATES.progress }),
    ];
    expect(rank(items).map(({ itemId, band, rank }) => `${band} ${rank} ${itemId}`)).toEqual([
      'now 1 now',
      'today 1 today',
      'today 2 today-too',
      'waiting 1 waiting',
      'fyi 1 fyi',
    ]);
  });
});

describe('the clock', () => {
  it('ranks against the time it is given: tomorrow, today’s Todo is overdue', () => {
    const due = todo('due', { dueOn: '2026-10-01' });
    expect(rank([due], { ...context, now: NOW + DAY })[0]).toMatchObject({
      band: 'now',
      reason: 'Overdue since yesterday',
    });
  });

  it('drops an FYI issue once its change is more than a day old', () => {
    const changed = issue('ENG-17', { creator: ME, assignee: PRIYA, updatedAt: NOW - HOUR });
    expect(rank([changed], { ...context, now: NOW + DAY })).toEqual([]);
  });
});
