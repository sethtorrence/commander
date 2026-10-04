import type { Project } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { dayTargets, projectTargets, resolveDays, searchTargets } from './link-targets';

// Saturday 3 October 2026.
const today = '2026-10-03';

const project = (fields: Partial<Project> & Pick<Project, 'id' | 'name' | 'code'>): Project => ({
  accent: 'blue',
  order: 0,
  archived: false,
  createdAt: 0,
  ...fields,
});

const projects = [
  project({ id: 'p-lt', name: 'Longtail', code: 'LT', order: 0 }),
  project({ id: 'p-tl', name: 'Titanlink', code: 'TL', order: 1 }),
  project({ id: 'p-old', name: 'Old tactics', code: 'OT', order: 2, archived: true }),
];

describe('resolving a day from what is typed after [[', () => {
  it.each([
    ['today', ['2026-10-03']],
    ['Today', ['2026-10-03']],
    ['yesterday', ['2026-10-02']],
    ['yes', ['2026-10-02']],
    ['tomorrow', ['2026-10-04']],
    // A weekday is the most recent one, today included.
    ['thursday', ['2026-10-01']],
    ['saturday', ['2026-10-03']],
    ['sunday', ['2026-09-27']],
    ['mon', ['2026-09-28']],
    // Explicit dates, with or without the year.
    ['2026-10-09', ['2026-10-09']],
    ['9 October', ['2026-10-09']],
    ['9 oct 2025', ['2025-10-09']],
    ['Oct 9', ['2026-10-09']],
    ['December 25 2026', ['2026-12-25']],
  ])('“%s” is %j', (query, days) => {
    expect(resolveDays(query, today)).toEqual(days);
  });

  it('offers every day word a short prefix could mean', () => {
    expect(resolveDays('t', today)).toEqual(['2026-10-03', '2026-10-04', '2026-09-29', '2026-10-01']);
  });

  it('offers today and yesterday before anything is typed', () => {
    expect(resolveDays('', today)).toEqual(['2026-10-03', '2026-10-02']);
  });

  it('finds nothing in words that are not days or impossible dates', () => {
    expect(resolveDays('Longtail', today)).toEqual([]);
    expect(resolveDays('2026-02-30', today)).toEqual([]);
    expect(resolveDays('31 Feb', today)).toEqual([]);
  });
});

describe('the [[ picker’s targets', () => {
  it('names days the way the User reads them', () => {
    expect(dayTargets(today).search('')).toEqual([
      {
        key: 'day:2026-10-03',
        target: { type: 'day', day: '2026-10-03' },
        label: 'Today',
        hint: 'Sat 3 Oct',
      },
      {
        key: 'day:2026-10-02',
        target: { type: 'day', day: '2026-10-02' },
        label: 'Yesterday',
        hint: 'Fri 2 Oct',
      },
    ]);
    expect(dayTargets(today).search('thu')[0]).toMatchObject({ label: 'Thursday', hint: 'Thu 1 Oct' });
    expect(dayTargets(today).search('2025-01-02')[0]).toMatchObject({ label: 'Thu 2 Jan 2025' });
  });

  it('finds Projects by name or code, archived ones included and last', () => {
    const search = projectTargets(projects).search;
    expect(search('long').map((c) => c.key)).toEqual(['project:p-lt']);
    expect(search('tl').map((c) => c.key)).toEqual(['project:p-tl']);
    expect(search('t').map((c) => c.key)).toEqual(['project:p-lt', 'project:p-tl', 'project:p-old']);
    expect(search('old')).toEqual([
      {
        key: 'project:p-old',
        target: { type: 'project', projectId: 'p-old' },
        label: 'Old tactics',
        hint: 'Archived',
        project: projects[2],
      },
    ]);
  });

  it('lists every provider’s matches in groups, skipping empty groups', () => {
    const groups = searchTargets([dayTargets(today), projectTargets(projects)], 't');
    expect(groups.map((group) => [group.provider.label, group.candidates.map((c) => c.label)])).toEqual([
      ['Days', ['Today', 'Tomorrow', 'Tuesday', 'Thursday']],
      ['Projects', ['Longtail', 'Titanlink', 'Old tactics']],
    ]);
    expect(searchTargets([projectTargets(projects)], 'tit')[0]?.candidates[0]?.label).toBe('Titanlink');
    expect(searchTargets([dayTargets(today), projectTargets(projects)], 'zzz')).toEqual([]);
  });
});
