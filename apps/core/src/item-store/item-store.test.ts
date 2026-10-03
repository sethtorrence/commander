import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, ItemQuery, SourceBatch } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
// Stands for the Longtail Project's id in test tables, which is only known once it is created.
const LONGTAIL = '<longtail>';

let dir: string;
let clock: number;
const stores: ItemStore[] = [];

function open() {
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  stores.push(store);
  return store;
}

const gmailWork = { source: 'gmail', account: 'work@example.com' } as const;

function emails(...items: { externalId: string; title: string }[]): SourceBatch {
  return { ...gmailWork, items: items.map((item) => ({ ...item, kind: 'email' as const })) };
}

// Saves a Source batch and returns the id of the first Item it created.
function firstCreated(store: ItemStore, batch: SourceBatch): string {
  const [id] = store.saveFromSource(batch).created;
  if (!id) throw new Error('The batch created no Item');
  return id;
}

function latestEntry(store: ItemStore, itemId?: string) {
  const [entry] = store.activity({ itemId });
  if (!entry) throw new Error('No activity yet');
  return entry;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-item-store-'));
  clock = Date.UTC(2026, 9, 1, 12);
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('saving Items from a Source', () => {
  it('makes them queryable, and they survive reopening the database', () => {
    const store = open();
    store.saveFromSource(emails({ externalId: 'm1', title: 'Quarterly numbers' }));
    store.close();
    stores.length = 0;

    const reopened = open();
    expect(reopened.query()).toMatchObject([
      {
        kind: 'email',
        source: 'gmail',
        account: 'work@example.com',
        externalId: 'm1',
        title: 'Quarterly numbers',
        people: [],
        filing: null,
        status: 'open',
        detail: null,
        createdAt: clock,
        updatedAt: clock,
        deletedAt: null,
      },
    ]);
  });

  it('updates an Item the Source sends again instead of adding a second one', () => {
    const store = open();
    const first = store.saveFromSource(emails({ externalId: 'm1', title: 'Draft' }));
    clock += 1000;
    const second = store.saveFromSource(emails({ externalId: 'm1', title: 'Final' }));

    expect(second).toEqual({ created: [], updated: first.created, tombstoned: [], unchanged: [] });
    expect(store.query()).toMatchObject([{ title: 'Final', createdAt: clock - 1000, updatedAt: clock }]);
  });

  it('leaves an Item untouched when the Source sends it unchanged', () => {
    const store = open();
    const first = store.saveFromSource(emails({ externalId: 'm1', title: 'Same' }));
    clock += 1000;

    expect(store.saveFromSource(emails({ externalId: 'm1', title: 'Same' })).unchanged).toEqual(
      first.created,
    );
    expect(store.query()[0]?.updatedAt).toBe(clock - 1000);
  });

  it('keeps the same externalId from different Accounts apart', () => {
    const store = open();
    store.saveFromSource(emails({ externalId: 'm1', title: 'Work mail' }));
    store.saveFromSource({ ...emails({ externalId: 'm1', title: 'Home mail' }), account: 'me@home.example' });

    expect(store.query().map((item) => item.title)).toEqual(
      expect.arrayContaining(['Work mail', 'Home mail']),
    );
  });

  it('records each change in the activity log as made by the Source', () => {
    const store = open();
    const id = firstCreated(store, emails({ externalId: 'm1', title: 'Draft' }));
    clock += 1000;
    store.saveFromSource(emails({ externalId: 'm1', title: 'Final' }));
    store.saveFromSource(emails({ externalId: 'm1', title: 'Final' }));

    const by = { kind: 'source', source: 'gmail', account: 'work@example.com' };
    expect(store.activity({ itemId: id })).toMatchObject([
      { action: 'update', by, itemId: id, at: clock, why: null, causedBy: null, undoes: null },
      { action: 'create', by, itemId: id, at: clock - 1000 },
    ]);
  });
});

describe('querying Items', () => {
  function stocked() {
    const store = open();
    const longtail = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    });
    store.saveFromSource(emails({ externalId: 'm1', title: 'Longtail invoice' }));
    clock += 1;
    store.saveFromSource({
      source: 'linear',
      account: 'acme',
      items: [{ externalId: 'ENG-1', kind: 'linear-issue', title: 'Ship tactics', status: 'done' }],
    });
    clock += 1;
    const todo = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Call the LONGTAIL bank' } },
      user,
    );
    store.record(
      {
        type: 'update',
        itemId: todo.itemId,
        changes: { filing: { projectId: longtail.id, filedBy: 'user' } },
      },
      user,
    );
    return { store, longtail };
  }

  const titles = (items: { title: string }[]) => items.map((item) => item.title);

  it('returns the most recently changed first', () => {
    expect(titles(stocked().store.query())).toEqual([
      'Call the LONGTAIL bank',
      'Ship tactics',
      'Longtail invoice',
    ]);
  });

  it.each<[ItemQuery, string[]]>([
    [{ kinds: ['email', 'todo'] }, ['Call the LONGTAIL bank', 'Longtail invoice']],
    [{ projectId: LONGTAIL }, ['Call the LONGTAIL bank']],
    [{ projectId: null }, ['Ship tactics', 'Longtail invoice']],
    [{ source: 'linear' }, ['Ship tactics']],
    [{ account: 'work@example.com' }, ['Longtail invoice']],
    [{ statuses: ['done'] }, ['Ship tactics']],
    [{ titleContains: 'longtail' }, ['Call the LONGTAIL bank', 'Longtail invoice']],
    [{ titleContains: '%' }, []],
    [{ limit: 1 }, ['Call the LONGTAIL bank']],
  ])('filters by %j', (query, expected) => {
    const { store, longtail } = stocked();
    const projectId = query.projectId === LONGTAIL ? longtail.id : query.projectId;
    expect(titles(store.query({ ...query, projectId }))).toEqual(expected);
  });
});

describe('Items deleted at their Source', () => {
  it('become tombstones, hidden from queries unless asked for', () => {
    const store = open();
    const id = firstCreated(store, emails({ externalId: 'm1', title: 'Gone soon' }));
    clock += 1000;

    expect(store.saveFromSource({ ...gmailWork, deleted: ['m1'] }).tombstoned).toEqual([id]);
    expect(store.query()).toEqual([]);
    expect(store.query({ includeDeleted: true })).toMatchObject([
      { id, title: 'Gone soon', deletedAt: clock },
    ]);
    expect(store.activity({ itemId: id })[0]).toMatchObject({ action: 'tombstone', by: { kind: 'source' } });
  });

  it('keep their Links and history', () => {
    const store = open();
    const email = firstCreated(store, emails({ externalId: 'm1', title: 'Contract' }));
    const todo = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Sign the contract' } },
      user,
    ).itemId;
    store.link({ from: todo, linkType: 'made-from', to: email }, user);

    store.saveFromSource({ ...gmailWork, deleted: ['m1'] });

    expect(store.get(todo)?.links).toMatchObject([
      { type: 'made-from', to: { id: email, title: 'Contract', source: 'gmail', deletedAt: clock } },
    ]);
    expect(store.get(email)?.backlinks).toMatchObject([{ type: 'made-from', from: { id: todo } }]);
    expect(store.activity({ itemId: email }).map((entry) => entry.action)).toEqual([
      'tombstone',
      'link',
      'create',
    ]);
  });

  it('come back when the Source sends them again', () => {
    const store = open();
    store.saveFromSource(emails({ externalId: 'm1', title: 'Restored from Trash' }));
    store.saveFromSource({ ...gmailWork, deleted: ['m1'] });
    store.saveFromSource(emails({ externalId: 'm1', title: 'Restored from Trash' }));

    expect(store.query()).toMatchObject([{ title: 'Restored from Trash', deletedAt: null }]);
  });

  it('ignores deletions of Items it never had, or has already tombstoned', () => {
    const store = open();
    store.saveFromSource(emails({ externalId: 'm1', title: 'Once' }));
    store.saveFromSource({ ...gmailWork, deleted: ['m1'] });

    expect(store.saveFromSource({ ...gmailWork, deleted: ['m1', 'never-seen'] }).tombstoned).toEqual([]);
  });
});

describe('removing an Account', () => {
  const linearAcme = { source: 'linear', account: 'linear:org-acme' } as const;
  const issues = (...externalIds: string[]): SourceBatch => ({
    ...linearAcme,
    items: externalIds.map((externalId) => ({
      externalId,
      kind: 'linear-issue' as const,
      title: externalId,
    })),
  });

  it('removes its Items, leaving notes and Todos with their Links shown as gone', () => {
    const store = open();
    const issue = firstCreated(store, issues('ENG-1'));
    store.saveFromSource(issues('ENG-2'));
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Ship ENG-1' } }, user).itemId;
    store.link({ from: todo, linkType: 'refers-to', to: issue }, user);
    clock += 1000;

    const removed = store.removeAccountItems(linearAcme, { ...user, why: 'Removed the Linear Account Acme' });

    expect(removed).toHaveLength(2);
    expect(store.query({ source: 'linear' })).toEqual([]);
    expect(store.query()).toMatchObject([{ id: todo, title: 'Ship ENG-1', deletedAt: null }]);
    expect(store.get(todo)?.links).toMatchObject([
      { type: 'refers-to', to: { id: issue, source: 'linear', deletedAt: clock } },
    ]);
    expect(store.activity({ itemId: issue })[0]).toMatchObject({
      action: 'delete',
      by: { kind: 'user' },
      why: 'Removed the Linear Account Acme',
    });
  });

  it('leaves other Accounts’ Items alone', () => {
    const store = open();
    store.saveFromSource(issues('ENG-1'));
    store.saveFromSource({ ...issues('OPS-1'), account: 'linear:org-globex' });
    store.saveFromSource(emails({ externalId: 'm1', title: 'Hello' }));

    store.removeAccountItems(linearAcme, user);

    expect(
      store
        .query()
        .map((item) => item.title)
        .sort(),
    ).toEqual(['Hello', 'OPS-1']);
  });
});

describe('recording actions made in Commander', () => {
  it('creates a Todo with its kind-specific detail', () => {
    const store = open();
    const issue = firstCreated(store, {
      source: 'linear',
      account: 'acme',
      items: [{ externalId: 'ENG-412', kind: 'linear-issue', title: 'Fix sync' }],
    });

    const entry = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Fix sync',
          detail: { kind: 'todo', origin: 'linear', dueOn: '2026-10-05', backedBy: issue },
        },
      },
      user,
    );

    expect(store.get(entry.itemId)?.item).toMatchObject({
      kind: 'todo',
      source: null,
      title: 'Fix sync',
      detail: { kind: 'todo', origin: 'linear', dueOn: '2026-10-05', backedBy: issue },
    });
    expect(entry).toMatchObject({ action: 'create', by: { kind: 'user' }, at: clock });
  });

  it('refuses detail that belongs to a different kind of Item', () => {
    const store = open();
    const action = {
      type: 'create',
      item: {
        kind: 'email',
        title: 'Hi',
        detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
      },
    } as const;

    expect(() => store.record(action, user)).toThrow(/detail/);
    expect(store.query()).toEqual([]);
  });

  it('files an Item into a Project, and a re-sync keeps the filing', () => {
    const store = open();
    const id = firstCreated(store, emails({ externalId: 'm1', title: 'Longtail invoice' }));
    const longtail = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    });
    const filing = { projectId: longtail.id, filedBy: 'rule' } as const;

    store.record({ type: 'update', itemId: id, changes: { filing } }, { by: { kind: 'rule', ruleId: 'r1' } });
    store.saveFromSource(emails({ externalId: 'm1', title: 'Longtail invoice (paid)' }));

    expect(store.query()).toMatchObject([{ title: 'Longtail invoice (paid)', filing }]);
    expect(store.activity({ itemId: id })).toMatchObject([
      { action: 'update', by: { kind: 'source' } },
      { action: 'update', by: { kind: 'rule', ruleId: 'r1' } },
      { action: 'create' },
    ]);
  });

  it('records why a change was made and what caused it', () => {
    const store = open();
    const email = firstCreated(store, emails({ externalId: 'm1', title: 'Can you review the deck?' }));
    const sync = latestEntry(store, email);

    const entry = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Review the deck' } },
      {
        by: { kind: 'ares' },
        why: 'The email asks for a review',
        causedBy: { itemId: email, entryId: sync.id },
      },
    );

    expect(store.activity({ itemId: entry.itemId })).toEqual([
      expect.objectContaining({
        by: { kind: 'ares' },
        why: 'The email asks for a review',
        causedBy: { itemId: email, entryId: sync.id },
      }),
    ]);
  });

  it('deletes an Item made in Commander but keeps its Links and history', () => {
    const store = open();
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Old idea' } }, user).itemId;
    const note = store.record(
      { type: 'create', item: { kind: 'block', title: 'See [[Old idea]]' } },
      user,
    ).itemId;
    store.link({ from: note, linkType: 'refers-to', to: todo }, user);

    store.record({ type: 'delete', itemId: todo }, user);

    expect(store.query().map((item) => item.id)).toEqual([note]);
    expect(store.get(note)?.links).toMatchObject([{ to: { id: todo, deletedAt: clock } }]);
    expect(store.activity({ itemId: todo }).map((entry) => entry.action)).toEqual([
      'delete',
      'link',
      'create',
    ]);
  });

  it('refuses to change an Item that does not exist', () => {
    const store = open();

    expect(() => store.record({ type: 'update', itemId: 'nope', changes: { title: 'x' } }, user)).toThrow(
      /No Item nope/,
    );
  });

  it('removes a Link, from both ends', () => {
    const store = open();
    const pr = store.record({ type: 'create', item: { kind: 'pull-request', title: '#2198' } }, user).itemId;
    const issue = store.record(
      { type: 'create', item: { kind: 'linear-issue', title: 'ENG-412' } },
      user,
    ).itemId;
    store.link({ from: pr, linkType: 'finishes', to: issue }, user);

    store.record({ type: 'unlink', from: pr, linkType: 'finishes', to: issue }, user);

    expect(store.get(pr)?.links).toEqual([]);
    expect(store.get(issue)?.backlinks).toEqual([]);
    expect(store.activity({ itemId: issue }).map((entry) => entry.action)).toEqual([
      'unlink',
      'link',
      'create',
    ]);
  });

  it('refuses to remove a Link that is not there', () => {
    const store = open();
    const pr = store.record({ type: 'create', item: { kind: 'pull-request', title: '#2198' } }, user).itemId;
    const issue = store.record(
      { type: 'create', item: { kind: 'linear-issue', title: 'ENG-412' } },
      user,
    ).itemId;

    expect(() => store.record({ type: 'unlink', from: pr, linkType: 'finishes', to: issue }, user)).toThrow(
      /No finishes Link/,
    );
  });

  it('refuses to link an Item to itself', () => {
    const store = open();
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Loop' } }, user).itemId;

    expect(() => store.link({ from: todo, linkType: 'about', to: todo }, user)).toThrow(/itself/);
  });
});

describe('what each activity entry changed', () => {
  it('lists the fields an update changed, with their values before and after', () => {
    const store = open();
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Pay rent' } }, user).itemId;

    const tick = store.record({ type: 'update', itemId: todo, changes: { status: 'done' } }, user);

    expect(tick.changes).toEqual([{ field: 'status', before: 'open', after: 'done' }]);
    expect(latestEntry(store, todo).changes).toEqual(tick.changes);
  });

  it('lists what an undo put back', () => {
    const store = open();
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Pay rent' } }, user).itemId;
    const tick = store.record({ type: 'update', itemId: todo, changes: { status: 'done' } }, user);

    const undo = store.record({ type: 'undo', entryId: tick.id }, user);

    expect(undo.changes).toEqual([{ field: 'status', before: 'done', after: 'open' }]);
  });

  it('lists nothing for a creation or a Link', () => {
    const store = open();
    const created = store.record({ type: 'create', item: { kind: 'todo', title: 'Pay rent' } }, user);
    const event = store.record({ type: 'create', item: { kind: 'event', title: 'Viewing' } }, user);

    const linked = store.link({ from: created.itemId, linkType: 'about', to: event.itemId }, user);

    expect([created.changes, linked.changes]).toEqual([[], []]);
  });
});

describe('undo', () => {
  function todoStore() {
    const store = open();
    const todo = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Write the brief' } },
      user,
    ).itemId;
    return { store, todo };
  }

  it('restores the state before a change', () => {
    const { store, todo } = todoStore();
    const done = store.record({ type: 'update', itemId: todo, changes: { status: 'done' } }, user);

    const undo = store.record({ type: 'undo', entryId: done.id }, user);

    expect(store.get(todo)?.item.status).toBe('open');
    expect(undo).toMatchObject({ action: 'undo', undoes: done.id, itemId: todo, by: { kind: 'user' } });
  });

  it('puts back only what the undone action changed', () => {
    const { store, todo } = todoStore();
    const tactics = store.changeProject({
      type: 'create',
      project: { name: 'Tactics', code: 'TX', accent: 'violet' },
    });
    const filing = { projectId: tactics.id, filedBy: 'ares' } as const;
    const filed = store.record(
      { type: 'update', itemId: todo, changes: { filing } },
      { by: { kind: 'ares' } },
    );
    store.record({ type: 'update', itemId: todo, changes: { title: 'Write the brief today' } }, user);

    store.record({ type: 'undo', entryId: filed.id }, user);

    expect(store.get(todo)?.item).toMatchObject({ filing: null, title: 'Write the brief today' });
  });

  it('of a creation deletes the Item, keeping its history', () => {
    const { store, todo } = todoStore();
    const created = latestEntry(store, todo);

    store.record({ type: 'undo', entryId: created.id }, user);

    expect(store.query()).toEqual([]);
    expect(store.get(todo)?.item.deletedAt).toBe(clock);
    expect(store.activity({ itemId: todo }).map((entry) => entry.action)).toEqual(['undo', 'create']);
  });

  it('of a deletion brings the Item back', () => {
    const { store, todo } = todoStore();
    const deleted = store.record({ type: 'delete', itemId: todo }, user);

    store.record({ type: 'undo', entryId: deleted.id }, user);

    expect(store.query()).toMatchObject([{ id: todo, deletedAt: null }]);
  });

  it('of a Link removes it, and of an unlink restores it', () => {
    const { store, todo } = todoStore();
    const event = store.record({ type: 'create', item: { kind: 'event', title: 'Kickoff' } }, user).itemId;
    const linked = store.link({ from: todo, linkType: 'about', to: event }, user);

    store.record({ type: 'undo', entryId: linked.id }, user);
    expect(store.get(todo)?.links).toEqual([]);

    const unlinked = store.link({ from: todo, linkType: 'about', to: event }, user);
    const removed = store.record({ type: 'unlink', from: todo, linkType: 'about', to: event }, user);
    store.record({ type: 'undo', entryId: removed.id }, user);
    expect(store.get(event)?.backlinks).toMatchObject([{ type: 'about', from: { id: todo } }]);
    expect(unlinked.action).toBe('link');
  });

  it('of an undo redoes the change', () => {
    const { store, todo } = todoStore();
    const done = store.record({ type: 'update', itemId: todo, changes: { status: 'done' } }, user);
    const undo = store.record({ type: 'undo', entryId: done.id }, user);

    store.record({ type: 'undo', entryId: undo.id }, user);

    expect(store.get(todo)?.item.status).toBe('done');
  });

  it('happens at most once per entry', () => {
    const { store, todo } = todoStore();
    const done = store.record({ type: 'update', itemId: todo, changes: { status: 'done' } }, user);
    store.record({ type: 'undo', entryId: done.id }, user);

    expect(() => store.record({ type: 'undo', entryId: done.id }, user)).toThrow(/already undone/);
  });

  it('refuses an entry that does not exist', () => {
    const { store } = todoStore();

    expect(() => store.record({ type: 'undo', entryId: 999 }, user)).toThrow(/No activity entry 999/);
  });

  it('of a Source change restores what the Source last sent', () => {
    const store = open();
    store.saveFromSource(emails({ externalId: 'm1', title: 'Original' }));
    store.saveFromSource(emails({ externalId: 'm1', title: 'Edited at the Source' }));
    const edit = latestEntry(store);

    store.record({ type: 'undo', entryId: edit.id }, user);

    expect(store.query()).toMatchObject([{ title: 'Original' }]);
  });
});

describe('daily snapshots', () => {
  const day = 24 * 60 * 60 * 1000;
  const snapshots = () => readdirSync(join(dir, 'snapshots')).sort();

  it('copies the database once a day into a file that opens with every Item', () => {
    const store = open();
    store.saveFromSource(emails({ externalId: 'm1', title: 'Keep me safe' }));

    const taken = store.takeDailySnapshot();
    expect(store.takeDailySnapshot()).toBeNull();

    expect(snapshots()).toEqual(['commander-2026-10-01.db']);
    expect(taken).toEqual({ path: join(dir, 'snapshots', 'commander-2026-10-01.db'), removed: [] });
    const copy = openItemStore({
      path: taken?.path ?? '',
      snapshotDir: join(dir, 'unused'),
      migrationsFolder,
    });
    stores.push(copy);
    expect(copy.query()).toMatchObject([{ title: 'Keep me safe' }]);
  });

  it('keeps only the last 7', () => {
    const store = open();
    for (let i = 0; i < 9; i++) {
      store.takeDailySnapshot();
      clock += day;
    }

    expect(snapshots()).toEqual([
      'commander-2026-10-03.db',
      'commander-2026-10-04.db',
      'commander-2026-10-05.db',
      'commander-2026-10-06.db',
      'commander-2026-10-07.db',
      'commander-2026-10-08.db',
      'commander-2026-10-09.db',
    ]);
  });
});
