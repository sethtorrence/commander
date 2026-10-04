import type { LinearCatalogTeam, LinearIssueDetail } from './linear';

/*
  Linear Todos: the User's assigned Linear issues, shown as Todos (labelled as Linear). An issue is a
  Linear Todo when it is assigned to the User (the Account's signed-in Linear user) and its workflow
  state is unstarted or started (Todo, In Progress, In Review and each team's equivalents), or backlog
  or triage while it is in its team's current cycle. Completed and cancelled issues never are.

  The Item store keeps exactly one Todo (origin Linear, backed by the issue) per Linear Todo, after
  each sync and after each change to the issue; the Dashboard ranks the same issues. Pure, with the
  clock passed in, so the window and the Core judge alike.
*/

type State = LinearIssueDetail['state'];

/**
 * What an issue means for its Todo: a Linear Todo (open), completed (its Todo, if any, is ticked), or
 * none (its Todo goes), with why in plain words ("ENG-418 was reassigned to Priya Patel").
 */
export type LinearTodoFate = { todo: 'open' } | { todo: 'done' } | { todo: 'none'; why: string };

const inCurrentCycle = ({ cycle }: LinearIssueDetail, now: number) =>
  !!cycle && cycle.startsAt <= now && now < cycle.endsAt;

/**
 * What the issue means for its Todo, for the User whose Linear user id is `me`. With `me` unknown
 * (null), only the state is judged: the caller must not make new Todos then.
 */
export function linearTodoFate(detail: LinearIssueDetail, me: string | null, now: number): LinearTodoFate {
  const { identifier, state, assignee } = detail;
  if (state.type === 'canceled') return { todo: 'none', why: `${identifier} was cancelled` };
  if (me !== null && assignee?.id !== me) {
    const why = assignee
      ? `${identifier} was reassigned to ${assignee.name}`
      : `${identifier} was unassigned`;
    return { todo: 'none', why };
  }
  switch (state.type) {
    case 'completed':
      return { todo: 'done' };
    case 'unstarted':
    case 'started':
      return { todo: 'open' };
    case 'backlog':
    case 'triage':
      return inCurrentCycle(detail, now)
        ? { todo: 'open' }
        : { todo: 'none', why: `${identifier} is in ${state.name}, outside the current cycle` };
    default:
      return { todo: 'none', why: `${identifier} moved to ${state.name}` };
  }
}

/** Whether the issue is one of the User's open Linear Todos (false while who the User is is unknown). */
export function isLinearTodo(detail: LinearIssueDetail, me: string | null, now: number): boolean {
  return me !== null && linearTodoFate(detail, me, now).todo === 'open';
}

/**
 * The team's default completed state, which ticking moves an issue to: its first completed state in
 * the team's own order (Linear's API names no default, and new teams have one, "Done"). Null when
 * none is known.
 */
export function completedStateOf(states: LinearCatalogTeam['states']): State | null {
  return states.find((state) => state.type === 'completed') ?? null;
}

/**
 * Where unticking moves an issue when the state it was in before it was completed is unknown: the
 * team's first unstarted state ("Todo"), else its first started one. Null when neither is known.
 */
export function reopenStateOf(states: LinearCatalogTeam['states']): State | null {
  return (
    states.find((state) => state.type === 'unstarted') ??
    states.find((state) => state.type === 'started') ??
    null
  );
}
