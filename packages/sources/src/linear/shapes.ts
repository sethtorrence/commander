import type { LinearComment, LinearIssueDetail, LinearUser, SourceItem } from '@commander/domain';
import { z } from 'zod';
import type { LinearQuery } from './client';
import { ISSUE_COMMENTS } from './graphql';

// Linear's answers as Commander reads them (validated before anything is translated), and how an
// issue becomes a `linear-issue` Item. Shared by sync and Two-way sync's writes.

export const user = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  email: z.string().nullish(),
});
export const comment = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  user: user.nullish(),
});
export const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });
export const comments = z.object({ nodes: z.array(comment), pageInfo });
export const issue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().nullish(),
  priority: z.number(),
  estimate: z.number().nullish(),
  dueDate: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullish(),
  completedAt: z.string().nullish(),
  canceledAt: z.string().nullish(),
  archivedAt: z.string().nullish(),
  trashed: z.boolean().nullish(),
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  state: z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string() }),
  assignee: user.nullish(),
  creator: user.nullish(),
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })) }),
  cycle: z
    .object({
      id: z.string(),
      number: z.number(),
      name: z.string().nullish(),
      startsAt: z.string(),
      endsAt: z.string(),
    })
    .nullish(),
  project: z.object({ id: z.string(), name: z.string() }).nullish(),
  comments,
});
export type Issue = z.infer<typeof issue>;
export const issuesData = z.object({ issues: z.object({ nodes: z.array(issue), pageInfo }) });
export const issueCommentsData = z.object({ issue: z.object({ comments }) });
export const changedCommentsData = z.object({
  comments: z.object({
    nodes: z.array(z.object({ updatedAt: z.string(), issue: z.object({ id: z.string() }).nullish() })),
    pageInfo,
  }),
});

export const time = (iso: string) => Date.parse(iso);
export const optionalTime = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
export const later = (a: string | null, b: string) => (a === null || time(b) > time(a) ? b : a);

export function toUser(from: z.infer<typeof user>): LinearUser {
  return { id: from.id, name: from.name, displayName: from.displayName, email: from.email ?? null };
}

export function toComment(from: z.infer<typeof comment>): LinearComment {
  return {
    id: from.id,
    author: from.user ? toUser(from.user) : null,
    body: from.body,
    createdAt: time(from.createdAt),
    updatedAt: time(from.updatedAt),
  };
}

// People involved, as handles: each Linear user, and their email where Linear gives it.
export function handles(...users: (z.infer<typeof user> | null | undefined)[]): string[] {
  const all = users.flatMap((who) => (who ? [`linear:${who.id}`, ...(who.email ? [who.email] : [])] : []));
  return [...new Set(all)];
}

export function toItem(from: Issue, everyComment: z.infer<typeof comment>[]): SourceItem {
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier: from.identifier,
    url: from.url,
    team: from.team,
    state: from.state,
    priority: from.priority,
    assignee: from.assignee ? toUser(from.assignee) : null,
    creator: from.creator ? toUser(from.creator) : null,
    labels: [...from.labels.nodes].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    cycle: from.cycle
      ? {
          id: from.cycle.id,
          number: from.cycle.number,
          name: from.cycle.name ?? null,
          startsAt: time(from.cycle.startsAt),
          endsAt: time(from.cycle.endsAt),
        }
      : null,
    linearProject: from.project ?? null,
    dueDate: from.dueDate ?? null,
    estimate: from.estimate ?? null,
    description: from.description ?? null,
    comments: everyComment
      .map(toComment)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    createdAt: time(from.createdAt),
    updatedAt: time(from.updatedAt),
    startedAt: optionalTime(from.startedAt),
    completedAt: optionalTime(from.completedAt),
    canceledAt: optionalTime(from.canceledAt),
  };
  const done = from.state.type === 'completed' || from.state.type === 'canceled';
  return {
    externalId: from.id,
    kind: 'linear-issue',
    title: from.title,
    people: handles(from.assignee, from.creator),
    status: done ? 'done' : 'open',
    detail,
  };
}

// Every comment of an issue: those that came with it, and the rest page by page.
export async function allComments(query: LinearQuery, from: Issue): Promise<z.infer<typeof comment>[]> {
  const all = [...from.comments.nodes];
  let page = from.comments.pageInfo;
  while (page.hasNextPage) {
    const data = await query(
      ISSUE_COMMENTS,
      'CommanderIssueComments',
      { id: from.id, after: page.endCursor ?? null },
      issueCommentsData,
    );
    all.push(...data.issue.comments.nodes);
    page = data.issue.comments.pageInfo;
  }
  return all;
}
