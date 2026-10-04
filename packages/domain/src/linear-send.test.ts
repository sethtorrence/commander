import { describe, expect, it } from 'vitest';
import type { LinearCatalog, LinearCatalogTeam, LinearIssueDetail } from './linear';
import {
  defaultStateOf,
  issueTitleFrom,
  linearIssueDraft,
  pendingIdentifier,
  sentWhy,
  teamForProject,
} from './linear-send';
import type { Rule } from './rules';

const ME = 'user-me';
const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: null };
const me = { id: ME, name: 'Sam Rivera', displayName: 'sam', email: null };
const NOW = Date.UTC(2026, 9, 3, 12);

const states = {
  backlog: { id: 'state-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  todo: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  progress: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  done: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
  canceled: { id: 'state-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3' },
};

const team = (id: string, key: string, extra: Partial<LinearCatalogTeam> = {}): LinearCatalogTeam => ({
  id,
  key,
  name: key,
  states: Object.values(states),
  members: [me, priya],
  labels: [],
  cycles: [],
  linearProjects: [],
  ...extra,
});
const catalog = (...teams: LinearCatalogTeam[]): LinearCatalog => ({ kind: 'linear', teams });
const ACME = 'linear:org-acme';
const GLOBEX = 'linear:org-globex';
const catalogs = new Map<string, LinearCatalog | null>([
  [ACME, catalog(team('team-eng', 'ENG'), team('team-ops', 'OPS'))],
  [GLOBEX, catalog(team('team-web', 'WEB'))],
]);

let order = 0;
const rule = (projectId: string, ...conditions: [string, string, string][]): Rule => ({
  id: `rule-${order}`,
  target: { kind: 'project', projectId },
  when: {
    join: 'and',
    terms: conditions.map(([field, op, value]) => ({
      field,
      op: op as 'is',
      value,
      label: value,
    })),
  },
  order: order++,
  createdAt: 0,
});

describe('which team Send to Linear starts on', () => {
  it('takes the first Rule, in list order, filing into the Project with a Linear team condition', () => {
    const rules = [
      rule('tx', ['linear.team', 'is', 'team-ops']),
      rule('tl', ['linear.label', 'is', 'label-bug']),
      rule('tl', ['linear.team', 'is', 'team-eng']),
      rule('tl', ['linear.team', 'is', 'team-web']),
    ];
    expect(teamForProject(rules, 'tl', catalogs, null)).toEqual({ account: ACME, teamId: 'team-eng' });
  });

  it('finds the team condition inside a group, and the workspace the team belongs to', () => {
    const grouped: Rule = {
      ...rule('tl'),
      when: {
        join: 'and',
        terms: [
          {
            join: 'or',
            conditions: [{ field: 'linear.team', op: 'is', value: 'team-web', label: 'WEB' }],
          },
        ],
      },
    };
    expect(teamForProject([grouped], 'tl', catalogs, null)).toEqual({ account: GLOBEX, teamId: 'team-web' });
  });

  it('passes over a Rule whose team no connected workspace offers, and "team is not" conditions', () => {
    const rules = [
      rule('tl', ['linear.team', 'is-not', 'team-ops']),
      rule('tl', ['linear.team', 'is', 'team-gone']),
      rule('tl', ['linear.team', 'is', 'team-ops']),
    ];
    expect(teamForProject(rules, 'tl', catalogs, null)).toEqual({ account: ACME, teamId: 'team-ops' });
  });

  it('falls back to the last team the User sent to, while it is still offered', () => {
    const last = { account: GLOBEX, teamId: 'team-web' };
    expect(teamForProject([rule('tx', ['linear.team', 'is', 'team-ops'])], 'tl', catalogs, last)).toEqual(
      last,
    );
    expect(teamForProject([], null, catalogs, last)).toEqual(last);
    expect(teamForProject([], null, catalogs, { account: GLOBEX, teamId: 'team-gone' })).toBeNull();
  });

  it('has nothing to offer without Rules or an earlier send', () => {
    expect(teamForProject([], 'tl', catalogs, null)).toBeNull();
  });
});

describe('the state a new issue starts in', () => {
  it('is the team’s default state, as Linear names it', () => {
    expect(defaultStateOf(team('t', 'T', { defaultStateId: 'state-backlog' }))).toEqual(states.backlog);
  });

  it('without one known, is its first unstarted state, else backlog, else the first', () => {
    expect(defaultStateOf(team('t', 'T'))).toEqual(states.todo);
    expect(defaultStateOf(team('t', 'T', { states: [states.done, states.backlog] }))).toEqual(states.backlog);
    expect(defaultStateOf(team('t', 'T', { states: [states.done] }))).toEqual(states.done);
    expect(defaultStateOf(team('t', 'T', { states: [] }))).toBeNull();
  });
});

describe('a new issue before Linear numbers it', () => {
  it('shows its team’s key and an ellipsis', () => {
    expect(pendingIdentifier({ key: 'ENG' })).toBe('ENG-…');
  });
});

describe('why a sent Todo is not a Linear Todo', () => {
  const detail = (changes: Partial<LinearIssueDetail>) =>
    ({ identifier: 'ENG-…', state: states.todo, assignee: me, cycle: null, ...changes }) as LinearIssueDetail;

  it('says who has it, or that nobody does', () => {
    expect(sentWhy(detail({ assignee: priya }), ME, NOW)).toBe('Sent to Linear, assigned to Priya Patel');
    expect(sentWhy(detail({ assignee: null }), ME, NOW)).toBe('Sent to Linear, unassigned');
  });

  it('says which state keeps it off the list', () => {
    expect(sentWhy(detail({ state: states.backlog }), ME, NOW)).toBe(
      'Sent to Linear in Backlog, outside the current cycle',
    );
    expect(sentWhy(detail({ state: states.canceled }), ME, NOW)).toBe('Sent to Linear as Canceled');
  });

  it('is null for one of the User’s Linear Todos (or a done one), and while who the User is is unknown', () => {
    expect(sentWhy(detail({}), ME, NOW)).toBeNull();
    expect(sentWhy(detail({ state: states.done }), ME, NOW)).toBeNull();
    expect(sentWhy(detail({ assignee: priya }), null, NOW)).toBeNull();
  });
});

describe('what the Send to Linear dialog sends', () => {
  const draft = {
    account: ACME,
    team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    title: '  Fix the login loop ',
    state: states.todo,
    assignee: me,
  };

  it('needs a title, and trims it', () => {
    expect(linearIssueDraft.parse(draft)).toMatchObject({ title: 'Fix the login loop', priority: 0 });
    expect(linearIssueDraft.safeParse({ ...draft, title: '   ' }).success).toBe(false);
  });

  it('takes a priority from none to low, and an optional description', () => {
    expect(linearIssueDraft.parse({ ...draft, priority: 2, description: 'Steps' })).toMatchObject({
      priority: 2,
      description: 'Steps',
    });
    expect(linearIssueDraft.safeParse({ ...draft, priority: 5 }).success).toBe(false);
  });
});

describe('the title a Block’s text suggests', () => {
  const projects = [
    { id: 'p-lt', code: 'LT', name: 'Longtail', archived: false },
    { id: 'p-tx', code: 'TX', name: 'Tactics', archived: false },
  ];

  it('drops `#LT` codes and Markdown marks, and names `[[` links', () => {
    expect(issueTitleFrom('**Plan** the _offsite_ #LT', projects)).toBe('Plan the offsite');
    expect(issueTitleFrom('## Ask [[project:p-tx]] about [[2026-10-05]] `deploys`', projects)).toBe(
      'Ask Tactics about 2026-10-05 deploys',
    );
    expect(issueTitleFrom('Read [the doc](https://example.com) ~~now~~', projects)).toBe('Read the doc now');
  });

  it('leaves text without any as it is, and an image Block empty', () => {
    expect(issueTitleFrom('Call Dana #hashtag', projects)).toBe('Call Dana #hashtag');
    expect(issueTitleFrom('![](attachment:abc.png)', projects)).toBe('');
  });
});
