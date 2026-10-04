import { COMMENT_FIELD, LABEL_FIELD, type LinearCatalog, type LinearComment } from '@commander/domain';
import { z } from 'zod';
import type { FieldChange, Superseded, WriteRequest, WriteResult } from '../source';
import type { LinearQuery } from './client';
import {
  CATALOG,
  COMMENT_CREATE,
  COMMENT_DELETE,
  ISSUE_BY_ID,
  ISSUE_FOR_WRITE,
  ISSUE_HISTORY,
  ISSUE_UPDATE,
} from './graphql';
import { allComments, issue, pageInfo, time, toItem, toUser, user } from './shapes';

// Linear's write side (Two-way sync): one issue's queued changes at a time, as the User (their token).
//
// 1. Read the issue as Linear has it now, with its history and comments.
// 2. Per field, the newer change wins: a change Linear recorded to the field after the User made
//    theirs (`madeAt`) supersedes it, and is reported with who made it and when. Changes to
//    different fields are always both kept.
// 3. Send the rest: one `issueUpdate` with only the changed fields (labels as add/remove deltas),
//    `commentCreate` with Commander's own comment id (skipped when Linear already has it, so a retry
//    never posts twice), and `commentDelete` for a comment the User took back.
// 4. Return the issue as Linear has it afterwards, so it can be saved at once.

// Linear's record of one change to an issue.
const historyEntry = z.object({
  createdAt: z.string(),
  actor: z.object({ id: z.string(), name: z.string() }).nullish(),
  fromStateId: z.string().nullish(),
  toStateId: z.string().nullish(),
  fromAssigneeId: z.string().nullish(),
  toAssigneeId: z.string().nullish(),
  fromPriority: z.number().nullish(),
  toPriority: z.number().nullish(),
  fromDueDate: z.string().nullish(),
  toDueDate: z.string().nullish(),
  fromEstimate: z.number().nullish(),
  toEstimate: z.number().nullish(),
  fromCycleId: z.string().nullish(),
  toCycleId: z.string().nullish(),
  fromProjectId: z.string().nullish(),
  toProjectId: z.string().nullish(),
  addedLabelIds: z.array(z.string()).nullish(),
  removedLabelIds: z.array(z.string()).nullish(),
});
type HistoryEntry = z.infer<typeof historyEntry>;
const history = z.object({ nodes: z.array(historyEntry), pageInfo });
const issueForWriteData = z.object({ issue: issue.extend({ history }) });
const issueHistoryData = z.object({ issue: z.object({ history }) });
const issueData = z.object({ issue });
const issueUpdateData = z.object({ issueUpdate: z.object({ success: z.boolean(), issue: issue.nullish() }) });
const commentCreateData = z.object({ commentCreate: z.object({ success: z.boolean() }) });
const commentDeleteData = z.object({ commentDelete: z.object({ success: z.boolean() }) });

// Enough history to judge any edit: Linear keeps every change, so a very old issue is cut off here.
const MOST_HISTORY_PAGES = 10;

const differs = (a: unknown, b: unknown) => (a ?? null) !== (b ?? null);

// Whether a history entry changed the synced field.
function touches(entry: HistoryEntry, field: string): boolean {
  if (field.startsWith(LABEL_FIELD)) {
    const id = field.slice(LABEL_FIELD.length);
    return !!entry.addedLabelIds?.includes(id) || !!entry.removedLabelIds?.includes(id);
  }
  switch (field) {
    case 'state':
      return entry.toStateId != null && differs(entry.fromStateId, entry.toStateId);
    case 'assignee':
      return differs(entry.fromAssigneeId, entry.toAssigneeId);
    case 'priority':
      return entry.toPriority != null && differs(entry.fromPriority, entry.toPriority);
    case 'dueDate':
      return differs(entry.fromDueDate, entry.toDueDate);
    case 'estimate':
      return differs(entry.fromEstimate, entry.toEstimate);
    case 'cycle':
      return differs(entry.fromCycleId, entry.toCycleId);
    case 'linearProject':
      return differs(entry.fromProjectId, entry.toProjectId);
    default:
      // Comments are never overwritten: posting one and deleting one's own don't conflict.
      return false;
  }
}

// The newest change Linear recorded to the field after the User made theirs, if any.
function newerInLinear(entries: HistoryEntry[], change: FieldChange): Superseded | null {
  let newest: HistoryEntry | null = null;
  for (const entry of entries) {
    if (!touches(entry, change.field) || time(entry.createdAt) <= change.madeAt) continue;
    if (!newest || time(entry.createdAt) > time(newest.createdAt)) newest = entry;
  }
  return newest ? { field: change.field, by: newest.actor?.name ?? null, at: time(newest.createdAt) } : null;
}

const idOf = (value: unknown) => (value as { id?: string } | null)?.id ?? null;

// Whether Linear already has the change's value for the field (a retry whose first answer was lost,
// or someone made the same change there): nothing to send, and nothing it lost to.
function alreadyHas(current: z.infer<typeof issue>, change: FieldChange): boolean {
  if (change.field.startsWith(LABEL_FIELD)) {
    const id = change.field.slice(LABEL_FIELD.length);
    return current.labels.nodes.some((label) => label.id === id) === !!change.value;
  }
  switch (change.field) {
    case 'state':
      return current.state.id === idOf(change.value);
    case 'assignee':
      return (current.assignee?.id ?? null) === idOf(change.value);
    case 'priority':
      return current.priority === change.value;
    case 'dueDate':
      return (current.dueDate ?? null) === (change.value ?? null);
    case 'estimate':
      return (current.estimate ?? null) === (change.value ?? null);
    case 'cycle':
      return (current.cycle?.id ?? null) === idOf(change.value);
    case 'linearProject':
      return (current.project?.id ?? null) === idOf(change.value);
    default:
      return false;
  }
}

// The issueUpdate input for one changed field (not labels or comments).
function inputFor(change: FieldChange): Record<string, unknown> {
  switch (change.field) {
    case 'state':
      return { stateId: idOf(change.value) };
    case 'assignee':
      return { assigneeId: idOf(change.value) };
    case 'priority':
      return { priority: change.value };
    case 'dueDate':
      return { dueDate: change.value };
    case 'estimate':
      return { estimate: change.value };
    case 'cycle':
      return { cycleId: idOf(change.value) };
    case 'linearProject':
      return { projectId: idOf(change.value) };
    default:
      return {};
  }
}

export async function writeIssue(
  query: LinearQuery,
  request: WriteRequest,
): Promise<Omit<WriteResult, 'cost'>> {
  const write = { write: true };
  const id = request.externalId;
  const { issue: current } = await query(
    ISSUE_FOR_WRITE,
    'CommanderIssueForWrite',
    { id },
    issueForWriteData,
    write,
  );
  const entries = [...current.history.nodes];
  let page = current.history.pageInfo;
  for (let pages = 1; page.hasNextPage && pages < MOST_HISTORY_PAGES; pages++) {
    const more = await query(
      ISSUE_HISTORY,
      'CommanderIssueHistory',
      { id, after: page.endCursor ?? null },
      issueHistoryData,
      write,
    );
    entries.push(...more.issue.history.nodes);
    page = more.issue.history.pageInfo;
  }
  const comments = await allComments(query, current);
  const has = new Set(comments.map((comment) => comment.id));

  const superseded: Superseded[] = [];
  const input: Record<string, unknown> = {};
  const addedLabelIds: string[] = [];
  const removedLabelIds: string[] = [];
  const posts: LinearComment[] = [];
  const takeBacks: string[] = [];
  for (const change of request.changes) {
    if (alreadyHas(current, change)) continue;
    const newer = newerInLinear(entries, change);
    if (newer) {
      superseded.push(newer);
      continue;
    }
    if (change.field.startsWith(LABEL_FIELD)) {
      const labelId = change.field.slice(LABEL_FIELD.length);
      (change.value ? addedLabelIds : removedLabelIds).push(labelId);
    } else if (change.field.startsWith(COMMENT_FIELD)) {
      const commentId = change.field.slice(COMMENT_FIELD.length);
      // Only posting and taking back: an edit to a comment's text stays in Linear.
      if (change.value && !change.synced && !has.has(commentId)) posts.push(change.value as LinearComment);
      if (!change.value && change.synced && has.has(commentId)) takeBacks.push(commentId);
    } else {
      Object.assign(input, inputFor(change));
    }
  }
  if (addedLabelIds.length) input.addedLabelIds = addedLabelIds;
  if (removedLabelIds.length) input.removedLabelIds = removedLabelIds;

  for (const comment of posts) {
    await query(
      COMMENT_CREATE,
      'CommanderCommentCreate',
      { input: { id: comment.id, issueId: id, body: comment.body } },
      commentCreateData,
      write,
    );
  }
  for (const commentId of takeBacks) {
    await query(COMMENT_DELETE, 'CommanderCommentDelete', { id: commentId }, commentDeleteData, write);
  }
  let after: z.infer<typeof issue> | null = null;
  if (Object.keys(input).length) {
    const updated = await query(ISSUE_UPDATE, 'CommanderIssueUpdate', { id, input }, issueUpdateData, write);
    after = updated.issueUpdate.issue ?? null;
  }
  if (!after && (posts.length || takeBacks.length || Object.keys(input).length)) {
    after = (await query(ISSUE_BY_ID, 'CommanderIssue', { id }, issueData, write)).issue;
  }
  const final = after ?? current;
  return { item: toItem(final, final === current ? comments : await allComments(query, final)), superseded };
}

// What Linear answers for the pickers.
const catalogData = z.object({
  teams: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        key: z.string(),
        name: z.string(),
        states: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              type: z.string(),
              color: z.string(),
              position: z.number(),
            }),
          ),
        }),
        members: z.object({ nodes: z.array(user.extend({ active: z.boolean().nullish() })) }),
        cycles: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              number: z.number(),
              name: z.string().nullish(),
              startsAt: z.string(),
              endsAt: z.string(),
            }),
          ),
        }),
        projects: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }),
      }),
    ),
  }),
  issueLabels: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        color: z.string(),
        team: z.object({ id: z.string() }).nullish(),
      }),
    ),
  }),
});

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** What the pickers offer, per team: workflow states in order, active members, labels, cycles not yet over. */
export async function fetchCatalog(query: LinearQuery, now: number): Promise<LinearCatalog> {
  const data = await query(
    CATALOG,
    'CommanderCatalog',
    { cycles: { endsAt: { gt: new Date(now).toISOString() } } },
    catalogData,
  );
  const labels = data.issueLabels.nodes;
  return {
    kind: 'linear',
    teams: data.teams.nodes.map((team) => ({
      id: team.id,
      key: team.key,
      name: team.name,
      states: [...team.states.nodes]
        .sort((a, b) => a.position - b.position)
        .map(({ id, name, type, color }) => ({ id, name, type, color })),
      members: team.members.nodes
        .filter((member) => member.active !== false)
        .map(toUser)
        .sort(byName),
      labels: labels
        .filter((label) => !label.team || label.team.id === team.id)
        .map(({ id, name, color }) => ({ id, name, color }))
        .sort(byName),
      cycles: team.cycles.nodes
        .map((cycle) => ({
          id: cycle.id,
          number: cycle.number,
          name: cycle.name ?? null,
          startsAt: time(cycle.startsAt),
          endsAt: time(cycle.endsAt),
        }))
        .sort((a, b) => a.startsAt - b.startsAt),
      linearProjects: [...team.projects.nodes].sort(byName),
    })),
  };
}
