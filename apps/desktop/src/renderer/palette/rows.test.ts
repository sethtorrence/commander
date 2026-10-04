import type { Item, Project, SearchHit, SearchResult } from '@commander/domain';
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

  it('lists the Projects the Core matched', () => {
    expect(shape('long', { hits: [], projects: [project] })[0]).toEqual(['Projects', ['Longtail']]);
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
