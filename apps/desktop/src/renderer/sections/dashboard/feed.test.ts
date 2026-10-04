import type { Item, LinearIssueDetail, Ranking } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  bandCounts,
  type Clears,
  clearRow,
  type FeedRow,
  feedRows,
  keepClears,
  rowMeta,
  sourceTag,
  tabCount,
} from './feed';

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function todo(id: string, dueOn: string | null = null, rest: Partial<Item> = {}): Item {
  return {
    id,
    kind: 'todo',
    source: null,
    account: null,
    externalId: null,
    title: `Todo ${id}`,
    people: [],
    filing: null,
    status: 'open',
    detail: { kind: 'todo', origin: 'manual', dueOn, backedBy: null },
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
    ...rest,
  };
}

function issue(id: string, detail: Partial<LinearIssueDetail> = {}): Item {
  return {
    ...todo(id),
    kind: 'linear-issue',
    source: 'linear',
    account: 'linear:acme',
    detail: {
      kind: 'linear-issue',
      identifier: id,
      url: '',
      team: { id: 't', key: 'ENG', name: 'Engineering' },
      state: { id: 's', name: 'In Progress', type: 'started', color: '' },
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
      createdAt: NOW - DAY,
      updatedAt: NOW - 3 * HOUR,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      ...detail,
    },
  };
}

const ranking = (itemId: string, band: Ranking['band'], rank = 1): Ranking => ({
  itemId,
  band,
  reason: `${band} reason`,
  rank,
});

describe('the rows on the Dashboard', () => {
  it('pairs each ranking with its Item, in the ranked order', () => {
    const items = [todo('a'), todo('b')];
    const rows = feedRows([ranking('b', 'now'), ranking('a', 'today')], items, {}, new Map());
    expect(rows.map((row) => [row.item.id, row.band, row.reason, row.done])).toEqual([
      ['b', 'now', 'now reason', false],
      ['a', 'today', 'today reason', false],
    ]);
  });

  it('leaves out cleared rows while they stay in the band they were cleared from', () => {
    const items = [todo('a'), todo('b')];
    const clears: Clears = { a: { band: 'now', at: NOW } };
    const rows = feedRows([ranking('a', 'now'), ranking('b', 'now', 2)], items, clears, new Map());
    expect(rows.map((row) => row.item.id)).toEqual(['b']);
  });

  it('shows a cleared row again once its band changes', () => {
    const clears: Clears = { a: { band: 'today', at: NOW } };
    const rows = feedRows([ranking('a', 'now')], [todo('a')], clears, new Map());
    expect(rows.map((row) => row.item.id)).toEqual(['a']);
  });

  it('keeps a row ticked here, done and in its place, until the Dashboard is left', () => {
    const ticked: FeedRow = {
      item: { ...todo('a'), status: 'done' },
      band: 'now',
      reason: 'Overdue',
      rank: 1,
      done: true,
    };
    const rows = feedRows([ranking('b', 'now', 1)], [todo('b')], {}, new Map([['a', ticked]]));
    expect(rows.map((row) => [row.item.id, row.done])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });

  it('shows a row ticked here and unticked again as ranked, once', () => {
    const ticked: FeedRow = { item: todo('a'), band: 'now', reason: 'Overdue', rank: 1, done: true };
    const rows = feedRows([ranking('a', 'today')], [todo('a')], {}, new Map([['a', ticked]]));
    expect(rows.map((row) => [row.item.id, row.band, row.done])).toEqual([['a', 'today', false]]);
  });

  it('skips a ranking whose Item it doesn’t have', () => {
    expect(feedRows([ranking('gone', 'now')], [], {}, new Map())).toEqual([]);
  });
});

describe('clearing', () => {
  it('remembers the band a row was cleared from', () => {
    const row: FeedRow = { item: todo('a'), band: 'waiting', reason: '', rank: 1, done: false };
    expect(clearRow({}, row, NOW)).toEqual({ a: { band: 'waiting', at: NOW } });
  });

  it('forgets a clear once its Item is ranked into another band', () => {
    const clears: Clears = { a: { band: 'today', at: NOW }, b: { band: 'now', at: NOW } };
    expect(keepClears(clears, [ranking('a', 'now'), ranking('b', 'now')], NOW)).toEqual({
      b: { band: 'now', at: NOW },
    });
  });

  it('keeps a clear while its Item is off the Dashboard, and forgets it after 30 days', () => {
    const clears: Clears = {
      fresh: { band: 'now', at: NOW - DAY },
      old: { band: 'now', at: NOW - 31 * DAY },
    };
    expect(keepClears(clears, [], NOW)).toEqual({ fresh: { band: 'now', at: NOW - DAY } });
  });

  it('returns the same clears when nothing is forgotten, so nothing is saved again', () => {
    const clears: Clears = { a: { band: 'now', at: NOW } };
    expect(keepClears(clears, [ranking('a', 'now')], NOW)).toBe(clears);
  });
});

describe('counts', () => {
  const row = (id: string, band: Ranking['band'], done = false): FeedRow => ({
    item: todo(id),
    band,
    reason: '',
    rank: 1,
    done,
  });

  it('counts the open rows in each band', () => {
    const rows = [row('a', 'now'), row('b', 'now'), row('c', 'today', true), row('d', 'fyi')];
    expect(bandCounts(rows)).toEqual({ now: 2, today: 0, waiting: 0, fyi: 1 });
  });

  it('puts the open rows in Now and Today on the tab', () => {
    const rows = [
      row('a', 'now'),
      row('b', 'today'),
      row('c', 'today', true),
      row('d', 'waiting'),
      row('e', 'fyi'),
    ];
    expect(tabCount(rows)).toBe(2);
  });
});

describe('how a row is labelled', () => {
  it('stamps Commander’s own Todos TODO, and Linear issues LIN with their state', () => {
    expect(sourceTag(todo('a', '2026-10-02'))).toEqual({ stamp: 'TODO', text: 'Manual · due Fri' });
    expect(sourceTag(todo('b'))).toEqual({ stamp: 'TODO', text: 'Manual' });
    expect(sourceTag(issue('ENG-1'))).toEqual({ stamp: 'LIN', text: 'In Progress' });
  });

  it('says when a Todo is due, on the right', () => {
    const at = (item: Item, band: Ranking['band']) =>
      rowMeta({ item, band, reason: '', rank: 1, done: false }, NOW);
    expect(at(todo('a', '2026-09-28'), 'now')).toEqual(['3D', 'Overdue']);
    expect(at(todo('b', '2026-10-01'), 'today')).toEqual(['Today', 'Due']);
    expect(at(issue('ENG-1', { priority: 1 }), 'now')).toEqual(['Urgent', 'ENG']);
    expect(
      at(issue('ENG-2', { state: { id: 's', name: 'In Review', type: 'started', color: '' } }), 'waiting'),
    ).toEqual(['Rev', 'Reviewers']);
    expect(at(issue('ENG-3'), 'today')).toEqual(['ENG', 'In Progress']);
    expect(
      at(
        issue('ENG-4', {
          state: { id: 's', name: 'Todo', type: 'unstarted', color: '' },
          cycle: { id: 'c', number: 41, name: null, startsAt: 0, endsAt: NOW + DAY },
        }),
        'today',
      ),
    ).toEqual(['ENG', 'Cycle 41']);
    expect(at(issue('ENG-5'), 'fyi')).toEqual(['3H', 'Changed']);
  });
});
