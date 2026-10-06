import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  GitHubIssueDetail,
  GitHubReleaseDetail,
  Project,
  PullRequestDetail,
  RuleCondition,
  SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Rules filing GitHub Items (#118): each GitHub field matches pull requests, issues and releases saved
// from GitHub sync, a Rule files them as they arrive ("filed under TL by Rule: repo is
// acme/titanlink-api"), a new Rule's re-filing preview includes them, an Item the User filed by hand
// is never moved, and a review request takes its pull request's Project (as inherited) and follows it.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GITHUB = 'github:583231';
const user: ActionContext = { by: { kind: 'user' } };
const API = { nodeId: 'R_api', owner: 'acme', name: 'titanlink-api' };
const WEB = { nodeId: 'R_web', owner: 'acme', name: 'web' };
const DOTFILES = { nodeId: 'R_dot', owner: 'octocat', name: 'dotfiles' };
type Repo = typeof API;

let dir: string;
let clock: number;
let store: ItemStore;
let tl: Project;
let tx: Project;

function pullRequest(
  repo: Repo,
  number: number,
  title: string,
  changes: Partial<PullRequestDetail> = {},
): SourceItem {
  return {
    externalId: `${repo.nodeId}:pull/${number}`,
    kind: 'pull-request',
    title,
    people: ['github:priya'],
    status: 'open',
    detail: {
      kind: 'pull-request',
      repo,
      number,
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
      nodeId: `PR_${repo.nodeId}_${number}`,
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
      checks: null,
      closingIssues: [],
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      body: '',
      createdAt: clock,
      updatedAt: clock,
      mergedAt: null,
      closedAt: null,
      ...changes,
    },
  };
}

function issue(
  repo: Repo,
  number: number,
  title: string,
  changes: Partial<GitHubIssueDetail> = {},
): SourceItem {
  return {
    externalId: `${repo.nodeId}:issue/${number}`,
    kind: 'github-issue',
    title,
    people: ['github:omar'],
    status: 'open',
    detail: {
      kind: 'github-issue',
      repo,
      number,
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}`,
      nodeId: `I_${repo.nodeId}_${number}`,
      author: 'omar',
      assignees: [],
      labels: [],
      milestone: null,
      state: 'open',
      stateReason: null,
      body: '',
      commentCount: 0,
      createdAt: clock,
      updatedAt: clock,
      closedAt: null,
      parent: null,
      subIssues: null,
      ...changes,
    },
  };
}

function release(repo: Repo, tag: string, changes: Partial<GitHubReleaseDetail> = {}): SourceItem {
  return {
    externalId: `${repo.nodeId}:release/${tag}`,
    kind: 'github-release',
    title: `${repo.name} ${tag}`,
    people: ['github:priya'],
    status: 'done',
    detail: {
      kind: 'github-release',
      repo,
      tag,
      name: null,
      url: `https://github.com/${repo.owner}/${repo.name}/releases/tag/${tag}`,
      author: 'priya',
      prerelease: false,
      publishedAt: clock,
      notes: '',
      ...changes,
    },
  };
}

function reviewRequest(repo: Repo, number: number, title: string): SourceItem {
  return {
    externalId: `${repo.nodeId}:review-request/${number}`,
    kind: 'review-request',
    title,
    people: ['github:priya'],
    detail: {
      kind: 'review-request',
      pullRequest: `${repo.nodeId}:pull/${number}`,
      pullRequestId: null,
      repo,
      number,
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
      direct: true,
      teams: [],
      requestedAt: clock,
    },
  };
}

// Saves GitHub Items as GitHub sync does; returns their Item ids by title.
function sync(...items: SourceItem[]): Record<string, string> {
  clock += 1000;
  store.saveFromSource({ source: 'github', account: GITHUB, items });
  return Object.fromEntries(
    store.query({ source: 'github', limit: 1000 }).map((item) => [item.title, item.id]),
  );
}

function addRule(project: Project, condition: RuleCondition) {
  clock += 1000;
  return store.changeRule({
    type: 'create',
    rule: { target: { kind: 'project', projectId: project.id }, when: { join: 'and', terms: [condition] } },
  });
}

const filingOf = (id: string | undefined) => store.get(id ?? '')?.item.filing ?? null;
const byRule = (project: Project) => ({ projectId: project.id, filedBy: 'rule' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-rules-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  const project = (name: string, code: string) =>
    store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Rules filing GitHub Items', () => {
  it('a repo Rule files its pull requests, issues and releases as they arrive, logging the Rule', () => {
    const rule = addRule(tl, {
      field: 'github.repo',
      op: 'is',
      value: API.nodeId,
      label: 'acme/titanlink-api',
    }).rule;

    const ids = sync(
      pullRequest(API, 12, 'Retry the relay'),
      issue(API, 7, 'Relay drops messages'),
      release(API, 'v2.0'),
      pullRequest(WEB, 3, 'New landing page'),
    );

    for (const title of ['Retry the relay', 'Relay drops messages', 'titanlink-api v2.0']) {
      expect(filingOf(ids[title])).toEqual(byRule(tl));
      const [entry] = store.activity({ itemId: ids[title] as string });
      expect(entry).toMatchObject({
        by: { kind: 'rule', ruleId: rule?.id },
        action: 'update',
        why: 'Rule: repo is acme/titanlink-api',
      });
    }
    expect(filingOf(ids['New landing page'])).toBeNull();
  });

  it.each<[string, RuleCondition, string[]]>([
    ['Account', { field: 'github.account', op: 'is', value: GITHUB, label: 'octocat' }, ['A', 'B', 'C', 'D']],
    ['org', { field: 'github.org', op: 'is', value: 'acme', label: 'acme' }, ['A', 'B', 'C']],
    ['label', { field: 'github.label', op: 'is', value: 'infra', label: 'infra' }, ['B']],
    ['author', { field: 'github.author', op: 'is', value: 'omar', label: 'omar' }, ['C']],
    ['milestone', { field: 'github.milestone', op: 'is', value: 'v2', label: 'v2' }, ['C']],
    ['kind', { field: 'github.kind', op: 'is', value: 'github-release', label: 'release' }, ['D']],
    ['title', { field: 'github.title', op: 'contains', value: 'relay', label: 'relay' }, ['A', 'C']],
  ])('files by its %s', (_name, condition, filed) => {
    addRule(tl, condition);
    const ids = sync(
      pullRequest(API, 1, 'A: retry the relay'),
      pullRequest(WEB, 2, 'B: speed up', { labels: [{ name: 'Infra', color: 'aaaaaa' }] }),
      issue(API, 3, 'C: relay drops', { milestone: { title: 'v2', dueOn: null } }),
      release(DOTFILES, 'D'),
    );
    const letters = { A: 'A: retry the relay', B: 'B: speed up', C: 'C: relay drops', D: 'dotfiles D' };
    const byTheRule = Object.entries(letters).filter(([, title]) => filingOf(ids[title])?.filedBy === 'rule');
    expect(byTheRule.map(([letter]) => letter)).toEqual(filed);
  });

  it('previews and re-files existing GitHub Items for a new Rule, skipping one the User filed by hand', () => {
    const ids = sync(
      pullRequest(API, 12, 'Retry the relay'),
      issue(API, 7, 'Relay drops messages'),
      pullRequest(WEB, 3, 'New landing page'),
    );
    store.record(
      {
        type: 'update',
        itemId: ids['Relay drops messages'] as string,
        changes: { filing: { projectId: tx.id, filedBy: 'user' } },
      },
      user,
    );
    const draft = {
      target: { kind: 'project' as const, projectId: tl.id },
      when: {
        join: 'and' as const,
        terms: [{ field: 'github.repo', op: 'is' as const, value: API.nodeId, label: 'acme/titanlink-api' }],
      },
    };

    const preview = store.previewRule({ rule: draft });
    expect(preview.count).toBe(2);
    const made = store.changeRule({ type: 'create', rule: draft });
    expect(made.refile.map((each) => each.item.id)).toEqual([ids['Retry the relay']]);

    store.refile(made.refile.map((each) => each.item.id));
    expect(filingOf(ids['Retry the relay'])).toEqual(byRule(tl));
    expect(filingOf(ids['Relay drops messages'])).toEqual({ projectId: tx.id, filedBy: 'user' });
    expect(filingOf(ids['New landing page'])).toBeNull();
  });

  it('offers the Rule editor each watched repo, with nothing synced from it yet', () => {
    const repo = { ...WEB, visibility: 'private' as const, pushedAt: null };
    store.githubWatch.saveAccess(GITHUB, {
      via: 'token',
      login: 'octocat',
      orgs: [{ login: 'acme', id: 1, reach: 'token', repos: [repo], addedByName: false, problem: null }],
      personal: [],
      fetchedAt: clock,
    });
    store.githubWatch.save(GITHUB, { orgs: [], repos: [WEB] });
    expect(store.ruleValues()).toEqual({
      'github.account': [{ value: GITHUB, label: 'octocat' }],
      'github.repo': [{ value: 'R_web', label: 'acme/web' }],
      'github.org': [{ value: 'acme', label: 'acme' }],
    });
  });

  it('a review request isn’t filed by Rules: it takes its pull request’s Project as inherited, and follows it', () => {
    addRule(tl, { field: 'github.repo', op: 'is', value: API.nodeId, label: 'acme/titanlink-api' });
    sync(pullRequest(API, 12, 'Retry the relay'), reviewRequest(API, 12, 'Retry the relay'));
    const [pull, request] = ['pull-request', 'review-request'].map(
      (kind) => store.query({ kinds: [kind as 'pull-request'] })[0],
    );
    expect(pull?.filing).toEqual(byRule(tl));
    expect(request?.filing).toEqual({ projectId: tl.id, filedBy: 'inherited' });

    // A Rule above it files the repo's Items elsewhere: re-filing the pull request moves the request too.
    const made = store.changeRule({
      type: 'create',
      position: 0,
      rule: {
        target: { kind: 'project', projectId: tx.id },
        when: { join: 'and', terms: [{ field: 'github.org', op: 'is', value: 'acme', label: 'acme' }] },
      },
    });
    expect(made.refile.map((each) => each.item.id)).toEqual([pull?.id]);
    store.refile([pull?.id as string]);
    expect(filingOf(pull?.id)).toEqual(byRule(tx));
    expect(filingOf(request?.id)).toEqual({ projectId: tx.id, filedBy: 'inherited' });
  });
});
