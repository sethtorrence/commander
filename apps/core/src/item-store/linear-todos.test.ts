import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  Item,
  LinearCatalog,
  LinearIssueDetail,
  Project,
  SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Linear-backed Todos in the Item store: after each save from Linear, every issue assigned to the
// User in a Todo state has exactly one Todo (origin Linear, backed by the issue), which follows the
// issue's title, Project and done-ness, and goes (tombstoned, with why) when the issue leaves the
// list. Ticking the Todo writes the issue's state through Two-way sync's queue; undo works.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACME = 'linear:org-acme';
const GLOBEX = 'linear:org-globex';
const ME = 'user-me-acme';
const ME_GLOBEX = 'user-me-globex';
const DAY = 86_400_000;
const user: ActionContext = { by: { kind: 'user' } };
const me = { id: ME, name: 'Sam Rivera', displayName: 'sam', email: 'sam@acme.test' };
const meAtGlobex = { id: ME_GLOBEX, name: 'Sam Rivera', displayName: 'sam', email: 'sam@globex.test' };
const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const states = {
  triage: { id: 'state-triage', name: 'Triage', type: 'triage', color: '#fc7840' },
  backlog: { id: 'state-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  todo: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  progress: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  review: { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' },
  done: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
  canceled: { id: 'state-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3' },
};

let dir: string;
let store: ItemStore;
let clock: number;

function open() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
}

const catalog: LinearCatalog = {
  kind: 'linear',
  teams: [
    {
      ...ENG,
      states: Object.values(states),
      members: [me, priya],
      labels: [],
      cycles: [],
      linearProjects: [],
    },
  ],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-linear-todos-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = open();
  store.syncState.saveCatalog(ACME, 'linear', catalog, clock);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const current = () => ({
  id: 'cycle-41',
  number: 41,
  name: null,
  startsAt: clock - 3 * DAY,
  endsAt: clock + 4 * DAY,
});

type IssueInput = Partial<LinearIssueDetail> & { n: number; title?: string };

function issue({ n, title, ...detail }: IssueInput): SourceItem {
  const identifier = `ENG-${n}`;
  return {
    externalId: `issue-${n}`,
    kind: 'linear-issue',
    title: title ?? `Issue ${n}`,
    detail: {
      kind: 'linear-issue',
      identifier,
      url: `https://linear.app/acme/issue/${identifier}`,
      team: ENG,
      state: states.progress,
      priority: 0,
      assignee: me,
      creator: priya,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: Date.UTC(2026, 8, 29),
      updatedAt: Date.UTC(2026, 9, 1),
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      ...detail,
    },
    status: detail.state?.type === 'completed' || detail.state?.type === 'canceled' ? 'done' : 'open',
  };
}

// Saves issues as Linear sync does for the Account (who the User is there: `me`).
function sync(
  issues: IssueInput[],
  { account = ACME, who = ME as string | null, deleted = [] as string[] } = {},
) {
  clock += 1000;
  return store.saveFromSource({ source: 'linear', account, me: who, items: issues.map(issue), deleted });
}

const issueItem = (n: number, account = ACME) =>
  store
    .query({ kinds: ['linear-issue'], account, includeDeleted: true })
    .find((item) => item.externalId === `issue-${n}`) as Item;

// Every Todo backed by the issue, deleted ones too.
function todosOf(n: number, account = ACME): Item[] {
  const issueId = issueItem(n, account)?.id;
  return store
    .query({ kinds: ['todo'], includeDeleted: true })
    .filter((todo) => todo.detail?.kind === 'todo' && todo.detail.backedBy === issueId);
}

const todoOf = (n: number, account = ACME) => {
  const found = todosOf(n, account);
  expect(found).toHaveLength(1);
  return found[0] as Item;
};

const liveTodos = () => store.query({ kinds: ['todo'] });
const stateOf = (n: number) => (issueItem(n).detail as LinearIssueDetail).state;
const latest = (itemId: string) => store.activity({ itemId, limit: 1 })[0];

describe('after a sync, assigned issues in a Todo state have exactly one Linear Todo', () => {
  it('makes one Todo per qualifying issue: origin Linear, backed by the issue, titled after it, Linked to it', () => {
    const result = sync([{ n: 1, title: 'Fix the login loop' }]);
    const issueId = issueItem(1).id;
    const todo = todoOf(1);
    expect(todo).toMatchObject({
      kind: 'todo',
      title: 'Fix the login loop',
      status: 'open',
      source: null,
      deletedAt: null,
      detail: { kind: 'todo', origin: 'linear', dueOn: null, backedBy: issueId },
    });
    expect(result.todos).toEqual([todo.id]);
    expect(store.get(todo.id)?.links.map((link) => [link.type, link.to.id])).toEqual([
      ['made-from', issueId],
    ]);
    expect(latest(todo.id)).toMatchObject({
      by: { kind: 'source', source: 'linear', account: ACME },
      why: 'ENG-1 is assigned to you',
      causedBy: { itemId: issueId },
    });
  });

  it('covers each state type and the current-cycle rule', () => {
    sync([
      { n: 1, state: states.todo },
      { n: 2, state: states.progress },
      { n: 3, state: states.review },
      { n: 4, state: states.backlog },
      { n: 5, state: states.backlog, cycle: current() },
      { n: 6, state: states.triage },
      { n: 7, state: states.triage, cycle: current() },
      { n: 8, state: states.done },
      { n: 9, state: states.canceled },
      { n: 10, assignee: priya },
      { n: 11, assignee: null },
    ]);
    const backed = liveTodos().map((todo) => (todo.detail?.kind === 'todo' ? todo.detail.backedBy : null));
    expect(backed.sort()).toEqual([1, 2, 3, 5, 7].map((n) => issueItem(n).id).sort());
  });

  it('keeps each workspace’s Todos to the issues assigned to the User there', () => {
    sync([{ n: 1 }, { n: 2, assignee: meAtGlobex }]);
    sync(
      [
        { n: 1, assignee: me },
        { n: 2, assignee: meAtGlobex },
      ],
      { account: GLOBEX, who: ME_GLOBEX },
    );
    expect(todosOf(1)).toHaveLength(1);
    expect(todosOf(2)).toHaveLength(0);
    expect(todosOf(1, GLOBEX)).toHaveLength(0);
    expect(todosOf(2, GLOBEX)).toHaveLength(1);
  });

  it('makes no duplicates on later syncs, or after a restart', () => {
    sync([{ n: 1 }]);
    const first = sync([{ n: 1 }]);
    expect(first.todos).toEqual([]);
    store.close();
    store = open();
    sync([{ n: 1 }]);
    expect(todosOf(1)).toHaveLength(1);
  });

  it('makes no Todos while who the User is in the Account is not known', () => {
    sync([{ n: 1 }], { who: null });
    expect(liveTodos()).toEqual([]);
  });

  it('mirrors the issue’s title', () => {
    sync([{ n: 1, title: 'Fix the login loop' }]);
    sync([{ n: 1, title: 'Fix the SSO login loop' }]);
    expect(todoOf(1).title).toBe('Fix the SSO login loop');
  });
});

describe('issues leaving the list', () => {
  it('removes the Todo of an issue reassigned away, saying to whom, and brings the same Todo back when it returns', () => {
    sync([{ n: 1 }]);
    const { id } = todoOf(1);
    sync([{ n: 1, assignee: priya }]);
    expect(todoOf(1).deletedAt).not.toBeNull();
    expect(latest(id)).toMatchObject({
      action: 'delete',
      by: { kind: 'source', source: 'linear', account: ACME },
      why: 'ENG-1 was reassigned to Priya Patel',
      causedBy: { itemId: issueItem(1).id },
    });
    // Its Links and history stay.
    expect(store.get(id)?.links).toHaveLength(1);

    sync([{ n: 1, assignee: me }]);
    expect(todoOf(1)).toMatchObject({ id, deletedAt: null, status: 'open' });
    expect(latest(id)?.why).toBe('ENG-1 is assigned to you again');
  });

  it('removes the Todo of an issue cancelled, moved out of the Todo states, or deleted in Linear', () => {
    sync([{ n: 1 }, { n: 2 }, { n: 3 }]);
    sync(
      [
        { n: 1, state: states.canceled },
        { n: 2, state: states.backlog },
      ],
      { deleted: ['issue-3'] },
    );
    expect(latest(todoOf(1).id)?.why).toBe('ENG-1 was cancelled');
    expect(latest(todoOf(2).id)?.why).toBe('ENG-2 is in Backlog, outside the current cycle');
    expect(latest(todoOf(3).id)?.why).toBe('ENG-3 was deleted in Linear');
    expect(liveTodos()).toEqual([]);
  });

  it('removes a backlog issue’s Todo once its cycle is over', () => {
    const cycle = current();
    sync([{ n: 1, state: states.backlog, cycle }]);
    clock = cycle.endsAt + 1;
    sync([{ n: 1, state: states.backlog, cycle }]);
    expect(todoOf(1).deletedAt).not.toBeNull();
  });

  it('never brings back a Linear Todo the User deleted', () => {
    sync([{ n: 1 }]);
    store.record({ type: 'delete', itemId: todoOf(1).id }, user);
    sync([{ n: 1 }]);
    sync([{ n: 1, title: 'Renamed' }]);
    expect(todoOf(1).deletedAt).not.toBeNull();
  });

  it('keeps the Todos of an Account being removed, with nothing behind them', () => {
    sync([{ n: 1 }]);
    store.removeAccountItems({ source: 'linear', account: ACME }, user);
    const todo = todoOf(1);
    expect(todo.deletedAt).toBeNull();
    expect(store.get(todo.id)?.links[0]?.to).toMatchObject({
      id: issueItem(1).id,
      deletedAt: expect.any(Number),
    });
  });
});

describe('done in Linear', () => {
  it('ticks the Todo of an issue completed in Linear, and unticks it when it is reopened there', () => {
    sync([{ n: 1 }]);
    const { id } = todoOf(1);
    sync([{ n: 1, state: states.done }]);
    expect(todoOf(1).status).toBe('done');
    expect(latest(id)).toMatchObject({ by: { kind: 'source' }, why: 'ENG-1 moved to Done' });
    sync([{ n: 1, state: states.review }]);
    expect(todoOf(1).status).toBe('open');
    expect(latest(id)?.why).toBe('ENG-1 moved to In Review');
  });

  it('makes no Todo for an issue that is already completed', () => {
    sync([{ n: 1, state: states.done }]);
    expect(todosOf(1)).toEqual([]);
  });
});

describe('ticking a Linear Todo', () => {
  const tick = (done: boolean) => {
    clock += 1000;
    return store.record(
      { type: 'update', itemId: todoOf(1).id, changes: { status: done ? 'done' : 'open' } },
      user,
    );
  };
  const queued = () => store.outgoing.list().map((change) => change.field);

  it('moves the issue to the team’s default completed state through the outgoing queue', () => {
    sync([{ n: 1 }]);
    const entry = tick(true);
    expect(entry.itemId).toBe(todoOf(1).id);
    expect(stateOf(1)).toEqual(states.done);
    expect(issueItem(1).status).toBe('done');
    expect(queued()).toEqual(['state']);
    expect(latest(issueItem(1).id)).toMatchObject({ by: { kind: 'user' }, causedBy: { entryId: entry.id } });
  });

  it('moves it back to the state it was in when unticked', () => {
    sync([{ n: 1, state: states.review }]);
    tick(true);
    tick(false);
    expect(stateOf(1)).toEqual(states.review);
    expect(todoOf(1).status).toBe('open');
    // Back to what Linear has: nothing left to send.
    expect(queued()).toEqual([]);
  });

  it('moves an issue completed in Linear back to its state before, when unticked here', () => {
    sync([{ n: 1, state: states.review }]);
    sync([{ n: 1, state: states.done }]);
    tick(false);
    expect(stateOf(1)).toEqual(states.review);
    expect(queued()).toEqual(['state']);
  });

  it('is undone with the Todo’s entry: the issue goes back too', () => {
    sync([{ n: 1, state: states.todo }]);
    const entry = tick(true);
    store.record({ type: 'undo', entryId: entry.id }, user);
    expect(todoOf(1).status).toBe('open');
    expect(stateOf(1)).toEqual(states.todo);
    expect(queued()).toEqual([]);
  });

  it('is refused while the team’s states are not known yet', () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'commander-linear-todos-'));
    store = open();
    sync([{ n: 1 }]);
    expect(() => tick(true)).toThrow(/Engineering’s workflow states/);
    expect(todoOf(1).status).toBe('open');
  });

  it('writes nothing for a Todo whose Account was removed', () => {
    sync([{ n: 1 }]);
    store.removeAccountItems({ source: 'linear', account: ACME }, user);
    tick(true);
    expect(todoOf(1).status).toBe('done');
    expect(queued()).toEqual([]);
  });
});

describe('changing the issue from Commander', () => {
  const edit = (fields: Record<string, unknown>) => {
    clock += 1000;
    return store.record({ type: 'edit-fields', itemId: issueItem(1).id, fields }, user);
  };

  it('ticks the Todo when the issue is set to a completed state, by the User', () => {
    sync([{ n: 1 }]);
    edit({ state: states.done });
    expect(todoOf(1).status).toBe('done');
    expect(latest(todoOf(1).id)).toMatchObject({ by: { kind: 'user' }, why: 'ENG-1 moved to Done' });
  });

  it('keeps the Todo open for any other Todo state, and removes it outside them; undo brings it back', () => {
    sync([{ n: 1 }]);
    edit({ state: states.review });
    expect(todoOf(1)).toMatchObject({ status: 'open', deletedAt: null });
    const entry = edit({ state: states.backlog });
    expect(todoOf(1).deletedAt).not.toBeNull();
    store.record({ type: 'undo', entryId: entry.id }, user);
    expect(todoOf(1)).toMatchObject({ status: 'open', deletedAt: null });
  });

  it('removes the Todo when the User assigns the issue to someone else', () => {
    sync([{ n: 1 }]);
    edit({ assignee: priya });
    expect(todoOf(1).deletedAt).not.toBeNull();
  });
});

describe('the Todo’s Project follows its issue', () => {
  let lt: Project;
  beforeEach(() => {
    lt = store.changeProject({ type: 'create', project: { name: 'Longtail', code: 'LT', accent: 'blue' } })
      .project as Project;
  });

  it('takes the Project a Rule files the issue under, as inherited', () => {
    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: lt.id },
        when: { join: 'and', terms: [{ field: 'linear.team', op: 'is', value: ENG.id, label: 'ENG' }] },
      },
    });
    sync([{ n: 1 }]);
    expect(todoOf(1).filing).toEqual({ projectId: lt.id, filedBy: 'inherited' });
  });

  it('files the issue when the Todo is filed, so the two never disagree; undo unfiles both', () => {
    sync([{ n: 1 }]);
    const entry = store.record(
      { type: 'update', itemId: todoOf(1).id, changes: { filing: { projectId: lt.id, filedBy: 'user' } } },
      user,
    );
    expect(entry.itemId).toBe(issueItem(1).id);
    expect(issueItem(1).filing).toEqual({ projectId: lt.id, filedBy: 'user' });
    expect(todoOf(1).filing).toEqual({ projectId: lt.id, filedBy: 'inherited' });
    store.record({ type: 'undo', entryId: entry.id }, user);
    expect(issueItem(1).filing).toBeNull();
    expect(todoOf(1).filing).toBeNull();
  });

  it('follows the issue when the User files or unfiles it, and when that is undone', () => {
    sync([{ n: 1 }]);
    const entry = store.record(
      { type: 'update', itemId: issueItem(1).id, changes: { filing: { projectId: lt.id, filedBy: 'user' } } },
      user,
    );
    expect(todoOf(1).filing).toEqual({ projectId: lt.id, filedBy: 'inherited' });
    store.record({ type: 'undo', entryId: entry.id }, user);
    expect(todoOf(1).filing).toBeNull();
  });
});

describe('the issues each sync re-reads', () => {
  it('lists the Account’s issues behind open Linear Todos', () => {
    sync([{ n: 1 }, { n: 2 }, { n: 3, assignee: priya }]);
    sync([{ n: 2, state: states.done }]);
    expect(store.recheckIds({ source: 'linear', account: ACME })).toEqual(['issue-1']);
    expect(store.recheckIds({ source: 'linear', account: GLOBEX })).toEqual([]);
  });
});
