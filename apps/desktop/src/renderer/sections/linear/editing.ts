import type {
  ActivityEntry,
  LinearCatalog,
  LinearCatalogTeam,
  LinearIssueDetail,
  LinearUser,
  OutgoingChange,
} from '@commander/domain';
import type { Issue } from './issues';

/*
  What the detail pane needs to edit an issue (Two-way sync), worked out as pure functions: each
  picker's choices, from what the issue's Linear offers (its Account's catalog for the issue's team)
  plus what the issues themselves show, so a picker always has the current value and still works
  before the first catalog arrives; whether the issue's changes are on their way or couldn't sync;
  and the note left when a change made in Linear won over the User's.
*/

type State = LinearIssueDetail['state'];
type Label = LinearIssueDetail['labels'][number];
type Cycle = NonNullable<LinearIssueDetail['cycle']>;
type LinearProject = NonNullable<LinearIssueDetail['linearProject']>;

export interface PickerOptions {
  states: State[];
  members: LinearUser[];
  labels: Label[];
  cycles: Cycle[];
  linearProjects: LinearProject[];
}

function unique<T extends { id: string }>(lists: (T | null | undefined)[][]): T[] {
  const found = new Map<string, T>();
  for (const list of lists)
    for (const each of list) if (each && !found.has(each.id)) found.set(each.id, each);
  return [...found.values()];
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
const STATE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];
const stateRank = (state: State) => {
  const rank = STATE_ORDER.indexOf(state.type);
  return rank === -1 ? STATE_ORDER.length : rank;
};

/**
 * The choices each picker offers for an issue: its team's states (in the team's order), members,
 * labels, cycles not yet over and Linear projects, as its Account's Linear offers them, plus any
 * the team's issues show (the catalog may be cut short, or not fetched yet).
 */
export function pickerOptions(
  issue: Issue,
  catalog: LinearCatalog | null,
  issues: readonly Issue[],
  now: number,
): PickerOptions {
  const team: LinearCatalogTeam | undefined = catalog?.teams.find((each) => each.id === issue.detail.team.id);
  const teamIssues = issues.filter(
    (other) => other.account === issue.account && other.detail.team.id === issue.detail.team.id,
  );
  const seen = <T>(pick: (detail: LinearIssueDetail) => T[]) =>
    teamIssues.flatMap((other) => pick(other.detail));
  const fromIssues = {
    states: seen((detail) => [detail.state]).sort((a, b) => stateRank(a) - stateRank(b) || byName(a, b)),
    members: seen((detail) =>
      [detail.assignee, detail.creator].filter((who): who is LinearUser => !!who),
    ).sort(byName),
    labels: seen((detail) => detail.labels).sort(byName),
    cycles: seen((detail) => (detail.cycle && detail.cycle.endsAt > now ? [detail.cycle] : [])),
    linearProjects: seen((detail) => (detail.linearProject ? [detail.linearProject] : [])).sort(byName),
  };
  const { detail } = issue;
  return {
    states: unique([team?.states ?? [], [detail.state], fromIssues.states]),
    members: unique([team?.members ?? [], [detail.assignee], fromIssues.members]),
    labels: unique([team?.labels ?? [], detail.labels, fromIssues.labels]).sort(byName),
    cycles: unique([team?.cycles ?? [], [detail.cycle], fromIssues.cycles]).sort(
      (a, b) => a.startsAt - b.startsAt,
    ),
    linearProjects: unique([
      team?.linearProjects ?? [],
      [detail.linearProject],
      fromIssues.linearProjects,
    ]).sort(byName),
  };
}

export type IssueSync =
  | { kind: 'synced' }
  // On its way to Linear (or waiting: offline, backing off).
  | { kind: 'sending' }
  // Couldn't sync: stopped until the User retries or undoes. `error` in plain words.
  | { kind: 'failed'; error: string | null };

/** Where an issue's own changes stand: all in Linear, on their way, or (any of them) couldn't sync. */
export function issueSync(changes: readonly OutgoingChange[]): IssueSync {
  const failed = changes.find((change) => change.status === 'failed');
  if (failed) return { kind: 'failed', error: failed.error };
  return changes.length ? { kind: 'sending' } : { kind: 'synced' };
}

/**
 * The note shown on an issue when a change made in Linear won over the User's ("Changed in Linear
 * by Priya Patel at 14:02"): the Source's newest such entry, until the User changes the issue again.
 */
export function supersededNote(history: readonly ActivityEntry[]): string | null {
  for (const entry of history) {
    if (entry.by.kind === 'source') {
      if (entry.why) return entry.why;
      continue;
    }
    if (entry.by.kind === 'user' || entry.by.kind === 'ares') return null;
  }
  return null;
}
