import type { Project } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { type QueryContext, readQuery, scopeFor, toggleChip } from './query';

const project = (id: string, name: string, code: string): Project => ({
  id,
  name,
  code,
  accent: 'blue',
  order: 0,
  archived: false,
  createdAt: 0,
});

const context: QueryContext = {
  projects: [project('p-lt', 'Longtail', 'LT'), project('p-tl', 'Titanlink', 'TL')],
  accounts: [
    { id: 'linear:org-acme', name: 'Acme' },
    { id: 'linear:org-globex', name: 'Globex Corp' },
  ],
  // Saturday 3 October 2026, 10:00 local.
  now: new Date(2026, 9, 3, 10),
};

describe('reading the palette input', () => {
  it('is plain text when there are no chips', () => {
    expect(readQuery('login loop', context)).toMatchObject({
      text: 'login loop',
      chips: [],
      search: { text: 'login loop' },
    });
  });

  it('keeps the trailing space, which ends the last word', () => {
    expect(readQuery('login ', context).search?.text).toBe('login ');
  });

  it('reads a Project chip by its code, or Unfiled', () => {
    const query = readQuery('#lt invoice', context);
    expect(query.text).toBe('invoice');
    expect(query.chips).toEqual([{ type: 'project', token: '#lt', label: 'LT', projectId: 'p-lt' }]);
    expect(query.search).toMatchObject({ text: 'invoice', projectId: 'p-lt' });
    expect(readQuery('invoice #unfiled', context).search).toMatchObject({ text: 'invoice', projectId: null });
  });

  it('reads a Section chip as the kinds it holds', () => {
    expect(readQuery('in:notes rate limiter', context).search).toMatchObject({
      text: 'rate limiter',
      kinds: ['block', 'daily-note'],
    });
    expect(readQuery('in:Linear in:todos x', context).search?.kinds).toEqual(['linear-issue', 'todo']);
  });

  it('reads an Account chip by its name, spaces left out', () => {
    expect(readQuery('@acme sso', context).search).toMatchObject({ accounts: ['linear:org-acme'] });
    expect(readQuery('@globexcorp sso', context).search).toMatchObject({ accounts: ['linear:org-globex'] });
  });

  it('reads date chips as local days: after from its start, before up to its start', () => {
    const query = readQuery('after:2026-09-01 before:2026-10-01 x', context);
    expect(query.search).toMatchObject({
      from: new Date(2026, 8, 1).getTime(),
      to: new Date(2026, 9, 1).getTime(),
    });
    expect(readQuery('after:today x', context).search?.from).toBe(new Date(2026, 9, 3).getTime());
    expect(readQuery('after:yesterday x', context).search?.from).toBe(new Date(2026, 9, 2).getTime());
  });

  it('leaves what it cannot read as words to search for', () => {
    const query = readQuery('#zz in:nowhere @nobody after:soon hashtag', context);
    expect(query.chips).toEqual([]);
    expect(query.text).toBe('#zz in:nowhere @nobody after:soon hashtag');
  });

  it('has no search when only chips are typed', () => {
    const query = readQuery('in:linear ', context);
    expect(query.chips).toHaveLength(1);
    expect(query.text).toBe('');
    expect(query.search).toBeNull();
  });
});

describe('the scope `/` starts from', () => {
  it("is the Section's chip and the Project filter's", () => {
    expect(scopeFor('linear', 'p-lt', context.projects)).toBe('in:linear #LT ');
    expect(scopeFor('todos', 'unfiled', context.projects)).toBe('in:todos #unfiled ');
    expect(scopeFor('notes', 'everything', context.projects)).toBe('in:notes ');
  });

  it('is only the Project filter in a Section search cannot narrow to', () => {
    expect(scopeFor('dashboard', 'p-tl', context.projects)).toBe('#TL ');
    expect(scopeFor('dashboard', 'everything', context.projects)).toBe('');
  });
});

describe('picking a chip from the filter row', () => {
  it('adds it in front, or takes it out again', () => {
    expect(toggleChip('invoice', 'in:todos')).toBe('in:todos invoice');
    expect(toggleChip('in:todos invoice', 'in:todos')).toBe('invoice');
    expect(toggleChip('', '#LT')).toBe('#LT ');
  });

  it('matches a typed chip whatever its case', () => {
    expect(toggleChip('#lt invoice', '#LT')).toBe('invoice');
  });
});
