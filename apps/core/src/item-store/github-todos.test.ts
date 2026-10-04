import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  GitHubIssueDetail,
  Item,
  Project,
  PullRequestDetail,
  ReviewRequestDetail,
  SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// GitHub Todos in the Item store (#116): after each save from GitHub, every review asked of the User
// and every open issue assigned to them has exactly one Todo (origin GitHub, backed by it), which
// takes the pull request's or issue's Project (as inherited) and goes (tombstoned, with why) once the
// review is given or withdrawn, the pull request closes, or the issue closes or goes to someone else.
// GitHub is read-only in v1: ticking only completes the Todo in Commander.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GITHUB = 'github:583231';
const user: ActionContext = { by: { kind: 'user' } };
const HOUR = 3_600_000;
const repo = { nodeId: 'R_api', owner: 'acme', name: 'api' };

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-todos-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  // Who the User is on GitHub: the login Settings → GitHub last read for the Account.
  store.githubWatch.saveAccess(GITHUB, {
    via: 'token',
    login: 'octocat',
    orgs: [],
    personal: [],
    fetchedAt: clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function pullRequest(changes: Partial<PullRequestDetail> = {}, title = 'Retry webhooks'): SourceItem {
  const detail: PullRequestDetail = {
    kind: 'pull-request',
    repo,
    number: 12,
    url: 'https://github.com/acme/api/pull/12',
    nodeId: 'PR_12',
    author: 'priya',
    state: 'open',
    draft: false,
    baseBranch: 'main',
    headBranch: 'retry',
    labels: [],
    assignees: [],
    requestedReviewers: [{ kind: 'user', login: 'octocat', requestedAt: clock - HOUR }],
    reviews: [],
    reviewDecision: 'review-required',
    checks: 'success',
    closingIssues: [],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    body: '',
    createdAt: clock - 48 * HOUR,
    updatedAt: clock,
    mergedAt: null,
    closedAt: null,
    ...changes,
  };
  return {
    externalId: 'R_api:pull/12',
    kind: 'pull-request',
    title,
    people: ['github:priya'],
    status: detail.state === 'open' ? 'open' : 'done',
    detail,
  };
}

function reviewRequest(changes: Partial<ReviewRequestDetail> = {}, title = 'Retry webhooks'): SourceItem {
  return {
    externalId: 'R_api:review-request/12',
    kind: 'review-request',
    title,
    people: ['github:priya'],
    detail: {
      kind: 'review-request',
      pullRequest: 'R_api:pull/12',
      pullRequestId: null,
      repo,
      number: 12,
      url: 'https://github.com/acme/api/pull/12',
      direct: true,
      teams: [],
      requestedAt: clock - HOUR,
      ...changes,
    },
  };
}

function issue(changes: Partial<GitHubIssueDetail> = {}, title = 'Webhooks drop on 502'): SourceItem {
  const detail: GitHubIssueDetail = {
    kind: 'github-issue',
    repo,
    number: 30,
    url: 'https://github.com/acme/api/issues/30',
    nodeId: 'I_30',
    author: 'priya',
    assignees: ['octocat'],
    labels: [],
    milestone: null,
    state: 'open',
    stateReason: null,
    body: '',
    commentCount: 0,
    createdAt: clock,
    updatedAt: clock,
    closedAt: null,
    parent: null,
    subIssues: null,
    ...changes,
  };
  return {
    externalId: 'R_api:issue/30',
    kind: 'github-issue',
    title,
    people: ['github:priya'],
    status: detail.state === 'open' ? 'open' : 'done',
    detail,
  };
}

const save = (items: SourceItem[], deleted: string[] = []) =>
  store.saveFromSource({ source: 'github', account: GITHUB, items, deleted });

// Every Todo, deleted ones too, oldest first.
const allTodos = (): Item[] =>
  store
    .activity({ limit: 1000 })
    .filter((entry) => entry.action === 'create')
    .map((entry) => store.get(entry.itemId)?.item)
    .filter((item): item is Item => item?.kind === 'todo')
    .reverse();
const liveTodos = () => store.query({ kinds: ['todo'], statuses: ['open', 'done'] });
const itemOf = (externalId: string) =>
  store
    .query({ kinds: ['pull-request', 'review-request', 'github-issue'] })
    .find((item) => item.externalId === externalId);
const lastEntry = (itemId: string) => store.activity({ itemId })[0];

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

describe('a review asked of the User', () => {
  it('gets one GitHub Todo, “Review: <pull request>”, backed by the request and made from it', () => {
    const result = save([pullRequest(), reviewRequest()]);
    const request = itemOf('R_api:review-request/12');
    const todos = liveTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      title: 'Review: Retry webhooks',
      status: 'open',
      filing: null,
      detail: { kind: 'todo', origin: 'github', dueOn: null, backedBy: request?.id },
    });
    expect(store.get(todos[0]?.id ?? '')?.links).toMatchObject([
      { type: 'made-from', to: { id: request?.id } },
    ]);
    expect(store.activity({ itemId: todos[0]?.id }).at(-1)).toMatchObject({
      action: 'create',
      by: { kind: 'source', source: 'github' },
      why: 'priya asked for your review',
    });
    expect(result.todos).toEqual([todos[0]?.id]);

    // The next sync hands the same request over: nothing changes.
    const activity = store.activity();
    expect(save([pullRequest(), reviewRequest()]).todos).toEqual([]);
    expect(store.activity()).toEqual(activity);
  });

  it('a team’s request names the team, and the Todo follows the pull request’s title', () => {
    save([pullRequest(), reviewRequest({ direct: false, teams: ['acme/backend'] })]);
    const [todo] = liveTodos();
    expect(store.activity({ itemId: todo?.id }).at(-1)?.why).toBe('Review requested from @acme/backend');
    save([pullRequest({}, 'Retry webhooks, gently'), reviewRequest({}, 'Retry webhooks, gently')]);
    expect(liveTodos()).toMatchObject([{ id: todo?.id, title: 'Review: Retry webhooks, gently' }]);
  });

  it('takes the pull request’s Project as inherited, follows it, and filing the Todo files the pull request', () => {
    const api = project('API', 'AP');
    const web = project('Web', 'WB');
    save([pullRequest(), reviewRequest()]);
    const pull = itemOf('R_api:pull/12');
    const request = itemOf('R_api:review-request/12');
    store.record(
      { type: 'update', itemId: pull?.id ?? '', changes: { filing: { projectId: api.id, filedBy: 'user' } } },
      user,
    );
    const [todo] = liveTodos();
    expect(todo?.filing).toEqual({ projectId: api.id, filedBy: 'inherited' });
    // The request (the Dashboard's row) shows the pull request's Project too.
    expect(store.get(request?.id ?? '')?.item.filing).toEqual({ projectId: api.id, filedBy: 'inherited' });

    // `b` on the Todo (or on the request's row) files the pull request instead; both follow.
    store.record(
      { type: 'update', itemId: todo?.id ?? '', changes: { filing: { projectId: web.id, filedBy: 'user' } } },
      user,
    );
    expect(store.get(pull?.id ?? '')?.item.filing).toEqual({ projectId: web.id, filedBy: 'user' });
    expect(store.get(todo?.id ?? '')?.item.filing).toEqual({ projectId: web.id, filedBy: 'inherited' });
    store.record(
      {
        type: 'update',
        itemId: request?.id ?? '',
        changes: { filing: { projectId: api.id, filedBy: 'user' } },
      },
      user,
    );
    expect(store.get(pull?.id ?? '')?.item.filing).toEqual({ projectId: api.id, filedBy: 'user' });
    expect(store.get(todo?.id ?? '')?.item.filing).toEqual({ projectId: api.id, filedBy: 'inherited' });

    // A pull request filed before its review was asked: the new Todo starts in its Project.
    store.record({ type: 'delete', itemId: todo?.id ?? '' }, user);
    save([pullRequest()], ['R_api:review-request/12']);
    save([pullRequest(), reviewRequest({ requestedAt: clock })]);
    expect(liveTodos()).toMatchObject([{ filing: { projectId: api.id, filedBy: 'inherited' } }]);
  });

  it('goes once the review is submitted, saying so, by GitHub', () => {
    save([pullRequest(), reviewRequest()]);
    const [todo] = liveTodos();
    const reviewed = pullRequest({
      requestedReviewers: [],
      reviews: [{ login: 'octocat', state: 'approved', submittedAt: clock }],
      reviewDecision: 'approved',
    });
    const result = save([reviewed], ['R_api:review-request/12']);
    expect(liveTodos()).toEqual([]);
    expect(store.get(todo?.id ?? '')?.item.deletedAt).toBe(clock);
    expect(lastEntry(todo?.id ?? '')).toMatchObject({
      action: 'delete',
      by: { kind: 'source', source: 'github', account: GITHUB },
      why: 'Review submitted',
    });
    expect(result.todos).toEqual([todo?.id]);
  });

  it('goes when the request is withdrawn or the pull request merged, saying which', () => {
    save([pullRequest(), reviewRequest()]);
    const [first] = liveTodos();
    save([pullRequest({ requestedReviewers: [] })], ['R_api:review-request/12']);
    expect(lastEntry(first?.id ?? '')?.why).toBe('Review request withdrawn');

    clock += HOUR;
    save([pullRequest(), reviewRequest({ requestedAt: clock })]);
    const [second] = liveTodos();
    save([pullRequest({ state: 'merged', mergedAt: clock })], ['R_api:review-request/12']);
    expect(lastEntry(second?.id ?? '')?.why).toBe('acme/api#12 was merged');
  });

  it('ticking completes the Todo only, says nothing changes on GitHub, and survives the next sync', () => {
    save([pullRequest(), reviewRequest()]);
    const [todo] = liveTodos();
    const entry = store.record({ type: 'update', itemId: todo?.id ?? '', changes: { status: 'done' } }, user);
    expect(entry.why).toBe('Ticked in Commander · Nothing changes on GitHub');
    expect(store.outgoing.list()).toEqual([]);

    save([pullRequest(), reviewRequest()]);
    expect(liveTodos()).toMatchObject([{ id: todo?.id, status: 'done' }]);

    // Unticking says so too.
    const untick = store.record(
      { type: 'update', itemId: todo?.id ?? '', changes: { status: 'open' } },
      user,
    );
    expect(untick.why).toBe('Unticked in Commander · Nothing changes on GitHub');
  });

  it('a fresh request after a review makes a new Todo', () => {
    save([pullRequest(), reviewRequest()]);
    const [first] = liveTodos();
    store.record({ type: 'update', itemId: first?.id ?? '', changes: { status: 'done' } }, user);
    save(
      [
        pullRequest({
          requestedReviewers: [],
          reviews: [{ login: 'octocat', state: 'commented', submittedAt: clock }],
        }),
      ],
      ['R_api:review-request/12'],
    );
    expect(liveTodos()).toEqual([]);

    clock += 2 * HOUR;
    save([pullRequest(), reviewRequest({ requestedAt: clock })]);
    const todos = liveTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ status: 'open', title: 'Review: Retry webhooks' });
    expect(todos[0]?.id).not.toBe(first?.id);
    expect(allTodos()).toHaveLength(2);
  });

  it('a Todo the User deleted doesn’t come back for the same request', () => {
    save([pullRequest(), reviewRequest()]);
    const [todo] = liveTodos();
    store.record({ type: 'delete', itemId: todo?.id ?? '' }, user);
    save([pullRequest(), reviewRequest()]);
    expect(liveTodos()).toEqual([]);
  });
});

describe('an issue assigned to the User', () => {
  it('gets one GitHub Todo titled after it, backed by it, in its Project', () => {
    const api = project('API', 'AP');
    save([issue()]);
    const found = itemOf('R_api:issue/30');
    store.record(
      {
        type: 'update',
        itemId: found?.id ?? '',
        changes: { filing: { projectId: api.id, filedBy: 'user' } },
      },
      user,
    );
    const todos = liveTodos();
    expect(todos).toMatchObject([
      {
        title: 'Webhooks drop on 502',
        filing: { projectId: api.id, filedBy: 'inherited' },
        detail: { origin: 'github', backedBy: found?.id },
      },
    ]);
    expect(store.activity({ itemId: todos[0]?.id }).at(-1)?.why).toBe('acme/api#30 is assigned to you');
  });

  it('an unassigned issue, or one assigned to someone else, never becomes a Todo', () => {
    save([issue({ assignees: [] })]);
    save([{ ...issue({ assignees: ['priya'] }), externalId: 'R_api:issue/31' }]);
    expect(liveTodos()).toEqual([]);
  });

  it('goes when the issue is reassigned or closes, saying why, and comes back when assigned again', () => {
    save([issue()]);
    const [first] = liveTodos();
    save([issue({ assignees: ['priya'] })]);
    expect(liveTodos()).toEqual([]);
    expect(lastEntry(first?.id ?? '')).toMatchObject({
      action: 'delete',
      by: { kind: 'source', source: 'github' },
      why: 'Reassigned to priya',
    });

    save([issue()]);
    const [second] = liveTodos();
    expect(second?.status).toBe('open');
    save([issue({ state: 'closed', closedAt: clock })]);
    expect(liveTodos()).toEqual([]);
    expect(lastEntry(second?.id ?? '')?.why).toBe('acme/api#30 was closed');
  });

  it('a ticked one isn’t recreated while the assignment stands', () => {
    save([issue()]);
    const [todo] = liveTodos();
    store.record({ type: 'update', itemId: todo?.id ?? '', changes: { status: 'done' } }, user);
    save([issue({ commentCount: 3 })]);
    expect(liveTodos()).toMatchObject([{ id: todo?.id, status: 'done' }]);
  });

  it('makes no Todo while who the User is on GitHub isn’t known', () => {
    store.saveFromSource({
      source: 'github',
      account: 'github:999',
      items: [issue()],
      deleted: [],
    });
    expect(liveTodos()).toEqual([]);
  });
});

describe('Linear Todos that left', () => {
  it('leave GitHub Todos out', () => {
    save([issue()]);
    save([issue({ assignees: ['priya'] })]);
    expect(store.linearTodosLeft(null)).toEqual([]);
  });
});
