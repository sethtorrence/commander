import { describe, expect, it } from 'vitest';
import { aresRanker, rankingFingerprint } from './ares-ranking';
import type { PullRequestDetail, ReviewRequestDetail } from './github';
import type { Item } from './items';
import { type RankingContext, rankByBandRules } from './ranking';

// The band rules for the User's open work on GitHub (#116), over fixture Items at a fixed local time.
// Who the User is in the GitHub Account (their login) comes from the context, as the window knows it
// from the Account.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GITHUB = 'github:583231';
const context: RankingContext = { now: NOW, users: { [GITHUB]: 'octocat' } };
const repo = { nodeId: 'R_api', owner: 'acme', name: 'api' };

function pull(id: string, changes: Partial<PullRequestDetail> = {}, item: Partial<Item> = {}): Item {
  const detail: PullRequestDetail = {
    kind: 'pull-request',
    repo,
    number: 12,
    url: 'https://github.com/acme/api/pull/12',
    nodeId: `PR_${id}`,
    author: 'octocat',
    state: 'open',
    draft: false,
    baseBranch: 'main',
    headBranch: 'retry',
    labels: [],
    assignees: [],
    requestedReviewers: [],
    reviews: [],
    reviewDecision: 'review-required',
    checks: 'success',
    closingIssues: [],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    body: '',
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW - HOUR,
    mergedAt: null,
    closedAt: null,
    ...changes,
  };
  return {
    id,
    kind: 'pull-request',
    source: 'github',
    account: GITHUB,
    externalId: `R_api:pull/${id}`,
    title: `Pull ${id}`,
    people: [`github:${detail.author}`],
    filing: null,
    status: detail.state === 'open' ? 'open' : 'done',
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW - HOUR,
    deletedAt: null,
    detail,
    ...item,
  };
}

function request(id: string, changes: Partial<ReviewRequestDetail> = {}, author = 'priya'): Item {
  return {
    id,
    kind: 'review-request',
    source: 'github',
    account: GITHUB,
    externalId: `R_api:review-request/${id}`,
    title: `Pull ${id}`,
    people: [`github:${author}`],
    filing: null,
    status: 'open',
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
    detail: {
      kind: 'review-request',
      pullRequest: `R_api:pull/${id}`,
      pullRequestId: null,
      repo,
      number: 12,
      url: 'https://github.com/acme/api/pull/12',
      direct: true,
      teams: [],
      requestedAt: NOW - 2 * DAY,
      ...changes,
    },
  };
}

// The GitHub Todo the Item store keeps for a review request.
function todoFor(backing: Item, status: Item['status'] = 'open'): Item {
  return {
    id: `todo-${backing.id}`,
    kind: 'todo',
    source: null,
    account: null,
    externalId: null,
    title: `Review: ${backing.title}`,
    people: [],
    filing: null,
    status,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
    detail: { kind: 'todo', origin: 'github', dueOn: null, backedBy: backing.id },
  };
}

const withTodo = (backing: Item) => [backing, todoFor(backing)];
const placed = (items: Item[]) =>
  rankByBandRules(items, context).map(({ itemId, band, reason }) => ({ itemId, band, reason }));

describe('review requests', () => {
  it('a review asked of the User directly is for Today, saying who asked and how long ago', () => {
    expect(placed(withTodo(request('r1')))).toEqual([
      { itemId: 'r1', band: 'today', reason: 'priya asked for your review · 2 days' },
    ]);
    expect(placed(withTodo(request('r2', { requestedAt: NOW - 3 * HOUR })))[0]?.reason).toBe(
      'priya asked for your review · 3h',
    );
    expect(placed(withTodo(request('r3', { requestedAt: NOW - DAY - HOUR })))[0]?.reason).toBe(
      'priya asked for your review · 1 day',
    );
  });

  it('a review asked of one of the User’s teams is FYI, naming the team, below every direct one', () => {
    const team = request('team', { direct: false, teams: ['acme/backend'] });
    const direct = request('direct', { requestedAt: NOW - 10 * DAY });
    const ranked = placed([...withTodo(team), ...withTodo(direct)]);
    expect(ranked).toEqual([
      { itemId: 'direct', band: 'today', reason: 'priya asked for your review · 10 days' },
      { itemId: 'team', band: 'fyi', reason: 'Review requested from @acme/backend' },
    ]);
  });

  it('shows the request once, not its Todo, and only while its Todo is open', () => {
    const ticked = request('ticked');
    const untodoed = request('untodoed');
    expect(placed([ticked, todoFor(ticked, 'done'), untodoed])).toEqual([]);
  });
});

describe('the User’s pull requests', () => {
  it('failing checks are for Today', () => {
    expect(placed([pull('p1', { checks: 'failure' })])).toEqual([
      { itemId: 'p1', band: 'today', reason: 'Checks failing on your PR' },
    ]);
  });

  it('changes requested are for Today, naming who asked for them', () => {
    const reviews = [{ login: 'omar', state: 'changes-requested' as const, submittedAt: NOW - HOUR }];
    expect(placed([pull('p2', { reviews, reviewDecision: 'changes-requested' })])).toEqual([
      { itemId: 'p2', band: 'today', reason: 'omar requested changes' },
    ]);
  });

  it('an open, ready pull request waiting on reviewers is Waiting on others, ranked below failing checks', () => {
    const waiting = pull('waiting', {
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 3 * DAY }],
    });
    const failing = pull('failing', { checks: 'error' });
    expect(placed([waiting, failing])).toEqual([
      { itemId: 'failing', band: 'today', reason: 'Checks failing on your PR' },
      { itemId: 'waiting', band: 'waiting', reason: 'Waiting on omar’s review · 3 days' },
    ]);
    const two = pull('two', {
      requestedReviewers: [
        { kind: 'user', login: 'omar', requestedAt: NOW - 3 * DAY },
        { kind: 'team', team: 'acme/backend', requestedAt: NOW - 3 * DAY },
      ],
    });
    expect(placed([two])[0]?.reason).toBe('Waiting on omar and @acme/backend’s reviews · 3 days');
  });

  it('leaves out drafts waiting on review, approved ones, others’ pull requests and closed ones', () => {
    const asked = [{ kind: 'user' as const, login: 'omar', requestedAt: NOW - DAY }];
    expect(
      placed([
        pull('draft', { draft: true, requestedReviewers: asked }),
        pull('approved', { reviewDecision: 'approved', requestedReviewers: asked }),
        pull('theirs', { author: 'priya', checks: 'failure' }),
        pull('merged', { state: 'merged', checks: 'failure' }),
        pull('quiet'),
      ]),
    ).toEqual([]);
  });

  it('needs to know who the User is on GitHub', () => {
    expect(rankByBandRules([pull('p1', { checks: 'failure' })], { now: NOW, users: {} })).toEqual([]);
  });
});

describe('Ares’s ranking', () => {
  it('ranks open work again once what the rules go by changes', () => {
    const before = pull('p1');
    const after = pull('p1', { checks: 'failure' });
    expect(rankingFingerprint(before)).not.toBe(rankingFingerprint(after));
    const asked = request('r1');
    expect(rankingFingerprint(asked)).not.toBe(
      rankingFingerprint(request('r1', { direct: false, teams: ['acme/backend'] })),
    );
  });

  it('places open work with his reasons', () => {
    const items = [...withTodo(request('r1')), pull('p1', { checks: 'failure' })];
    const ranking = {
      by: 'ares' as const,
      at: NOW - HOUR,
      why: null,
      entries: [
        {
          itemId: 'p1',
          band: 'now' as const,
          rank: 1,
          reason: 'Release is blocked on this',
          fingerprint: rankingFingerprint(items[2] as Item),
        },
      ],
    };
    expect(
      aresRanker(ranking)(items, context).map(({ itemId, band, reason }) => ({ itemId, band, reason })),
    ).toEqual([
      { itemId: 'p1', band: 'now', reason: 'Release is blocked on this' },
      { itemId: 'r1', band: 'today', reason: 'priya asked for your review · 2 days' },
    ]);
  });
});
