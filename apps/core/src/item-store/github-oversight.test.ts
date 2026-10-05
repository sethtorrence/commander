import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultOversightSettings,
  type GitHubIssueDetail,
  type GitHubRepoHealth,
  type GitHubWriterDetail,
  type PullRequestDetail,
  type SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// The oversight summary in the Item store (#119): its settings (Settings → GitHub), the summary made
// from the GitHub Items and each Account's repo health, and the writer's detail kept beside a pull
// request until it changes.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GITHUB = 'github:583231';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 4, 15);
const API = { nodeId: 'R_api', owner: 'acme', name: 'api' };

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-oversight-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => NOW,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function pullRequest(number: number, changes: Partial<PullRequestDetail> = {}): SourceItem {
  return {
    externalId: `R_api:pull/${number}`,
    kind: 'pull-request',
    title: `Change ${number}`,
    status: changes.state && changes.state !== 'open' ? 'done' : 'open',
    detail: {
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
      createdAt: NOW - 20 * DAY,
      updatedAt: NOW - HOUR,
      mergedAt: null,
      closedAt: null,
      ...changes,
    },
  };
}

const health = (changes: Partial<GitHubRepoHealth> = {}): GitHubRepoHealth => ({
  repo: API,
  defaultBranch: 'main',
  head: { oid: 'abc1234', checks: 'success', committedAt: NOW - HOUR },
  commits: [],
  checkedAt: NOW - HOUR,
  ...changes,
});

describe('settings', () => {
  it('starts with the defaults, and keeps what the User saves', () => {
    expect(store.githubOversight.settings()).toEqual(defaultOversightSettings);
    const saved = store.githubOversight.saveSettings({
      longRunningDays: 10,
      idleDays: 3,
      bots: ['acme-bot'],
    });
    // The skill-managed labels (#120) stay as they were when left out.
    expect(saved).toEqual({
      longRunningDays: 10,
      idleDays: 3,
      bots: ['acme-bot'],
      skillLabels: defaultOversightSettings.skillLabels,
    });
    expect(store.githubOversight.settings()).toEqual(saved);
  });

  it('keeps the skill-managed labels the User edits (#120)', () => {
    const saved = store.githubOversight.saveSettings({
      ...defaultOversightSettings,
      skillLabels: [' build:* ', 'agent-ready', 'agent-ready'],
    });
    expect(saved.skillLabels).toEqual(['build:*', 'agent-ready']);
    store.githubOversight.saveSettings({ longRunningDays: 7, idleDays: 5, bots: [] });
    expect(store.githubOversight.settings().skillLabels).toEqual(['build:*', 'agent-ready']);
    expect(store.githubOversight.saveSettings({ ...saved, skillLabels: [] }).skillLabels).toEqual([]);
  });

  it('refuses settings that make no sense', () => {
    expect(() => store.githubOversight.saveSettings({ longRunningDays: 0, idleDays: 3, bots: [] })).toThrow();
  });
});

describe('the summary', () => {
  it('is made from the GitHub Items, each Account’s repo health, the Projects and the settings', () => {
    const titanlink = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
    }).project;
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [
        pullRequest(1, { state: 'merged', mergedAt: NOW - 2 * HOUR, closedAt: NOW - 2 * HOUR }),
        pullRequest(2, { createdAt: NOW - 10 * DAY, updatedAt: NOW - 4 * DAY }),
      ],
    });
    const [merged] = store.query({ kinds: ['pull-request'], titleContains: 'Change 1' });
    store.record(
      {
        type: 'update',
        itemId: merged?.id ?? '',
        changes: { filing: { projectId: titanlink?.id ?? '', filedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    store.syncState.saveCatalog(
      GITHUB,
      'github',
      {
        kind: 'github',
        repos: [health({ head: { oid: 'abc1234', checks: 'failure', committedAt: NOW - HOUR } })],
      },
      NOW,
    );

    const summary = store.githubOversight.summary({ range: { from: NOW - DAY, to: NOW } });
    const shipped = summary.sections.find((each) => each.kind === 'shipped');
    expect(shipped?.groups.map((group) => [group.project?.name, group.entries[0]?.itemIds])).toEqual([
      ['Titanlink', [merged?.id]],
    ]);
    expect(
      summary.sections.find((each) => each.kind === 'on-fire')?.groups[0]?.entries[0]?.facts,
    ).toMatchObject({
      kind: 'head-failing',
      oid: 'abc1234',
    });
    // 10 days open, 4 idle: not Stuck by default, Stuck once the User says 3 idle days are enough.
    expect(summary.sections.find((each) => each.kind === 'stuck')?.groups).toEqual([]);
    store.githubOversight.saveSettings({ ...defaultOversightSettings, idleDays: 3 });
    const tighter = store.githubOversight.summary({ range: { from: NOW - DAY, to: NOW } });
    expect(tighter.sections.find((each) => each.kind === 'stuck')?.groups[0]?.entries).toHaveLength(1);

    // One Project only.
    const unfiled = store.githubOversight.summary({ range: { from: NOW - DAY, to: NOW }, projectId: null });
    expect(unfiled.sections.find((each) => each.kind === 'shipped')?.groups).toEqual([]);
  });

  it('shows a map as progress, by the skill-managed labels in the settings (#120)', () => {
    const issue = (number: number, changes: Partial<GitHubIssueDetail> = {}): SourceItem => ({
      externalId: `R_api:issue/${number}`,
      kind: 'github-issue',
      title: number === 1 ? 'Commander v1 map' : `Ticket ${number}`,
      status: changes.state === 'closed' ? 'done' : 'open',
      detail: {
        kind: 'github-issue',
        repo: API,
        number,
        url: `https://github.com/acme/api/issues/${number}`,
        nodeId: `I_${number}`,
        author: 'priya',
        assignees: [],
        labels: [],
        milestone: null,
        state: 'open',
        stateReason: null,
        body: '',
        commentCount: 0,
        createdAt: NOW - 40 * DAY,
        updatedAt: NOW - 30 * DAY,
        closedAt: null,
        parent: null,
        subIssues: null,
        ...changes,
      },
    });
    const parent = { owner: 'acme', name: 'api', number: 1, title: 'Commander v1 map', url: '' };
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [
        issue(1, {
          labels: [{ name: 'wayfinder:map', color: '0e8a16' }],
          subIssues: { total: 3, completed: 1 },
        }),
        issue(2, { parent, createdAt: NOW - HOUR }),
        issue(3, { parent, state: 'closed', stateReason: 'completed', closedAt: NOW - 2 * HOUR }),
        issue(4, { parent }),
        // A build ticket, opened today: never Started.
        issue(5, { labels: [{ name: 'build:ticket', color: 'ededed' }], createdAt: NOW - HOUR }),
      ],
    });
    const range = { from: NOW - DAY, to: NOW };
    const lines = () =>
      store.githubOversight
        .summary({ range })
        .sections.flatMap((each) =>
          each.groups.flatMap((group) => group.entries.map((entry) => entry.facts)),
        );
    expect(lines()).toEqual([
      {
        kind: 'shipped',
        merged: 0,
        issuesClosed: 0,
        releases: [],
        tickets: [{ number: 3, title: 'Ticket 3', kind: 'map-ticket', pullRequest: null }],
      },
      { kind: 'started', pullRequests: 0, issues: 1, claimed: [] },
      {
        kind: 'progress',
        group: 'map',
        number: 1,
        title: 'Commander v1 map',
        done: 1,
        total: 3,
        opened: 1,
        closed: 1,
        blocked: 0,
      },
    ]);
    store.githubOversight.saveSettings({ ...defaultOversightSettings, skillLabels: ['build:*'] });
    expect(lines().map((facts) => facts.kind)).toEqual(['shipped', 'progress']);
  });

  it('leaves out deleted Items', () => {
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [pullRequest(1, { state: 'merged', mergedAt: NOW - HOUR, closedAt: NOW - HOUR })],
    });
    store.saveFromSource({ source: 'github', account: GITHUB, deleted: ['R_api:pull/1'] });
    const summary = store.githubOversight.summary({ range: { from: NOW - DAY, to: NOW } });
    expect(summary.sections.every((each) => each.groups.length === 0)).toBe(true);
  });
});

describe('the writer’s detail', () => {
  const detail: GitHubWriterDetail = {
    forUpdatedAt: NOW - HOUR,
    fetchedAt: NOW,
    description: 'Retries failed deliveries.',
    linkedIssues: [],
    reviews: [],
    reviewComments: [],
    comments: [{ author: 'omar', body: 'Looks close.', at: NOW - 2 * HOUR }],
    moreComments: false,
    changeOutline: {
      areas: [{ area: 'apps/core', files: 1, additions: 3, deletions: 1 }],
      files: 1,
      totalFiles: 1,
    },
  };

  it('is kept beside a pull request, records nothing in its log, and is stale once it changes', () => {
    store.saveFromSource({ source: 'github', account: GITHUB, items: [pullRequest(1)] });
    const [pull] = store.query({ kinds: ['pull-request'] });
    const id = pull?.id ?? '';
    const logged = store.activity({ itemId: id }).length;
    expect(store.githubOversight.writerDetail(id)).toBeNull();

    store.githubOversight.saveWriterDetail(id, detail);
    expect(store.githubOversight.writerDetail(id)).toEqual(detail);
    expect(store.activity({ itemId: id })).toHaveLength(logged);
    expect(store.githubOversight.staleWriterDetails([id])).toEqual([]);

    store.saveFromSource({ source: 'github', account: GITHUB, items: [pullRequest(1, { updatedAt: NOW })] });
    expect(store.githubOversight.staleWriterDetails([id])).toEqual([
      { itemId: id, account: GITHUB, nodeId: 'PR_1', updatedAt: NOW },
    ]);
  });

  it('is only for live pull requests', () => {
    store.githubOversight.saveWriterDetail('no-such-item', detail);
    expect(store.githubOversight.writerDetail('no-such-item')).toBeNull();
    expect(store.githubOversight.staleWriterDetails(['no-such-item'])).toEqual([]);
  });
});

describe('People (#122)', () => {
  const linearIssue = (identifier: string, assignee: { id: string; email: string; name: string }) => ({
    externalId: identifier,
    kind: 'linear-issue' as const,
    title: `Linear ${identifier}`,
    detail: {
      kind: 'linear-issue' as const,
      identifier,
      url: `https://linear.app/acme/issue/${identifier}`,
      team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
      state: { id: 's', name: 'In Progress', type: 'started', color: '#f2c94c' },
      priority: 2,
      assignee: { ...assignee, displayName: assignee.name },
      creator: null,
      labels: [],
      linearProject: null,
      cycle: null,
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

  it('gives each active Person’s week, their GitHub and Linear work as one Person, by name', () => {
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [
        {
          ...pullRequest(1, { state: 'merged', mergedAt: NOW - DAY, closedAt: NOW - DAY }),
          identities: [{ handle: 'github:priya', email: 'priya@acme.dev', name: 'Priya Raman' }],
        },
        pullRequest(2, {
          author: 'sam',
          requestedReviewers: [{ kind: 'user', login: 'priya', requestedAt: NOW - 3 * DAY }],
        }),
      ],
    });
    store.saveFromSource({
      source: 'linear',
      account: 'linear:1',
      items: [linearIssue('ENG-412', { id: 'u-priya', email: 'priya@acme.dev', name: 'Priya Raman' })],
    });

    const range = { from: NOW - 7 * DAY, to: NOW };
    const weeks = store.githubOversight.people({ range });
    expect(
      weeks.map((week) => [week.name, week.merged.length, week.waiting.length, week.linear.length]),
    ).toEqual([
      ['Priya Raman', 1, 1, 1],
      ['sam', 0, 0, 0],
    ]);
    const priya = store.people.list().find((each) => each.name === 'Priya Raman');
    expect(weeks[0]?.personId).toBe(priya?.id);
    expect(store.githubOversight.people({ range, personId: priya?.id })).toEqual([weeks[0]]);
  });
});
