import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  ActivityEntry,
  Item,
  ItemAction,
  LinearCatalog,
  LinearIssueDetail,
  LinearIssueDraft,
  SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Send to Linear in the Item store: the new issue's Item is made at once with its creation queued for
// Linear in the same transaction (the outgoing change `create`, under an external id Commander made);
// a Todo sent becomes backed by the issue, a Block sent gets a made-from Link from it; the issue takes
// the item's Project as inherited; undoing the send queues the issue's deletion and puts everything
// back as it was.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACME = 'linear:org-acme';
const ME = 'user-me-acme';
const user: ActionContext = { by: { kind: 'user' } };
const me = { id: ME, name: 'Sam Rivera', displayName: 'sam', email: 'sam@acme.test' };
const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const states = {
  backlog: { id: 'state-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  todo: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
  progress: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  done: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
};
const team = (t: typeof ENG) => ({
  ...t,
  states: Object.values(states),
  members: [me, priya],
  labels: [],
  cycles: [],
  linearProjects: [],
});
const catalog: LinearCatalog = { kind: 'linear', teams: [team(ENG), team(OPS)] };

let dir: string;
let store: ItemStore;
let clock: number;
let lt: string;
let tx: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-linear-send-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  store.syncState.saveCatalog(ACME, 'linear', catalog, clock);
  // Who the User is in the workspace, as the first sync says.
  store.saveFromSource({ source: 'linear', account: ACME, items: [], me: ME });
  const create = (name: string, code: string, accent: string) =>
    store.changeProject({ type: 'create', project: { name, code, accent } }).project?.id as string;
  lt = create('Longtail', 'LT', 'blue');
  tx = create('Tactics', 'TX', 'teal');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const tick = () => {
  clock += 1000;
};

function addTodo(title: string, projectId: string | null = null): Item {
  const entry = store.record(
    {
      type: 'create',
      item: {
        kind: 'todo',
        title,
        filing: projectId ? { projectId, filedBy: 'user' } : null,
        detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
      },
    },
    user,
  );
  return store.get(entry.itemId)?.item as Item;
}

function addBlock(text: string, projectId: string | null = null): Item {
  const note = store.ensureDailyNote('2026-10-03', user);
  const entry = store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        filing: projectId ? { projectId, filedBy: 'user' } : null,
        detail: { kind: 'block', dailyNoteId: note.id, parentId: null, position: 'a0', text, folded: false },
      },
    },
    user,
  );
  return store.get(entry.itemId)?.item as Item;
}

const draft = (changes: Partial<LinearIssueDraft> = {}): LinearIssueDraft => ({
  account: ACME,
  team: ENG,
  title: 'Write the runbook',
  assignee: me,
  state: states.todo,
  priority: 2,
  description: 'Steps first',
  ...changes,
});

function send(changes: Partial<LinearIssueDraft> = {}): { issue: Item; entries: ActivityEntry[] } {
  tick();
  const entries = store.sendToLinear(draft(changes), user);
  const issue = store.get(entries[0]?.itemId as string)?.item as Item;
  return { issue, entries };
}

const read = (id: string) => store.get(id)?.item as Item;
const detailOf = (item: Item) => item.detail as LinearIssueDetail;
const undoAll = (entries: ActivityEntry[]) =>
  store.recordAll(
    [...entries].reverse().map((entry): ItemAction => ({ type: 'undo', entryId: entry.id })),
    user,
  );

describe('sending makes the issue at once, and queues its creation for Linear', () => {
  it('makes a Linear issue Item in the Account, numbered when Linear answers, with what the dialog chose', () => {
    const { issue } = send();
    expect(issue).toMatchObject({
      kind: 'linear-issue',
      source: 'linear',
      account: ACME,
      title: 'Write the runbook',
      status: 'open',
      deletedAt: null,
    });
    expect(issue.externalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(detailOf(issue)).toMatchObject({
      identifier: 'ENG-…',
      team: ENG,
      state: states.todo,
      assignee: me,
      priority: 2,
      description: 'Steps first',
      labels: [],
      comments: [],
    });
  });

  it('queues one `create` change, with Linear’s input, in the same transaction', () => {
    const { issue, entries } = send();
    const [queued] = store.outgoing.forItem(issue.id);
    expect(store.outgoing.forItem(issue.id)).toHaveLength(1);
    expect(queued).toMatchObject({
      account: ACME,
      source: 'linear',
      externalId: issue.externalId,
      field: 'create',
      status: 'pending',
      madeAt: clock,
      entryId: entries[0]?.id,
      value: {
        teamId: 'team-eng',
        title: 'Write the runbook',
        description: 'Steps first',
        assigneeId: ME,
        stateId: 'state-todo',
        priority: 2,
      },
    });
  });

  it('refuses a team the workspace doesn’t offer, and an item that can’t be sent', () => {
    expect(() => send({ team: { id: 'team-gone', key: 'GONE', name: 'Gone' } })).toThrow(/team/i);
    const todo = addTodo('Once');
    send({ from: todo.id });
    expect(() => send({ from: todo.id })).toThrow(/already/i);
    const note = store.ensureDailyNote('2026-10-03', user);
    expect(() => send({ from: note.id })).toThrow(/Todo or a Block/);
    expect(store.query({ kinds: ['linear-issue'] })).toHaveLength(1);
  });
});

describe('from a Todo', () => {
  it('backs the Todo by the issue (origin Linear), with a made-from Link from the issue to it', () => {
    const todo = addTodo('Write the runbook', lt);
    const { issue } = send({ from: todo.id });
    expect(read(todo.id).detail).toEqual({ kind: 'todo', origin: 'linear', dueOn: null, backedBy: issue.id });
    expect(store.get(issue.id)?.links.map((link) => [link.type, link.to.id])).toEqual([
      ['made-from', todo.id],
    ]);
    expect(store.get(todo.id)?.backlinks.map((link) => [link.type, link.from.id])).toEqual([
      ['made-from', issue.id],
    ]);
    // No second Todo for the issue.
    expect(store.query({ kinds: ['todo'] })).toHaveLength(1);
  });

  it('gives the issue the Todo’s Project, filed as inherited, which the Todo then follows', () => {
    const todo = addTodo('Write the runbook', lt);
    const { issue } = send({ from: todo.id });
    expect(issue.filing).toEqual({ projectId: lt, filedBy: 'inherited' });
    expect(read(todo.id).filing).toEqual({ projectId: lt, filedBy: 'inherited' });
  });

  it('takes the issue’s title, as a Linear Todo does', () => {
    const todo = addTodo('runbook');
    send({ from: todo.id, title: 'Write the runbook' });
    expect(read(todo.id).title).toBe('Write the runbook');
  });

  it('removes the Todo, saying why, when the issue isn’t one of the User’s Linear Todos', () => {
    const todo = addTodo('Write the runbook');
    send({ from: todo.id, assignee: priya });
    expect(read(todo.id).deletedAt).not.toBeNull();
    expect(store.activity({ itemId: todo.id, limit: 1 })[0]).toMatchObject({
      action: 'delete',
      why: 'Sent to Linear, assigned to Priya Patel',
    });
  });

  it('ticks the Todo when it is sent as done', () => {
    const todo = addTodo('Already did it');
    send({ from: todo.id, state: states.done });
    expect(read(todo.id).status).toBe('done');
  });
});

describe('from a Block', () => {
  it('Links the issue to the Block (made from), visible from both ends, and files it under the Block’s Project as inherited', () => {
    const block = addBlock('Write the runbook #LT', lt);
    const { issue } = send({ from: block.id });
    expect(store.get(issue.id)?.links.map((link) => [link.type, link.to.id])).toEqual([
      ['made-from', block.id],
    ]);
    expect(store.get(block.id)?.backlinks.map((link) => [link.type, link.from.id])).toEqual([
      ['made-from', issue.id],
    ]);
    expect(issue.filing).toEqual({ projectId: lt, filedBy: 'inherited' });
  });

  it('makes the issue a Linear Todo when it is assigned to the User', () => {
    const block = addBlock('Write the runbook');
    const { issue } = send({ from: block.id });
    const [todo] = store.query({ kinds: ['todo'] });
    expect(todo?.detail).toMatchObject({ origin: 'linear', backedBy: issue.id });
  });

  it('backs the Block’s own Todo (`[]`) by the issue, rather than making another', () => {
    const block = addBlock('Write the runbook');
    const todo = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Write the runbook',
          detail: { kind: 'todo', origin: 'daily-note', dueOn: null, backedBy: null },
        },
      },
      user,
    );
    store.link({ from: todo.itemId, linkType: 'made-from', to: block.id }, user);
    const { issue } = send({ from: block.id });
    expect(store.query({ kinds: ['todo'] }).map((each) => each.id)).toEqual([todo.itemId]);
    expect(read(todo.itemId).detail).toMatchObject({ origin: 'linear', backedBy: issue.id });
    // Still the Block's Todo.
    expect(store.blockTodos({ todoIds: [todo.itemId] })).toHaveLength(1);
  });
});

describe('from the Linear Section', () => {
  it('files the issue as the dialog says (the Project filter’s Project), or leaves it Unfiled', () => {
    expect(send({ filing: { projectId: tx, filedBy: 'user' } }).issue.filing).toEqual({
      projectId: tx,
      filedBy: 'user',
    });
    expect(send().issue.filing).toBeNull();
  });
});

describe('once Linear has made it', () => {
  // What the sync engine does with Linear's answer: settles the queued creation and saves the issue.
  function created(issue: Item, changes: Partial<LinearIssueDetail> = {}): SourceItem {
    const detail = {
      ...detailOf(issue),
      identifier: 'ENG-512',
      url: 'https://linear.app/x/ENG-512',
      ...changes,
    };
    return { externalId: issue.externalId as string, kind: 'linear-issue', title: issue.title, detail };
  }
  const answer = (issue: Item, changes: Partial<LinearIssueDetail> = {}) => {
    tick();
    store.transaction(() => {
      store.outgoing.settle(store.outgoing.forItem(issue.id).map((row) => row.id));
      store.saveFromSource({ source: 'linear', account: ACME, items: [created(issue, changes)], me: ME });
    });
  };

  it('is the same Item, numbered as Linear numbered it; nothing is duplicated', () => {
    const todo = addTodo('Write the runbook');
    const { issue } = send({ from: todo.id });
    answer(issue);
    expect(store.query({ kinds: ['linear-issue'] })).toHaveLength(1);
    expect(detailOf(read(issue.id)).identifier).toBe('ENG-512');
    expect(store.query({ kinds: ['todo'] })).toHaveLength(1);
    expect(read(todo.id).detail).toMatchObject({ backedBy: issue.id });
  });

  it('is re-checked with the open Linear Todos only once it is in Linear', () => {
    const { issue } = send();
    expect(store.recheckIds({ source: 'linear', account: ACME })).toEqual([]);
    answer(issue);
    expect(store.recheckIds({ source: 'linear', account: ACME })).toEqual([issue.externalId]);
  });

  it('keeps its inherited Project when a Rule files the same team into that Project, and follows a Rule elsewhere', () => {
    const when = {
      join: 'and' as const,
      terms: [{ field: 'linear.team', op: 'is' as const, value: 'team-eng', label: 'ENG' }],
    };
    store.changeRule({ type: 'create', rule: { target: { kind: 'project', projectId: lt }, when } });
    const block = addBlock('Write the runbook', lt);
    const { issue } = send({ from: block.id });
    answer(issue);
    expect(read(issue.id).filing).toEqual({ projectId: lt, filedBy: 'inherited' });

    const other = send({ from: addBlock('Elsewhere', tx).id, title: 'Elsewhere' }).issue;
    answer(other);
    expect(read(other.id).filing).toEqual({ projectId: lt, filedBy: 'rule' });
  });
});

describe('undo', () => {
  it('deletes the issue, queues its deletion in Linear, and restores the Todo as it was', () => {
    const todo = addTodo('runbook', lt);
    const before = read(todo.id);
    const { issue, entries } = send({ from: todo.id, title: 'Write the runbook' });
    tick();
    undoAll(entries);
    expect(read(issue.id).deletedAt).not.toBeNull();
    expect(store.outgoing.forItem(issue.id).map((row) => [row.field, row.value])).toEqual([
      ['create', expect.anything()],
      ['delete', true],
    ]);
    const after = read(todo.id);
    expect({ ...after, updatedAt: 0 }).toEqual({ ...before, updatedAt: 0 });
    expect(store.get(todo.id)?.backlinks).toEqual([]);
  });

  it('brings back a Todo the send removed, and removes a Todo the send made', () => {
    const todo = addTodo('Write the runbook');
    const removed = send({ from: todo.id, assignee: priya });
    undoAll(removed.entries);
    expect(read(todo.id)).toMatchObject({ deletedAt: null, detail: { origin: 'manual', backedBy: null } });

    const block = addBlock('Plan the offsite');
    const made = send({ from: block.id, title: 'Plan the offsite' });
    undoAll(made.entries);
    expect(store.query({ kinds: ['todo'] }).map((each) => each.title)).toEqual(['Write the runbook']);
    expect(store.get(block.id)?.backlinks).toEqual([]);
  });

  it('keeps the issue deleted when a sync brings it before the deletion reaches Linear', () => {
    const { issue, entries } = send();
    undoAll(entries);
    tick();
    const detail = { ...detailOf(issue), identifier: 'ENG-512' };
    store.saveFromSource({
      source: 'linear',
      account: ACME,
      items: [{ externalId: issue.externalId as string, kind: 'linear-issue', title: issue.title, detail }],
    });
    expect(read(issue.id).deletedAt).not.toBeNull();
  });
});

describe('where the dialog starts', () => {
  const when = (teamId: string) => ({
    join: 'and' as const,
    terms: [{ field: 'linear.team', op: 'is' as const, value: teamId, label: teamId }],
  });

  it('titles the issue after the Todo or Block, and picks the team from the first Rule for its Project', () => {
    store.changeRule({
      type: 'create',
      rule: { target: { kind: 'project', projectId: tx }, when: when('team-eng') },
    });
    store.changeRule({
      type: 'create',
      rule: { target: { kind: 'project', projectId: lt }, when: when('team-ops') },
    });
    const todo = addTodo('Write the runbook', lt);
    expect(store.linearSendPrefill({ from: todo.id })).toEqual({
      title: 'Write the runbook',
      projectId: lt,
      team: { account: ACME, teamId: 'team-ops' },
    });
    const block = addBlock('**Plan** the offsite #TX', tx);
    expect(store.linearSendPrefill({ from: block.id })).toMatchObject({
      title: 'Plan the offsite',
      projectId: tx,
      team: { account: ACME, teamId: 'team-eng' },
    });
  });

  it('falls back to the last team the User sent to, and starts empty from the Linear Section', () => {
    expect(store.linearSendPrefill({ projectId: null })).toEqual({ title: '', projectId: null, team: null });
    send({ team: OPS });
    expect(store.linearSendPrefill({ projectId: lt })).toEqual({
      title: '',
      projectId: lt,
      team: { account: ACME, teamId: 'team-ops' },
    });
  });
});
