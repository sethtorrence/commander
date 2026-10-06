import type { Item, Memory, Person, Project, SearchHit, SearchResult } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { readQuery } from './query';
import { type PaletteContext, paletteGroups } from './rows';

const project: Project = {
  id: 'p-lt',
  name: 'Longtail',
  code: 'LT',
  accent: 'blue',
  order: 0,
  archived: false,
  createdAt: 0,
};

const item = (id: string, kind: Item['kind'], title: string, extra: Partial<Item> = {}): Item => ({
  id,
  kind,
  source: null,
  account: null,
  externalId: null,
  title,
  people: [],
  filing: null,
  status: 'open',
  detail: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  ...extra,
});

const hit = (found: Item, day: string | null = null, exact = false): SearchHit => ({
  item: found,
  day,
  exact,
  foundBy: ['words'],
});

const issue = item('i-418', 'linear-issue', 'Fix the login loop', {
  source: 'linear',
  account: 'linear:org-acme',
  filing: { projectId: 'p-lt', filedBy: 'user' },
  detail: {
    kind: 'linear-issue',
    identifier: 'ENG-418',
    url: 'https://linear.app/acme/issue/ENG-418',
    team: { id: 't', key: 'ENG', name: 'Engineering' },
    state: { id: 's', name: 'In Progress', type: 'started', color: '#f2c94c' },
    priority: 0,
    assignee: null,
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
});
const todo = item('t-1', 'todo', 'Ask about the login loop');
const block = item('b-1', 'block', 'Login loop is back on staging');

const base: Omit<PaletteContext, 'query' | 'result'> = {
  sections: [
    { id: 'dashboard', label: 'Dashboard', code: 'DSH' },
    { id: 'notes', label: 'Notes', code: 'DN' },
    { id: 'todos', label: 'Todos', code: 'TDO' },
    { id: 'linear', label: 'Linear', code: 'LIN' },
  ],
  current: 'todos',
  projects: [project],
  commands: [
    { label: 'Switch theme', run: () => {} },
    { label: 'Open Settings', keys: ',', run: () => {} },
  ],
  linearAccounts: [{ name: 'Acme', urlKey: 'acme' }],
  today: '2026-10-03',
};

const context = (input: string, result: SearchResult | null = null): PaletteContext => ({
  ...base,
  query: readQuery(input, { projects: [project], accounts: [], now: new Date(2026, 9, 3) }),
  result,
});

const shape = (input: string, result?: SearchResult) =>
  paletteGroups(context(input, result)).map((group) => [group.title, group.rows.map((row) => row.label)]);

describe('the palette before anything is typed', () => {
  it('offers every Section, today’s Daily Note, the Projects and the commands', () => {
    expect(shape('')).toEqual([
      ['Jump', ['Dashboard', 'Notes', 'Todos', 'Linear', 'Today’s Daily Note']],
      ['Projects', ['Longtail']],
      ['Commands', ['Switch theme', 'Open Settings']],
    ]);
  });

  it('tags Sections with their number and code, and marks the open one', () => {
    const [jump] = paletteGroups(context(''));
    expect(jump?.rows[2]).toMatchObject({
      tag: '03 · TDO',
      hint: 'Here',
      action: { type: 'section', sectionId: 'todos' },
    });
    expect(jump?.rows[0]).toMatchObject({ tag: '01 · DSH', hint: 'Section' });
  });

  it('shows a command’s keys as its tag', () => {
    const commands = paletteGroups(context('')).at(-1);
    expect(commands?.rows.map((row) => row.tag)).toEqual(['Cmd', ',']);
  });
});

describe('as the User types', () => {
  it('keeps the Jump rows and commands whose words start with what was typed', () => {
    expect(shape('li', { hits: [], projects: [] })).toEqual([
      ['Jump', ['Linear']],
      ['Search in Linear', ['Search “li” in Linear']],
    ]);
    expect(shape('switch th', { hits: [], projects: [] })).toEqual([
      ['Commands', ['Switch theme']],
      ['Search in Linear', ['Search “switch th” in Linear']],
    ]);
    expect(shape('today', { hits: [], projects: [] })[0]).toEqual(['Jump', ['Today’s Daily Note']]);
  });

  it('groups results by kind, the group with the best hit first, each with its Badge', () => {
    const groups = paletteGroups(
      context('login loop', {
        hits: [hit(issue), hit(todo), hit(block, '2026-09-30'), hit(item('t-2', 'todo', 'Login loop retro'))],
        projects: [],
      }),
    );
    expect(groups.map((group) => [group.title, group.rows.map((row) => row.label)])).toEqual([
      ['Linear', ['Fix the login loop']],
      ['Todos', ['Ask about the login loop', 'Login loop retro']],
      ['Notes', ['Login loop is back on staging']],
    ]);
    expect(groups[0]?.rows[0]).toMatchObject({
      tag: 'ENG-418',
      hint: 'In Progress',
      filing: { projectId: 'p-lt' },
      action: { type: 'item' },
    });
    expect(groups[2]?.rows[0]).toMatchObject({ tag: 'Wed 30 Sep', hint: 'Daily Note' });
  });

  it('groups Teams Chats under Teams', () => {
    const chat = item('c-1', 'chat', 'Priya Patel', { source: 'teams' });
    const groups = paletteGroups(context('rollout plan', { hits: [hit(chat)], projects: [] }));

    expect(groups.map((group) => group.title)).toContain('Teams');
    expect(groups.find((group) => group.title === 'Teams')?.rows[0]).toMatchObject({
      label: 'Priya Patel',
      tag: 'TMS',
      hint: 'Teams',
    });
  });

  it('groups pull requests and GitHub issues under GitHub, tagged repo#number', () => {
    const repo = { nodeId: 'R_api', owner: 'acme', name: 'api' };
    const pull = item('pr-12', 'pull-request', 'Retry webhooks with back-off', {
      source: 'github',
      detail: {
        kind: 'pull-request',
        repo,
        number: 12,
        url: 'https://github.com/acme/api/pull/12',
        nodeId: 'PR_12',
        author: 'priya',
        state: 'open',
        draft: false,
        baseBranch: 'main',
        headBranch: 'retry',
        labels: [],
        assignees: [],
        requestedReviewers: [],
        reviews: [],
        reviewDecision: null,
        checks: null,
        closingIssues: [],
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        body: '',
        createdAt: 0,
        updatedAt: 0,
        mergedAt: null,
        closedAt: null,
      },
    });
    const groups = paletteGroups(context('api#12', { hits: [hit(pull, null, true)], projects: [] }));

    expect(groups.find((group) => group.title === 'GitHub')?.rows[0]).toMatchObject({
      label: 'Retry webhooks with back-off',
      tag: 'api#12',
      hint: 'GitHub',
    });
  });

  it('lists the Projects the Core matched', () => {
    expect(shape('long', { hits: [], projects: [project] })[0]).toEqual(['Projects', ['Longtail']]);
  });

  it('lists the People the Core matched as their own group, each opening at their Person', () => {
    const priya: Person = {
      id: 'person-priya',
      name: 'Priya Patel',
      userName: null,
      isUser: false,
      handles: [
        { handle: 'linear:u-priya', source: 'linear', name: 'Priya Patel' },
        { handle: 'github:priya-p', source: 'github', name: null },
        { handle: 'priya@acme.io', source: 'email', name: null },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    const groups = paletteGroups(context('pri', { hits: [hit(issue)], projects: [], people: [priya] }));
    expect(groups.find((group) => group.title === 'People')?.rows).toEqual([
      {
        key: 'person:person-priya',
        tag: 'Person',
        label: 'Priya Patel',
        hint: 'Linear · GitHub · Email',
        action: { type: 'person', personId: 'person-priya' },
      },
    ]);
  });

  it('lists what Ares knows that matches as its own Memory group, each opening at the memory (#74)', () => {
    const memory: Memory = {
      id: 'memory-1',
      kind: 'fact',
      text: 'Priya works mostly on TL',
      confirmed: false,
      by: 'ares',
      personId: null,
      projectId: null,
      ruleId: null,
      sources: [],
      learnedAt: 0,
      updatedAt: 0,
      forReview: false,
    };
    const groups = paletteGroups(context('pri', { hits: [], projects: [], memories: [memory] }));
    expect(groups.find((group) => group.title === 'Memory')?.rows).toEqual([
      {
        key: 'memory:memory-1',
        tag: 'Fact',
        label: 'Priya works mostly on TL',
        hint: 'What Ares knows · unconfirmed',
        action: { type: 'memory', memoryId: 'memory-1' },
      },
    ]);
  });

  it('offers Search in Linear when local results are thin, one row per workspace', () => {
    const thin = paletteGroups(context('okta', { hits: [hit(issue)], projects: [] }));
    expect(thin.at(-1)).toMatchObject({
      title: 'Search in Linear',
      rows: [
        {
          label: 'Search “okta” in Linear',
          hint: 'Acme ↗',
          action: { type: 'browser', url: 'https://linear.app/acme/search?q=okta' },
        },
      ],
    });
    const plenty = paletteGroups(
      context('login', { hits: [hit(issue), hit(todo), hit(block)], projects: [] }),
    );
    expect(plenty.some((group) => group.title === 'Search in Linear')).toBe(false);
  });

  it('offers Search in Gmail, one row per Account, when emails are among the results (#135)', () => {
    const mail = item('e-1', 'email', 'Q4 offsite dates', { source: 'gmail', account: 'google:alex' });
    const gmailAccounts = [{ email: 'alex@gmail.test' }, { email: 'sam@work.test' }];
    const groups = paletteGroups({
      ...context('offsite', { hits: [hit(mail), hit(issue), hit(todo)], projects: [] }),
      gmailAccounts,
    });
    expect(groups.find((group) => group.title === 'Search in Gmail')).toMatchObject({
      rows: [
        {
          label: 'Search “offsite” in Gmail',
          hint: 'alex@gmail.test ↗',
          action: {
            type: 'browser',
            url: 'https://mail.google.com/mail/?authuser=alex%40gmail.test#search/offsite',
          },
        },
        { hint: 'sam@work.test ↗' },
      ],
    });
    const noMail = paletteGroups({
      ...context('login', { hits: [hit(issue)], projects: [] }),
      gmailAccounts,
    });
    expect(noMail.some((group) => group.title === 'Search in Gmail')).toBe(false);
  });

  it('offers Search in Outlook for each Outlook Account when emails are among the results (#136)', () => {
    const mail = item('e-2', 'email', 'Q4 offsite dates', { source: 'outlook', account: 'outlook:t:sam' });
    const groups = paletteGroups({
      ...context('offsite', { hits: [hit(mail)], projects: [] }),
      outlookAccounts: [{ address: 'sam@contoso.test', personal: false }],
    });
    expect(groups.find((group) => group.title === 'Search in Outlook')).toMatchObject({
      rows: [
        {
          label: 'Search “offsite” in Outlook',
          hint: 'sam@contoso.test ↗',
          action: {
            type: 'browser',
            url: 'https://outlook.office.com/mail/deeplink/search?query=offsite&login_hint=sam%40contoso.test',
          },
        },
      ],
    });
  });

  it('offers no Search in Linear without a Linear Account', () => {
    const groups = paletteGroups({ ...context('okta', { hits: [], projects: [] }), linearAccounts: [] });
    expect(groups).toEqual([]);
  });
});

describe('a search narrowed by chips', () => {
  it('shows only results, and Search in Linear only when Linear is in scope', () => {
    expect(shape('in:todos login', { hits: [hit(todo)], projects: [] })).toEqual([
      ['Todos', ['Ask about the login loop']],
    ]);
    expect(shape('in:linear okta', { hits: [], projects: [] })).toEqual([
      ['Search in Linear', ['Search “okta” in Linear']],
    ]);
  });

  it('shows nothing until words are typed', () => {
    expect(shape('in:linear ')).toEqual([]);
  });
});
