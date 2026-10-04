// Send to Linear in the Item store (the domain's linear-send.ts): a new Linear issue made in
// Commander, from a Todo, a Block or the Linear Section, in one transaction. The issue's Item is made
// at once, under an external id Commander chose, and its creation is queued for Linear as the outgoing
// change `create` (ADR 0003): the sync engine sends it, retries it, and never makes it twice. The issue
// takes the item's Project as inherited; a Block sent gets a made-from Link from the issue; the Todo
// sent (or the Block's own Todo) becomes backed by the issue, so it is that issue's one Linear Todo.
import { randomUUID } from 'node:crypto';
import {
  type ActivityEntry,
  type Actor,
  type CausedBy,
  CREATE_FIELD,
  type Filing,
  type Item,
  type ItemState,
  inheritedFiling,
  issueTitleFrom,
  type LinearCatalog,
  type LinearIssueCreate,
  type LinearIssueDetail,
  type LinearIssueDraft,
  type LinearSendPrefill,
  linearIssueDraft,
  type Project,
  pendingIdentifier,
  type Rule,
  statusFromDetail,
  type TeamChoice,
  teamForProject,
} from '@commander/domain';
import type Database from 'better-sqlite3';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LinearTodos } from './linear-todos';
import type { OutgoingQueue } from './outgoing';
import * as schema from './schema';

type Entry = { by: Actor; why?: string | null; causedBy?: CausedBy | null };

export type LinearSendDeps = {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
  readItem(id: string): Item | undefined;
  // Inserts the issue's Item (as `insertItem`), returning its id and state as stored.
  insert(
    identity: Pick<Item, 'kind' | 'source' | 'account' | 'externalId'>,
    state: ItemState,
    at: number,
  ): { id: string; state: ItemState };
  log(
    entry: Entry & { action: 'create'; itemId: string; before: null; after: ItemState },
    at: number,
  ): ActivityEntry;
  link(link: { from: string; linkType: 'made-from'; to: string }, entry: Entry, at: number): ActivityEntry;
  update(item: Item, changes: Partial<ItemState>, entry: Entry, at: number): ActivityEntry;
  outgoing: OutgoingQueue;
  linearTodos: LinearTodos;
  catalog(account: string): LinearCatalog | null;
  catalogs(): ReadonlyMap<string, LinearCatalog | null>;
  rules(): Rule[];
  projects(): Project[];
  checkFiling(filing: Filing): void;
  invalid(message: string): Error;
};

export function linearSendIn(deps: LinearSendDeps) {
  const { db } = deps;

  // The live Todo made from a Block (`[]`), the latest made if there are several.
  function blockTodo(blockId: string): Item | undefined {
    const { links, items } = schema;
    const row = db
      .select({ id: items.id })
      .from(links)
      .innerJoin(items, eq(items.id, links.fromItemId))
      .where(
        and(
          eq(links.toItemId, blockId),
          eq(links.type, 'made-from'),
          eq(items.kind, 'todo'),
          isNull(items.deletedAt),
        ),
      )
      .orderBy(desc(items.createdAt))
      .get();
    return row ? deps.readItem(row.id) : undefined;
  }

  // The live Todo or Block an issue is sent from, and the Todo that becomes backed by it.
  function source(fromId: string): { from: Item; todo: Item | undefined } {
    const from = deps.readItem(fromId);
    if (!from || from.deletedAt !== null) throw deps.invalid('That Todo or Block is gone');
    if (from.kind !== 'todo' && from.kind !== 'block') {
      throw deps.invalid('Only a Todo or a Block can be sent to Linear');
    }
    const todo = from.kind === 'todo' ? from : blockTodo(from.id);
    const backedBy = todo?.detail?.kind === 'todo' ? todo.detail.backedBy : null;
    const behind = backedBy ? deps.readItem(backedBy) : undefined;
    if (behind && behind.deletedAt === null && behind.detail?.kind === 'linear-issue') {
      throw deps.invalid(`That Todo is already in Linear, as ${behind.detail.identifier}`);
    }
    return { from, todo };
  }

  // The team the User last sent an issue to, from the activity log.
  function lastSent(): TeamChoice | null {
    const row = deps.sqlite
      .prepare(
        `SELECT i.account AS account, json_extract(d.data, '$.team.id') AS teamId
         FROM activity a
         JOIN items i ON i.id = a.item_id
         JOIN linear_issue_details d ON d.item_id = i.id
         WHERE a.action = 'create' AND a.actor <> 'source' AND i.kind = 'linear-issue'
         ORDER BY a.id DESC LIMIT 1`,
      )
      .get() as { account: string | null; teamId: string | null } | undefined;
    return row?.account && row.teamId ? { account: row.account, teamId: row.teamId } : null;
  }

  return {
    /** Sends a new issue, recording every change it makes by `entry.by`. Runs inside a transaction. */
    send(input: LinearIssueDraft, entry: Entry, at: number) {
      const parsed = linearIssueDraft.safeParse(input);
      if (!parsed.success) throw deps.invalid(parsed.error.issues[0]?.message ?? 'That issue can’t be sent');
      const draft = parsed.data;
      const team = deps.catalog(draft.account)?.teams.find((each) => each.id === draft.team.id);
      if (!team) {
        throw deps.invalid(
          `Commander doesn’t know the team ${draft.team.name} in that workspace: try again once Linear has synced`,
        );
      }
      const { from, todo } = draft.from ? source(draft.from) : { from: undefined, todo: undefined };
      if (!from && draft.filing) deps.checkFiling(draft.filing);
      const filing = from ? inheritedFiling(from.filing) : (draft.filing ?? null);

      const detail: LinearIssueDetail = {
        kind: 'linear-issue',
        identifier: pendingIdentifier(team),
        url: '',
        team: { id: team.id, key: team.key, name: team.name },
        state: draft.state,
        priority: draft.priority,
        assignee: draft.assignee,
        creator: null,
        labels: [],
        cycle: null,
        linearProject: null,
        dueDate: null,
        estimate: null,
        description: draft.description?.trim() || null,
        comments: [],
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        completedAt: null,
        canceledAt: null,
      };
      const assignee = draft.assignee;
      const people = assignee ? [`linear:${assignee.id}`, ...(assignee.email ? [assignee.email] : [])] : [];
      const externalId = randomUUID();
      const identity = {
        kind: 'linear-issue' as const,
        source: 'linear' as const,
        account: draft.account,
        externalId,
      };
      const { id, state } = deps.insert(
        identity,
        {
          title: draft.title,
          people,
          status: statusFromDetail(detail, 'open'),
          filing,
          detail,
          deletedAt: null,
        },
        at,
      );
      const created = deps.log({ ...entry, action: 'create', itemId: id, before: null, after: state }, at);
      const create: LinearIssueCreate = {
        teamId: team.id,
        title: draft.title,
        description: detail.description,
        assigneeId: assignee?.id ?? null,
        stateId: draft.state.id,
        priority: draft.priority,
      };
      deps.outgoing.queue({
        account: draft.account,
        source: 'linear',
        itemId: id,
        externalId,
        field: CREATE_FIELD,
        value: create,
        synced: null,
        madeAt: at,
        entryId: created.id,
      });

      const following: Entry = { by: entry.by, causedBy: { entryId: created.id, itemId: id } };
      if (from) deps.link({ from: id, linkType: 'made-from', to: from.id }, following, at);
      if (todo) {
        const was = todo.detail?.kind === 'todo' ? todo.detail : { kind: 'todo' as const, dueOn: null };
        deps.update(todo, { detail: { ...was, origin: 'linear', backedBy: id } }, following, at);
      }
      const issue = deps.readItem(id);
      if (issue) deps.linearTodos.sent(issue, { by: entry.by, causedBy: { entryId: created.id } });
    },

    /**
     * Where the dialog starts for an item (or, from the Linear Section, for a Project): its title, its
     * Project, and the team from the Rules, else the team last sent to.
     */
    prefill({ from, projectId = null }: { from?: string; projectId?: string | null }): LinearSendPrefill {
      const item = from ? deps.readItem(from) : undefined;
      if (from && !item) throw deps.invalid('That Todo or Block is gone');
      const title = !item
        ? ''
        : item.detail?.kind === 'block'
          ? issueTitleFrom(item.detail.text, deps.projects())
          : item.title;
      const project = item ? (item.filing?.projectId ?? null) : projectId;
      return {
        title,
        projectId: project,
        team: teamForProject(deps.rules(), project, deps.catalogs(), lastSent()),
      };
    },
  };
}
