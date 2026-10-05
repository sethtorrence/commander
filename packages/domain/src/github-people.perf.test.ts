import { expect, it } from 'vitest';
import type { PullRequestDetail } from './github';
import { defaultOversightSettings } from './github-oversight';
import { githubPeople } from './github-people';
import type { Item } from './items';
import type { Person } from './people';

// Speed check for the People view's facts (#122), run by `pnpm test:perf` one file at a time (see
// vitest.perf.config.ts). The view is worked out on every open and every change, so a busy org (a
// few thousand pull requests, hundreds of People, a couple of thousand Linear issues) must stay quick.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 4, 15);
const REPO = { nodeId: 'R_api', owner: 'acme', name: 'api' };
const PEOPLE = 300;

const login = (n: number) => `dev${n % PEOPLE}`;

function pull(n: number): Item {
  const merged = n % 3 === 0;
  const detail: PullRequestDetail = {
    kind: 'pull-request',
    repo: REPO,
    number: n,
    url: `https://github.com/acme/api/pull/${n}`,
    nodeId: `PR_${n}`,
    author: login(n),
    state: merged ? 'merged' : 'open',
    draft: false,
    baseBranch: 'main',
    headBranch: `b-${n}`,
    labels: [],
    assignees: [],
    requestedReviewers: [
      { kind: 'user', login: login(n + 1), requestedAt: NOW - (n % 200) * HOUR },
      { kind: 'user', login: login(n + 2), requestedAt: NOW - (n % 90) * HOUR },
    ],
    reviews: [{ login: login(n + 3), state: 'approved', submittedAt: NOW - (n % 300) * HOUR }],
    reviewDecision: null,
    checks: n % 7 === 0 ? 'failure' : 'success',
    closingIssues: [],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    body: '',
    createdAt: NOW - (n % 1000) * HOUR,
    updatedAt: NOW - (n % 50) * HOUR,
    mergedAt: merged ? NOW - (n % 400) * HOUR : null,
    closedAt: merged ? NOW - (n % 400) * HOUR : null,
  };
  return {
    id: `pr-${n}`,
    kind: 'pull-request',
    source: 'github',
    account: 'github:1',
    externalId: `x-${n}`,
    title: `Change ${n}`,
    people: [],
    filing: n % 2 ? { projectId: 'p1', filedBy: 'rule' } : null,
    status: merged ? 'done' : 'open',
    detail,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function linear(n: number): Item {
  return {
    id: `lin-${n}`,
    kind: 'linear-issue',
    source: 'linear',
    account: 'linear:1',
    externalId: `ENG-${n}`,
    title: `Issue ${n}`,
    people: [],
    filing: null,
    status: 'open',
    detail: {
      kind: 'linear-issue',
      identifier: `ENG-${n}`,
      url: '',
      team: { id: 't', key: 'ENG', name: 'Engineering' },
      state: { id: 's', name: 'In Progress', type: 'started', color: '#000' },
      priority: 2,
      assignee: { id: `u${n % PEOPLE}`, name: 'x', displayName: 'x', email: null },
      creator: null,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: 0,
      updatedAt: 0,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

const people: Person[] = Array.from({ length: PEOPLE }, (_, n) => ({
  id: `person-${n}`,
  name: `Developer ${n}`,
  userName: null,
  isUser: false,
  handles: [
    { handle: `github:dev${n}`, source: 'github', name: null },
    { handle: `linear:u${n}`, source: 'linear', name: null },
  ],
  createdAt: 0,
  updatedAt: 0,
}));

const items = [
  ...Array.from({ length: 5_000 }, (_, n) => pull(n + 1)),
  ...Array.from({ length: 2_000 }, (_, n) => linear(n + 1)),
];

it('works out every Person’s week across thousands of pull requests quickly', () => {
  const started = Date.now();
  for (const projectId of [undefined, 'p1', null] as const)
    githubPeople({
      range: { from: NOW - 7 * 24 * HOUR, to: NOW },
      ...(projectId !== undefined && { projectId }),
      items,
      people,
      settings: defaultOversightSettings,
    });
  // Each run takes a few tens of milliseconds; the budget leaves room for a loaded machine.
  expect(Date.now() - started).toBeLessThan(3_000);
});
