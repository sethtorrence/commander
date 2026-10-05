import { describe, expect, it } from 'vitest';
import type { GitHubIssueDetail, GitHubReleaseDetail, PullRequestDetail } from './github';
import { githubRepoRule, githubRepoWhen, githubRuleFields, githubWatchRuleValues } from './github-rules';
import type { Item } from './items';
import {
  describeRule,
  firstMatch,
  RULE_FIELDS,
  RULE_SOURCES,
  type Rule,
  type RuleWhen,
  ruleMatches,
} from './rules';

// GitHub's Rule fields (#118): what a pull request, issue or release can be filed by. Read from
// Items as GitHub sync saves them.

const ACCOUNT = 'github:583231';
const API = { nodeId: 'R_api', owner: 'Acme', name: 'titanlink-api' };

function pullRequest(changes: Partial<PullRequestDetail> = {}, title = 'Retry the relay'): Item {
  return {
    id: 'pr-1',
    kind: 'pull-request',
    source: 'github',
    account: ACCOUNT,
    externalId: 'R_api:pull/12',
    title,
    detail: {
      kind: 'pull-request',
      repo: API,
      number: 12,
      url: 'https://github.com/Acme/titanlink-api/pull/12',
      nodeId: 'PR_12',
      author: 'Priya',
      state: 'open',
      draft: false,
      baseBranch: 'main',
      headBranch: 'retry',
      labels: [
        { name: 'infra', color: 'aaaaaa' },
        { name: 'Perf', color: 'bbbbbb' },
      ],
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
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      closedAt: null,
      ...changes,
    },
  } as Item;
}

function issue(changes: Partial<GitHubIssueDetail> = {}): Item {
  return {
    id: 'issue-1',
    kind: 'github-issue',
    source: 'github',
    account: ACCOUNT,
    externalId: 'R_api:issue/7',
    title: 'Relay drops messages',
    detail: {
      kind: 'github-issue',
      repo: API,
      number: 7,
      url: 'https://github.com/Acme/titanlink-api/issues/7',
      nodeId: 'I_7',
      author: 'omar',
      assignees: [],
      labels: [{ name: 'bug', color: 'cccccc' }],
      milestone: { title: 'v2', dueOn: null },
      state: 'open',
      stateReason: null,
      body: '',
      commentCount: 0,
      createdAt: 1,
      updatedAt: 2,
      closedAt: null,
      parent: null,
      subIssues: null,
      ...changes,
    },
  } as Item;
}

function release(changes: Partial<GitHubReleaseDetail> = {}): Item {
  return {
    id: 'release-1',
    kind: 'github-release',
    source: 'github',
    account: ACCOUNT,
    externalId: 'R_api:release/3',
    title: 'titanlink-api v2.0',
    detail: {
      kind: 'github-release',
      repo: API,
      tag: 'v2.0',
      name: 'v2.0',
      url: 'https://github.com/Acme/titanlink-api/releases/tag/v2.0',
      author: 'priya',
      prerelease: false,
      publishedAt: 3,
      notes: '',
      ...changes,
    },
  } as Item;
}

const reviewRequest = {
  id: 'rr-1',
  kind: 'review-request',
  source: 'github',
  account: ACCOUNT,
  externalId: 'R_api:review/12',
  title: 'Retry the relay',
  detail: {
    kind: 'review-request',
    pullRequest: 'R_api:pull/12',
    pullRequestId: 'pr-1',
    repo: API,
    number: 12,
    url: 'https://github.com/Acme/titanlink-api/pull/12',
    direct: true,
    teams: [],
    requestedAt: null,
  },
} as unknown as Item;

const linearIssue = {
  kind: 'linear-issue',
  source: 'linear',
  account: 'linear:acme',
  title: 'Retry the relay',
} as Item;

const fields = new Map(githubRuleFields.map((field) => [field.id, field]));
const read = (id: string, item: Item) => fields.get(id)?.read(item);

describe('GitHub Rule fields', () => {
  it('read the Account, org and repo of pull requests, issues and releases alike', () => {
    for (const item of [pullRequest(), issue(), release()]) {
      expect(read('github.account', item)).toEqual([{ value: ACCOUNT, label: ACCOUNT }]);
      // GitHub logins don't care about case, so neither does the org.
      expect(read('github.org', item)).toEqual([{ value: 'acme', label: 'Acme' }]);
      // A repo by its node id (renames keep it), reading as owner/name.
      expect(read('github.repo', item)).toEqual([{ value: 'R_api', label: 'Acme/titanlink-api' }]);
    }
  });

  it('read labels and authors (by login, in any case) and the title', () => {
    expect(read('github.label', pullRequest())).toEqual([
      { value: 'infra', label: 'infra' },
      { value: 'perf', label: 'Perf' },
    ]);
    expect(read('github.label', issue())).toEqual([{ value: 'bug', label: 'bug' }]);
    expect(read('github.label', release())).toEqual([]);
    expect(read('github.author', pullRequest())).toEqual([{ value: 'priya', label: 'Priya' }]);
    expect(read('github.author', issue())).toEqual([{ value: 'omar', label: 'omar' }]);
    expect(read('github.author', release())).toEqual([{ value: 'priya', label: 'priya' }]);
    expect(read('github.author', pullRequest({ author: null }))).toEqual([]);
    expect(read('github.title', pullRequest())).toEqual([
      { value: 'Retry the relay', label: 'Retry the relay' },
    ]);
    expect(read('github.title', release())).toEqual([
      { value: 'titanlink-api v2.0', label: 'titanlink-api v2.0' },
    ]);
  });

  it('read an issue’s milestone and what kind of GitHub Item it is', () => {
    expect(read('github.milestone', issue())).toEqual([{ value: 'v2', label: 'v2' }]);
    expect(read('github.milestone', issue({ milestone: null }))).toEqual([]);
    expect(read('github.milestone', pullRequest())).toEqual([]);
    expect(read('github.kind', pullRequest())).toEqual([{ value: 'pull-request', label: 'pull request' }]);
    expect(read('github.kind', issue())).toEqual([{ value: 'github-issue', label: 'issue' }]);
    expect(read('github.kind', release())).toEqual([{ value: 'github-release', label: 'release' }]);
  });

  it('read nothing from a review request (it takes its pull request’s Project) or another Source’s Item', () => {
    for (const field of githubRuleFields) {
      expect(field.read(reviewRequest)).toEqual([]);
      expect(field.read(linearIssue)).toEqual([]);
    }
  });

  it('are registered for the Rule editor and matching, in the editor’s order', () => {
    expect(RULE_SOURCES.find((each) => each.source === 'github')?.fields.map((field) => field.id)).toEqual([
      'github.account',
      'github.org',
      'github.repo',
      'github.label',
      'github.author',
      'github.milestone',
      'github.kind',
      'github.title',
    ]);
    for (const field of githubRuleFields) expect(RULE_FIELDS.get(field.id)).toBe(field);
  });

  it('match in Rules, and read as a sentence', () => {
    const repo: RuleWhen = {
      join: 'and',
      terms: [{ field: 'github.repo', op: 'is', value: 'R_api', label: 'Acme/titanlink-api' }],
    };
    const labelled: RuleWhen = {
      join: 'and',
      terms: [
        { field: 'github.org', op: 'is', value: 'acme', label: 'Acme' },
        {
          join: 'or',
          conditions: [
            { field: 'github.label', op: 'is', value: 'perf', label: 'Perf' },
            { field: 'github.title', op: 'contains', value: 'RELAY', label: 'RELAY' },
          ],
        },
      ],
    };
    expect(ruleMatches(repo, pullRequest())).toBe(true);
    expect(ruleMatches(repo, release())).toBe(true);
    expect(ruleMatches(repo, reviewRequest)).toBe(false);
    expect(ruleMatches(labelled, pullRequest({ labels: [] }))).toBe(true);
    expect(ruleMatches(labelled, issue())).toBe(true);
    expect(ruleMatches(labelled, release())).toBe(false);
    expect(firstMatch([{ when: repo }], linearIssue)).toBeUndefined();
    expect(describeRule(repo)).toBe('repo is Acme/titanlink-api');
    expect(describeRule(labelled)).toBe('org is Acme AND (GitHub label is Perf OR title contains “RELAY”)');
    expect(
      describeRule({
        join: 'and',
        terms: [
          { field: 'github.author', op: 'is-not', value: 'priya', label: 'priya' },
          { field: 'github.kind', op: 'is', value: 'github-release', label: 'release' },
        ],
      }),
    ).toBe('author is not priya AND GitHub Item is release');
  });
});

describe('a repo’s own Rule, for Settings → GitHub', () => {
  const repo = { nodeId: 'R_api', owner: 'Acme', name: 'titanlink-api' };
  const rule = (id: string, when: RuleWhen, projectId = 'p-tl'): Rule => ({
    id,
    target: { kind: 'project', projectId },
    when,
    order: 0,
    createdAt: 0,
  });

  it('is the first Project Rule whose one condition is “repo is <it>”', () => {
    const other = rule('r-org', {
      join: 'and',
      terms: [{ field: 'github.org', op: 'is', value: 'acme', label: 'Acme' }],
    });
    const more = rule('r-more', {
      join: 'and',
      terms: [
        githubRepoWhen(repo).terms[0] as never,
        { field: 'github.label', op: 'is', value: 'x', label: 'x' },
      ],
    });
    const notIt = rule('r-not', {
      join: 'and',
      terms: [{ field: 'github.repo', op: 'is-not', value: 'R_api', label: 'Acme/titanlink-api' }],
    });
    const grouped = rule('r-grouped', {
      join: 'and',
      terms: [{ join: 'or', conditions: [githubRepoWhen(repo).terms[0] as never] }],
    });
    const own = rule('r-own', githubRepoWhen(repo), 'p-lt');
    expect(githubRepoWhen(repo)).toEqual({
      join: 'and',
      terms: [{ field: 'github.repo', op: 'is', value: 'R_api', label: 'Acme/titanlink-api' }],
    });
    expect(githubRepoRule([other, more, notIt, own, grouped], 'R_api')?.id).toBe('r-own');
    expect(githubRepoRule([grouped, own], 'R_api')?.id).toBe('r-grouped');
    expect(githubRepoRule([other, more, notIt], 'R_api')).toBeUndefined();
    expect(githubRepoRule([own], 'R_web')).toBeUndefined();
  });
});

describe('the Rule editor’s GitHub values from the watch list', () => {
  const repo = (owner: string, name: string) => ({
    nodeId: `R_${name}`,
    owner,
    name,
    visibility: 'private' as const,
    pushedAt: null,
  });
  const api = repo('Acme', 'titanlink-api');
  const web = repo('Acme', 'web');
  const handbook = repo('Acme', 'handbook');
  const dotfiles = repo('octocat', 'dotfiles');
  const access = {
    via: 'app' as const,
    login: 'octocat',
    orgs: [
      {
        login: 'Acme',
        id: 1,
        reach: 'installed' as const,
        repos: [api, web, handbook],
        addedByName: false,
        problem: null,
      },
    ],
    personal: [dotfiles],
    fetchedAt: 0,
  };

  it('offers each watched repo (nothing synced from it needed), its org and the Account, by login', () => {
    const values = githubWatchRuleValues([
      {
        account: ACCOUNT,
        // The whole org less the handbook, and a personal repo; plus one out of reach now.
        watch: {
          orgs: [{ login: 'acme', except: [{ nodeId: handbook.nodeId, owner: 'Acme', name: 'handbook' }] }],
          repos: [
            { nodeId: dotfiles.nodeId, owner: 'octocat', name: 'dotfiles' },
            { nodeId: 'R_gone', owner: 'initech', name: 'gone' },
          ],
        },
        access,
      },
      // An Account that hasn't chosen yet offers only itself.
      { account: 'github:2', watch: null, access: null },
    ]);
    expect(values['github.repo']).toEqual([
      { value: 'R_titanlink-api', label: 'Acme/titanlink-api' },
      { value: 'R_web', label: 'Acme/web' },
      { value: 'R_dotfiles', label: 'octocat/dotfiles' },
      { value: 'R_gone', label: 'initech/gone' },
    ]);
    expect(values['github.org']).toEqual([
      { value: 'acme', label: 'Acme' },
      { value: 'octocat', label: 'octocat' },
      { value: 'initech', label: 'initech' },
    ]);
    expect(values['github.account']).toEqual([
      { value: ACCOUNT, label: 'octocat' },
      { value: 'github:2', label: 'github:2' },
    ]);
  });
});
