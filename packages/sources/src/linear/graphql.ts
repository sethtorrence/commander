// The GraphQL documents Linear sync sends. Only what Commander keeps is asked for: Linear charges by
// query complexity, and each field adds to it.

const USER = 'id name displayName email';
const COMMENT = `id body createdAt updatedAt user { ${USER} }`;
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

// Comments that come with each issue; an issue with more gets the rest from ISSUE_COMMENTS.
export const COMMENTS_PER_ISSUE = 20;
// Relations pointing at each issue (those blocking it among them), for spotting stuck issues.
const RELATIONS_PER_ISSUE = 10;

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
  inverseRelations(first: ${RELATIONS_PER_ISSUE}) { nodes { type issue { id identifier title state { type } } } }
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

// Two-way sync. Before writing, Commander reads the issue as Linear has it now, with its history:
// a change Linear recorded to a field after the User's edit wins over it (newest wins, per field).
const HISTORY = `
  nodes {
    createdAt
    actor { id name }
    fromStateId toStateId fromAssigneeId toAssigneeId fromPriority toPriority
    fromDueDate toDueDate fromEstimate toEstimate fromCycleId toCycleId fromProjectId toProjectId
    addedLabelIds removedLabelIds
  }
  ${PAGE_INFO}
`;

export const ISSUE_FOR_WRITE = `query CommanderIssueForWrite($id: String!) {
  issue(id: $id) {
    ${ISSUE}
    history(first: 50) { ${HISTORY} }
  }
}`;

export const ISSUE_HISTORY = `query CommanderIssueHistory($id: String!, $after: String) {
  issue(id: $id) {
    history(first: 50, after: $after) { ${HISTORY} }
  }
}`;

export const ISSUE_BY_ID = `query CommanderIssue($id: String!) {
  issue(id: $id) { ${ISSUE} }
}`;

// Only the fields that changed; labels as add and remove deltas, so a label added in Linear
// meanwhile stays.
export const ISSUE_UPDATE = `mutation CommanderIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { ${ISSUE} }
  }
}`;

// The comment's id is Commander's own (a UUID made when the User wrote it), so a retried post can be
// recognised rather than posted twice.
export const COMMENT_CREATE = `mutation CommanderCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

// Send to Linear: a new issue, made under Commander's own id for it (a UUID made with the Item), so
// a retried creation can be recognised (ISSUES with `id: { in: [id] }` first) rather than made twice.
export const ISSUE_CREATE = `mutation CommanderIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { ${ISSUE} }
  }
}`;

// Undoing a send deletes the issue (Linear keeps it in its trash for a while).
export const ISSUE_DELETE = `mutation CommanderIssueDelete($id: String!) {
  issueDelete(id: $id) { success }
}`;

export const COMMENT_DELETE = `mutation CommanderCommentDelete($id: String!) {
  commentDelete(id: $id) { success }
}`;

// What the detail pane's pickers offer, fetched with each sync. Kept small: Linear caps one query's
// complexity, so very large teams' lists are cut short (the pickers also offer what issues show).
export const CATALOG = `query CommanderCatalog($cycles: CycleFilter) {
  teams(first: 25) {
    nodes {
      id key name
      defaultIssueState { id }
      states(first: 30) { nodes { id name type color position } }
      members(first: 50) { nodes { ${USER} active } }
      cycles(first: 10, filter: $cycles) { nodes { id number name startsAt endsAt } }
      projects(first: 30) { nodes { id name } }
    }
  }
  issueLabels(first: 250) { nodes { id name color team { id } } }
}`;
