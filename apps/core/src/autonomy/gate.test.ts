import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, Project, Proposal, RegisteredAction } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { type Gate, openGate } from './gate';

// The gate, tested through its interface on a real Item store over a temporary database. Proposals
// come from a fake proposer: fixtures shaped like the ones Ares's jobs will hand over.

const user: ActionContext = { by: { kind: 'user' } };

// The actions the fake proposer's jobs register.
const ACTIONS: RegisteredAction[] = [
  { action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' },
  { action: 'file-into-projects', actionKind: 'organise', name: 'File into Projects' },
  { action: 'archive-email', actionKind: 'tidy-sources', name: 'Archive email' },
  { action: 'move-hold', actionKind: 'tidy-sources', name: 'Move your calendar holds' },
  { action: 'update-linear-status', actionKind: 'act-for-you', name: 'Update Linear status' },
  { action: 'delete-email', actionKind: 'delete', name: 'Delete email' },
];

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let changes: number;
let block: string;
let email: string;
let issue: string;
let hold: string;

function openAll() {
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store, onChange: () => changes++ });
  for (const action of ACTIONS) gate.registerAction(action);
}

function created(entry: { itemId: string }) {
  return entry.itemId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-gate-'));
  clock = Date.UTC(2026, 9, 1, 12);
  changes = 0;
  openAll();
  block = created(
    store.record(
      {
        type: 'create',
        item: {
          kind: 'block',
          title: 'need to send Dana the Q3 numbers',
          detail: {
            kind: 'block',
            dailyNoteId: store.ensureDailyNote('2026-10-01', user).id,
            parentId: null,
            position: 'a0',
            text: 'need to send Dana the Q3 numbers',
            folded: false,
          },
        },
      },
      user,
    ),
  );
  const saved = store.saveFromSource({
    source: 'gmail',
    account: 'me@example.com',
    items: [{ externalId: 'm1', kind: 'email', title: 'Dana: the meeting moved to 3pm' }],
  });
  email = saved.created[0] as string;
  issue = store.saveFromSource({
    source: 'linear',
    account: 'me@example.com',
    items: [{ externalId: 'ENG-412', kind: 'linear-issue', title: 'Ship the Q3 report' }],
  }).created[0] as string;
  hold = store.saveFromSource({
    source: 'google-calendar',
    account: 'me@example.com',
    items: [{ externalId: 'e1', kind: 'event', title: 'Hold: Q3 review 2pm' }],
  }).created[0] as string;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// Fixture proposals, one per Action kind.
const suggestTodo = (overrides: Partial<Proposal> = {}): Proposal => ({
  actionKind: 'organise',
  action: 'suggest-todos',
  section: 'notes',
  itemId: block,
  itemActions: [
    {
      type: 'create',
      item: {
        kind: 'todo',
        title: 'Send Dana the Q3 numbers',
        detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
      },
    },
    { type: 'link', from: { step: 0 }, linkType: 'made-from', to: block },
  ],
  confidence: 0.9,
  reason: 'You wrote that you need to send Dana the Q3 numbers',
  causedBy: { itemId: block },
  ...overrides,
});

const archiveEmail = (overrides: Partial<Proposal> = {}): Proposal => ({
  actionKind: 'tidy-sources',
  action: 'archive-email',
  section: 'email',
  itemId: email,
  itemActions: [{ type: 'update', itemId: email, changes: { status: 'archived' } }],
  confidence: 0.95,
  reason: 'A notice you’ve read',
  causedBy: { itemId: email },
  ...overrides,
});

const markIssueDone = (overrides: Partial<Proposal> = {}): Proposal => ({
  actionKind: 'act-for-you',
  action: 'update-linear-status',
  section: 'linear',
  itemId: issue,
  itemActions: [{ type: 'update', itemId: issue, changes: { status: 'done' } }],
  confidence: 1,
  reason: 'The report went out this morning',
  ...overrides,
});

const deleteEmail = (overrides: Partial<Proposal> = {}): Proposal => ({
  actionKind: 'delete',
  action: 'delete-email',
  section: 'email',
  itemId: email,
  itemActions: [{ type: 'delete', itemId: email }],
  confidence: 1,
  reason: 'An old notice',
  ...overrides,
});

// "The meeting moved to 3pm" in Dana's email → move the User's hold: a chained suggestion.
const moveHold = (overrides: Partial<Proposal> = {}): Proposal => ({
  actionKind: 'tidy-sources',
  action: 'move-hold',
  section: 'calendar',
  itemId: hold,
  itemActions: [{ type: 'update', itemId: hold, changes: { title: 'Hold: Q3 review 3pm' } }],
  confidence: 1,
  reason: 'Dana says the meeting moved to 3pm',
  causedBy: { itemId: email },
  chained: true,
  ...overrides,
});

const titleOf = (id: string) => store.get(id)?.item.title;
const statusOf = (id: string) => store.get(id)?.item.status;
const todos = () => store.query({ kinds: ['todo'] });

function everythingAuto() {
  gate.setLevel({ scope: 'everywhere', actionKind: 'organise' }, 'auto');
  gate.setLevel({ scope: 'everywhere', actionKind: 'tidy-sources' }, 'auto');
  gate.setLevel({ scope: 'everywhere', actionKind: 'act-for-you' }, 'ask');
  gate.setLevel({ scope: 'everywhere', actionKind: 'delete' }, 'ask');
}

describe('propose', () => {
  it('drops a proposal whose Action kind is Off: nothing is stored and no Item changes', () => {
    const before = store.activity();
    expect(gate.propose(deleteEmail())).toEqual({ decision: 'off' });
    expect(store.get(email)?.item.deletedAt).toBeNull();
    expect(store.activity()).toEqual(before);
    expect(gate.activity()).toEqual([]);
  });

  it('keeps an Ask proposal as a pending suggestion on its Item, and changes nothing yet', () => {
    const before = store.activity();
    const outcome = gate.propose(archiveEmail());
    expect(outcome).toMatchObject({
      decision: 'ask',
      suggestion: { status: 'pending', itemId: email, reason: 'A notice you’ve read', entryIds: [] },
    });
    expect(gate.activity({ itemId: email, statuses: ['pending'] })).toMatchObject([
      {
        name: 'Archive email',
        actionKind: 'tidy-sources',
        section: 'email',
        item: { id: email, title: 'Dana: the meeting moved to 3pm' },
        status: 'pending',
      },
    ]);
    expect(statusOf(email)).toBe('open');
    expect(store.activity()).toEqual(before);
  });

  it('carries out an Auto proposal through the Item store as Ares, with the reason and the cause', () => {
    const outcome = gate.propose(suggestTodo({ confidence: 0.9 }));
    expect(outcome.decision).toBe('auto');

    const [todo] = todos();
    expect(todo).toMatchObject({ title: 'Send Dana the Q3 numbers', detail: { origin: 'ares' } });
    const view = store.get(todo?.id ?? '');
    expect(view?.links).toMatchObject([{ type: 'made-from', to: { id: block } }]);

    const entries = store.activity({ itemId: todo?.id }).reverse();
    expect(entries).toMatchObject([
      {
        action: 'create',
        by: { kind: 'ares' },
        why: 'You wrote that you need to send Dana the Q3 numbers',
        causedBy: { itemId: block },
      },
      { action: 'link', by: { kind: 'ares' }, causedBy: { itemId: block } },
    ]);
    expect(gate.activity()).toMatchObject([
      { name: 'Suggest Todos', decision: 'auto', status: 'done', entryIds: entries.map((entry) => entry.id) },
    ]);
  });

  it('keeps a less confident proposal as a suggestion at Auto when sure', () => {
    expect(gate.propose(suggestTodo({ confidence: 0.6 })).decision).toBe('ask');
    expect(todos()).toEqual([]);
  });

  it('follows the levels the User set', () => {
    gate.setLevel({ scope: 'everywhere', actionKind: 'organise' }, 'off');
    expect(gate.propose(suggestTodo()).decision).toBe('off');
    gate.setLevel({ scope: 'section', section: 'notes', actionKind: 'organise' }, 'ask');
    expect(gate.propose(suggestTodo()).decision).toBe('ask');
    gate.setLevel({ scope: 'action', action: 'suggest-todos' }, 'auto');
    expect(gate.propose(suggestTodo({ confidence: 0.1 })).decision).toBe('auto');
  });

  it('never carries out Act for you or Delete on its own, whatever the stored settings say', () => {
    store.autonomy.saveSettings({
      everywhere: { organise: 'auto', 'tidy-sources': 'auto', 'act-for-you': 'auto', delete: 'auto' },
      sections: {},
      actions: { 'delete-email': 'auto' },
    });
    expect(gate.propose(markIssueDone()).decision).toBe('ask');
    expect(gate.propose(deleteEmail()).decision).toBe('ask');
    expect(statusOf(issue)).toBe('open');
  });

  it('refuses a proposal for an action no job registered, or under the wrong Action kind', () => {
    expect(() => gate.propose(suggestTodo({ action: 'tidy-everything' }))).toThrow(/not registered/);
    expect(() => gate.propose(suggestTodo({ actionKind: 'tidy-sources' }))).toThrow(/is Organise/);
  });

  it('refuses a step that points at an Item no earlier step creates', () => {
    expect(() =>
      gate.propose(
        suggestTodo({ itemActions: [{ type: 'link', from: { step: 0 }, linkType: 'made-from', to: block }] }),
      ),
    ).toThrow(/step 0/);
  });

  it('never lets a delete step ride inside a proposal of another kind, at any settings', () => {
    const smuggled = suggestTodo({ itemActions: [{ type: 'delete', itemId: email }], confidence: 1 });
    // With the defaults (Delete Off) it is refused, so it doesn't even become a suggestion.
    expect(() => gate.propose(smuggled)).toThrow(/deletes, which is Delete/);
    // Nor with Organise at Auto and Delete raised to its limit, from Everywhere or the action.
    everythingAuto();
    gate.setLevel({ scope: 'action', action: 'suggest-todos' }, 'auto');
    expect(() => gate.propose(smuggled)).toThrow(/deletes, which is Delete/);
    expect(() => gate.propose(archiveEmail({ itemActions: [{ type: 'delete', itemId: email }] }))).toThrow(
      /deletes, which is Delete/,
    );
    expect(store.get(email)?.item.deletedAt).toBeNull();
    expect(gate.activity()).toEqual([]);
  });

  it('keeps Organise inside Commander: it may file an outside Item, but not change it at its Source', () => {
    gate.setLevel({ scope: 'everywhere', actionKind: 'organise' }, 'auto');
    const archiving = suggestTodo({
      itemId: email,
      itemActions: [{ type: 'update', itemId: email, changes: { status: 'archived' } }],
    });
    expect(() => gate.propose(archiving)).toThrow(/changes an Item at its Source/);
    expect(statusOf(email)).toBe('open');

    const longtail = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    }).project as Project;
    const filing = suggestTodo({
      action: 'file-into-projects',
      itemId: email,
      itemActions: [
        { type: 'update', itemId: email, changes: { filing: { projectId: longtail.id, filedBy: 'ares' } } },
      ],
    });
    expect(gate.propose(filing).decision).toBe('auto');
    // Commander's own Items (a Block, a Todo it creates) are Organise's to change.
    const renaming = suggestTodo({
      itemActions: [{ type: 'update', itemId: block, changes: { title: 'Send Dana the Q3 numbers' } }],
    });
    expect(gate.propose(renaming).decision).toBe('auto');
  });

  it('tells the Core when Ares did or suggested something', () => {
    gate.propose(deleteEmail());
    expect(changes).toBe(0);
    gate.propose(archiveEmail());
    gate.propose(suggestTodo());
    expect(changes).toBe(2);
  });
});

describe('Autonomy settings', () => {
  it('start at the defaults, and survive reopening', () => {
    expect(gate.settings().everywhere).toEqual({
      organise: 'auto-when-sure',
      'tidy-sources': 'ask',
      'act-for-you': 'ask',
      delete: 'off',
    });
    gate.setLevel({ scope: 'section', section: 'email', actionKind: 'tidy-sources' }, 'auto');
    gate.setLevel({ scope: 'action', action: 'suggest-todos' }, 'ask');
    store.close();
    openAll();
    expect(gate.settings()).toMatchObject({
      sections: { email: { 'tidy-sources': 'auto' } },
      actions: { 'suggest-todos': 'ask' },
    });
  });

  it('refuse a level above the hard limit, from Everywhere, a Section or a per-action override', () => {
    expect(() => gate.setLevel({ scope: 'everywhere', actionKind: 'act-for-you' }, 'auto')).toThrow(/Ask/);
    expect(() =>
      gate.setLevel({ scope: 'section', section: 'email', actionKind: 'delete' }, 'auto-when-sure'),
    ).toThrow(/Ask/);
    expect(() => gate.setLevel({ scope: 'action', action: 'delete-email' }, 'auto')).toThrow(/Ask/);
    expect(gate.settings().everywhere['act-for-you']).toBe('ask');
  });

  it('clear a Section or per-action override, but never the Everywhere level', () => {
    gate.setLevel({ scope: 'section', section: 'email', actionKind: 'tidy-sources' }, 'auto');
    gate.setLevel({ scope: 'section', section: 'email', actionKind: 'tidy-sources' }, null);
    gate.setLevel({ scope: 'action', action: 'suggest-todos' }, 'off');
    gate.setLevel({ scope: 'action', action: 'suggest-todos' }, null);
    expect(gate.settings()).toMatchObject({ sections: { email: {} }, actions: {} });
    expect(() => gate.setLevel({ scope: 'everywhere', actionKind: 'organise' }, null)).toThrow(/Everywhere/);
  });

  it('take per-action overrides only for registered actions', () => {
    expect(() => gate.setLevel({ scope: 'action', action: 'tidy-everything' }, 'ask')).toThrow(
      /not registered/,
    );
  });

  it('list the registered actions with their Action kinds', () => {
    expect(gate.actions()).toEqual(ACTIONS);
  });
});

// The id of the suggestion a proposal became.
function suggest(proposal: Proposal): number {
  const outcome = gate.propose(proposal);
  if (outcome.decision !== 'ask') throw new Error(`Expected a suggestion, got ${outcome.decision}`);
  return outcome.suggestion.id;
}

describe('accepting and dismissing suggestions', () => {
  it('accept carries the suggestion out as the User, with Ares’s reason and the cause', () => {
    const id = suggest(archiveEmail());
    const accepted = gate.accept(id);
    expect(accepted).toMatchObject({ status: 'accepted', settledAt: clock });
    expect(statusOf(email)).toBe('archived');
    expect(store.activity({ itemId: email })[0]).toMatchObject({
      id: accepted.entryIds[0],
      by: { kind: 'user' },
      why: 'A notice you’ve read',
      causedBy: { itemId: email },
    });
  });

  it('dismiss changes nothing, and a settled suggestion can’t be accepted or dismissed again', () => {
    const dismissed = suggest(archiveEmail());
    expect(gate.dismiss(dismissed)).toMatchObject({ status: 'dismissed', entryIds: [] });
    expect(statusOf(email)).toBe('open');
    expect(() => gate.accept(dismissed)).toThrow(/no longer waiting/);

    const accepted = suggest(markIssueDone());
    gate.accept(accepted);
    expect(() => gate.accept(accepted)).toThrow(/no longer waiting/);
    expect(() => gate.dismiss(accepted)).toThrow(/no longer waiting/);
    expect(() => gate.accept(999)).toThrow(/No suggestion 999/);
  });

  it('accepts Act for you and Delete suggestions one at a time', () => {
    gate.setLevel({ scope: 'everywhere', actionKind: 'delete' }, 'ask');
    gate.accept(suggest(markIssueDone()));
    gate.accept(suggest(deleteEmail()));
    expect(statusOf(issue)).toBe('done');
    expect(store.get(email)?.item.deletedAt).toBe(clock);
  });

  it('accept-all carries out Organise and Tidy your Sources suggestions together', () => {
    const ids = [suggest(suggestTodo({ confidence: 0.5 })), suggest(archiveEmail())];
    expect(gate.acceptAll(ids).map((record) => record.status)).toEqual(['accepted', 'accepted']);
    expect(todos()).toHaveLength(1);
    expect(statusOf(email)).toBe('archived');
  });

  it('refuses to accept Act for you or Delete suggestions in bulk, and then accepts none of them', () => {
    gate.setLevel({ scope: 'everywhere', actionKind: 'delete' }, 'ask');
    const tidy = suggest(archiveEmail());
    const actForYou = suggest(markIssueDone());
    expect(() => gate.acceptAll([tidy, actForYou])).toThrow(/one at a time/);
    expect(() => gate.acceptAll([suggest(deleteEmail())])).toThrow(/one at a time/);
    expect(statusOf(email)).toBe('open');
    expect(statusOf(issue)).toBe('open');
    expect(gate.activity({ statuses: ['pending'] })).toHaveLength(3);
  });

  it('accepts nothing when one suggestion in the batch is no longer waiting', () => {
    const first = suggest(archiveEmail());
    const second = suggest(suggestTodo({ confidence: 0.5 }));
    gate.dismiss(second);
    expect(() => gate.acceptAll([first, second])).toThrow(/no longer waiting/);
    expect(statusOf(email)).toBe('open');
  });
});

describe('chained proposals', () => {
  it('are always Ask, even at Auto and fully sure, and show what caused them', () => {
    everythingAuto();
    const outcome = gate.propose(moveHold());
    expect(outcome.decision).toBe('ask');
    expect(titleOf(hold)).toBe('Hold: Q3 review 2pm');
    expect(gate.activity({ itemId: hold })).toMatchObject([
      { chained: true, cause: { item: { id: email, title: 'Dana: the meeting moved to 3pm' } } },
    ]);
  });

  it('when accepted, carry out only their own step, with a caused-by Link to the Item behind them', () => {
    everythingAuto();
    const id = suggest(moveHold());
    const before = store.activity().length;
    const accepted = gate.accept(id);

    expect(titleOf(hold)).toBe('Hold: Q3 review 3pm');
    expect(store.get(hold)?.links).toMatchObject([{ type: 'caused-by', to: { id: email } }]);
    // The update and the caused-by Link, and nothing else: no further action, no new proposal.
    expect(accepted.entryIds).toHaveLength(2);
    expect(store.activity()).toHaveLength(before + 2);
    expect(gate.activity()).toHaveLength(1);
  });

  it('make whatever follows from them a fresh chained suggestion, never an automatic step', () => {
    everythingAuto();
    const accepted = gate.accept(suggest(moveHold()));
    // A job reacting to the moved hold proposes the next step, caused by that change.
    const next = gate.propose(
      archiveEmail({ chained: false, causedBy: { entryId: accepted.entryIds[0] }, confidence: 1 }),
    );
    expect(next).toMatchObject({ decision: 'ask', suggestion: { chained: true } });
    expect(statusOf(email)).toBe('open');
    // It shows the step it follows from.
    expect(gate.activity({ itemId: email })[0]?.cause).toMatchObject({
      item: { id: hold },
      entry: { id: accepted.entryIds[0] },
    });
  });
});

describe('Ares’s activity', () => {
  it('lists what Ares did and suggested, newest first, filtered by Action kind and Section', () => {
    gate.propose(suggestTodo());
    clock += 1000;
    gate.propose(archiveEmail());
    clock += 1000;
    gate.propose(markIssueDone());

    expect(gate.activity().map((row) => [row.name, row.status])).toEqual([
      ['Update Linear status', 'pending'],
      ['Archive email', 'pending'],
      ['Suggest Todos', 'done'],
    ]);
    expect(gate.activity({ actionKinds: ['tidy-sources'] }).map((row) => row.name)).toEqual([
      'Archive email',
    ]);
    expect(gate.activity({ section: 'notes' }).map((row) => row.name)).toEqual(['Suggest Todos']);
  });

  it('undoes an automatic action for as long as it hasn’t been undone', () => {
    const outcome = gate.propose(suggestTodo());
    if (outcome.decision !== 'auto') throw new Error('Expected Auto');
    expect(gate.activity()[0]?.undoable).toBe(true);

    const undone = gate.undo(outcome.done.id);
    expect(undone.undoable).toBe(false);
    expect(todos()).toEqual([]);
    expect(store.get(block)?.backlinks).toEqual([]);
    expect(store.activity()[0]).toMatchObject({ action: 'undo', by: { kind: 'user' } });
    expect(() => gate.undo(outcome.done.id)).toThrow(/can’t be undone/);
  });

  it('has nothing to undo for a suggestion still waiting', () => {
    const pending = suggest(archiveEmail());
    expect(gate.activity()[0]?.undoable).toBe(false);
    expect(() => gate.undo(pending)).toThrow(/can’t be undone/);
  });
});
