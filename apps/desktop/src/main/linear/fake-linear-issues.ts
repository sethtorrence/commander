// The fake Linear's issues, for tests only: enough of Linear's `issues`, `comments` and
// `issue.comments` queries to drive Linear sync end to end, answering in Linear's shapes with
// cursor pagination and an X-Complexity header. Only the filters Commander sends are understood.

export type FakeUser = { id: string; name: string; displayName: string; email: string | null };

export type FakeComment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: FakeUser | null;
};

export type FakeIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  archivedAt: string | null;
  trashed: boolean | null;
  team: { id: string; key: string; name: string };
  state: { id: string; name: string; type: string; color: string };
  assignee: FakeUser | null;
  creator: FakeUser | null;
  labels: { nodes: { id: string; name: string; color: string }[] };
  cycle: { id: string; number: number; name: string | null; startsAt: string; endsAt: string } | null;
  project: { id: string; name: string } | null;
  comments: FakeComment[];
};

// What a test says about an issue; the rest is filled in.
export type FakeIssueInput = Partial<FakeIssue> & { identifier: string; title: string };

const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const TODO = { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' };

type Filter = Record<string, unknown> & { or?: Filter[] };

const after = (value: string | null | undefined, gt: unknown) =>
  typeof gt === 'string' && value !== null && value !== undefined && Date.parse(value) > Date.parse(gt);

// Linear's IssueFilter, as far as Commander uses it: updatedAt.gt, id.in, completedAt.gt,
// canceledAt.gt, state.type.nin, and `or`.
function matches(issue: FakeIssue, filter: Filter | undefined): boolean {
  if (!filter) return true;
  if (filter.or) return filter.or.some((each) => matches(issue, each));
  const { updatedAt, id, completedAt, canceledAt, state } = filter as {
    updatedAt?: { gt?: string };
    id?: { in?: string[] };
    completedAt?: { gt?: string };
    canceledAt?: { gt?: string };
    state?: { type?: { nin?: string[] } };
  };
  if (updatedAt && !after(issue.updatedAt, updatedAt.gt)) return false;
  if (id?.in && !id.in.includes(issue.id)) return false;
  if (completedAt && !after(issue.completedAt, completedAt.gt)) return false;
  if (canceledAt && !after(issue.canceledAt, canceledAt.gt)) return false;
  if (state?.type?.nin?.includes(issue.state.type)) return false;
  return true;
}

// Newest change first, as `orderBy: updatedAt` gives, then one page after the cursor.
function page<T extends { id: string }>(all: T[], first: number, cursor: string | null | undefined) {
  const start = cursor ? all.findIndex((node) => node.id === cursor) + 1 : 0;
  const nodes = all.slice(start, start + first);
  return {
    nodes,
    pageInfo: { hasNextPage: start + first < all.length, endCursor: nodes.at(-1)?.id ?? null },
  };
}

const newestFirst = <T extends { updatedAt: string }>(list: T[]) =>
  [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

export function createFakeIssues(now: () => number = Date.now) {
  const byWorkspace = new Map<string, FakeIssue[]>();
  let nextId = 1;
  const stamp = () => new Date(now()).toISOString();

  function find(id: string): FakeIssue {
    for (const issues of byWorkspace.values()) {
      const found = issues.find((issue) => issue.id === id);
      if (found) return found;
    }
    throw new Error(`The fake Linear has no issue ${id}`);
  }

  // The GraphQL shape of an issue, with its first comments.
  const node = (issue: FakeIssue, commentsFirst = 20) => ({
    ...issue,
    comments: page(issue.comments, commentsFirst, null),
  });

  return {
    add(workspaceId: string, input: FakeIssueInput): FakeIssue {
      const id = input.id ?? `issue-${nextId++}`;
      const at = stamp();
      const issue: FakeIssue = {
        id,
        url: `https://linear.app/fake/issue/${input.identifier}`,
        description: null,
        priority: 0,
        estimate: null,
        dueDate: null,
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        completedAt: null,
        canceledAt: null,
        archivedAt: null,
        trashed: null,
        team: ENG,
        state: TODO,
        assignee: null,
        creator: null,
        labels: { nodes: [] },
        cycle: null,
        project: null,
        comments: [],
        ...input,
      };
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), issue]);
      return issue;
    },

    // Changes an issue the way an edit in Linear does, moving its updatedAt on.
    update(id: string, changes: Partial<FakeIssue>) {
      Object.assign(find(id), changes, { updatedAt: stamp() });
    },

    archive(id: string) {
      const at = stamp();
      Object.assign(find(id), { archivedAt: at, updatedAt: at });
    },

    // Answers one of Commander's sync queries for a workspace, or null for any other query.
    answer(workspaceId: string, operationName: string, variables: Record<string, unknown>): unknown {
      const issues = byWorkspace.get(workspaceId) ?? [];
      const first = typeof variables.first === 'number' ? variables.first : 50;
      const cursor = variables.after as string | null | undefined;
      switch (operationName) {
        case 'CommanderIssues': {
          const visible = issues.filter(
            (issue) =>
              (variables.includeArchived || !issue.archivedAt) && matches(issue, variables.filter as Filter),
          );
          const result = page(newestFirst(visible), first, cursor);
          return { issues: { ...result, nodes: result.nodes.map((issue) => node(issue)) } };
        }
        case 'CommanderChangedComments': {
          const gt = (variables.filter as { updatedAt?: { gt?: string } } | undefined)?.updatedAt?.gt;
          const changed = issues.flatMap((issue) =>
            issue.comments
              .filter((comment) => after(comment.updatedAt, gt))
              .map((comment) => ({ id: comment.id, updatedAt: comment.updatedAt, issue: { id: issue.id } })),
          );
          return { comments: page(newestFirst(changed), first, cursor) };
        }
        case 'CommanderIssueComments': {
          const issue = find(String(variables.id));
          return { issue: { comments: page(issue.comments, 100, cursor) } };
        }
        default:
          return null;
      }
    },
  };
}

export type FakeIssues = ReturnType<typeof createFakeIssues>;
