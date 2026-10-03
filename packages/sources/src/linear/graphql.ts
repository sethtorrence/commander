// The GraphQL documents Linear sync sends. Only what Commander keeps is asked for: Linear charges by
// query complexity, and each field adds to it.

const USER = 'id name displayName email';
const COMMENT = `id body createdAt updatedAt user { ${USER} }`;
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

// Comments that come with each issue; an issue with more gets the rest from ISSUE_COMMENTS.
export const COMMENTS_PER_ISSUE = 20;

const ISSUE = `
  id identifier title url description priority estimate dueDate
  createdAt updatedAt startedAt completedAt canceledAt archivedAt trashed
  team { id key name }
  state { id name type color }
  assignee { ${USER} }
  creator { ${USER} }
  labels { nodes { id name color } }
  cycle { id number name startsAt endsAt }
  project { id name }
  comments(first: ${COMMENTS_PER_ISSUE}) { nodes { ${COMMENT} } ${PAGE_INFO} }
`;

export const ISSUES = `query CommanderIssues($filter: IssueFilter, $first: Int!, $after: String, $includeArchived: Boolean) {
  issues(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived, orderBy: updatedAt) {
    nodes { ${ISSUE} }
    ${PAGE_INFO}
  }
}`;

export const ISSUE_COMMENTS = `query CommanderIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) { nodes { ${COMMENT} } ${PAGE_INFO} }
  }
}`;

// Comments changed since the cursor, for the issues they belong to: whether a new comment moves its
// issue's updatedAt is undocumented, so Commander asks for both.
export const CHANGED_COMMENTS = `query CommanderChangedComments($filter: CommentFilter, $first: Int!, $after: String) {
  comments(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { updatedAt issue { id } }
    ${PAGE_INFO}
  }
}`;
