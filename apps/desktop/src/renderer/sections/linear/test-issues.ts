import type { LinearIssueDetail, LinearUser, SourceItem } from '@commander/domain';

// For tests only: Linear issues as Linear sync hands them to the Item store (saveFromSource), with
// everything not under test filled in.

export const ACME = 'linear:org-acme';
export const GLOBEX = 'linear:org-globex';

export const SAM: LinearUser = { id: 'user-sam', name: 'Sam Rivera', displayName: 'sam', email: null };
export const PRIYA: LinearUser = {
  id: 'user-priya',
  name: 'Priya Patel',
  displayName: 'priya',
  email: 'priya@acme.test',
};

export const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
export const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };

export const STATES = {
  triage: { id: 'state-triage', name: 'Triage', type: 'triage', color: '#fc7840' },
  backlog: { id: 'state-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  todo: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  progress: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  review: { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' },
  done: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
  canceled: { id: 'state-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3' },
} as const;

const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 9, 3, 12);
export const CURRENT_CYCLE = {
  id: 'cycle-41',
  number: 41,
  name: null,
  startsAt: NOW - 3 * DAY,
  endsAt: NOW + 4 * DAY,
};
export const NEXT_CYCLE = {
  id: 'cycle-42',
  number: 42,
  name: 'Polish',
  startsAt: NOW + 4 * DAY,
  endsAt: NOW + 11 * DAY,
};

export type IssueInput = Partial<LinearIssueDetail> & { identifier: string; title?: string };

/** A `linear-issue` Item as Linear sync hands it over. */
export function issue({ title, ...detail }: IssueInput): SourceItem {
  const state = detail.state ?? STATES.todo;
  const full: LinearIssueDetail = {
    kind: 'linear-issue',
    url: `https://linear.app/acme/issue/${detail.identifier}`,
    team: ENG,
    state,
    priority: 0,
    assignee: null,
    creator: PRIYA,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    ...detail,
  };
  return {
    externalId: `issue-${detail.identifier}`,
    kind: 'linear-issue',
    title: title ?? `Issue ${detail.identifier}`,
    status: state.type === 'completed' || state.type === 'canceled' ? 'done' : 'open',
    detail: full,
  };
}
