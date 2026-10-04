import { z } from 'zod';

// The `linear-issue` kind detail: what Linear sync keeps of each Linear issue, as Linear reported
// it. Linear's own groupings (team, Linear project, labels, cycle) stay here as Source groupings
// for Rules to match; they never file the issue into a Commander Project by themselves. Linear
// users are kept as they are (handles) until People are matched across Sources.

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

export const linearUser = z.object({
  id,
  name: z.string(),
  displayName: z.string(),
  // Linear gives it for members of the workspace; null when it doesn't.
  email: z.string().nullable(),
});
export type LinearUser = z.infer<typeof linearUser>;

// Linear's workflow state types. Completed and canceled count as done.
export const linearStateTypes = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;

export const linearComment = z.object({
  id,
  // null for comments made by integrations rather than a person.
  author: linearUser.nullable(),
  body: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type LinearComment = z.infer<typeof linearComment>;

export const linearIssueDetail = z.object({
  kind: z.literal('linear-issue'),
  // e.g. ENG-418.
  identifier: z.string().min(1),
  url: z.string(),
  team: z.object({ id, key: z.string(), name: z.string() }),
  // `type` is one of linearStateTypes; kept as a string so a new type from Linear never breaks sync.
  state: z.object({ id, name: z.string(), type: z.string(), color: z.string() }),
  // 0 none, 1 urgent, 2 high, 3 medium, 4 low.
  priority: z.number().int().min(0).max(4),
  assignee: linearUser.nullable(),
  creator: linearUser.nullable(),
  labels: z.array(z.object({ id, name: z.string(), color: z.string() })),
  cycle: z
    .object({
      id,
      number: z.number().int(),
      name: z.string().nullable(),
      startsAt: timestamp,
      endsAt: timestamp,
    })
    .nullable(),
  // The issue's Linear project (not a Commander Project).
  linearProject: z.object({ id, name: z.string() }).nullable(),
  // Calendar day, as YYYY-MM-DD.
  dueDate: z.iso.date().nullable(),
  estimate: z.number().nullable(),
  // Markdown, read-only in v1.
  description: z.string().nullable(),
  // Oldest first.
  comments: z.array(linearComment),
  // The issues blocking this one ("blocked by" relations), with each one's state type as of this
  // issue's last sync. Missing on issues saved before Commander asked Linear for it.
  blockedBy: z
    .array(z.object({ id, identifier: z.string(), title: z.string(), stateType: z.string() }))
    .optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  canceledAt: timestamp.nullable(),
});
export type LinearIssueDetail = z.infer<typeof linearIssueDetail>;

// What the detail pane's pickers offer, per team: its workflow states, members, labels (the team's
// own and the workspace's), current and upcoming cycles, and Linear projects. Fetched by Linear sync
// with each sync and kept per Account.
export const linearCatalogTeam = z.object({
  id,
  key: z.string(),
  name: z.string(),
  // The state Linear gives the team's new issues, when known.
  defaultStateId: id.nullable().optional(),
  // In the team's own order.
  states: z.array(z.object({ id, name: z.string(), type: z.string(), color: z.string() })),
  members: z.array(linearUser),
  labels: z.array(z.object({ id, name: z.string(), color: z.string() })),
  cycles: z.array(
    z.object({
      id,
      number: z.number().int(),
      name: z.string().nullable(),
      startsAt: timestamp,
      endsAt: timestamp,
    }),
  ),
  linearProjects: z.array(z.object({ id, name: z.string() })),
});
export type LinearCatalogTeam = z.infer<typeof linearCatalogTeam>;

export const linearCatalog = z.object({
  kind: z.literal('linear'),
  teams: z.array(linearCatalogTeam),
});
export type LinearCatalog = z.infer<typeof linearCatalog>;
