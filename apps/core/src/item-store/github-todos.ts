// GitHub Todos (#116), inside the Item store so they change in the same transaction as what backs
// them. Each review asked of the User (a live `review-request` Item) and each open issue assigned to
// them has exactly one Todo (origin GitHub, backed by it, with a made-from Link to it): "Review: <pull
// request>" or the issue's title, filed as inherited from the pull request or issue and following it.
// When the review is given or withdrawn, the pull request closes, or the issue closes or goes to
// someone else, the Todo is deleted (kept as a tombstone) with why, by the Source.
//
// GitHub is read-only in v1: ticking a GitHub Todo only completes it in Commander, and its activity
// entry says so. A Todo is made when its review request or assignment begins (or the first time
// Commander sees one with none), so a ticked Todo, or one the User deleted, isn't made again for the
// same request or assignment; a fresh request after a review, or being assigned again, makes a new one.
//
// A review request's own Item takes its pull request's Project too (it is the Dashboard's row), and
// filing a GitHub Todo or a review request files the pull request or issue behind it instead.
import { isDeepStrictEqual } from 'node:util';
import {
  type Actor,
  type CausedBy,
  type Filing,
  type GitHubIssueDetail,
  githubIdentifier,
  githubIssueTodoFate,
  type Item,
  type ItemState,
  type PullRequestDetail,
  type ReviewRequestDetail,
  reviewAskedBy,
  reviewEndedWhy,
  reviewTodoTitle,
} from '@commander/domain';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { stateOf } from './rows';
import * as schema from './schema';

type Entry = { by: Actor; why?: string | null; causedBy?: CausedBy | null };
type Request = Item & { detail: ReviewRequestDetail };
type Issue = Item & { detail: GitHubIssueDetail };
type Pull = Item & { detail: PullRequestDetail };

export type GitHubTodosDeps = {
  db: BetterSQLite3Database<typeof schema>;
  now: () => number;
  readItems(ids: string[]): Item[];
  // Writes an Item's new state (a Todo's, or a review request's filing) and logs it.
  change(item: Item, after: ItemState, entry: Entry & { action: 'update' | 'delete' }): void;
  // Makes a new Todo, logs it, and Links it (made from) to what backs it.
  create(state: ItemState, backingId: string, entry: Entry): string;
  // Who the User is on GitHub in the Account (their login), when known.
  login(account: string): string | null;
};

const inherited = (filing: Filing): Filing =>
  filing ? { projectId: filing.projectId, filedBy: 'inherited' } : null;
const isRequest = (item: Item | null | undefined): item is Request =>
  item?.kind === 'review-request' && item.detail?.kind === 'review-request';
const isIssue = (item: Item | null | undefined): item is Issue =>
  item?.kind === 'github-issue' && item.detail?.kind === 'github-issue';
const isPull = (item: Item | null | undefined): item is Pull =>
  item?.kind === 'pull-request' && item.detail?.kind === 'pull-request';
const isGitHubTodo = (item: Item | null | undefined) =>
  item?.detail?.kind === 'todo' && item.detail.origin === 'github' && item.detail.backedBy !== null;

export function githubTodosIn(deps: GitHubTodosDeps) {
  const { db, now } = deps;
  // Todos changed since the last `takeChanged`, for the sync to report.
  let changed: string[] = [];

  const readOne = (id: string | null | undefined) => (id ? (deps.readItems([id])[0] ?? null) : null);

  // Every Todo backed by the Item, deleted ones too, the most recently changed first.
  function backing(itemId: string): Item[] {
    const { todoDetails, items } = schema;
    const rows = db
      .select({ id: items.id })
      .from(todoDetails)
      .innerJoin(items, eq(items.id, todoDetails.itemId))
      .where(and(eq(todoDetails.backedBy, itemId), eq(todoDetails.origin, 'github')))
      .orderBy(desc(items.updatedAt), desc(items.createdAt))
      .all();
    return deps.readItems(rows.map((row) => row.id));
  }

  // The live review requests about a pull request.
  function requestsAbout(pullId: string): Request[] {
    const { githubDetails, items } = schema;
    const rows = db
      .select({ id: items.id })
      .from(githubDetails)
      .innerJoin(items, eq(items.id, githubDetails.itemId))
      .where(
        and(
          eq(items.kind, 'review-request'),
          isNull(items.deletedAt),
          sql`json_extract(${githubDetails.data}, '$.pullRequestId') = ${pullId}`,
        ),
      )
      .all();
    return deps.readItems(rows.map((row) => row.id)).filter(isRequest);
  }

  const pullOf = (request: Request): Pull | null => {
    const pull = readOne(request.detail.pullRequestId);
    return isPull(pull) ? pull : null;
  };

  // A review request's Item takes its pull request's Project, as inherited.
  function fileRequest(request: Request, entry: Entry): Request {
    const pull = pullOf(request);
    if (!pull) return request;
    const filing = inherited(pull.filing);
    if (isDeepStrictEqual(request.filing, filing)) return request;
    deps.change(
      request,
      { ...stateOf(request), filing },
      { ...entry, action: 'update', why: 'Follows its pull request' },
    );
    return readOne(request.id) as Request;
  }

  // Deletes the backing's live Todo, saying why.
  function remove(live: Item | undefined, why: string, entry: Entry) {
    if (!live) return;
    deps.change(live, { ...stateOf(live), deletedAt: now() }, { ...entry, action: 'delete', why });
    changed.push(live.id);
  }

  // Keeps the live Todo's title and Project in step, or makes one when a request or assignment begins.
  function keep(
    backingId: string,
    todos: Item[],
    wanted: { title: string; filing: Filing },
    begins: boolean,
    entry: Entry & { why: string },
  ) {
    const live = todos.find((todo) => todo.deletedAt === null);
    if (live) {
      const current = stateOf(live);
      const after = { ...current, ...wanted };
      if (isDeepStrictEqual(current, after)) return;
      deps.change(live, after, { ...entry, action: 'update', why: 'Follows GitHub' });
      changed.push(live.id);
      return;
    }
    if (!begins && todos.length) return;
    const todo: ItemState = {
      ...wanted,
      people: [],
      status: 'open',
      detail: { kind: 'todo', origin: 'github', dueOn: null, backedBy: backingId },
      deletedAt: null,
    };
    changed.push(deps.create(todo, backingId, entry));
  }

  function followRequest(item: Request, before: ItemState | null, entry: Entry, tombstoned: boolean) {
    const by = { by: entry.by, causedBy: { ...entry.causedBy, itemId: item.id } };
    const todos = backing(item.id);
    const live = todos.find((todo) => todo.deletedAt === null);
    if (tombstoned || item.deletedAt !== null) {
      const was = before?.detail?.kind === 'review-request' ? before.detail : item.detail;
      const why = reviewEndedWhy(
        pullOf(item)?.detail ?? null,
        deps.login(item.account ?? ''),
        was.requestedAt,
      );
      remove(live, why, by);
      return;
    }
    const request = fileRequest(item, by);
    const pull = pullOf(request);
    const begins = before === null || before.deletedAt !== null;
    const { direct, teams } = request.detail;
    const why = direct
      ? `${reviewAskedBy(request) ?? 'Someone'} asked for your review`
      : `Review requested from ${teams.map((team) => `@${team}`).join(', ') || 'your team'}`;
    const wanted = { title: reviewTodoTitle(request.title), filing: inherited(pull?.filing ?? null) };
    keep(request.id, todos, wanted, begins, { ...by, why });
  }

  function followIssue(item: Issue, before: ItemState | null, entry: Entry, tombstoned: boolean) {
    const by = { by: entry.by, causedBy: { ...entry.causedBy, itemId: item.id } };
    const identifier = githubIdentifier(item.detail.repo, item.detail.number);
    const me = deps.login(item.account ?? '');
    const fate = tombstoned
      ? { todo: 'none' as const, why: `${identifier} was deleted on GitHub` }
      : githubIssueTodoFate(item.detail, me);
    const todos = backing(item.id);
    if (fate.todo === 'none') {
      remove(
        todos.find((todo) => todo.deletedAt === null),
        fate.why,
        by,
      );
      return;
    }
    if (fate.todo === 'unknown') return;
    const was = before?.detail?.kind === 'github-issue' ? before.detail : null;
    // An assignment begins when the issue is new, comes back, or wasn't the User's open issue before.
    const begins = was === null || before?.deletedAt !== null || githubIssueTodoFate(was, me).todo !== 'open';
    const wanted = { title: item.title, filing: inherited(item.filing) };
    keep(item.id, todos, wanted, begins, { ...by, why: `${identifier} is assigned to you` });
  }

  return {
    // The Todos changed since asked last.
    takeChanged(): string[] {
      const taken = changed;
      changed = [];
      return taken;
    },

    /**
     * Brings GitHub Todos in step with a GitHub Item as it is now, given its state before the change
     * (null for a new one). `tombstoned` when GitHub sync tombstoned it. A pull request's review
     * requests (and their Todos) follow its Project. Changes are made by `entry.by`.
     */
    follow(item: Item, before: ItemState | null, entry: Entry, tombstoned = false) {
      if (item.source !== 'github') return;
      // An Account being removed (or a repo unwatched) deletes its Items without asking here: the
      // Todos stay.
      if (item.deletedAt !== null && !tombstoned) return;
      if (isRequest(item)) followRequest(item, before, entry, tombstoned);
      else if (isIssue(item)) followIssue(item, before, entry, tombstoned);
      else if (isPull(item) && item.deletedAt === null) {
        for (const request of requestsAbout(item.id)) followRequest(request, stateOf(request), entry, false);
      }
    },

    /**
     * Where filing an Item really goes: a GitHub Todo files the pull request (for a review request) or
     * issue behind it, and a review request files its pull request. Null for anything else.
     */
    filingTarget(item: Item): Item | null {
      const behind =
        isGitHubTodo(item) && item.detail?.kind === 'todo' ? readOne(item.detail.backedBy) : item;
      if (!behind || behind.deletedAt !== null) return null;
      if (isRequest(behind)) {
        const pull = pullOf(behind);
        return pull && pull.deletedAt === null ? pull : null;
      }
      return behind !== item && isIssue(behind) ? behind : null;
    },

    /** What a tick or untick of a GitHub Todo says, as GitHub is read-only in v1 (null for other changes). */
    tickNote(item: Item, changes: Partial<ItemState>): string | null {
      if (!isGitHubTodo(item) || changes.status === undefined || changes.status === item.status) return null;
      return `${changes.status === 'done' ? 'Ticked' : 'Unticked'} in Commander · Nothing changes on GitHub`;
    },
  };
}

export type GitHubTodos = ReturnType<typeof githubTodosIn>;
