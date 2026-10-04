// Linear-backed Todos, inside the Item store so they change in the same transaction as their issue.
// Each issue assigned to the User in a Todo state (the domain's linear-todos.ts) has exactly one Todo
// (origin Linear, backed by the issue, with a made-from Link to it) that follows the issue's title,
// Project (as inherited) and done-ness, and is deleted (kept as a tombstone, with why) when the issue
// leaves the list, or brought back when it returns. Ticking or unticking the Todo writes the issue's
// state through (`edit-fields { state }`), so Two-way sync's queue, conflicts and undo apply as to any
// other edit of the issue. A Todo the User deleted themselves is never brought back.
import { isDeepStrictEqual } from 'node:util';
import {
  type ActivityEntry,
  type Actor,
  type CausedBy,
  CREATE_FIELD,
  completedStateOf,
  type Filing,
  type Item,
  type ItemState,
  type LinearCatalog,
  type LinearIssueDetail,
  linearTodoFate,
  reopenStateOf,
  type Source,
  sentWhy,
} from '@commander/domain';
import { and, asc, desc, eq, gt, isNull, notExists } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';
import { stateOf, toEntry } from './rows';
import * as schema from './schema';

type Issue = Item & { detail: LinearIssueDetail };
type Entry = { by: Actor; why?: string | null; causedBy?: CausedBy | null };

export type LinearTodosDeps = {
  db: BetterSQLite3Database<typeof schema>;
  now: () => number;
  readItems(ids: string[]): Item[];
  // Writes a Todo's new state and logs it.
  change(todo: Item, after: ItemState, entry: Entry & { action: 'update' | 'delete' }): void;
  // Makes a new Todo, logs it, and Links it (made from) to its issue.
  create(state: ItemState, issueId: string, entry: Entry): string;
  // Changes the issue's state as an edit of that synced field (queued for Linear).
  editState(issue: Issue, state: LinearIssueDetail['state'], entry: Entry): void;
  catalog(account: string): LinearCatalog | null;
  invalid(message: string): Error;
};

const CLOSED = new Set(['completed', 'canceled']);
const issueDetailOf = (state: ItemState | null) =>
  state?.detail?.kind === 'linear-issue' ? state.detail : null;
const isDone = (detail: LinearIssueDetail | null) => detail?.state.type === 'completed';
const inherited = (filing: Filing): Filing =>
  filing ? { projectId: filing.projectId, filedBy: 'inherited' } : null;

export function linearTodosIn(deps: LinearTodosDeps) {
  const { db, now } = deps;
  // Who the User is (their Linear user id) in each Account, as the last save from it said.
  const users = new Map<string, string | null>();
  // Todos changed since the last `takeChanged`, for the sync to report.
  let changed: string[] = [];

  // Every Todo backed by the Item, deleted ones too, the most recently changed first.
  function backing(itemId: string): Item[] {
    const { todoDetails, items } = schema;
    const rows = db
      .select({ id: items.id })
      .from(todoDetails)
      .innerJoin(items, eq(items.id, todoDetails.itemId))
      .where(eq(todoDetails.backedBy, itemId))
      .orderBy(desc(items.updatedAt), desc(items.createdAt))
      .all();
    return deps.readItems(rows.map((row) => row.id));
  }

  // Whether the Todo was last deleted by following its issue (not by the User deleting it).
  function deletedFollowing(todo: Item, issueId: string): boolean {
    const { activity } = schema;
    const last = db
      .select()
      .from(activity)
      .where(and(eq(activity.itemId, todo.id), isNull(activity.otherItemId)))
      .orderBy(desc(activity.id))
      .limit(1)
      .get();
    return last?.action === 'delete' && last.causedByItemId === issueId;
  }

  // The state the issue was in before it was last completed (here or in Linear), if the log has it.
  function stateBeforeDone(issueId: string): LinearIssueDetail['state'] | null {
    const { activity } = schema;
    const rows = db
      .select({ before: activity.before, after: activity.after })
      .from(activity)
      .where(and(eq(activity.itemId, issueId), isNull(activity.otherItemId)))
      .orderBy(desc(activity.id))
      .limit(500)
      .all();
    for (const row of rows) {
      const before = issueDetailOf(row.before as ItemState | null);
      const after = issueDetailOf(row.after as ItemState | null);
      if (before && after && isDone(after) && !CLOSED.has(before.state.type)) return before.state;
    }
    return null;
  }

  function teamStates(issue: Issue) {
    const team = deps.catalog(issue.account ?? '')?.teams.find((each) => each.id === issue.detail.team.id);
    return team?.states ?? [];
  }

  return {
    // Who the User is in the Account, from a save from it (null: not known yet).
    remember(account: string, me: string | null) {
      users.set(account, me);
    },

    // The Todos changed since asked last.
    takeChanged(): string[] {
      const taken = changed;
      changed = [];
      return taken;
    },

    /**
     * Brings the issue's Todo in step with the issue as it is now, given its state before the change
     * (null for a new one). `tombstoned` when Linear deleted it. Changes are made by `entry.by`.
     */
    follow(item: Item, before: ItemState | null, entry: Entry, tombstoned = false) {
      if (item.kind !== 'linear-issue' || item.detail?.kind !== 'linear-issue') return;
      const issue = item as Issue;
      const { identifier, state } = issue.detail;
      // An Account being removed tombstones its issues without asking here: its Todos stay.
      if (issue.deletedAt !== null && !tombstoned) return;
      const me = (issue.account && users.get(issue.account)) || null;
      const fate = tombstoned
        ? { todo: 'none' as const, why: `${identifier} was deleted in Linear` }
        : linearTodoFate(issue.detail, me, now());
      const todos = backing(issue.id).filter((todo) => todo.detail?.kind === 'todo');
      const live = todos.find((todo) => todo.deletedAt === null);
      const causedBy: CausedBy = { ...entry.causedBy, itemId: issue.id };
      const by = { by: entry.by, causedBy };

      if (fate.todo === 'none') {
        if (!live) return;
        deps.change(live, { ...stateOf(live), deletedAt: now() }, { ...by, action: 'delete', why: fate.why });
        changed.push(live.id);
        return;
      }

      const was = issueDetailOf(before);
      const moved = was !== null && isDone(was) !== isDone(issue.detail);
      const wanted = { title: issue.title, filing: inherited(issue.filing) };
      if (!live) {
        if (fate.todo === 'done') return;
        const dead = todos[0];
        if (dead) {
          if (!deletedFollowing(dead, issue.id)) return;
          const reassigned = was !== null && me !== null && was.assignee?.id !== me;
          const why = reassigned
            ? `${identifier} is assigned to you again`
            : `${identifier} moved to ${state.name}`;
          const after = { ...stateOf(dead), ...wanted, status: 'open' as const, deletedAt: null };
          deps.change(dead, after, { ...by, action: 'update', why });
          changed.push(dead.id);
          return;
        }
        // A new Todo only once it is known the issue is the User's.
        if (me === null) return;
        const todo: ItemState = {
          ...wanted,
          people: [],
          status: 'open',
          detail: { kind: 'todo', origin: 'linear', dueOn: null, backedBy: issue.id },
          deletedAt: null,
        };
        changed.push(deps.create(todo, issue.id, { ...by, why: `${identifier} is assigned to you` }));
        return;
      }

      const current = stateOf(live);
      const after = {
        ...current,
        ...wanted,
        status: moved ? (isDone(issue.detail) ? 'done' : 'open') : current.status,
      };
      if (isDeepStrictEqual(current, after)) return;
      const why =
        after.status !== current.status ? `${identifier} moved to ${state.name}` : `Follows ${identifier}`;
      deps.change(live, after as ItemState, { ...by, action: 'update', why });
      changed.push(live.id);
    },

    /**
     * A new issue sent to Linear from Commander (linear-send.ts), whose Todo, if it was sent from one,
     * is already backed by it: the Todo follows the issue (title, Project, done), or goes when the
     * issue isn't one of the User's Linear Todos, saying why; an issue sent from a Block or the Linear
     * Section that is one gets its Todo.
     */
    sent(item: Item, entry: Entry) {
      if (item.detail?.kind !== 'linear-issue') return;
      const issue = item as Issue;
      const me = (issue.account && users.get(issue.account)) || null;
      const live = backing(issue.id).find((todo) => todo.deletedAt === null && todo.detail?.kind === 'todo');
      const by = { by: entry.by, causedBy: { ...entry.causedBy, itemId: issue.id } };
      const why = sentWhy(issue.detail, me, now());
      if (why) {
        if (live) deps.change(live, { ...stateOf(live), deletedAt: now() }, { ...by, action: 'delete', why });
        return;
      }
      const wanted = { title: issue.title, filing: inherited(issue.filing) };
      if (!live) {
        if (me === null || linearTodoFate(issue.detail, me, now()).todo !== 'open') return;
        const todo: ItemState = {
          ...wanted,
          people: [],
          status: 'open',
          detail: { kind: 'todo', origin: 'linear', dueOn: null, backedBy: issue.id },
          deletedAt: null,
        };
        deps.create(todo, issue.id, { ...by, why: 'Sent to Linear, assigned to you' });
        return;
      }
      const current = stateOf(live);
      const after: ItemState = {
        ...current,
        ...wanted,
        status: isDone(issue.detail) ? 'done' : current.status,
      };
      if (!isDeepStrictEqual(current, after))
        deps.change(live, after, { ...by, action: 'update', why: 'Sent to Linear' });
    },

    /**
     * After a Todo was ticked or unticked (not by the Source): moves the issue behind it to its team's
     * default completed state, or back to the state it was in before, unless it is there already.
     */
    writeThrough(todo: Item, before: ItemState, after: ItemState, entry: ActivityEntry) {
      if (entry.by.kind === 'source' || before.status === after.status || after.deletedAt !== null) return;
      const backedBy = after.detail?.kind === 'todo' ? after.detail.backedBy : null;
      if (!backedBy) return;
      const [item] = deps.readItems([backedBy]);
      if (!item || item.deletedAt !== null || item.detail?.kind !== 'linear-issue') return;
      const issue = item as Issue;
      const closed = CLOSED.has(issue.detail.state.type);
      const ticking = after.status === 'done';
      if (ticking === closed) return;
      const states = teamStates(issue);
      const target = ticking
        ? completedStateOf(states)
        : (stateBeforeDone(issue.id) ?? reopenStateOf(states));
      if (!target) {
        throw deps.invalid(
          `Commander doesn’t know ${issue.detail.team.name}’s workflow states yet: try again once Linear has synced`,
        );
      }
      deps.editState(issue, target, {
        by: entry.by,
        why: `${ticking ? 'Ticked' : 'Unticked'} its Todo`,
        causedBy: { itemId: todo.id, entryId: entry.id },
      });
    },

    /**
     * The entries where a Linear Todo went because a sync found its issue off the User's list
     * (reassigned, unassigned, cancelled, moved out of the Todo states, deleted in Linear), after an
     * activity entry (all of them, from null), oldest first, at most 1000: what Ares tells the User.
     * Not the User's own changes, nor Ares's.
     */
    leftSince(after: number | null): ActivityEntry[] {
      const { activity, todoDetails } = schema;
      return db
        .select({ entry: activity })
        .from(activity)
        .innerJoin(todoDetails, eq(todoDetails.itemId, activity.itemId))
        .where(
          and(
            eq(activity.action, 'delete'),
            eq(activity.actor, 'source'),
            eq(todoDetails.origin, 'linear'),
            isNull(activity.otherItemId),
            eq(todoDetails.backedBy, activity.causedByItemId),
            after === null ? undefined : gt(activity.id, after),
          ),
        )
        .orderBy(asc(activity.id))
        .limit(1000)
        .all()
        .map((row) => toEntry(row.entry));
    },

    /** The live Linear issue behind a Todo, if it is a Linear Todo still backed by one. */
    issueBehind(todo: Item): Item | null {
      const backedBy = todo.detail?.kind === 'todo' ? todo.detail.backedBy : null;
      if (!backedBy) return null;
      const [item] = deps.readItems([backedBy]);
      return item && item.deletedAt === null && item.detail?.kind === 'linear-issue' ? item : null;
    },

    /**
     * The external ids of the Account's live Items behind open Todos: each sync re-reads them. Not an
     * issue still being made (Send to Linear), which Linear doesn't have yet.
     */
    recheckIds({ source, account }: { source: Source; account: string }): string[] {
      const { todoDetails, items } = schema;
      const issues = alias(items, 'issues');
      return db
        .select({ externalId: issues.externalId })
        .from(todoDetails)
        .innerJoin(items, eq(items.id, todoDetails.itemId))
        .innerJoin(issues, eq(issues.id, todoDetails.backedBy))
        .where(
          and(
            isNull(items.deletedAt),
            eq(items.status, 'open'),
            eq(issues.source, source),
            eq(issues.account, account),
            isNull(issues.deletedAt),
            notExists(
              db
                .select({ id: schema.outgoingChanges.id })
                .from(schema.outgoingChanges)
                .where(
                  and(
                    eq(schema.outgoingChanges.itemId, issues.id),
                    eq(schema.outgoingChanges.field, CREATE_FIELD),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(issues.externalId))
        .all()
        .flatMap((row) => (row.externalId ? [row.externalId] : []));
    },
  };
}

export type LinearTodos = ReturnType<typeof linearTodosIn>;
