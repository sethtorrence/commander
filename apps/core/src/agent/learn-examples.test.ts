import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  FILE_INTO_PROJECTS,
  type LinearIssueDetail,
  type Project,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { createFiling, type Filing } from './filing';
import { learnExamples } from './learn-examples';
import { SUGGEST_TODOS } from './suggest-todos';

// Examples (#74): the User's answers to Ares become example memories. Each correction and
// confirmation of his filing, and each Todo suggestion of his the User dismissed or undid, is
// learned once, as the User's own (confirmed), with the Item it was about as its source.

const user: ActionContext = { by: { kind: 'user' } };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let filing: Filing;
let tl: Project;
let tx: Project;

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

function issue(externalId: string, identifier: string, title: string): string {
  clock += 1000;
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier,
    url: `https://linear.app/acme/issue/${identifier}`,
    team: OPS,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee: { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' },
    creator: null,
    labels: [{ id: 'label-infra', name: 'infra', color: '#000000' }],
    cycle: null,
    linearProject: { id: 'lp-relay', name: 'Relay' },
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: clock,
    updatedAt: clock,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
  return store.saveFromSource({
    source: 'linear',
    account: 'linear:org-acme',
    items: [{ externalId, kind: 'linear-issue', title, detail }],
  }).created[0] as string;
}

// Ares's filing suggestion on an Item: the dashed Badge.
function suggestFiling(itemId: string, projectId: string): number {
  const outcome = gate.propose({
    itemId,
    action: FILE_INTO_PROJECTS,
    actionKind: 'organise',
    section: 'linear',
    itemActions: [{ type: 'update', itemId, changes: { filing: { projectId, filedBy: 'ares' } } }],
    confidence: 0.5,
    reason: 'Looks like Titanlink work',
  });
  if (outcome.decision !== 'ask') throw new Error('expected a suggestion');
  return outcome.suggestion.id;
}

function block(text: string): string {
  const note = store.ensureDailyNote('2026-10-04', user).id;
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: { kind: 'block', dailyNoteId: note, parentId: null, position: 'a0', text, folded: false },
      },
    },
    user,
  ).itemId;
}

function suggestTodo(blockId: string, title: string, confidence = 0.5) {
  return gate.propose({
    itemId: blockId,
    action: SUGGEST_TODOS,
    actionKind: 'organise',
    section: 'notes',
    itemActions: [
      {
        type: 'create',
        item: { kind: 'todo', title, detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null } },
      },
      { type: 'link', from: { step: 0 }, linkType: 'made-from', to: blockId },
    ],
    confidence,
    reason: 'You wrote it',
  });
}

const examples = () =>
  store.memory
    .list()
    .memories.filter((memory) => memory.kind === 'example')
    .map((memory) => ({
      text: memory.text,
      confirmed: memory.confirmed,
      sources: memory.sources.map((s) => s.itemId),
    }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-learn-examples-'));
  clock = Date.UTC(2026, 9, 4, 9);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store });
  gate.registerAction({ action: FILE_INTO_PROJECTS, actionKind: 'organise', name: 'File into Projects' });
  gate.registerAction({ action: SUGGEST_TODOS, actionKind: 'organise', name: 'Suggest Todos' });
  filing = createFiling({ itemStore: store, gate });
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('learning examples', () => {
  it('turns corrections and confirmations of Ares’s filing into examples, each once', () => {
    const corrected = issue('i1', 'OPS-1', 'Pager rota for October');
    const confirmed = issue('i2', 'OPS-2', 'Relay latency dashboard');
    const declined = issue('i3', 'OPS-3', 'Lunch order');
    filing.settle(suggestFiling(corrected, tl.id), tx.id);
    filing.settle(suggestFiling(confirmed, tl.id), tl.id);
    filing.settle(suggestFiling(declined, tl.id), null);

    expect(learnExamples(store)).toBe(3);
    expect(examples()).toEqual([
      {
        text: 'Linear issue OPS-3 (team OPS · Relay · infra) belongs to no Project, not TL (Titanlink)',
        confirmed: true,
        sources: [declined],
      },
      {
        text: 'Linear issue OPS-2 (team OPS · Relay · infra) belongs to TL (Titanlink)',
        confirmed: true,
        sources: [confirmed],
      },
      {
        text: 'Linear issue OPS-1 (team OPS · Relay · infra) belongs to TX (Tactics), not TL (Titanlink)',
        confirmed: true,
        sources: [corrected],
      },
    ]);
    // About the Project chosen, and the people on the Item; found by its title, though not shown.
    const example = store.memory
      .list()
      .memories.find((memory) => memory.text.startsWith('Linear issue OPS-1'));
    expect(example?.projectId).toBe(tx.id);
    expect(store.memory.lookup({ text: 'pager rota' }).map((memory) => memory.id)).toEqual([example?.id]);
    expect(store.memory.lookup({ text: '', handles: ['priya@acme.test'] })).toHaveLength(3);

    // Each is learned once, and one the User deleted stays deleted.
    expect(learnExamples(store)).toBe(0);
    store.memory.change({ type: 'delete', memoryId: example?.id as string });
    store.memory.saveProgress('examples:filing', 0);
    expect(learnExamples(store)).toBe(0);
    expect(examples()).toHaveLength(2);
  });

  it('turns a Todo suggestion the User dismissed, or a Todo of Ares’s the User undid, into an example', () => {
    const flights = block('maybe book flights for the offsite');
    const dentist = block('dentist was fine');
    const dismissed = suggestTodo(flights, 'Book flights for the offsite');
    if (dismissed.decision !== 'ask') throw new Error('expected a suggestion');
    gate.dismiss(dismissed.suggestion.id);
    gate.setLevel({ scope: 'everywhere', actionKind: 'organise' }, 'auto');
    const added = suggestTodo(dentist, 'Book the dentist', 0.95);
    if (added.decision !== 'auto') throw new Error('expected it carried out');
    gate.undo(added.done.id);
    // An accepted one teaches nothing.
    const kept = suggestTodo(block('need to call the bank'), 'Call the bank', 0.95);
    expect(kept.decision).toBe('auto');

    expect(learnExamples(store)).toBe(2);
    expect(examples()).toEqual(
      expect.arrayContaining([
        {
          text: 'Not a Todo: “maybe book flights for the offsite” (Ares suggested “Book flights for the offsite”)',
          confirmed: true,
          sources: [flights],
        },
        {
          text: 'Not a Todo: “dentist was fine” (Ares added “Book the dentist”, and the User undid it)',
          confirmed: true,
          sources: [dentist],
        },
      ]),
    );
    expect(learnExamples(store)).toBe(0);
  });
});
