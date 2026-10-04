import { describe, expect, it } from 'vitest';
import {
  dueSummaries,
  type GitHubSummaryDetail,
  githubSummaryDetail,
  summaryLead,
  summaryPlacement,
  summaryRangeLabel,
  summaryTitle,
} from './github-summary';
import type { Item } from './items';
import { rankByBandRules } from './ranking';

// Ares's GitHub summary (#121): what is kept of each, how its row and Update line read, and when the
// daily summary and the Monday roll-up are due. Times are in Europe/London; Monday 5 October 2026.

const TZ = 'Europe/London';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 00:00 on Monday 5 October 2026 in London (BST, UTC+1).
const MONDAY = Date.UTC(2026, 9, 4, 23);
const API = { nodeId: 'R_api', owner: 'acme', name: 'titanlink-api' };

function detail(changes: Partial<GitHubSummaryDetail> = {}): GitHubSummaryDetail {
  return githubSummaryDetail.parse({
    kind: 'github-summary',
    cadence: 'daily',
    day: '2026-10-05',
    range: { from: MONDAY - DAY + 7 * HOUR, to: MONDAY + 7 * HOUR },
    choice: null,
    writtenAt: MONDAY + 7 * HOUR + 2 * 60_000,
    sections: [
      {
        kind: 'shipped',
        groups: [
          {
            project: null,
            repos: [
              {
                repo: API,
                entries: [
                  {
                    theme: 'Webhook retries',
                    text: 'Three PRs made webhook delivery retry with backoff, finishing ENG-412.',
                    itemIds: ['pr-1', 'pr-2', 'pr-3'],
                    plain: false,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        kind: 'stuck',
        groups: [
          {
            project: null,
            repos: [
              {
                repo: API,
                entries: [
                  {
                    theme: null,
                    text: 'The session cache PR has waited four days on Omar’s review.',
                    itemIds: ['pr-4'],
                    plain: false,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    onFire: [],
    counts: { shipped: 3, started: 0, stuck: 1, onFire: 0 },
    seenAt: null,
    ...changes,
  });
}

describe('when the summaries are due', () => {
  const none = () => false;

  it('nothing before 05:00, then the daily summary since the last one', () => {
    const lastDailyTo = MONDAY - DAY + 7 * HOUR;
    expect(dueSummaries({ now: MONDAY + 4 * HOUR, timeZone: TZ, lastDailyTo, written: none })).toEqual([]);
    const at = MONDAY + 6 * HOUR;
    expect(
      dueSummaries({ now: at, timeZone: TZ, lastDailyTo, written: none }).find(
        (due) => due.cadence === 'daily',
      ),
    ).toEqual({ cadence: 'daily', day: '2026-10-05', range: { from: lastDailyTo, to: at } });
  });

  it('starts from the start of yesterday with no daily summary yet, and never covers more than a week', () => {
    const at = Date.UTC(2026, 9, 6, 8); // Tuesday 09:00 in London
    expect(dueSummaries({ now: at, timeZone: TZ, lastDailyTo: null, written: none })).toEqual([
      { cadence: 'daily', day: '2026-10-06', range: { from: MONDAY, to: at } },
    ]);
    expect(
      dueSummaries({ now: at, timeZone: TZ, lastDailyTo: at - 30 * DAY, written: none })[0]?.range.from,
    ).toBe(at - 7 * DAY);
  });

  it('one a day: none once today’s is written', () => {
    const written = (cadence: string, day: string) => cadence === 'daily' && day === '2026-10-06';
    expect(dueSummaries({ now: Date.UTC(2026, 9, 6, 15), timeZone: TZ, lastDailyTo: null, written })).toEqual(
      [],
    );
  });

  it('on Mondays, the roll-up of the previous Monday to Sunday too, after the daily one', () => {
    const at = MONDAY + 8 * HOUR;
    expect(dueSummaries({ now: at, timeZone: TZ, lastDailyTo: null, written: none })).toEqual([
      { cadence: 'daily', day: '2026-10-05', range: { from: MONDAY - DAY, to: at } },
      { cadence: 'weekly', day: '2026-10-05', range: { from: MONDAY - 7 * DAY, to: MONDAY } },
    ]);
    const weeklyWritten = (cadence: string) => cadence === 'weekly';
    expect(
      dueSummaries({ now: at, timeZone: TZ, lastDailyTo: null, written: weeklyWritten }).map(
        (due) => due.cadence,
      ),
    ).toEqual(['daily']);
  });

  it('honours the hour it is given (the end-to-end tests start it at midnight)', () => {
    expect(
      dueSummaries({ now: MONDAY + HOUR, timeZone: TZ, lastDailyTo: null, written: none, hour: 0 }),
    ).toHaveLength(2);
  });
});

describe('how a summary reads', () => {
  it('names its range: since yesterday, the week of a roll-up, or what was asked for', () => {
    expect(summaryRangeLabel(detail(), TZ)).toBe('since yesterday');
    expect(
      summaryRangeLabel(detail({ cadence: 'weekly', range: { from: MONDAY - 7 * DAY, to: MONDAY } }), TZ),
    ).toBe('week of 28 Sep');
    expect(summaryRangeLabel(detail({ cadence: 'on-demand', choice: { kind: 'this-week' } }), TZ)).toBe(
      'this week',
    );
    expect(
      summaryRangeLabel(detail({ cadence: 'on-demand', choice: { kind: 'since', day: '2026-10-01' } }), TZ),
    ).toBe('since 1 Oct');
    // A daily summary after a weekend away covers more than yesterday.
    expect(summaryRangeLabel(detail({ range: { from: MONDAY - 3 * DAY, to: MONDAY + 7 * HOUR } }), TZ)).toBe(
      'since Fri 2 Oct',
    );
  });

  it('is titled by what it is, with its Project when it covers one', () => {
    expect(summaryTitle(detail(), TZ)).toBe('GitHub summary · since yesterday');
    expect(
      summaryTitle(detail({ cadence: 'weekly', range: { from: MONDAY - 7 * DAY, to: MONDAY } }), TZ),
    ).toBe('GitHub roll-up · week of 28 Sep');
    expect(
      summaryTitle(
        detail({ cadence: 'on-demand', choice: { kind: 'this-week' }, projectId: 'p1' }),
        TZ,
        'Titanlink',
      ),
    ).toBe('GitHub summary · Titanlink · this week');
  });

  it('sits in FYI with its counts, or in Today when something is on fire', () => {
    expect(summaryPlacement(detail())).toEqual({ band: 'fyi', reason: '3 shipped · 1 stuck' });
    expect(summaryPlacement(detail({ counts: { shipped: 0, started: 0, stuck: 0, onFire: 0 } }))).toEqual({
      band: 'fyi',
      reason: 'A quiet day: nothing shipped',
    });
    expect(
      summaryPlacement(
        detail({
          onFire: ['Main is failing on acme/titanlink-api', '2 reverts on main of acme/web'],
          counts: { shipped: 3, started: 0, stuck: 1, onFire: 2 },
        }),
      ),
    ).toEqual({ band: 'today', reason: 'Main is failing on acme/titanlink-api, and 1 more' });
  });

  it('leads with its first lines, ending “Nothing on fire” when that is true', () => {
    expect(summaryLead(detail())).toBe(
      'Webhook retries: Three PRs made webhook delivery retry with backoff, finishing ENG-412. The session cache PR has waited four days on Omar’s review. Nothing on fire.',
    );
    expect(
      summaryLead(detail({ sections: [], counts: { shipped: 0, started: 0, stuck: 0, onFire: 0 } })),
    ).toBe('Nothing happened worth telling. Nothing on fire.');
  });
});

describe('the Dashboard row', () => {
  const asItem = (summary: GitHubSummaryDetail): Item => ({
    id: 'summary-1',
    kind: 'github-summary',
    source: null,
    account: null,
    externalId: null,
    title: summaryTitle(summary, TZ),
    people: [],
    filing: null,
    status: 'open',
    detail: summary,
    createdAt: summary.writtenAt,
    updatedAt: summary.writtenAt,
    deletedAt: null,
  });

  it('is placed by the band rules: FYI, or Today when something is on fire', () => {
    const context = { now: MONDAY + 9 * HOUR, users: {} };
    expect(rankByBandRules([asItem(detail())], context)).toEqual([
      { itemId: 'summary-1', band: 'fyi', reason: '3 shipped · 1 stuck', rank: 1 },
    ]);
    const burning = detail({ onFire: ['Main is failing on acme/titanlink-api'] });
    expect(rankByBandRules([asItem(burning)], context)).toEqual([
      { itemId: 'summary-1', band: 'today', reason: 'Main is failing on acme/titanlink-api', rank: 1 },
    ]);
  });
});
