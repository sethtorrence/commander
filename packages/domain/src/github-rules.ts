import type { GitHubIssueDetail, GitHubReleaseDetail, PullRequestDetail } from './github';
import { type GitHubAccess, type GitHubWatch, watchedRepos } from './github-watch';
import type { Rule, RuleCondition, RuleField, RuleFieldValue, RuleWhen } from './rules';

/*
  GitHub's Rule fields (#118): what a pull request, issue or release can be filed by. "repo is
  acme/titanlink-api → TL" files every pull request, issue and release from it. A review request
  reads nothing: it takes its pull request's Project (as inherited) and follows it. Everything read
  here came from outside (ADR 0004): it is only compared.

  Repos are named by node id (renames and transfers keep it) and read as owner/name; GitHub logins
  (an org, an author) and label names are compared in lower case, as GitHub treats them.
*/

type Readable = Parameters<RuleField['read']>[0];
type FiledDetail = PullRequestDetail | GitHubIssueDetail | GitHubReleaseDetail;

const choices = ['is', 'is-not'] as const;

const KIND_WORDS: Record<FiledDetail['kind'], string> = {
  'pull-request': 'pull request',
  'github-issue': 'issue',
  'github-release': 'release',
};

/** The detail of a GitHub Item Rules file (a pull request, issue or release), or null. */
export function githubFiledDetail(item: Readable): FiledDetail | null {
  if (item.source !== 'github' || !item.detail) return null;
  const { detail } = item;
  return detail.kind === 'pull-request' || detail.kind === 'github-issue' || detail.kind === 'github-release'
    ? detail
    : null;
}

const login = (name: string | null): RuleFieldValue[] =>
  name ? [{ value: name.toLowerCase(), label: name }] : [];

/** A repo as the `github.repo` field names it: its node id, reading as owner/name. */
export const githubRepoValue = (repo: { nodeId: string; owner: string; name: string }): RuleFieldValue => ({
  value: repo.nodeId,
  label: `${repo.owner}/${repo.name}`,
});

/** An org as the `github.org` field names it: its login in lower case. */
export const githubOrgValue = (owner: string): RuleFieldValue => ({
  value: owner.toLowerCase(),
  label: owner,
});

export const githubRuleFields: readonly RuleField[] = [
  {
    id: 'github.account',
    name: 'GitHub account',
    label: 'Account',
    ops: choices,
    // Labelled with the Account's id here; the editor names it by its login.
    read: (item) =>
      githubFiledDetail(item) && item.account ? [{ value: item.account, label: item.account }] : [],
  },
  {
    id: 'github.org',
    name: 'org',
    label: 'Org',
    ops: choices,
    read: (item) => {
      const detail = githubFiledDetail(item);
      return detail ? [githubOrgValue(detail.repo.owner)] : [];
    },
  },
  {
    id: 'github.repo',
    name: 'repo',
    label: 'Repo',
    ops: choices,
    read: (item) => {
      const detail = githubFiledDetail(item);
      return detail ? [githubRepoValue(detail.repo)] : [];
    },
  },
  {
    id: 'github.label',
    name: 'GitHub label',
    label: 'Label',
    ops: choices,
    read: (item) => {
      const detail = githubFiledDetail(item);
      if (!detail || detail.kind === 'github-release') return [];
      const found = new Map<string, RuleFieldValue>();
      for (const label of detail.labels) {
        const value = label.name.toLowerCase();
        if (value && !found.has(value)) found.set(value, { value, label: label.name });
      }
      return [...found.values()];
    },
  },
  {
    id: 'github.author',
    name: 'author',
    label: 'Author',
    ops: choices,
    read: (item) => login(githubFiledDetail(item)?.author ?? null),
  },
  {
    id: 'github.milestone',
    name: 'milestone',
    label: 'Milestone',
    ops: choices,
    read: (item) => {
      const detail = githubFiledDetail(item);
      const milestone = detail?.kind === 'github-issue' ? detail.milestone : null;
      return milestone ? [{ value: milestone.title, label: milestone.title }] : [];
    },
  },
  {
    id: 'github.kind',
    name: 'GitHub Item',
    label: 'Kind',
    ops: choices,
    read: (item) => {
      const detail = githubFiledDetail(item);
      return detail ? [{ value: detail.kind, label: KIND_WORDS[detail.kind] }] : [];
    },
  },
  {
    id: 'github.title',
    name: 'title',
    label: 'Title',
    ops: ['contains'],
    read: (item) => (githubFiledDetail(item) ? [{ value: item.title, label: item.title }] : []),
  },
];

/**
 * The values the Rule editor offers from Settings → GitHub, beside those of synced Items: each
 * watched repo (so a repo with nothing synced yet can still be chosen), its org, and each GitHub
 * Account by its login. Watched repos are those watched and reachable as GitHub last listed them,
 * then those the selection names one by one (out of reach for now, or not listed yet).
 */
export function githubWatchRuleValues(
  accounts: readonly { account: string; watch: GitHubWatch | null; access: GitHubAccess | null }[],
): Record<string, RuleFieldValue[]> {
  const repos = new Map<string, RuleFieldValue>();
  const orgs = new Map<string, RuleFieldValue>();
  const add = (into: Map<string, RuleFieldValue>, each: RuleFieldValue) => {
    if (!into.has(each.value)) into.set(each.value, each);
  };
  for (const { watch, access } of accounts) {
    if (!watch) continue;
    for (const repo of [...(access ? watchedRepos(watch, access) : []), ...watch.repos]) {
      add(repos, githubRepoValue(repo));
      add(orgs, githubOrgValue(repo.owner));
    }
    // An org watched whole, though nothing in it is listed yet.
    for (const org of watch.orgs) add(orgs, githubOrgValue(org.login));
  }
  return {
    'github.account': accounts.map(({ account, access }) => ({
      value: account,
      label: access?.login ?? account,
    })),
    'github.repo': [...repos.values()],
    'github.org': [...orgs.values()],
  };
}

/** A repo's own conditions: "repo is acme/titanlink-api". */
export function githubRepoWhen(repo: { nodeId: string; owner: string; name: string }): RuleWhen {
  const { value, label } = githubRepoValue(repo);
  return { join: 'and', terms: [{ field: 'github.repo', op: 'is', value, label }] };
}

/**
 * A repo's own Rule, for Settings → GitHub's Projects column: the first Rule filing into a Project
 * whose one condition is "repo is <it>" (a Rule naming more than the repo is the Rules list's to
 * show).
 */
export function githubRepoRule<R extends Pick<Rule, 'target' | 'when'>>(
  rules: readonly R[],
  repoNodeId: string,
): R | undefined {
  return rules.find((rule) => {
    if (rule.target.kind !== 'project') return false;
    const conditions: RuleCondition[] = rule.when.terms.flatMap((term) =>
      'conditions' in term ? term.conditions : [term],
    );
    const [only] = conditions;
    return (
      conditions.length === 1 &&
      only?.field === 'github.repo' &&
      only.op === 'is' &&
      only.value === repoNodeId
    );
  });
}
