import { describe, expect, it } from 'vitest';
import {
  type AresRankingEntry,
  aresRanker,
  type DashboardRanking,
  isSuggestionItemId,
  rankingFingerprint,
  rankingOrigin,
  suggestionItemId,
} from './ares-ranking';
import type { Item } from './items';
import type { LinearIssueDetail, LinearUser } from './linear';
import { type RankingContext, rankByBandRules } from './ranking';

// Ares's ranking as the window applies it: his bands, ranks and reasons for the Items he ranked as
// they are, the band rules for the rest, and the rules alone whenever his ranking can't be used.
// Thursday 1 October 2026, 11:40, local.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACCOUNT = 'linear:org-acme';
const ME: LinearUser = { id: 'user-sam', name: 'Sam Rivera', displayName: 'sam', email: null };
const context: RankingContext = { now: NOW, users: { [ACCOUNT]: ME.id } };

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
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
    detail: { kind: 'todo', origin: 'manual', dueOn, backedBy: null },
    ...rest,
  };
}

function issue(id: string, detail: Partial<LinearIssueDetail> = {}): Item {
  return {
    ...todo(id),
    kind: 'linear-issue',
    source: 'linear',
    account: ACCOUNT,
    externalId: `ext-${id}`,
    title: `Issue ${id}`,
    detail: {
      kind: 'linear-issue',
      identifier: id,
      url: `https://linear.app/acme/issue/${id}`,
      team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
      state: { id: 's-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
      priority: 0,
      assignee: ME,
      creator: ME,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 2 * DAY,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      ...detail,
    },
  };
}

const entry = (item: Item, band: AresRankingEntry['band'], rank: number, reason: string) => ({
  itemId: item.id,
  band,
  rank,
  reason,
  fingerprint: rankingFingerprint(item),
});

const byAres = (entries: AresRankingEntry[], at = NOW - HOUR): DashboardRanking => ({
  by: 'ares',
  at,
  why: null,
  entries,
});

describe('rankingFingerprint', () => {
  it('stays the same while nothing Ares ranks by changes', () => {
    const item = todo('a', '2026-10-02');
    expect(rankingFingerprint(item)).toBe(rankingFingerprint({ ...item, injectionWarning: { at: NOW } }));
    expect(rankingFingerprint(item)).toBe(rankingFingerprint({ ...item }));
  });

  it('changes with the title, the due date, the Project, or an issue’s state or last change', () => {
    const item = todo('a', '2026-10-02');
    const linear = issue('ENG-1');
    const fingerprint = rankingFingerprint(item);
    expect(rankingFingerprint({ ...item, title: 'Other' })).not.toBe(fingerprint);
    expect(rankingFingerprint(todo('a', '2026-10-03'))).not.toBe(fingerprint);
    expect(rankingFingerprint({ ...item, filing: { projectId: 'p-lt', filedBy: 'user' } })).not.toBe(
      fingerprint,
    );
    const detail = linear.detail as LinearIssueDetail;
    expect(rankingFingerprint({ ...linear, detail: { ...detail, priority: 1 } })).not.toBe(
      rankingFingerprint(linear),
    );
    expect(rankingFingerprint({ ...linear, detail: { ...detail, updatedAt: NOW } })).not.toBe(
      rankingFingerprint(linear),
    );
  });
});

describe('suggestion ids', () => {
  it('names a pending suggestion apart from any Item', () => {
    expect(suggestionItemId(12)).toBe('suggestion:12');
    expect(isSuggestionItemId('suggestion:12')).toBe(true);
    expect(isSuggestionItemId('0b5c…')).toBe(false);
  });
});

describe('aresRanker', () => {
  it('uses Ares’s bands, ranks and reasons for the Items he ranked', () => {
    const report = todo('report');
    const runbook = issue('ENG-2');
    const ranker = aresRanker(
      byAres([
        entry(runbook, 'now', 1, 'Priya needs it before the 3pm review'),
        entry(report, 'today', 1, 'Dana’s waiting on this before Friday'),
      ]),
    );
    expect(ranker([report, runbook], context)).toEqual([
      { itemId: 'ENG-2', band: 'now', rank: 1, reason: 'Priya needs it before the 3pm review' },
      { itemId: 'report', band: 'today', rank: 1, reason: 'Dana’s waiting on this before Friday' },
    ]);
  });

  it('leaves off the Items Ares put in no band, even when the rules would place them', () => {
    const due = todo('due', '2026-10-01');
    expect(aresRanker(byAres([entry(due, 'none', 1, '')]))([due], context)).toEqual([]);
  });

  it('places Items Ares hasn’t ranked by the rules, after his in the same band', () => {
    const his = todo('his');
    const overdue = todo('overdue', '2026-09-30');
    const rankings = aresRanker(byAres([entry(his, 'now', 1, 'Blocking the release')]))(
      [overdue, his],
      context,
    );
    expect(rankings).toEqual([
      { itemId: 'his', band: 'now', rank: 1, reason: 'Blocking the release' },
      { itemId: 'overdue', band: 'now', rank: 2, reason: 'Overdue since yesterday' },
    ]);
  });

  it('lets the rules take over an Item that changed since Ares ranked it, where they place it', () => {
    const before = todo('moved', '2026-10-05');
    const after = todo('moved', '2026-09-30');
    const rankings = aresRanker(byAres([entry(before, 'fyi', 1, 'Not until next week')]))([after], context);
    expect(rankings).toEqual([{ itemId: 'moved', band: 'now', rank: 1, reason: 'Overdue since yesterday' }]);
  });

  it('keeps Ares’s word for a changed Item the rules have no place for, until he ranks again', () => {
    const before = todo('filed');
    const after = { ...before, filing: { projectId: 'p-lt', filedBy: 'user' as const } };
    const rankings = aresRanker(byAres([entry(before, 'today', 1, 'Due at the standup')]))([after], context);
    expect(rankings).toEqual([{ itemId: 'filed', band: 'today', rank: 1, reason: 'Due at the standup' }]);
  });

  it('ranks closed Items nowhere, whatever Ares said', () => {
    const done = todo('done', null, { status: 'done' });
    expect(aresRanker(byAres([entry(done, 'now', 1, 'Urgent')]))([done], context)).toEqual([]);
  });

  it('shows a Todo backed by another Item once, by that Item', () => {
    const backing = issue('ENG-3');
    const backed = todo('backed', null, {
      detail: { kind: 'todo', origin: 'linear', dueOn: null, backedBy: 'ENG-3' },
    });
    const rankings = aresRanker(
      byAres([entry(backing, 'today', 1, 'In progress'), entry(backed, 'today', 2, 'Also')]),
    )([backing, backed], context);
    expect(rankings.map((ranking) => ranking.itemId)).toEqual(['ENG-3']);
  });

  it('uses the rules alone when the ranking is the rules’, or Ares’s is from another day', () => {
    const his = todo('his');
    const due = todo('due', '2026-10-01');
    const rules: DashboardRanking = { by: 'rules', at: null, why: 'Ares is off', entries: [] };
    expect(aresRanker(rules)([his, due], context)).toEqual(rankByBandRules([his, due], context));
    const yesterday = byAres([entry(his, 'now', 1, 'Urgent')], NOW - DAY);
    expect(aresRanker(yesterday)([his, due], context)).toEqual(rankByBandRules([his, due], context));
    expect(aresRanker(null)([his, due], context)).toEqual(rankByBandRules([his, due], context));
  });
});

describe('rankingOrigin', () => {
  it('says who ranked the Dashboard, and when', () => {
    expect(rankingOrigin(byAres([], NOW - HOUR), NOW)).toEqual({ by: 'ares', at: NOW - HOUR, why: null });
  });

  it('says the rules ranked it, and why, when Ares’s ranking can’t be used', () => {
    expect(rankingOrigin({ by: 'rules', at: null, why: 'Ares is off', entries: [] }, NOW)).toEqual({
      by: 'rules',
      at: null,
      why: 'Ares is off',
    });
    expect(rankingOrigin(byAres([], NOW - DAY), NOW)).toEqual({
      by: 'rules',
      at: null,
      why: 'Ares hasn’t ranked it today yet',
    });
    expect(rankingOrigin(null, NOW)).toEqual({ by: 'rules', at: null, why: null });
  });
});
