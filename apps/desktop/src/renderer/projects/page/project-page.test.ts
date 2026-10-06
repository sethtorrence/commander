import type { FiledBy, Item } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { filingBreakdown, projectPartNumber, sectionCounts } from './project-page';

const item = (kind: Item['kind'], status: Item['status'], filedBy: FiledBy = 'user') => ({
  kind,
  status,
  filing: { projectId: 'p-lt', filedBy },
});

describe('a Project page’s numbers', () => {
  it('counts open Todos, the Notes’ Blocks, the Teams Chats and open GitHub work, by kind', () => {
    expect(
      sectionCounts([
        item('todo', 'open'),
        item('todo', 'open'),
        item('todo', 'done'),
        item('block', 'open'),
        item('email', 'open'),
        item('chat', 'open'),
        // Open pull requests and issues; not merged ones, releases, or review requests (their pull
        // request's shadow).
        item('pull-request', 'open'),
        item('github-issue', 'open'),
        item('pull-request', 'done'),
        item('github-release', 'done'),
        item('review-request', 'open'),
      ]),
    ).toEqual({ todos: 2, notes: 1, teams: 1, github: 2 });
    expect(sectionCounts([])).toEqual({ todos: 0, notes: 0, teams: 0, github: 0 });
  });

  it('counts how its Items were filed: by a Rule, by Ares, by the User, or inherited', () => {
    expect(
      filingBreakdown([
        item('todo', 'open', 'user'),
        item('todo', 'done', 'user'),
        item('email', 'open', 'rule'),
        item('block', 'open', 'inherited'),
        item('todo', 'open', 'ares'),
        { filing: null },
      ]),
    ).toEqual({ rule: 1, ares: 1, user: 2, inherited: 1 });
  });

  it('gives the sheet a part number from the Badge code and the day of the year', () => {
    expect(projectPartNumber('LT', new Date(2026, 9, 1))).toBe('PRJ-LT-274');
    expect(projectPartNumber('TX', new Date(2026, 0, 5))).toBe('PRJ-TX-005');
  });
});
