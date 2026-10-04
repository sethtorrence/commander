import {
  type GitHubCheckState,
  type GitHubCommit,
  type GitHubIssueDetail,
  type GitHubReleaseDetail,
  type GitHubRepoName,
  type GitHubRequestedReviewer,
  type GitHubReview,
  githubExternalId,
  isRevert,
  type PullRequestDetail,
  type ReviewRequestDetail,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';

// GitHub's answers as GitHub sync reads them, and the Items they become. The adapter only translates:
// what GitHub reports is kept as reported, untrusted (bodies are other people's Markdown).

const time = z.string().min(1);
const nullableTime = time.nullable().optional().default(null);
const connection = <T extends z.ZodType>(node: T) =>
  z
    .object({ nodes: z.array(node.nullable()).default([]) })
    .nullable()
    .optional()
    .transform((value) =>
      (value?.nodes ?? []).filter((each): each is NonNullable<z.infer<T>> => each != null),
    );

const repository = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});
const actor = z
  .object({ login: z.string().min(1), email: z.string().nullable().optional() })
  .nullable()
  .optional()
  .default(null);
const reviewer = z
  .object({
    __typename: z.string(),
    login: z.string().optional(),
    slug: z.string().optional(),
    organization: z.object({ login: z.string() }).optional(),
  })
  .nullable()
  .optional()
  .default(null);
const issueRef = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

export const pullRequestNode = z.object({
  __typename: z.literal('PullRequest'),
  id: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  body: z.string().nullable().default(''),
  isDraft: z.boolean().default(false),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  createdAt: time,
  updatedAt: time,
  mergedAt: nullableTime,
  closedAt: nullableTime,
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  changedFiles: z.number().int().nonnegative().default(0),
  baseRefName: z.string().default(''),
  headRefName: z.string().default(''),
  reviewDecision: z
    .enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])
    .nullable()
    .optional()
    .default(null),
  repository,
  author: actor,
  labels: connection(z.object({ name: z.string(), color: z.string() })),
  assignees: connection(z.object({ login: z.string().min(1) })),
  reviewRequests: connection(z.object({ requestedReviewer: reviewer })),
  timelineItems: connection(z.object({ createdAt: time.optional(), requestedReviewer: reviewer })),
  latestReviews: connection(z.object({ author: actor, state: z.string(), submittedAt: nullableTime })),
  commits: connection(
    z.object({
      commit: z.object({
        statusCheckRollup: z.object({ state: z.string() }).nullable().optional().default(null),
        author: z
          .object({
            email: z.string().nullable().optional(),
            user: z.object({ login: z.string() }).nullable().optional(),
          })
          .nullable()
          .optional()
          .default(null),
      }),
    }),
  ),
  closingIssuesReferences: connection(issueRef),
});
export type PullRequestNode = z.infer<typeof pullRequestNode>;

export const issueNode = z.object({
  __typename: z.literal('Issue'),
  id: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  body: z.string().nullable().default(''),
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().nullable().optional().default(null),
  createdAt: time,
  updatedAt: time,
  closedAt: nullableTime,
  repository,
  author: actor,
  assignees: connection(z.object({ login: z.string().min(1) })),
  labels: connection(z.object({ name: z.string(), color: z.string() })),
  milestone: z.object({ title: z.string(), dueOn: nullableTime }).nullable().optional().default(null),
  comments: z.object({ totalCount: z.number().int().nonnegative() }).nullable().optional().default(null),
  parent: issueRef.nullable().optional().default(null),
  subIssuesSummary: z
    .object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative() })
    .nullable()
    .optional()
    .default(null),
});
export type IssueNode = z.infer<typeof issueNode>;

// A search result: a pull request, an issue, or something else (skipped).
export const searchNode = z.union([
  pullRequestNode,
  issueNode,
  z.object({ __typename: z.string() }).transform(() => null),
]);
export type SearchNode = PullRequestNode | IssueNode;

const searchResults = z.object({
  issueCount: z.number().int().nonnegative(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).optional(),
  nodes: z
    .array(searchNode.nullable())
    .default([])
    .transform((nodes) => nodes.filter((node): node is SearchNode => node != null)),
});
export type SearchResults = z.infer<typeof searchResults>;

export const searchCountData = z.object({
  search: z.object({ issueCount: z.number().int().nonnegative() }),
});

// A pull request or issue as open work lists it: enough to tell whether it changed.
export const lightNode = z.object({
  __typename: z.enum(['PullRequest', 'Issue']),
  id: z.string().min(1),
  number: z.number().int().positive(),
  updatedAt: time,
  repository,
});
export type LightNode = z.infer<typeof lightNode>;
const lightResults = z.object({
  issueCount: z.number().int().nonnegative(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).optional(),
  nodes: z
    .array(z.union([lightNode, z.object({ __typename: z.string() }).transform(() => null)]).nullable())
    .default([])
    .transform((nodes) => nodes.filter((node): node is LightNode => node != null)),
});
export const lightSearchData = z.object({ search: lightResults });
export const nodesData = z.object({
  nodes: z
    .array(searchNode.nullable())
    .transform((nodes) => nodes.filter((node): node is SearchNode => node != null)),
});
export const searchData = z.object({ search: searchResults });
export const openWorkData = z.object({
  viewer: z.object({ login: z.string().min(1) }),
  mine: lightResults,
  direct: lightResults,
  team: lightResults,
  assigned: lightResults,
});

const commitNode = z.object({
  oid: z.string().min(1),
  messageHeadline: z.string().default(''),
  message: z.string().default(''),
  committedDate: time,
  author: z
    .object({
      name: z.string().nullable().optional().default(null),
      email: z.string().nullable().optional().default(null),
      user: z.object({ login: z.string() }).nullable().optional().default(null),
    })
    .nullable()
    .optional()
    .default(null),
});

export const repoNode = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  defaultBranchRef: z
    .object({
      name: z.string(),
      target: z
        .object({
          oid: z.string().min(1),
          committedDate: time,
          statusCheckRollup: z.object({ state: z.string() }).nullable().optional().default(null),
          history: connection(commitNode),
        })
        .nullable()
        .optional()
        .default(null),
    })
    .nullable()
    .optional()
    .default(null),
  releases: connection(
    z.object({
      id: z.string().min(1),
      tagName: z.string(),
      name: z.string().nullable().optional().default(null),
      url: z.string(),
      isDraft: z.boolean().default(false),
      isPrerelease: z.boolean().default(false),
      publishedAt: nullableTime,
      description: z.string().nullable().optional().default(null),
      author: actor,
    }),
  ),
});
export type RepoNode = z.infer<typeof repoNode>;
export const reposData = z.object({
  nodes: z.array(
    z
      .union([
        repoNode,
        z
          .object({})
          .strict()
          .transform(() => null),
      ])
      .nullable(),
  ),
});

export const sweepData = z.object({
  items: z.array(
    z
      .object({
        id: z.string().optional(),
        number: z.number().optional(),
        repository: z.object({ id: z.string() }).optional(),
      })
      .nullable(),
  ),
  repos: z.array(z.object({ id: z.string().optional() }).nullable()),
});

// REST: a repo in a list (/orgs/{org}/repos, /user/repos).
export const restRepo = z.object({
  node_id: z.string().min(1),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1), type: z.string().optional() }),
  archived: z.boolean().default(false),
  pushed_at: z.string().nullable().optional().default(null),
});
export type RestRepo = z.infer<typeof restRepo>;
export const restTeam = z.object({
  slug: z.string().min(1),
  organization: z.object({ login: z.string().min(1) }),
});

// ------------------------------------------------------------------------------------------------

const at = (iso: string) => Date.parse(iso);
const atOrNull = (iso: string | null) => (iso ? Date.parse(iso) : null);

export const repoOf = (repo: z.infer<typeof repository>): GitHubRepoName => ({
  nodeId: repo.id,
  owner: repo.owner.login,
  name: repo.name,
});

export const pullRequestId = (repoNodeId: string, number: number) =>
  githubExternalId(repoNodeId, `pull/${number}`);
export const issueId = (repoNodeId: string, number: number) =>
  githubExternalId(repoNodeId, `issue/${number}`);
export const reviewRequestId = (repoNodeId: string, number: number) =>
  githubExternalId(repoNodeId, `review-request/${number}`);
export const releaseId = (repoNodeId: string, releaseNodeId: string) =>
  githubExternalId(repoNodeId, `release/${releaseNodeId}`);

const CHECK_STATES: Record<string, GitHubCheckState> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'error',
  PENDING: 'pending',
  EXPECTED: 'expected',
};
export const checkState = (rollup: { state: string } | null): GitHubCheckState | null =>
  rollup ? (CHECK_STATES[rollup.state] ?? null) : null;

const REVIEW_STATES: Record<string, GitHubReview['state']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};

// A GitHub email worth matching People by: not GitHub's no-reply addresses.
const usableEmail = (email: string | null | undefined): email is string =>
  !!email && email.includes('@') && !/@users\.noreply\.github\.com$/i.test(email);

// People as handles: `github:<login>` for each login (in order, once), then the email addresses
// GitHub tied to those logins.
function peopleOf(
  logins: (string | null | undefined)[],
  emails: { login: string | null; email: string | null | undefined }[],
) {
  const handles: string[] = [];
  const add = (handle: string) => {
    if (!handles.includes(handle)) handles.push(handle);
  };
  const known = logins.filter((login): login is string => !!login);
  for (const login of known) add(`github:${login}`);
  for (const { login, email } of emails)
    if (login && known.includes(login) && usableEmail(email)) add(email.toLowerCase());
  return handles;
}

const teamName = (node: { slug?: string | undefined; organization?: { login: string } | undefined }) =>
  node.slug && node.organization ? `${node.organization.login}/${node.slug}` : null;

// Who is asked to review, each with when they were last asked (from the timeline).
function requestedReviewers(node: PullRequestNode): GitHubRequestedReviewer[] {
  const askedAt = new Map<string, number>();
  for (const event of node.timelineItems) {
    const who = event.requestedReviewer;
    if (!who || !event.createdAt) continue;
    const key = who.__typename === 'Team' ? `team:${teamName(who)}` : `user:${who.login}`;
    askedAt.set(key, Math.max(askedAt.get(key) ?? 0, at(event.createdAt)));
  }
  const reviewers: GitHubRequestedReviewer[] = [];
  for (const { requestedReviewer: who } of node.reviewRequests) {
    if (!who) continue;
    if (who.__typename === 'Team') {
      const team = teamName(who);
      if (team) reviewers.push({ kind: 'team', team, requestedAt: askedAt.get(`team:${team}`) ?? null });
    } else if (who.login) {
      reviewers.push({
        kind: 'user',
        login: who.login,
        requestedAt: askedAt.get(`user:${who.login}`) ?? null,
      });
    }
  }
  return reviewers;
}

export function toPullRequestItem(node: PullRequestNode): SourceItem {
  const repo = repoOf(node.repository);
  const head = node.commits.at(-1)?.commit ?? null;
  const reviewers = requestedReviewers(node);
  const reviews: GitHubReview[] = node.latestReviews.flatMap((review) =>
    review.author
      ? [
          {
            login: review.author.login,
            state: REVIEW_STATES[review.state] ?? 'commented',
            submittedAt: atOrNull(review.submittedAt),
          },
        ]
      : [],
  );
  const detail: PullRequestDetail = {
    kind: 'pull-request',
    repo,
    number: node.number,
    url: node.url,
    nodeId: node.id,
    author: node.author?.login ?? null,
    state: node.state === 'MERGED' ? 'merged' : node.state === 'CLOSED' ? 'closed' : 'open',
    draft: node.isDraft,
    baseBranch: node.baseRefName,
    headBranch: node.headRefName,
    labels: node.labels,
    assignees: node.assignees.map((each) => each.login),
    requestedReviewers: reviewers,
    reviews,
    reviewDecision:
      node.reviewDecision === 'APPROVED'
        ? 'approved'
        : node.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes-requested'
          : node.reviewDecision === 'REVIEW_REQUIRED'
            ? 'review-required'
            : null,
    checks: checkState(head?.statusCheckRollup ?? null),
    closingIssues: node.closingIssuesReferences.map((issue) => ({
      owner: issue.repository.owner.login,
      name: issue.repository.name,
      number: issue.number,
      title: issue.title,
      url: issue.url,
    })),
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    body: node.body ?? '',
    createdAt: at(node.createdAt),
    updatedAt: at(node.updatedAt),
    mergedAt: atOrNull(node.mergedAt),
    closedAt: atOrNull(node.closedAt),
  };
  const people = peopleOf(
    [
      detail.author,
      ...detail.assignees,
      ...reviewers.flatMap((each) => (each.kind === 'user' ? [each.login] : [])),
      ...reviews.map((each) => each.login),
    ],
    [
      { login: detail.author, email: node.author?.email },
      ...(head?.author?.user ? [{ login: head.author.user.login, email: head.author.email }] : []),
    ],
  );
  return {
    externalId: pullRequestId(repo.nodeId, node.number),
    kind: 'pull-request',
    title: node.title,
    people,
    status: detail.state === 'open' ? 'open' : 'done',
    detail,
  };
}

const STATE_REASONS: Record<string, GitHubIssueDetail['stateReason']> = {
  COMPLETED: 'completed',
  NOT_PLANNED: 'not-planned',
  REOPENED: 'reopened',
  DUPLICATE: 'duplicate',
};

export function toIssueItem(node: IssueNode): SourceItem {
  const repo = repoOf(node.repository);
  const detail: GitHubIssueDetail = {
    kind: 'github-issue',
    repo,
    number: node.number,
    url: node.url,
    nodeId: node.id,
    author: node.author?.login ?? null,
    assignees: node.assignees.map((each) => each.login),
    labels: node.labels,
    milestone: node.milestone ? { title: node.milestone.title, dueOn: atOrNull(node.milestone.dueOn) } : null,
    state: node.state === 'OPEN' ? 'open' : 'closed',
    stateReason: node.stateReason ? (STATE_REASONS[node.stateReason] ?? null) : null,
    body: node.body ?? '',
    commentCount: node.comments?.totalCount ?? 0,
    createdAt: at(node.createdAt),
    updatedAt: at(node.updatedAt),
    closedAt: atOrNull(node.closedAt),
    parent: node.parent
      ? {
          owner: node.parent.repository.owner.login,
          name: node.parent.repository.name,
          number: node.parent.number,
          title: node.parent.title,
          url: node.parent.url,
        }
      : null,
    subIssues: node.subIssuesSummary && node.subIssuesSummary.total > 0 ? node.subIssuesSummary : null,
  };
  return {
    externalId: issueId(repo.nodeId, node.number),
    kind: 'github-issue',
    title: node.title,
    people: peopleOf(
      [detail.author, ...detail.assignees],
      [{ login: detail.author, email: node.author?.email }],
    ),
    status: detail.state === 'open' ? 'open' : 'done',
    detail,
  };
}

// The review asked of the User on an open pull request: directly, and/or through these teams of theirs.
export function toReviewRequestItem(
  pull: SourceItem,
  direct: boolean,
  teams: string[],
  me: string,
): SourceItem | null {
  const detail = pull.detail;
  if (detail?.kind !== 'pull-request' || (!direct && teams.length === 0)) return null;
  const asked = detail.requestedReviewers
    .filter((each) =>
      each.kind === 'user'
        ? direct && each.login.toLowerCase() === me.toLowerCase()
        : teams.includes(each.team),
    )
    .map((each) => each.requestedAt)
    .filter((when): when is number => when !== null);
  const request: ReviewRequestDetail = {
    kind: 'review-request',
    pullRequest: pull.externalId,
    pullRequestId: null,
    repo: detail.repo,
    number: detail.number,
    url: detail.url,
    direct,
    teams,
    requestedAt: asked.length ? Math.max(...asked) : null,
  };
  return {
    externalId: reviewRequestId(detail.repo.nodeId, detail.number),
    kind: 'review-request',
    title: pull.title,
    people: detail.author ? [`github:${detail.author}`] : [],
    status: 'open',
    detail: request,
  };
}

export function toReleaseItem(repo: GitHubRepoName, release: RepoNode['releases'][number]): SourceItem {
  const detail: GitHubReleaseDetail = {
    kind: 'github-release',
    repo,
    tag: release.tagName,
    name: release.name || null,
    url: release.url,
    author: release.author?.login ?? null,
    prerelease: release.isPrerelease,
    publishedAt: atOrNull(release.publishedAt),
    notes: release.description ?? '',
  };
  return {
    externalId: releaseId(repo.nodeId, release.id),
    kind: 'github-release',
    title: `${repo.name} ${release.name || release.tagName}`,
    people: release.author ? [`github:${release.author.login}`] : [],
    status: 'done',
    detail,
  };
}

export function toCommit(node: z.infer<typeof commitNode>): GitHubCommit {
  return {
    oid: node.oid,
    headline: node.messageHeadline,
    author: {
      login: node.author?.user?.login ?? null,
      name: node.author?.name ?? null,
      email: usableEmail(node.author?.email) ? (node.author?.email ?? null) : null,
    },
    committedAt: at(node.committedDate),
    revert: isRevert(node.message || node.messageHeadline),
  };
}
