import type { Item, LinearIssueDetail } from '@commander/domain';

/*
  The Linear Section's list, worked out from the `linear-issue` Items: the two views (Assigned to
  me, All tickets), the Linear filters (team, Linear project, assignee, state, cycle) with a count
  for each choice, and the groups the list is shown in. Pure functions, so the Section's hook and
  its tests share them. The app-wide Project filter is applied beside these (projects/filter.ts).
*/

/** A Linear issue as the Section shows it: its Item, with the `linear-issue` detail Linear sync keeps. */
export type Issue = Item & { detail: LinearIssueDetail };

/** What the Section knows of each Linear Account: its workspace's name, and who the User is there. */
export interface IssueAccount {
  id: string;
  name: string;
  user: { id: string; name: string } | null;
}
export type AccountsById = ReadonlyMap<string, IssueAccount>;

export type IssueView = 'mine' | 'all';

export function toIssues(items: readonly Item[]): Issue[] {
  return items.filter(
    (item): item is Issue => item.kind === 'linear-issue' && item.detail?.kind === 'linear-issue',
  );
}

/** Whether the issue is assigned to the User, in its own workspace. */
export function isMine(issue: Issue, accounts: AccountsById): boolean {
  const user = issue.account ? accounts.get(issue.account)?.user : null;
  return !!user && issue.detail.assignee?.id === user.id;
}

export function inView(issue: Issue, view: IssueView, accounts: AccountsById): boolean {
  return view === 'all' || isMine(issue, accounts);
}

const CLOSED_TYPES = new Set(['completed', 'canceled']);

/** Open until its workflow state is completed or canceled. */
export function isOpen(issue: Issue): boolean {
  return !CLOSED_TYPES.has(issue.detail.state.type);
}

// ---------------------------------------------------------------------------------------------
// Groups

export type GroupId = 'started' | 'unstarted' | 'backlog' | 'closed';
export interface IssueGroup {
  id: GroupId;
  title: string;
  issues: Issue[];
}

const GROUPS: { id: GroupId; title: string }[] = [
  { id: 'started', title: 'Started' },
  { id: 'unstarted', title: 'Unstarted' },
  { id: 'backlog', title: 'Backlog and triage' },
  { id: 'closed', title: 'Closed' },
];

function groupOf(issue: Issue): GroupId {
  const { type } = issue.detail.state;
  if (CLOSED_TYPES.has(type)) return 'closed';
  if (type === 'started' || type === 'unstarted') return type;
  // Backlog, triage, and any state type Linear adds later.
  return 'backlog';
}

// Urgent (1) first, then high, medium, low, and no priority (0) last.
const priorityRank = (priority: number) => (priority === 0 ? 5 : priority);
const closedAt = ({ detail }: Issue) => detail.completedAt ?? detail.canceledAt ?? detail.updatedAt;

const byPriority = (a: Issue, b: Issue) =>
  priorityRank(a.detail.priority) - priorityRank(b.detail.priority) ||
  b.detail.updatedAt - a.detail.updatedAt;
const byClosing = (a: Issue, b: Issue) => closedAt(b) - closedAt(a);

/**
 * The list's groups, in order: started, unstarted, backlog and triage, then closed (completed and
 * canceled). Open groups are ordered by priority, then the latest change; closed, latest closed first.
 */
export function groupIssues(issues: readonly Issue[]): IssueGroup[] {
  return GROUPS.map(({ id, title }) => ({
    id,
    title,
    issues: issues.filter((issue) => groupOf(issue) === id).sort(id === 'closed' ? byClosing : byPriority),
  }));
}

// ---------------------------------------------------------------------------------------------
// Filters

/**
 * The Linear filters. null is "any". `none` picks issues with no Linear project, assignee or cycle;
 * `current` picks issues in the cycle running now (each team has its own). States are chosen by
 * name, so "In Progress" covers every team's In Progress.
 */
export interface IssueFilters {
  team: string | null;
  linearProject: string | null;
  assignee: string | null;
  state: string | null;
  cycle: string | null;
}
export type FilterKey = keyof IssueFilters;
export const FILTER_KEYS: readonly FilterKey[] = ['team', 'linearProject', 'assignee', 'state', 'cycle'];
export const NO_FILTERS: IssueFilters = {
  team: null,
  linearProject: null,
  assignee: null,
  state: null,
  cycle: null,
};

export function isCurrentCycle(cycle: LinearIssueDetail['cycle'], now: number): boolean {
  return !!cycle && cycle.startsAt <= now && now < cycle.endsAt;
}

function matches(issue: Issue, key: FilterKey, value: string | null, now: number): boolean {
  if (value === null) return true;
  const { detail } = issue;
  switch (key) {
    case 'team':
      return detail.team.id === value;
    case 'linearProject':
      return value === 'none' ? !detail.linearProject : detail.linearProject?.id === value;
    case 'assignee':
      return value === 'none' ? !detail.assignee : detail.assignee?.id === value;
    case 'state':
      return detail.state.name === value;
    case 'cycle':
      if (value === 'current') return isCurrentCycle(detail.cycle, now);
      return value === 'none' ? !detail.cycle : detail.cycle?.id === value;
  }
}

export function inFilters(issue: Issue, filters: IssueFilters, now: number, except?: FilterKey): boolean {
  return FILTER_KEYS.every((key) => key === except || matches(issue, key, filters[key], now));
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}
export type FilterOptions = Record<FilterKey, FilterOption[]>;

const STATE_ORDER = ['started', 'unstarted', 'backlog', 'triage', 'completed', 'canceled'];
const stateRank = (type: string) => {
  const rank = STATE_ORDER.indexOf(type);
  return rank === -1 ? STATE_ORDER.length : rank;
};

type Choice = { value: string; label: string; order: (string | number)[] };

// Every choice a filter offers, from the issues there are (whatever the other filters).
function choicesFor(key: FilterKey, issues: readonly Issue[], accounts: AccountsById): Choice[] {
  const found = new Map<string, Choice>();
  const add = (choice: Choice) => {
    if (!found.has(choice.value)) found.set(choice.value, choice);
  };
  for (const issue of issues) {
    const { detail } = issue;
    switch (key) {
      case 'team':
        add({ value: detail.team.id, label: detail.team.name, order: [detail.team.name] });
        break;
      case 'linearProject':
        if (detail.linearProject) {
          const { id, name } = detail.linearProject;
          add({ value: id, label: name, order: [1, name] });
        }
        break;
      case 'assignee':
        if (detail.assignee) {
          const mine = isMine(issue, accounts);
          const { id, name } = detail.assignee;
          add({ value: id, label: mine ? 'You' : name, order: [mine ? 1 : 2, name] });
        }
        break;
      case 'state':
        add({
          value: detail.state.name,
          label: detail.state.name,
          order: [stateRank(detail.state.type), detail.state.name],
        });
        break;
      case 'cycle':
        if (detail.cycle) {
          const { id, number, name, startsAt } = detail.cycle;
          const label = [detail.team.key, `Cycle ${number}`, ...(name ? [name] : [])].join(' · ');
          add({ value: id, label, order: [2, startsAt, label] });
        }
        break;
    }
  }
  if (key === 'linearProject') add({ value: 'none', label: 'No Linear project', order: [0] });
  if (key === 'assignee') add({ value: 'none', label: 'Unassigned', order: [0] });
  if (key === 'cycle') {
    add({ value: 'current', label: 'Current cycle', order: [0] });
    add({ value: 'none', label: 'No cycle', order: [1] });
  }
  const compare = (a: Choice, b: Choice) => {
    for (let i = 0; i < Math.max(a.order.length, b.order.length); i++) {
      const x = a.order[i] ?? '';
      const y = b.order[i] ?? '';
      if (x === y) continue;
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    }
    return 0;
  };
  return [...found.values()].sort(compare);
}

/**
 * Each filter's choices, with how many issues each would show alongside the other filters: open
 * issues, except that a state counts every issue in it (so closed states count their closed issues).
 * `issues` are those the view and the Project filter let through.
 */
export function filterOptions(
  issues: readonly Issue[],
  filters: IssueFilters,
  now: number,
  accounts: AccountsById,
): FilterOptions {
  const options = {} as FilterOptions;
  for (const key of FILTER_KEYS) {
    const counted = issues.filter(
      (issue) => (key === 'state' || isOpen(issue)) && inFilters(issue, filters, now, key),
    );
    options[key] = choicesFor(key, issues, accounts).map(({ value, label }) => ({
      value,
      label,
      count: counted.filter((issue) => matches(issue, key, value, now)).length,
    }));
  }
  return options;
}
