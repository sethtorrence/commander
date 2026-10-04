import { describe, expect, it } from 'vitest';
import type { LinearIssueDetail } from './linear';
import { completedStateOf, isLinearTodo, linearTodoFate, reopenStateOf } from './linear-todos';

const ME = 'user-me';
const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: null };
const me = { id: ME, name: 'Sam Rivera', displayName: 'sam', email: null };
const NOW = Date.UTC(2026, 9, 3, 12);
const DAY = 86_400_000;

const states = {
  triage: { id: 'state-triage', name: 'Triage', type: 'triage', color: '#fc7840' },
  backlog: { id: 'state-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  todo: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  progress: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  review: { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' },
  done: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
  shipped: { id: 'state-shipped', name: 'Shipped', type: 'completed', color: '#5e6ad2' },
  canceled: { id: 'state-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3' },
};
const current = { id: 'cycle-41', number: 41, name: null, startsAt: NOW - 3 * DAY, endsAt: NOW + 4 * DAY };
const next = { id: 'cycle-42', number: 42, name: null, startsAt: NOW + 4 * DAY, endsAt: NOW + 11 * DAY };
const past = { id: 'cycle-40', number: 40, name: null, startsAt: NOW - 10 * DAY, endsAt: NOW - 3 * DAY };

const detail = (changes: Partial<LinearIssueDetail> = {}): LinearIssueDetail => ({
  kind: 'linear-issue',
  identifier: 'ENG-418',
  url: 'https://linear.app/acme/issue/ENG-418',
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  state: states.progress,
  priority: 0,
  assignee: me,
  creator: null,
  labels: [],
  cycle: null,
  linearProject: null,
  dueDate: null,
  estimate: null,
  description: null,
  comments: [],
  createdAt: 1,
  updatedAt: 2,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  ...changes,
});

describe('which Linear issues are Linear Todos', () => {
  it('counts unstarted and started issues assigned to the User, whatever the state is called', () => {
    for (const state of [states.todo, states.progress, states.review]) {
      expect(linearTodoFate(detail({ state }), ME, NOW)).toEqual({ todo: 'open' });
      expect(isLinearTodo(detail({ state }), ME, NOW)).toBe(true);
    }
  });

  it('counts backlog and triage issues only while they are in their team’s current cycle', () => {
    for (const state of [states.backlog, states.triage]) {
      expect(linearTodoFate(detail({ state, cycle: current }), ME, NOW)).toEqual({ todo: 'open' });
      for (const cycle of [null, next, past]) {
        expect(linearTodoFate(detail({ state, cycle }), ME, NOW)).toEqual({
          todo: 'none',
          why: `ENG-418 is in ${state.name}, outside the current cycle`,
        });
        expect(isLinearTodo(detail({ state, cycle }), ME, NOW)).toBe(false);
      }
    }
  });

  it('ticks the Todo of a completed issue, and drops a cancelled one', () => {
    expect(linearTodoFate(detail({ state: states.done }), ME, NOW)).toEqual({ todo: 'done' });
    expect(isLinearTodo(detail({ state: states.done }), ME, NOW)).toBe(false);
    expect(linearTodoFate(detail({ state: states.canceled }), ME, NOW)).toEqual({
      todo: 'none',
      why: 'ENG-418 was cancelled',
    });
  });

  it('drops an issue assigned to someone else, or to no one, naming who has it', () => {
    expect(linearTodoFate(detail({ assignee: priya }), ME, NOW)).toEqual({
      todo: 'none',
      why: 'ENG-418 was reassigned to Priya Patel',
    });
    expect(linearTodoFate(detail({ assignee: null }), ME, NOW)).toEqual({
      todo: 'none',
      why: 'ENG-418 was unassigned',
    });
    expect(isLinearTodo(detail({ assignee: priya }), ME, NOW)).toBe(false);
  });

  it('judges the state alone while who the User is is not known yet', () => {
    expect(linearTodoFate(detail({ assignee: priya }), null, NOW)).toEqual({ todo: 'open' });
    expect(isLinearTodo(detail({ assignee: priya }), null, NOW)).toBe(false);
  });

  it('drops an issue in a state type Linear adds later', () => {
    const odd = { id: 'state-odd', name: 'Parked', type: 'parked', color: '#000000' };
    expect(linearTodoFate(detail({ state: odd }), ME, NOW)).toEqual({
      todo: 'none',
      why: 'ENG-418 moved to Parked',
    });
  });
});

describe('the states ticking moves an issue between', () => {
  const team = [states.backlog, states.todo, states.progress, states.review, states.shipped, states.done];

  it('ticks into the team’s default completed state: its first completed state, in the team’s order', () => {
    expect(completedStateOf(team)).toEqual(states.shipped);
    expect(completedStateOf([states.todo, states.progress])).toBeNull();
  });

  it('unticks back to the team’s first unstarted state when the earlier state is unknown', () => {
    expect(reopenStateOf(team)).toEqual(states.todo);
    expect(reopenStateOf([states.progress, states.done])).toEqual(states.progress);
    expect(reopenStateOf([states.done])).toBeNull();
  });
});
