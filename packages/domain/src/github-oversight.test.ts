import { describe, expect, it } from 'vitest';
import type {
  GitHubIssueDetail,
  GitHubReleaseDetail,
  GitHubRepoHealth,
  GitHubRepoName,
  PullRequestDetail,
} from './github';
import {
  defaultOversightSettings,
  type OversightInput,
  type OversightSummary,
  oversightRange,
  oversightSummary,
  plainSummary,
} from './github-oversight';
import type { Item } from './items';

// The facts behind the oversight summary (#119): for a time range and a scope, what Shipped, what
// Started, what's Stuck and what's On fire, from local Items and repo health only, grouped by Project
// (Items' filing, Unfiled last) then repo. And the plain summary made from them with no model.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Sunday 4 October 2026, 15:00 UTC: "now", the end of every range here.
const NOW = Date.UTC(2026, 9, 4, 15);
// Since yesterday's start (UTC), for these tests.
const FROM = Date.UTC(2026, 9, 3);

const API: GitHubRepoName = { nodeId: 'R_api', owner: 'acme', name: 'api' };
const WEB: GitHubRepoName = { nodeId: 'R_web', owner: 'acme', name: 'web' };
const DOCS: GitHubRepoName = { nodeId: 'R_docs', owner: 'acme', name: 'docs' };

const TITANLINK = { id: 'p-titan', name: 'Titanlink', code: 'TL', accent: 'blue' as const };
const LONGTAIL = { id: 'p-long', name: 'Longtail', code: 'LT', accent: 'green' as const };

let next = 0;

function item(kind: Item['kind'], title: string, detail: Item['detail'], projectId: string | null): Item {
  next += 1;
  return {
    id: `${kind}-${next}`,
    kind,
    source: 'github',
    account: 'github:1',
    externalId: `x-${next}`,
    title,
    people: [],
    filing: projectId ? { projectId, filedBy: 'rule' } : null,
    status: 'open',
    detail,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function pr(
  changes: Partial<PullRequestDetail> & { title?: string; projectId?: string | null } = {},
): Item & { detail: PullRequestDetail } {
  const { title = 'A change', projectId = null, ...detail } = changes;
  const number = detail.number ?? next + 100;
  return item(
    'pull-request',
    title,
    {
      kind: 'pull-request',
      repo: API,
      number,
      url: `https://github.com/acme/api/pull/${number}`,
      nodeId: `PR_${number}`,
      author: 'priya',
      state: 'open',
      draft: false,
      baseBranch: 'main',
      headBranch: `branch-${number}`,
      labels: [],
      assignees: [],
      requestedReviewers: [],
      reviews: [],
      reviewDecision: null,
      checks: 'success',
      closingIssues: [],
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      body: '',
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW - HOUR,
      mergedAt: null,
      closedAt: null,
      ...detail,
    },
    projectId,
  ) as Item & { detail: PullRequestDetail };
}

function issue(
  changes: Partial<GitHubIssueDetail> & { title?: string; projectId?: string | null } = {},
): Item {
  const { projectId = null, title = 'An issue', ...detail } = changes;
  const number = detail.number ?? next + 100;
  return item(
    'github-issue',
    title,
    {
      kind: 'github-issue',
      repo: API,
      number,
      url: `https://github.com/acme/api/issues/${number}`,
      nodeId: `I_${number}`,
      author: 'omar',
      assignees: [],
      labels: [],
      milestone: null,
      state: 'open',
      stateReason: null,
      body: '',
      commentCount: 0,
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW - DAY,
      closedAt: null,
      parent: null,
      subIssues: null,
      ...detail,
    },
    projectId,
  );
}

function release(changes: Partial<GitHubReleaseDetail> & { projectId?: string | null } = {}): Item {
  const { projectId = null, ...detail } = changes;
  return item(
    'github-release',
    detail.tag ?? 'v1.0.0',
    {
      kind: 'github-release',
      repo: API,
      tag: 'v1.0.0',
      name: null,
      url: 'https://github.com/acme/api/releases/v1.0.0',
      author: 'priya',
      prerelease: false,
      publishedAt: NOW - 2 * HOUR,
      notes: '',
      ...detail,
    },
    projectId,
  );
}

function health(repo: GitHubRepoName, changes: Partial<GitHubRepoHealth> = {}): GitHubRepoHealth {
  return {
    repo,
    defaultBranch: 'main',
    head: { oid: `head-${repo.name}`, checks: 'success', committedAt: NOW - 3 * HOUR },
    commits: [],
    checkedAt: NOW - HOUR,
    ...changes,
  };
}

function oversight(input: Partial<OversightInput>): OversightSummary {
  return oversightSummary({
    range: { from: FROM, to: NOW },
    items: [],
    repos: [],
    projects: [TITANLINK, LONGTAIL],
    settings: defaultOversightSettings,
    ...input,
  });
}

const section = (result: OversightSummary, kind: OversightSummary['sections'][number]['kind']) =>
  result.sections.find((each) => each.kind === kind)?.groups ?? [];
const entries = (result: OversightSummary, kind: OversightSummary['sections'][number]['kind']) =>
  section(result, kind).flatMap((group) => group.entries);

describe('Shipped', () => {
  it('counts the pull requests merged in the range, per repo, with the releases published in it', () => {
    const merged = pr({ state: 'merged', mergedAt: NOW - 5 * HOUR, closedAt: NOW - 5 * HOUR });
    const alsoMerged = pr({ state: 'merged', mergedAt: FROM + HOUR, closedAt: FROM + HOUR });
    const before = pr({ state: 'merged', mergedAt: FROM - HOUR, closedAt: FROM - HOUR });
    const closedUnmerged = pr({ state: 'closed', closedAt: NOW - HOUR });
    const open = pr();
    const shipped = release({ tag: 'v2.3.0' });
    const oldRelease = release({ tag: 'v2.2.0', publishedAt: FROM - DAY });
    const webMerged = pr({ repo: WEB, state: 'merged', mergedAt: NOW - HOUR, closedAt: NOW - HOUR });

    const result = oversight({
      items: [merged, alsoMerged, before, closedUnmerged, open, shipped, oldRelease, webMerged],
    });

    expect(entries(result, 'shipped')).toEqual([
      {
        repo: API,
        // Pull requests, then issues, then releases; each kind oldest first.
        itemIds: [alsoMerged.id, merged.id, shipped.id],
        facts: { kind: 'shipped', merged: 2, issuesClosed: 0, releases: ['v2.3.0'], tickets: [] },
      },
      {
        repo: WEB,
        itemIds: [webMerged.id],
        facts: { kind: 'shipped', merged: 1, issuesClosed: 0, releases: [], tickets: [] },
      },
    ]);
  });

  it('counts issues closed as done in the range, but not those closed as not planned', () => {
    const done = issue({ state: 'closed', stateReason: 'completed', closedAt: NOW - HOUR });
    const notPlanned = issue({ state: 'closed', stateReason: 'not-planned', closedAt: NOW - HOUR });
    const duplicate = issue({ state: 'closed', stateReason: 'duplicate', closedAt: NOW - HOUR });
    const earlier = issue({ state: 'closed', stateReason: 'completed', closedAt: FROM - HOUR });

    expect(entries(oversight({ items: [done, notPlanned, duplicate, earlier] }), 'shipped')).toEqual([
      {
        repo: API,
        itemIds: [done.id],
        facts: { kind: 'shipped', merged: 0, issuesClosed: 1, releases: [], tickets: [] },
      },
    ]);
  });
});

describe('Started', () => {
  it('counts the pull requests and issues opened in the range, per repo', () => {
    const opened = pr({ createdAt: NOW - 2 * HOUR });
    const openedAndMerged = pr({
      createdAt: FROM + HOUR,
      state: 'merged',
      mergedAt: NOW - HOUR,
      closedAt: NOW - HOUR,
    });
    const older = pr({ createdAt: FROM - HOUR });
    const newIssue = issue({ createdAt: NOW - 3 * HOUR });

    expect(entries(oversight({ items: [opened, openedAndMerged, older, newIssue] }), 'started')).toEqual([
      {
        repo: API,
        itemIds: [openedAndMerged.id, opened.id, newIssue.id],
        facts: { kind: 'started', pullRequests: 2, issues: 1, claimed: [] },
      },
    ]);
  });

  it('leaves out bots: [bot] authors and the configured list, whatever their case', () => {
    const person = pr({ createdAt: NOW - HOUR, author: 'priya' });
    const appBot = pr({ createdAt: NOW - HOUR, author: 'github-actions[bot]' });
    const dependabot = pr({ createdAt: NOW - HOUR, author: 'dependabot' });
    const renovate = pr({ createdAt: NOW - HOUR, author: 'Renovate[bot]' });
    const ourBot = issue({ createdAt: NOW - HOUR, author: 'acme-release-bot' });

    const byDefault = oversight({ items: [person, appBot, dependabot, renovate, ourBot] });
    expect(entries(byDefault, 'started').flatMap((entry) => entry.itemIds)).toEqual([person.id, ourBot.id]);

    const withOurs = oversight({
      items: [person, appBot, dependabot, renovate, ourBot],
      settings: { ...defaultOversightSettings, bots: ['acme-release-bot'] },
    });
    // The list is the User's: Dependabot counts once it is taken off it.
    expect(entries(withOurs, 'started').flatMap((entry) => entry.itemIds)).toEqual([
      person.id,
      dependabot.id,
    ]);
  });

  it('leaves out drafts opened and closed within the range, but keeps drafts still open', () => {
    const abandoned = pr({ draft: true, createdAt: FROM + HOUR, state: 'closed', closedAt: NOW - HOUR });
    const stillDrafting = pr({ draft: true, createdAt: FROM + HOUR });
    const oldDraftClosed = pr({ draft: true, createdAt: FROM - DAY, state: 'closed', closedAt: NOW - HOUR });

    expect(
      entries(oversight({ items: [abandoned, stillDrafting, oldDraftClosed] }), 'started').flatMap(
        (entry) => entry.itemIds,
      ),
    ).toEqual([stillDrafting.id]);
  });

  it('leaves out skill-managed issues merely opened (#120)', () => {
    const map = issue({ createdAt: NOW - HOUR, labels: [{ name: 'wayfinder:map', color: 'ededed' }] });
    const ticket = issue({ createdAt: NOW - HOUR, labels: [{ name: 'ready-for-agent', color: 'ededed' }] });
    const plain = issue({ createdAt: NOW - HOUR });
    const result = oversight({ items: [map, ticket, plain] });
    expect(entries(result, 'started').flatMap((entry) => entry.itemIds)).toEqual([plain.id]);
  });
});

describe('Stuck', () => {
  it('names open pull requests whose review was asked more than 2 days ago, with no review since', () => {
    const waiting = pr({
      number: 12,
      title: 'Retry webhooks',
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 4 * DAY - HOUR }],
    });
    const askedYesterday = pr({
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - DAY }],
    });
    // Reviewed after being asked (and asked again since GitHub keeps him listed): not waiting.
    const reviewedSince = pr({
      requestedReviewers: [{ kind: 'team', team: 'acme/core', requestedAt: NOW - 5 * DAY }],
      reviews: [{ login: 'sam', state: 'commented', submittedAt: NOW - 3 * DAY }],
    });
    const unknownWhen = pr({ requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: null }] });

    expect(
      entries(oversight({ items: [waiting, askedYesterday, reviewedSince, unknownWhen] }), 'stuck'),
    ).toEqual([
      {
        repo: API,
        itemIds: [waiting.id],
        facts: {
          kind: 'stuck',
          number: 12,
          title: 'Retry webhooks',
          author: 'priya',
          reasons: [{ kind: 'review-waiting', reviewer: 'omar', name: 'omar', days: 4 }],
        },
      },
    ]);
  });

  it('names open pull requests whose checks are failing', () => {
    const failing = pr({ number: 14, checks: 'failure' });
    const erroring = pr({ number: 15, checks: 'error' });
    const pending = pr({ checks: 'pending' });
    const mergedFailing = pr({ checks: 'failure', state: 'merged', mergedAt: NOW - DAY });

    const stuck = entries(oversight({ items: [failing, erroring, pending, mergedFailing] }), 'stuck');
    expect(stuck.map((entry) => entry.itemIds)).toEqual([[failing.id], [erroring.id]]);
    expect(stuck.map((entry) => entry.facts.kind === 'stuck' && entry.facts.reasons)).toEqual([
      [{ kind: 'checks-failing' }],
      [{ kind: 'checks-failing' }],
    ]);
  });

  it('names open, non-draft pull requests older than 7 days with no activity for 5 days', () => {
    const idle = pr({ number: 20, createdAt: NOW - 10 * DAY, updatedAt: NOW - 6 * DAY });
    const young = pr({ createdAt: NOW - 6 * DAY, updatedAt: NOW - 6 * DAY });
    const active = pr({ createdAt: NOW - 10 * DAY, updatedAt: NOW - 4 * DAY });
    const draft = pr({ draft: true, createdAt: NOW - 10 * DAY, updatedAt: NOW - 6 * DAY });

    expect(entries(oversight({ items: [idle, young, active, draft] }), 'stuck')).toEqual([
      {
        repo: API,
        itemIds: [idle.id],
        facts: {
          kind: 'stuck',
          number: 20,
          title: 'A change',
          author: 'priya',
          reasons: [{ kind: 'idle', openDays: 10, idleDays: 6 }],
        },
      },
    ]);
  });

  it('follows the two Stuck settings: how old, and how long without activity', () => {
    const pull = pr({ createdAt: NOW - 4 * DAY, updatedAt: NOW - 3 * DAY });
    expect(entries(oversight({ items: [pull] }), 'stuck')).toEqual([]);
    const tighter = { ...defaultOversightSettings, longRunningDays: 3, idleDays: 2 };
    expect(
      entries(oversight({ items: [pull], settings: tighter }), 'stuck').map((entry) => entry.facts),
    ).toEqual([
      {
        kind: 'stuck',
        number: pull.detail.number,
        title: 'A change',
        author: 'priya',
        reasons: [{ kind: 'idle', openDays: 4, idleDays: 3 }],
      },
    ]);
  });

  it('gives a pull request stuck several ways one entry with every reason, and leaves drafts alone', () => {
    const everything = pr({
      checks: 'failure',
      createdAt: NOW - 12 * DAY,
      updatedAt: NOW - 8 * DAY,
      requestedReviewers: [
        { kind: 'user', login: 'omar', requestedAt: NOW - 3 * DAY },
        { kind: 'team', team: 'acme/core', requestedAt: NOW - 9 * DAY },
      ],
    });
    const draft = pr({ draft: true, checks: 'failure' });
    const stuck = entries(oversight({ items: [everything, draft] }), 'stuck');
    expect(stuck).toHaveLength(1);
    // The longest wait is the one named.
    expect(stuck[0]?.facts).toMatchObject({
      reasons: [
        { kind: 'review-waiting', reviewer: 'acme/core', name: 'acme/core', days: 9 },
        { kind: 'checks-failing' },
        { kind: 'idle', openDays: 12, idleDays: 8 },
      ],
    });
  });
});

describe('On fire', () => {
  it('names watched repos whose default-branch head is failing its checks', () => {
    const result = oversight({
      repos: [
        health(API, { head: { oid: 'abc1234', checks: 'failure', committedAt: NOW - 2 * HOUR } }),
        health(WEB, { head: { oid: 'def5678', checks: 'error', committedAt: NOW - 3 * HOUR } }),
        health(DOCS, { head: { oid: 'aaa0000', checks: 'pending', committedAt: NOW - HOUR } }),
      ],
    });
    expect(entries(result, 'on-fire')).toEqual([
      {
        repo: API,
        itemIds: [],
        facts: { kind: 'head-failing', branch: 'main', oid: 'abc1234', checks: 'failure' },
      },
      {
        repo: WEB,
        itemIds: [],
        facts: { kind: 'head-failing', branch: 'main', oid: 'def5678', checks: 'error' },
      },
    ]);
  });

  it('names revert commits on a default branch in the range', () => {
    const revert = {
      oid: 'r1',
      headline: 'Revert "Cache the session lookups"',
      author: { login: 'sam', name: 'Sam', email: null },
      committedAt: NOW - 4 * HOUR,
      revert: true,
    };
    const result = oversight({
      repos: [
        health(API, {
          commits: [
            revert,
            { ...revert, oid: 'c1', headline: 'Add caching', revert: false },
            { ...revert, oid: 'r0', headline: 'Revert "Old thing"', committedAt: FROM - HOUR },
          ],
        }),
      ],
    });
    expect(entries(result, 'on-fire')).toEqual([
      {
        repo: API,
        itemIds: [],
        facts: {
          kind: 'reverts',
          branch: 'main',
          commits: [
            { oid: 'r1', headline: 'Revert "Cache the session lookups"', author: 'sam', at: NOW - 4 * HOUR },
          ],
        },
      },
    ]);
  });

  it('files a repo’s fire under the Project most of its Items are in', () => {
    const result = oversight({
      items: [
        pr({ projectId: TITANLINK.id }),
        pr({ projectId: TITANLINK.id }),
        issue({ projectId: LONGTAIL.id }),
      ],
      repos: [health(API, { head: { oid: 'abc', checks: 'failure', committedAt: NOW } })],
    });
    expect(section(result, 'on-fire').map((group) => group.project?.id ?? null)).toEqual([TITANLINK.id]);
  });
});

describe('grouping', () => {
  it('groups by Project in the Projects’ order, Unfiled last, then by repo', () => {
    const recent = { state: 'merged' as const, mergedAt: NOW - HOUR, closedAt: NOW - HOUR };
    const unfiledApi = pr({ ...recent });
    const longtailWeb = pr({ ...recent, repo: WEB, projectId: LONGTAIL.id });
    const titanWeb = pr({ ...recent, repo: WEB, projectId: TITANLINK.id });
    const titanApi = pr({ ...recent, projectId: TITANLINK.id });

    const groups = section(oversight({ items: [unfiledApi, longtailWeb, titanWeb, titanApi] }), 'shipped');
    expect(
      groups.map((group) => [group.project?.name ?? 'Unfiled', group.entries.map((e) => e.repo.name)]),
    ).toEqual([
      ['Titanlink', ['api', 'web']],
      ['Longtail', ['web']],
      ['Unfiled', ['api']],
    ]);
  });

  it('keeps to one Project, or to Unfiled, when asked', () => {
    const recent = { state: 'merged' as const, mergedAt: NOW - HOUR, closedAt: NOW - HOUR };
    const titan = pr({ ...recent, projectId: TITANLINK.id });
    const unfiled = pr({ ...recent });
    const items = [titan, unfiled];
    expect(
      entries(oversight({ items, projectId: TITANLINK.id }), 'shipped').flatMap((e) => e.itemIds),
    ).toEqual([titan.id]);
    expect(entries(oversight({ items, projectId: null }), 'shipped').flatMap((e) => e.itemIds)).toEqual([
      unfiled.id,
    ]);
  });

  it('always has the five sections, in order', () => {
    expect(oversight({}).sections.map((each) => each.kind)).toEqual([
      'shipped',
      'started',
      'progress',
      'stuck',
      'on-fire',
    ]);
  });
});

describe('skill-managed issues (#120)', () => {
  const wayfinder = (type: string) => ({ name: `wayfinder:${type}`, color: 'ededed' });
  const agent = { name: 'ready-for-agent', color: 'ededed' };
  const parentRef = (number: number) => ({
    owner: 'acme',
    name: 'api',
    number,
    title: 'Commander v1 map',
    url: `https://github.com/acme/api/issues/${number}`,
  });
  const m4 = { title: 'M4 · GitHub', dueOn: null };
  const closedDone = (at: number) => ({
    state: 'closed' as const,
    stateReason: 'completed' as const,
    closedAt: at,
  });

  // A map filed under Titanlink: 26 sub-issues on GitHub, 15 closed; Commander holds six of them.
  function aMap() {
    const map = issue({
      number: 1,
      title: 'Commander v1 map',
      labels: [wayfinder('map')],
      projectId: TITANLINK.id,
      subIssues: { total: 26, completed: 15 },
      createdAt: NOW - 60 * DAY,
    });
    const tickets = {
      openedToday: issue({
        number: 40,
        labels: [wayfinder('grilling')],
        parent: parentRef(1),
        createdAt: NOW - HOUR,
      }),
      openedYesterday: issue({
        number: 41,
        labels: [wayfinder('task')],
        parent: parentRef(1),
        createdAt: FROM + HOUR,
      }),
      closedToday: issue({
        number: 30,
        labels: [wayfinder('research')],
        parent: parentRef(1),
        ...closedDone(NOW - 2 * HOUR),
      }),
      notPlanned: issue({
        number: 31,
        labels: [wayfinder('research')],
        parent: parentRef(1),
        state: 'closed',
        stateReason: 'not-planned',
        closedAt: NOW - 3 * HOUR,
      }),
      closedLongAgo: issue({
        number: 20,
        labels: [wayfinder('task')],
        parent: parentRef(1),
        ...closedDone(NOW - 20 * DAY),
      }),
      oldOpen: issue({
        number: 21,
        labels: [wayfinder('grilling')],
        parent: parentRef(1),
        createdAt: NOW - 60 * DAY,
        updatedAt: NOW - 50 * DAY,
        blockedBy: [{ owner: 'acme', name: 'api', number: 40, state: 'open' }],
      }),
    };
    return { map, tickets };
  }

  it('gives each map that moved in the range one Progress line in its Project', () => {
    const { map, tickets } = aMap();
    const quiet = issue({
      number: 2,
      title: 'Quiet map',
      labels: [wayfinder('map')],
      createdAt: NOW - 90 * DAY,
    });
    const result = oversight({ items: [map, ...Object.values(tickets), quiet] });
    expect(section(result, 'progress')).toEqual([
      {
        project: TITANLINK,
        entries: [
          {
            repo: API,
            // The map, then its tickets: open, then closed, each by number.
            itemIds: [
              map.id,
              tickets.oldOpen.id,
              tickets.openedToday.id,
              tickets.openedYesterday.id,
              tickets.closedLongAgo.id,
              tickets.closedToday.id,
              tickets.notPlanned.id,
            ],
            facts: {
              kind: 'progress',
              group: 'map',
              number: 1,
              title: 'Commander v1 map',
              // GitHub's 15 closed of 26, as the three closed tickets Commander holds are among them.
              done: 15,
              total: 26,
              opened: 2,
              closed: 2,
              blocked: 1,
            },
          },
        ],
      },
    ]);
  });

  it('gives a milestone of build tickets a Progress line, under the Project most of its tickets are in', () => {
    const items = [
      issue({
        number: 119,
        labels: [agent],
        milestone: m4,
        projectId: LONGTAIL.id,
        ...closedDone(NOW - HOUR),
      }),
      issue({ number: 120, labels: [agent], milestone: m4, projectId: LONGTAIL.id }),
      issue({ number: 121, labels: [agent], milestone: m4 }),
    ];
    expect(entries(oversight({ items }), 'progress').map((entry) => entry.facts)).toEqual([
      {
        kind: 'progress',
        group: 'milestone',
        number: null,
        title: 'M4 · GitHub',
        done: 1,
        total: 3,
        opened: 0,
        closed: 1,
        blocked: 0,
      },
    ]);
    expect(section(oversight({ items }), 'progress')[0]?.project).toEqual(LONGTAIL);
  });

  it('lists tickets claimed in the range under Started, and freshly opened ones only in the Progress line', () => {
    const { map, tickets } = aMap();
    const claimed = issue({
      number: 66,
      title: 'Retry webhooks',
      labels: [agent],
      milestone: m4,
      assignees: ['priya'],
      claimedAt: NOW - 4 * HOUR,
      createdAt: NOW - 10 * DAY,
    });
    const claimedLastWeek = issue({
      number: 67,
      labels: [agent],
      milestone: m4,
      assignees: ['omar'],
      claimedAt: NOW - 7 * DAY,
    });
    const result = oversight({ items: [map, ...Object.values(tickets), claimed, claimedLastWeek] });
    expect(entries(result, 'started')).toEqual([
      {
        repo: API,
        itemIds: [claimed.id],
        facts: {
          kind: 'started',
          pullRequests: 0,
          issues: 0,
          claimed: [{ number: 66, title: 'Retry webhooks', by: ['priya'] }],
        },
      },
    ]);
  });

  it('lists tickets closed as done under Shipped, a pull request that closed one once, with its ticket', () => {
    const ticket = issue({
      number: 66,
      title: 'Retry webhooks',
      labels: [agent],
      milestone: m4,
      ...closedDone(NOW - HOUR),
    });
    const byHand = issue({
      number: 67,
      title: 'Docs',
      labels: [agent],
      milestone: m4,
      ...closedDone(NOW - 2 * HOUR),
    });
    const dropped = issue({
      number: 68,
      labels: [agent],
      milestone: m4,
      state: 'closed',
      stateReason: 'not-planned',
      closedAt: NOW - HOUR,
    });
    const fix = pr({
      number: 170,
      state: 'merged',
      mergedAt: NOW - HOUR,
      closedAt: NOW - HOUR,
      closingIssues: [{ owner: 'acme', name: 'api', number: 66, title: 'Retry webhooks', url: '' }],
    });
    const other = pr({ number: 171, state: 'merged', mergedAt: NOW - 3 * HOUR, closedAt: NOW - 3 * HOUR });
    const plainIssue = issue({ number: 90, ...closedDone(NOW - HOUR) });

    const result = oversight({ items: [ticket, byHand, dropped, fix, other, plainIssue] });
    expect(entries(result, 'shipped')).toEqual([
      {
        repo: API,
        itemIds: [other.id, fix.id, byHand.id, ticket.id, plainIssue.id],
        facts: {
          kind: 'shipped',
          // #171 only: #170 shows with its ticket.
          merged: 1,
          issuesClosed: 1,
          releases: [],
          tickets: [
            { number: 67, title: 'Docs', kind: 'build-ticket', pullRequest: null },
            { number: 66, title: 'Retry webhooks', kind: 'build-ticket', pullRequest: 170 },
          ],
        },
      },
    ]);
    expect(plainSummary(result).sections[0]?.groups[0]?.lines.map((line) => line.text)).toEqual([
      'acme/api: 1 PR merged, 1 issue closed, #67 done (build ticket), #170 closes #66 (build ticket)',
    ]);
  });

  it('never counts an old open ticket as Stuck', () => {
    const { map, tickets } = aMap();
    const idle = pr({ number: 20, createdAt: NOW - 10 * DAY, updatedAt: NOW - 6 * DAY });
    const result = oversight({ items: [map, ...Object.values(tickets), idle] });
    expect(entries(result, 'stuck').flatMap((entry) => entry.itemIds)).toEqual([idle.id]);
  });

  it('follows the skill-managed labels in the settings', () => {
    const ticket = issue({
      number: 5,
      labels: [{ name: 'build:ticket', color: 'ededed' }],
      createdAt: NOW - HOUR,
    });
    const triage = issue({ number: 6, labels: [agent], createdAt: NOW - HOUR });
    const result = oversight({
      items: [ticket, triage],
      settings: { ...defaultOversightSettings, skillLabels: ['build:*'] },
    });
    expect(entries(result, 'started').flatMap((entry) => entry.itemIds)).toEqual([triage.id]);
  });

  it('words Progress lines and claimed tickets', () => {
    const { map, tickets } = aMap();
    const claimed = issue({
      number: 66,
      title: 'Retry webhooks',
      labels: [agent],
      assignees: ['priya'],
      claimedAt: NOW - HOUR,
    });
    const milestone = [
      issue({ number: 119, labels: [agent], milestone: m4, ...closedDone(NOW - HOUR) }),
      issue({ number: 120, labels: [agent], milestone: m4 }),
    ];
    const summary = plainSummary(
      oversight({ items: [map, ...Object.values(tickets), claimed, ...milestone] }),
    );
    const lines = (title: string) =>
      summary.sections
        .find((each) => each.title === title)
        ?.groups.flatMap((g) => g.lines.map((l) => l.text));
    expect(lines('Progress')).toEqual([
      'acme/api#1 Commander v1 map: 15 of 26 decided, 2 opened and 2 closed, 1 blocked',
      'acme/api milestone M4 · GitHub: 1 of 2 done, 1 closed',
    ]);
    expect(lines('Started')).toEqual(['acme/api: claimed #66 Retry webhooks (priya)']);
    // A progress line carries its counts, for a progress bar.
    expect(summary.sections.find((each) => each.kind === 'progress')?.groups[0]?.lines[0]?.progress).toEqual({
      done: 15,
      total: 26,
    });
  });
});

describe('people', () => {
  it('says per GitHub user what they merged, opened, reviewed and what waits on them', () => {
    const merged = pr({ author: 'priya', state: 'merged', mergedAt: NOW - HOUR, closedAt: NOW - HOUR });
    const opened = pr({
      author: 'sam',
      createdAt: NOW - HOUR,
      reviews: [{ login: 'priya', state: 'approved', submittedAt: NOW - 2 * HOUR }],
    });
    const waiting = pr({
      author: 'sam',
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 3 * DAY }],
    });
    const result = oversight({ items: [merged, opened, waiting] });
    expect(result.people).toEqual([
      {
        login: 'omar',
        personId: null,
        name: 'omar',
        merged: [],
        opened: [],
        reviewed: [],
        waitingOn: [waiting.id],
      },
      {
        login: 'priya',
        personId: null,
        name: 'priya',
        merged: [merged.id],
        opened: [],
        reviewed: [opened.id],
        waitingOn: [],
      },
      {
        login: 'sam',
        personId: null,
        name: 'sam',
        merged: [],
        opened: [opened.id],
        reviewed: [],
        waitingOn: [],
      },
    ]);
  });

  it('names the People logins are matched to, keeping the login for anyone unmatched', () => {
    const waiting = pr({
      number: 12,
      title: 'Retry webhooks',
      requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 4 * DAY }],
    });
    const result = oversight({
      items: [waiting],
      personOf: (login) => (login === 'omar' ? { id: 'person-omar', name: 'Omar Haddad' } : null),
    });
    expect(result.people.find((each) => each.login === 'omar')).toMatchObject({
      personId: 'person-omar',
      name: 'Omar Haddad',
    });
    expect(plainSummary(result).sections[3]?.groups[0]?.lines[0]?.text).toBe(
      'acme/api#12 Retry webhooks: waiting 4 days on Omar Haddad',
    );
  });
});

describe('the plain summary', () => {
  it('writes one line per entry, per section, per Project, ending "Nothing on fire"', () => {
    const recent = { state: 'merged' as const, mergedAt: NOW - HOUR, closedAt: NOW - HOUR };
    const items = [
      ...Array.from({ length: 4 }, () => pr({ ...recent, projectId: TITANLINK.id })),
      release({ tag: 'v2.3.0', projectId: TITANLINK.id }),
      pr({ repo: WEB, createdAt: NOW - HOUR }),
      issue({ repo: WEB, createdAt: NOW - HOUR }),
      issue({ repo: WEB, createdAt: NOW - HOUR }),
      pr({
        number: 12,
        title: 'Retry webhooks',
        projectId: TITANLINK.id,
        checks: 'failure',
        requestedReviewers: [{ kind: 'user', login: 'omar', requestedAt: NOW - 4 * DAY }],
      }),
    ];
    const summary = plainSummary(oversight({ items }));
    expect(
      summary.sections.map((each) => [
        each.title,
        each.groups.map((group) => [group.title, group.lines.map((line) => line.text)]),
      ]),
    ).toEqual([
      ['Shipped', [['Titanlink', ['acme/api: 4 PRs merged, release v2.3.0']]]],
      ['Started', [['Unfiled', ['acme/web: 1 PR and 2 issues opened']]]],
      ['Progress', []],
      ['Stuck', [['Titanlink', ['acme/api#12 Retry webhooks: waiting 4 days on omar, checks failing']]]],
      ['On fire', []],
    ]);
    expect(summary.closing).toBe('Nothing on fire');
    // Every line keeps the Items behind it.
    expect(summary.sections[0]?.groups[0]?.lines[0]?.itemIds).toHaveLength(5);
  });

  it('words fires, idle pull requests, closed issues and several releases', () => {
    const summary = plainSummary(
      oversight({
        items: [
          issue({ state: 'closed', stateReason: 'completed', closedAt: NOW - HOUR }),
          release({ tag: 'v2.3.0' }),
          release({ tag: 'v2.3.1' }),
          pr({ number: 20, title: 'Old work', createdAt: NOW - 10 * DAY, updatedAt: NOW - 6 * DAY }),
        ],
        repos: [
          health(API, {
            head: { oid: 'abc1234def', checks: 'failure', committedAt: NOW },
            commits: [
              {
                oid: 'r1',
                headline: 'Revert "Cache"',
                author: { login: 'sam', name: null, email: null },
                committedAt: NOW - HOUR,
                revert: true,
              },
            ],
          }),
        ],
      }),
    );
    const lines = summary.sections.flatMap((each) =>
      each.groups.flatMap((group) => group.lines.map((l) => l.text)),
    );
    expect(lines).toEqual([
      'acme/api: 1 issue closed, releases v2.3.0 and v2.3.1',
      'acme/api#20 Old work: open 10 days, no activity for 6 days',
      'acme/api: main is failing its checks',
      'acme/api: 1 revert on main: Revert "Cache"',
    ]);
    expect(summary.closing).toBeNull();
  });

  it('says when there is nothing at all', () => {
    const summary = plainSummary(oversight({}));
    expect(summary.empty).toBe(true);
    expect(summary.closing).toBe('Nothing on fire');
  });
});

describe('ranges', () => {
  // Sunday 4 October 2026, 09:00 in Denver (15:00 UTC).
  const tz = 'America/Denver';

  it('starts "Since yesterday" at the start of yesterday, in the User’s time zone', () => {
    expect(oversightRange({ kind: 'since-yesterday' }, NOW, tz)).toEqual({
      from: Date.UTC(2026, 9, 3, 6),
      to: NOW,
    });
  });

  it('starts "This week" on Monday', () => {
    expect(oversightRange({ kind: 'this-week' }, NOW, tz)).toEqual({
      from: Date.UTC(2026, 8, 28, 6),
      to: NOW,
    });
    // On a Monday, the week began that morning.
    const monday = Date.UTC(2026, 9, 5, 15);
    expect(oversightRange({ kind: 'this-week' }, monday, tz).from).toBe(Date.UTC(2026, 9, 5, 6));
  });

  it('starts "Custom since…" at the start of the chosen day, across a clock change', () => {
    // Daylight saving ends in Denver on 1 November 2026: that day starts at UTC−6, the next at UTC−7.
    const later = Date.UTC(2026, 10, 3, 15);
    expect(oversightRange({ kind: 'since', day: '2026-11-02' }, later, tz).from).toBe(
      Date.UTC(2026, 10, 2, 7),
    );
    expect(oversightRange({ kind: 'since', day: '2026-10-30' }, later, tz).from).toBe(
      Date.UTC(2026, 9, 30, 6),
    );
  });
});
