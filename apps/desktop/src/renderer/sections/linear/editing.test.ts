import type { ActivityEntry, LinearCatalog, OutgoingChange } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { issueSync, pickerOptions, supersededNote } from './editing';
import { type Issue, toIssues } from './issues';
import { ACME, CURRENT_CYCLE, ENG, issue, NEXT_CYCLE, NOW, OPS, PRIYA, SAM, STATES } from './test-issues';

// What the detail pane needs to edit an issue, as pure functions.

const asIssue = (input: Parameters<typeof issue>[0], account = ACME): Issue => {
  const item = issue(input);
  const [found] = toIssues([
    {
      id: item.externalId,
      kind: 'linear-issue',
      source: 'linear',
      account,
      externalId: item.externalId,
      title: item.title,
      people: [],
      filing: null,
      status: item.status ?? 'open',
      detail: item.detail ?? null,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    },
  ]);
  if (!found) throw new Error('Not an issue');
  return found;
};

const bug = { id: 'label-bug', name: 'Bug', color: '#eb5757' };
const customer = { id: 'label-customer', name: 'Customer', color: '#5e6ad2' };

const catalog: LinearCatalog = {
  kind: 'linear',
  teams: [
    {
      ...ENG,
      states: [STATES.backlog, STATES.todo, STATES.progress, STATES.review, STATES.done],
      members: [PRIYA, SAM],
      labels: [customer],
      cycles: [CURRENT_CYCLE, NEXT_CYCLE],
      linearProjects: [{ id: 'lp-audit', name: 'Audit trail' }],
    },
  ],
};

describe('picker options', () => {
  const current = asIssue({
    identifier: 'ENG-418',
    state: STATES.progress,
    assignee: PRIYA,
    labels: [bug],
    linearProject: { id: 'lp-login', name: 'Login revamp' },
  });

  it('come from the team’s catalog, with the issue’s own values too', () => {
    const options = pickerOptions(current, catalog, [current], NOW);
    expect(options.states.map((state) => state.name)).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'Done',
    ]);
    expect(options.members).toEqual([PRIYA, SAM]);
    expect(options.labels).toEqual([bug, customer]);
    expect(options.cycles.map((cycle) => cycle.number)).toEqual([41, 42]);
    expect(options.linearProjects.map((project) => project.name)).toEqual(['Audit trail', 'Login revamp']);
  });

  it('fall back on what the team’s issues show before the first catalog arrives', () => {
    const other = asIssue({ identifier: 'ENG-420', state: STATES.review, assignee: SAM, cycle: NEXT_CYCLE });
    const elsewhere = asIssue({ identifier: 'OPS-7', team: OPS, state: STATES.triage });
    const options = pickerOptions(current, null, [current, other, elsewhere], NOW);
    expect(options.states.map((state) => state.name)).toEqual(['In Progress', 'In Review']);
    expect(options.members.map((member) => member.name)).toEqual(['Priya Patel', 'Sam Rivera']);
    expect(options.cycles.map((cycle) => cycle.number)).toEqual([42]);
  });
});

describe('an issue’s sync', () => {
  const change = (status: OutgoingChange['status'], error: string | null = null): OutgoingChange => ({
    id: 1,
    itemId: 'issue',
    source: 'linear',
    account: ACME,
    field: 'priority',
    status,
    madeAt: NOW,
    attempts: 0,
    error,
  });

  it('is synced with nothing queued, sending while anything is, and failed if any couldn’t sync', () => {
    expect(issueSync([])).toEqual({ kind: 'synced' });
    expect(issueSync([change('pending'), change('sending')])).toEqual({ kind: 'sending' });
    expect(issueSync([change('pending'), change('failed', 'Linear refused the change.')])).toEqual({
      kind: 'failed',
      error: 'Linear refused the change.',
    });
  });
});

describe('the note when Linear’s change won', () => {
  const entry = (id: number, by: ActivityEntry['by'], why: string | null = null): ActivityEntry => ({
    id,
    at: NOW,
    by,
    action: 'update',
    itemId: 'issue',
    otherItemId: null,
    otherProjectId: null,
    why,
    causedBy: null,
    undoes: null,
    changes: [],
  });
  const linear = { kind: 'source' as const, source: 'linear' as const, account: ACME };

  it('shows the newest such note until the User changes the issue again', () => {
    const note = 'Changed in Linear by Priya Patel at 14:02';
    expect(supersededNote([entry(3, linear), entry(2, linear, note), entry(1, { kind: 'user' })])).toBe(note);
    expect(supersededNote([entry(3, { kind: 'user' }), entry(2, linear, note)])).toBeNull();
    expect(supersededNote([entry(1, linear)])).toBeNull();
  });
});
