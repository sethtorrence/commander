import type { Filing, Item, SourceItem } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  type AccountsById,
  filterOptions,
  groupIssues,
  type Issue,
  type IssueFilters,
  inFilters,
  inView,
  isCurrentCycle,
  NO_FILTERS,
  toIssues,
} from './issues';
import {
  ACME,
  CURRENT_CYCLE,
  ENG,
  GLOBEX,
  issue,
  NEXT_CYCLE,
  NOW,
  OPS,
  PRIYA,
  SAM,
  STATES,
} from './test-issues';

// The Linear Section's list, worked out from the Items: which issues each view shows, how the
// filters narrow them and count their choices, and how the list is grouped.

let next = 0;
function item(source: SourceItem, account = ACME, filing: Filing = null): Item {
  next += 1;
  return {
    id: `item-${next}`,
    kind: 'linear-issue',
    source: 'linear',
    account,
    externalId: source.externalId,
    title: source.title,
    people: [],
    filing,
    status: source.status ?? 'open',
    detail: source.detail ?? null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

const me: AccountsById = new Map([
  [ACME, { id: ACME, name: 'Acme', user: { id: SAM.id, name: SAM.name } }],
  [GLOBEX, { id: GLOBEX, name: 'Globex', user: { id: 'user-sam-globex', name: SAM.name } }],
]);

const ids = (issues: readonly Issue[]) => issues.map((each) => each.detail.identifier);

describe('the views', () => {
  it('shows issues assigned to the User in each workspace under Assigned to me, and every issue under All tickets', () => {
    const issues = toIssues([
      item(issue({ identifier: 'ENG-1', assignee: SAM })),
      item(issue({ identifier: 'ENG-2', assignee: PRIYA })),
      item(issue({ identifier: 'ENG-3', assignee: null })),
      // Sam in Globex is another Linear user: the one Globex says signed in.
      item(issue({ identifier: 'GLX-1', assignee: { ...SAM, id: 'user-sam-globex' } }), GLOBEX),
      item(issue({ identifier: 'GLX-2', assignee: SAM }), GLOBEX),
    ]);

    expect(ids(issues.filter((each) => inView(each, 'mine', me)))).toEqual(['ENG-1', 'GLX-1']);
    expect(ids(issues.filter((each) => inView(each, 'all', me)))).toHaveLength(5);
  });

  it('assigns nothing to the User in a workspace that hasn’t said who signed in', () => {
    const issues = toIssues([item(issue({ identifier: 'ENG-1', assignee: SAM }))]);
    const unknown: AccountsById = new Map([[ACME, { id: ACME, name: 'Acme', user: null }]]);

    expect(issues.filter((each) => inView(each, 'mine', unknown))).toEqual([]);
  });

  it('leaves out Items that aren’t Linear issues', () => {
    const todo: Item = { ...item(issue({ identifier: 'X' })), kind: 'todo', detail: null };
    expect(toIssues([todo])).toEqual([]);
  });
});

describe('grouping the list', () => {
  it('puts started issues first, then unstarted, then backlog and triage, with closed ones last', () => {
    const groups = groupIssues(
      toIssues([
        item(issue({ identifier: 'ENG-1', state: STATES.backlog })),
        item(issue({ identifier: 'ENG-2', state: STATES.done })),
        item(issue({ identifier: 'ENG-3', state: STATES.progress })),
        item(issue({ identifier: 'ENG-4', state: STATES.todo })),
        item(issue({ identifier: 'ENG-5', state: STATES.triage })),
        item(issue({ identifier: 'ENG-6', state: STATES.canceled })),
        item(issue({ identifier: 'ENG-7', state: STATES.review })),
      ]),
    );

    expect(groups.map((group) => [group.id, ids(group.issues)])).toEqual([
      ['started', ['ENG-3', 'ENG-7']],
      ['unstarted', ['ENG-4']],
      ['backlog', ['ENG-1', 'ENG-5']],
      ['closed', ['ENG-2', 'ENG-6']],
    ]);
  });

  it('orders each group by priority, urgent first and no priority last, then by the latest change', () => {
    const groups = groupIssues(
      toIssues([
        item(issue({ identifier: 'ENG-1', priority: 0 })),
        item(issue({ identifier: 'ENG-2', priority: 3, updatedAt: NOW - 5000 })),
        item(issue({ identifier: 'ENG-3', priority: 1 })),
        item(issue({ identifier: 'ENG-4', priority: 3, updatedAt: NOW })),
        item(issue({ identifier: 'ENG-5', priority: 4 })),
      ]),
    );

    expect(ids(groups[1]?.issues ?? [])).toEqual(['ENG-3', 'ENG-4', 'ENG-2', 'ENG-5', 'ENG-1']);
  });

  it('files an unfamiliar state type with the backlog rather than losing the issue', () => {
    const groups = groupIssues(
      toIssues([item(issue({ identifier: 'ENG-1', state: { ...STATES.todo, type: 'someday' } }))]),
    );
    expect(ids(groups[2]?.issues ?? [])).toEqual(['ENG-1']);
  });
});

describe('the filters', () => {
  const issues = toIssues([
    item(
      issue({
        identifier: 'ENG-1',
        assignee: SAM,
        state: STATES.progress,
        cycle: CURRENT_CYCLE,
        linearProject: { id: 'lp-login', name: 'Login revamp' },
      }),
    ),
    item(issue({ identifier: 'ENG-2', assignee: PRIYA, state: STATES.todo, cycle: NEXT_CYCLE })),
    item(issue({ identifier: 'OPS-1', team: OPS, assignee: PRIYA, state: STATES.progress })),
    item(issue({ identifier: 'OPS-2', team: OPS, state: STATES.done, cycle: CURRENT_CYCLE })),
  ]);
  const shown = (filters: Partial<IssueFilters>) =>
    ids(issues.filter((each) => inFilters(each, { ...NO_FILTERS, ...filters }, NOW)));

  it('narrows by team, Linear project, assignee, state and cycle, all together', () => {
    expect(shown({})).toEqual(['ENG-1', 'ENG-2', 'OPS-1', 'OPS-2']);
    expect(shown({ team: OPS.id })).toEqual(['OPS-1', 'OPS-2']);
    expect(shown({ linearProject: 'lp-login' })).toEqual(['ENG-1']);
    expect(shown({ linearProject: 'none' })).toEqual(['ENG-2', 'OPS-1', 'OPS-2']);
    expect(shown({ assignee: PRIYA.id })).toEqual(['ENG-2', 'OPS-1']);
    expect(shown({ assignee: 'none' })).toEqual(['OPS-2']);
    expect(shown({ state: 'In Progress' })).toEqual(['ENG-1', 'OPS-1']);
    expect(shown({ cycle: NEXT_CYCLE.id })).toEqual(['ENG-2']);
    expect(shown({ cycle: 'none' })).toEqual(['OPS-1']);
    expect(shown({ team: OPS.id, state: 'In Progress', assignee: PRIYA.id })).toEqual(['OPS-1']);
  });

  it('has the current cycle as a shortcut: whichever cycle is running now in each team', () => {
    expect(shown({ cycle: 'current' })).toEqual(['ENG-1', 'OPS-2']);
    expect(isCurrentCycle(CURRENT_CYCLE, NOW)).toBe(true);
    expect(isCurrentCycle(NEXT_CYCLE, NOW)).toBe(false);
    expect(isCurrentCycle(null, NOW)).toBe(false);
  });

  it('offers each choice with how many open issues it would show alongside the other filters', () => {
    const options = filterOptions(issues, { ...NO_FILTERS, team: ENG.id }, NOW, me);

    // Teams count across every team, under the other filters (none here).
    expect(options.team).toEqual([
      { value: ENG.id, label: 'Engineering', count: 2 },
      { value: OPS.id, label: 'Operations', count: 1 },
    ]);
    // The rest count within Engineering.
    expect(options.assignee).toEqual([
      { value: 'none', label: 'Unassigned', count: 0 },
      { value: SAM.id, label: 'You', count: 1 },
      { value: PRIYA.id, label: 'Priya Patel', count: 1 },
    ]);
    expect(options.linearProject).toEqual([
      { value: 'none', label: 'No Linear project', count: 1 },
      { value: 'lp-login', label: 'Login revamp', count: 1 },
    ]);
    expect(options.cycle).toEqual([
      { value: 'current', label: 'Current cycle', count: 1 },
      { value: 'none', label: 'No cycle', count: 0 },
      { value: CURRENT_CYCLE.id, label: 'ENG · Cycle 41', count: 1 },
      { value: NEXT_CYCLE.id, label: 'ENG · Cycle 42 · Polish', count: 1 },
    ]);
  });

  it('counts closed issues only under their own closed state, so every state can be chosen', () => {
    const options = filterOptions(issues, NO_FILTERS, NOW, me);
    expect(options.state).toEqual([
      { value: 'In Progress', label: 'In Progress', count: 2 },
      { value: 'Todo', label: 'Todo', count: 1 },
      { value: 'Done', label: 'Done', count: 1 },
    ]);
  });
});
