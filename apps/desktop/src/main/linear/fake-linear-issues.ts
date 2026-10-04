// The fake Linear's issues, for tests only: enough of Linear's `issues`, `comments` and
// `issue.comments` queries to drive Linear sync end to end, answering in Linear's shapes with
// cursor pagination and an X-Complexity header. Only the filters Commander sends are understood.
//
// Two-way sync too: the issue with its history, `issueUpdate` (ids checked against the team's
// catalog, labels as deltas), `commentCreate` with the caller's id (a second post with the same id
// is refused, as Linear refuses a duplicate id), `commentDelete`, and what the pickers offer. Every
// change records history entries with who made it and when, as Linear's IssueHistory does.

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

// One change Linear recorded on an issue (IssueHistory), as Commander reads it.
export type FakeHistoryEntry = {
  createdAt: string;
  actor: { id: string; name: string } | null;
  fromStateId: string | null;
  toStateId: string | null;
  fromAssigneeId: string | null;
  toAssigneeId: string | null;
  fromPriority: number | null;
  toPriority: number | null;
  fromDueDate: string | null;
  toDueDate: string | null;
  fromEstimate: number | null;
  toEstimate: number | null;
  fromCycleId: string | null;
  toCycleId: string | null;
  fromProjectId: string | null;
  toProjectId: string | null;
  addedLabelIds: string[] | null;
  removedLabelIds: string[] | null;
};

// What a team offers the pickers.
export type FakeTeamCatalog = {
  team: { id: string; key: string; name: string };
  states: FakeIssue['state'][];
  members: FakeUser[];
  labels: FakeIssue['labels']['nodes'];
  cycles: NonNullable<FakeIssue['cycle']>[];
  projects: NonNullable<FakeIssue['project']>[];
};

// Linear refusing a request: answered with GraphQL errors.
export class FakeLinearRefusal extends Error {}

const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const TODO = { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' };

// Every team's workflow, unless a test sets its own catalog.
export const FAKE_STATES: FakeIssue['state'][] = [
  { id: 'state-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  TODO,
  { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' },
  { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
  { id: 'state-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3' },
];
export const FAKE_LABELS: FakeIssue['labels']['nodes'] = [
  { id: 'label-bug', name: 'Bug', color: '#eb5757' },
  { id: 'label-customer', name: 'Customer', color: '#5e6ad2' },
  { id: 'label-feature', name: 'Feature', color: '#4cb782' },
];

const NO_CHANGE: Omit<FakeHistoryEntry, 'createdAt' | 'actor'> = {
  fromStateId: null,
  toStateId: null,
  fromAssigneeId: null,
  toAssigneeId: null,
  fromPriority: null,
  toPriority: null,
  fromDueDate: null,
  toDueDate: null,
  fromEstimate: null,
  toEstimate: null,
  fromCycleId: null,
  toCycleId: null,
  fromProjectId: null,
  toProjectId: null,
  addedLabelIds: null,
  removedLabelIds: null,
};

// The history entry for the synced fields that differ between two versions of an issue, if any.
function historyOf(
  before: FakeIssue,
  after: FakeIssue,
): Omit<FakeHistoryEntry, 'createdAt' | 'actor'> | null {
  const entry = { ...NO_CHANGE };
  let changed = false;
  const note = <K extends keyof typeof entry>(from: K, to: K, a: unknown, b: unknown) => {
    if ((a ?? null) === (b ?? null)) return;
    Object.assign(entry, { [from]: a ?? null, [to]: b ?? null });
    changed = true;
  };
  note('fromStateId', 'toStateId', before.state.id, after.state.id);
  note('fromAssigneeId', 'toAssigneeId', before.assignee?.id, after.assignee?.id);
  note('fromPriority', 'toPriority', before.priority, after.priority);
  note('fromDueDate', 'toDueDate', before.dueDate, after.dueDate);
  note('fromEstimate', 'toEstimate', before.estimate, after.estimate);
  note('fromCycleId', 'toCycleId', before.cycle?.id, after.cycle?.id);
  note('fromProjectId', 'toProjectId', before.project?.id, after.project?.id);
  const had = new Set(before.labels.nodes.map((label) => label.id));
  const has = new Set(after.labels.nodes.map((label) => label.id));
  const added = [...has].filter((id) => !had.has(id));
  const removed = [...had].filter((id) => !has.has(id));
  if (added.length || removed.length) {
    Object.assign(entry, { addedLabelIds: added, removedLabelIds: removed });
    changed = true;
  }
  return changed ? entry : null;
}

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
  const histories = new Map<string, FakeHistoryEntry[]>();
  const catalogs = new Map<string, FakeTeamCatalog[]>();
  let nextId = 1;
  const stamp = () => new Date(now()).toISOString();

  // Applies a change to an issue as Linear would, recording what it changed and who changed it.
  function change(issue: FakeIssue, changes: Partial<FakeIssue>, by: FakeUser | null, quietly = false) {
    const before = structuredClone(issue);
    const at = stamp();
    Object.assign(issue, changes, quietly ? {} : { updatedAt: at });
    const entry = historyOf(before, issue);
    if (entry) {
      const actor = by ? { id: by.id, name: by.name } : null;
      histories.set(issue.id, [{ createdAt: at, actor, ...entry }, ...(histories.get(issue.id) ?? [])]);
    }
  }

  // What a workspace's teams offer: the catalog a test set, or every team's issues' values plus the
  // standard workflow and labels.
  function catalogOf(workspaceId: string, viewer: FakeUser | null): FakeTeamCatalog[] {
    const set = catalogs.get(workspaceId);
    if (set) return set;
    const issues = byWorkspace.get(workspaceId) ?? [];
    const teams = new Map<string, FakeTeamCatalog>();
    const unique = <T extends { id: string }>(list: T[]) => [
      ...new Map(list.map((each) => [each.id, each])).values(),
    ];
    for (const issue of issues) {
      const team = teams.get(issue.team.id) ?? {
        team: issue.team,
        states: [...FAKE_STATES],
        members: viewer ? [viewer] : [],
        labels: [...FAKE_LABELS],
        cycles: [],
        projects: [],
      };
      team.states = unique([...team.states, issue.state]);
      team.members = unique([
        ...team.members,
        ...[issue.assignee, issue.creator].filter((who) => !!who),
      ] as FakeUser[]);
      team.labels = unique([...team.labels, ...issue.labels.nodes]);
      if (issue.cycle) team.cycles = unique([...team.cycles, issue.cycle]);
      if (issue.project) team.projects = unique([...team.projects, issue.project]);
      teams.set(issue.team.id, team);
    }
    return [...teams.values()];
  }

  function teamOf(workspaceId: string, issue: FakeIssue, viewer: FakeUser | null): FakeTeamCatalog {
    const team = catalogOf(workspaceId, viewer).find((each) => each.team.id === issue.team.id);
    if (!team) throw new FakeLinearRefusal('Could not find referenced Team.');
    return team;
  }

  // An issueUpdate input, resolved against the team's catalog as Linear checks ids.
  function changesFrom(team: FakeTeamCatalog, issue: FakeIssue, input: Record<string, unknown>) {
    const pick = <T extends { id: string }>(list: T[], id: unknown, what: string): T | null => {
      if (id === null) return null;
      const found = list.find((each) => each.id === id);
      if (!found) throw new FakeLinearRefusal(`Could not find referenced ${what}.`);
      return found;
    };
    const changes: Partial<FakeIssue> = {};
    if ('stateId' in input) {
      const state = pick(team.states, input.stateId, 'WorkflowState');
      if (!state) throw new FakeLinearRefusal('An issue needs a workflow state.');
      changes.state = state;
    }
    if ('assigneeId' in input) changes.assignee = pick(team.members, input.assigneeId, 'User');
    if ('priority' in input) changes.priority = Number(input.priority);
    if ('dueDate' in input) changes.dueDate = (input.dueDate as string | null) ?? null;
    if ('estimate' in input) changes.estimate = (input.estimate as number | null) ?? null;
    if ('cycleId' in input) changes.cycle = pick(team.cycles, input.cycleId, 'Cycle');
    if ('projectId' in input) changes.project = pick(team.projects, input.projectId, 'Project');
    const added = (input.addedLabelIds as string[] | undefined) ?? [];
    const removed = new Set((input.removedLabelIds as string[] | undefined) ?? []);
    if (added.length || removed.size) {
      const labels = issue.labels.nodes.filter((label) => !removed.has(label.id));
      for (const id of added) {
        const label = pick(team.labels, id, 'IssueLabel');
        if (label && !labels.some((each) => each.id === id)) labels.push(label);
      }
      changes.labels = { nodes: labels };
    }
    return changes;
  }

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

    // Changes an issue the way an edit in Linear does (by `by`, when given), moving its updatedAt on
    // and recording what changed in its history. `quietly` leaves updatedAt alone, so a sync asking
    // for what changed since misses it (as an "assigned to me" poll misses a reassignment).
    update(id: string, changes: Partial<FakeIssue>, by: FakeUser | null = null, { quietly = false } = {}) {
      change(find(id), changes, by, quietly);
    },

    // The issue as the fake has it now, for checking what reached Linear.
    get(id: string): FakeIssue {
      return structuredClone(find(id));
    },

    history(id: string): FakeHistoryEntry[] {
      return structuredClone(histories.get(id) ?? []);
    },

    // What a workspace's teams offer the pickers, in place of what its issues show.
    setCatalog(workspaceId: string, teams: FakeTeamCatalog[]) {
      catalogs.set(workspaceId, teams);
    },

    archive(id: string) {
      const at = stamp();
      Object.assign(find(id), { archivedAt: at, updatedAt: at });
    },

    // Answers one of Commander's sync queries or writes for a workspace (as `viewer`), or null for any
    // other query. Throws FakeLinearRefusal for a request Linear would refuse.
    answer(
      workspaceId: string,
      operationName: string,
      variables: Record<string, unknown>,
      viewer: FakeUser | null = null,
    ): unknown {
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
        case 'CommanderIssueForWrite':
        case 'CommanderIssueHistory':
        case 'CommanderIssue': {
          const issue = issues.find((each) => each.id === variables.id);
          if (!issue) throw new FakeLinearRefusal('Could not find referenced Issue.');
          const entries = (histories.get(issue.id) ?? []).map((entry, i) => ({
            id: `history-${i}`,
            ...entry,
          }));
          const history = page(entries, 50, cursor);
          if (operationName === 'CommanderIssueHistory') return { issue: { history } };
          if (operationName === 'CommanderIssue') return { issue: node(issue) };
          return { issue: { ...node(issue), history } };
        }
        case 'CommanderIssueUpdate': {
          const issue = issues.find((each) => each.id === variables.id);
          if (!issue) throw new FakeLinearRefusal('Could not find referenced Issue.');
          const input = (variables.input ?? {}) as Record<string, unknown>;
          change(issue, changesFrom(teamOf(workspaceId, issue, viewer), issue, input), viewer);
          return { issueUpdate: { success: true, issue: node(issue) } };
        }
        case 'CommanderCommentCreate': {
          const input = (variables.input ?? {}) as { id?: string; issueId?: string; body?: string };
          const issue = issues.find((each) => each.id === input.issueId);
          if (!issue) throw new FakeLinearRefusal('Could not find referenced Issue.');
          const id = input.id ?? `comment-${nextId++}`;
          if (issues.some((each) => each.comments.some((comment) => comment.id === id))) {
            throw new FakeLinearRefusal('Entity already exists.');
          }
          const at = stamp();
          issue.comments.push({ id, body: input.body ?? '', createdAt: at, updatedAt: at, user: viewer });
          return { commentCreate: { success: true } };
        }
        case 'CommanderCommentDelete': {
          const issue = issues.find((each) => each.comments.some((comment) => comment.id === variables.id));
          if (!issue) throw new FakeLinearRefusal('Could not find referenced Comment.');
          issue.comments = issue.comments.filter((comment) => comment.id !== variables.id);
          return { commentDelete: { success: true } };
        }
        case 'CommanderCatalog': {
          const gt = (variables.cycles as { endsAt?: { gt?: string } } | undefined)?.endsAt?.gt;
          const teams = catalogOf(workspaceId, viewer);
          return {
            teams: {
              nodes: teams.map((team) => ({
                ...team.team,
                states: { nodes: team.states.map((state, position) => ({ ...state, position })) },
                members: { nodes: team.members.map((member) => ({ ...member, active: true })) },
                cycles: { nodes: team.cycles.filter((cycle) => !gt || after(cycle.endsAt, gt)) },
                projects: { nodes: team.projects },
              })),
            },
            issueLabels: {
              nodes: [
                ...new Map(
                  teams.flatMap((team) => team.labels.map((label) => [label.id, { ...label, team: null }])),
                ).values(),
              ],
            },
          };
        }
        default:
          return null;
      }
    },
  };
}

export type FakeIssues = ReturnType<typeof createFakeIssues>;
