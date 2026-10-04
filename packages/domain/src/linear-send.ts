import { z } from 'zod';
import { labelBlockLinks } from './block-links';
import { blockTags } from './block-projects';
import { filing } from './items';
import { type LinearCatalog, type LinearCatalogTeam, type LinearIssueDetail, linearUser } from './linear';
import { linearTodoFate } from './linear-todos';
import type { Project } from './projects';
import { isGroup, type Rule, type RuleCondition } from './rules';

/*
  Send to Linear: a new Linear issue made in Commander, from a Todo, a Daily Note Block, or the Linear
  Section. The Item store makes the issue's Item at once and queues its creation for Linear in the
  same transaction (ADR 0003), as the outgoing change `create`; the sync engine sends it with an id
  Commander made (Linear accepts a client-generated UUID for a new issue), and checks first whether
  Linear already has that id, so a retry after a lost answer never makes a second issue. Undoing the
  send queues `delete`, which deletes the issue in Linear (or, if it never got there, nothing).
*/

const id = z.string().min(1);

// The outgoing changes that make and delete a Source Item, beside its synced fields.
export const CREATE_FIELD = 'create';
export const DELETE_FIELD = 'delete';

const state = z.object({ id, name: z.string(), type: z.string(), color: z.string() });

// What the Send to Linear dialog hands the Item store.
export const linearIssueDraft = z.object({
  // The Todo or Block the issue is made from; left out for New Linear issue in the Linear Section.
  from: id.optional(),
  // For an issue made from nothing: its Project (the Project filter's), filed by the User.
  filing: filing.optional(),
  account: id,
  team: z.object({ id, key: z.string().min(1), name: z.string() }),
  title: z.string().trim().min(1, 'An issue needs a title').max(255),
  // Markdown. Sent only when the issue is made; read-only in Commander after that.
  description: z.string().max(100_000).optional(),
  assignee: linearUser.nullable(),
  state,
  // 0 none, 1 urgent, 2 high, 3 medium, 4 low.
  priority: z.number().int().min(0).max(4).default(0),
});
export type LinearIssueDraft = z.input<typeof linearIssueDraft>;

// The `create` change's value: Linear's issueCreate input, less the id (the Item's external id).
export const linearIssueCreate = z.object({
  teamId: id,
  title: z.string().min(1),
  description: z.string().nullable(),
  assigneeId: id.nullable(),
  stateId: id,
  priority: z.number().int().min(0).max(4),
});
export type LinearIssueCreate = z.infer<typeof linearIssueCreate>;

// Where the dialog starts: the title from the Todo or Block, the item's Project, and the team.
export const linearSendPrefill = z.object({
  title: z.string(),
  projectId: id.nullable(),
  team: z.object({ account: id, teamId: id }).nullable(),
});
export type LinearSendPrefill = z.infer<typeof linearSendPrefill>;

export type TeamChoice = { account: string; teamId: string };

/** The identifier a new issue shows until Linear numbers it: "ENG-…". */
export function pendingIdentifier(team: { key: string }): string {
  return `${team.key}-…`;
}

const teamConditions = (rule: Rule): RuleCondition[] =>
  rule.when.terms
    .flatMap((term) => (isGroup(term) ? term.conditions : [term]))
    .filter((condition) => condition.field === 'linear.team' && condition.op === 'is');

// The Account whose workspace has the team, if any connected one does.
function accountWith(catalogs: ReadonlyMap<string, LinearCatalog | null>, teamId: string): string | null {
  for (const [account, catalog] of catalogs)
    if (catalog?.teams.some((team) => team.id === teamId)) return account;
  return null;
}

/**
 * The team Send to Linear starts on for an item in `projectId`: the team of the first Rule, in list
 * order, that files into that Project and has a "team is" condition (in the workspace that has the
 * team); else the last team the User sent to; else null. Only teams a connected workspace offers.
 */
export function teamForProject(
  rules: readonly Rule[],
  projectId: string | null,
  catalogs: ReadonlyMap<string, LinearCatalog | null>,
  last: TeamChoice | null,
): TeamChoice | null {
  if (projectId !== null) {
    const ordered = [...rules].sort((a, b) => a.order - b.order);
    for (const rule of ordered) {
      if (rule.target.projectId !== projectId) continue;
      for (const condition of teamConditions(rule)) {
        const account = accountWith(catalogs, condition.value);
        if (account) return { account, teamId: condition.value };
      }
    }
  }
  if (last && catalogs.get(last.account)?.teams.some((team) => team.id === last.teamId)) return last;
  return null;
}

/**
 * The state a new issue starts in: the team's default state, as Linear names it; else its first
 * unstarted state, else its first backlog state, else its first. Null when it has none known.
 */
export function defaultStateOf(team: LinearCatalogTeam): LinearIssueDetail['state'] | null {
  const named = team.defaultStateId ? team.states.find((each) => each.id === team.defaultStateId) : null;
  return (
    named ??
    team.states.find((each) => each.type === 'unstarted') ??
    team.states.find((each) => each.type === 'backlog') ??
    team.states[0] ??
    null
  );
}

/**
 * Why an issue sent from a Todo leaves that Todo off the User's list (the Todo goes, as any Linear
 * Todo that leaves the list): "Sent to Linear, assigned to Priya Patel". Null when it is one of the
 * User's Linear Todos (or a done one), and while who the User is (`me`) is unknown.
 */
export function sentWhy(detail: LinearIssueDetail, me: string | null, now: number): string | null {
  if (detail.state.type === 'canceled') return `Sent to Linear as ${detail.state.name}`;
  if (me === null) return null;
  if (detail.assignee?.id !== me) {
    return detail.assignee
      ? `Sent to Linear, assigned to ${detail.assignee.name}`
      : 'Sent to Linear, unassigned';
  }
  const fate = linearTodoFate(detail, me, now);
  if (fate.todo !== 'none') return null;
  if (detail.state.type === 'backlog' || detail.state.type === 'triage')
    return `Sent to Linear in ${detail.state.name}, outside the current cycle`;
  return `Sent to Linear in ${detail.state.name}`;
}

/**
 * The issue title a Block's text suggests: its words without `#LT` codes and Markdown marks, with each
 * `[[` link named (a day as it is, a Project or a calendar event by name). An image Block suggests
 * nothing.
 */
export function issueTitleFrom(
  text: string,
  projects: readonly Pick<Project, 'id' | 'code' | 'name' | 'archived'>[],
  eventTitle: (eventId: string) => string | undefined = () => undefined,
): string {
  let plain = text;
  for (const tag of blockTags(text, projects).reverse())
    plain = plain.slice(0, tag.start) + plain.slice(tag.end);
  plain = labelBlockLinks(plain, (target) => {
    if (target.type === 'day') return target.day;
    if (target.type === 'event') return eventTitle(target.eventId) ?? '';
    return projects.find((p) => p.id === target.projectId)?.name ?? '';
  });
  return plain
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/(\*\*|__|~~|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
