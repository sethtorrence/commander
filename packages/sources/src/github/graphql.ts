import { RATE_LIMIT_FIELDS } from './client';

// The GraphQL documents GitHub sync sends. Searches pin their type (ISSUE_ADVANCED) rather than lean
// on GitHub's default, which is due to change. Every query asks for its rate limit.

const REPO = 'repository { id name owner { login } }';
const REVIEWER = '__typename ... on User { login } ... on Team { slug organization { login } }';

const PULL_REQUEST = `fragment CommanderPullRequest on PullRequest {
  id number url title body isDraft state createdAt updatedAt mergedAt closedAt
  additions deletions changedFiles baseRefName headRefName reviewDecision
  ${REPO}
  author { login ... on User { email } }
  labels(first: 20) { nodes { name color } }
  assignees(first: 10) { nodes { login } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ${REVIEWER} } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
    nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ${REVIEWER} } } }
  }
  latestReviews(first: 20) { nodes { author { login } state submittedAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } author { email user { login } } } } }
  closingIssuesReferences(first: 10) { nodes { number title url repository { name owner { login } } } }
}`;

const ISSUE = `fragment CommanderIssue on Issue {
  id number url title body state stateReason createdAt updatedAt closedAt
  ${REPO}
  author { login ... on User { email } }
  assignees(first: 10) { nodes { login } }
  labels(first: 20) { nodes { name color } }
  milestone { title dueOn }
  comments { totalCount }
  parent { number title url repository { name owner { login } } }
  subIssuesSummary { total completed }
}`;

// How many pull requests and issues match a search, before fetching them.
export const SEARCH_COUNT = `query CommanderSearchCount($query: String!) {
  search(query: $query, type: ISSUE_ADVANCED, first: 1) { issueCount }
  ${RATE_LIMIT_FIELDS}
}`;

export const SEARCH = `query CommanderSearch($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE_ADVANCED, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { __typename ...CommanderPullRequest ...CommanderIssue }
  }
  ${RATE_LIMIT_FIELDS}
}
${PULL_REQUEST}
${ISSUE}`;

// The User's open work: their pull requests, reviews asked of them directly and through their teams,
// and issues assigned to them. One light request every sync (ids and update times only, about a point);
// those new or changed since are then fetched whole (NODES).
export const OPEN_WORK_SEARCHES = {
  mine: 'is:open is:pr author:@me',
  direct: 'is:open is:pr user-review-requested:@me',
  team: 'is:open is:pr team-review-requested:@me',
  assigned: 'is:open is:issue assignee:@me',
} as const;
export type OpenWorkSearch = keyof typeof OPEN_WORK_SEARCHES;

const LIGHT = `__typename
      ... on PullRequest { id number updatedAt ${REPO} }
      ... on Issue { id number updatedAt ${REPO} }`;

const openWorkSearch = (
  alias: OpenWorkSearch,
) => `${alias}: search(query: "${OPEN_WORK_SEARCHES[alias]}", type: ISSUE_ADVANCED, first: $first) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${LIGHT} }
  }`;

export const OPEN_WORK = `query CommanderOpenWork($first: Int!) {
  viewer { login }
  ${openWorkSearch('mine')}
  ${openWorkSearch('direct')}
  ${openWorkSearch('team')}
  ${openWorkSearch('assigned')}
  ${RATE_LIMIT_FIELDS}
}`;

// More of one open-work search, past its first page.
export const OPEN_WORK_PAGE = `query CommanderOpenWorkPage($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE_ADVANCED, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${LIGHT} }
  }
  ${RATE_LIMIT_FIELDS}
}`;

// Pull requests and issues, whole, by node id.
export const NODES = `query CommanderNodes($ids: [ID!]!) {
  nodes(ids: $ids) { __typename ...CommanderPullRequest ...CommanderIssue }
  ${RATE_LIMIT_FIELDS}
}
${PULL_REQUEST}
${ISSUE}`;

// Each repo's default branch, its head commit's checks and commits since, and its latest releases.
export const REPOS = `query CommanderRepos($ids: [ID!]!, $since: GitTimestamp!) {
  nodes(ids: $ids) {
    ... on Repository {
      id name owner { login }
      defaultBranchRef {
        name
        target {
          ... on Commit {
            oid committedDate statusCheckRollup { state }
            history(first: 30, since: $since) {
              nodes { oid messageHeadline message committedDate author { name email user { login } } }
            }
          }
        }
      }
      releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { id tagName name url isDraft isPrerelease publishedAt description author { login } }
      }
    }
  }
  ${RATE_LIMIT_FIELDS}
}`;

// Whether pull requests and issues (and their repos) are still there: a deleted one comes back null,
// a transferred one with another repo.
export const SWEEP = `query CommanderSweep($ids: [ID!]!, $repos: [ID!]!) {
  items: nodes(ids: $ids) {
    __typename
    ... on Issue { id number repository { id } }
    ... on PullRequest { id number repository { id } }
  }
  repos: nodes(ids: $repos) { ... on Repository { id } }
  ${RATE_LIMIT_FIELDS}
}`;
