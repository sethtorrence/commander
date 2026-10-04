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

// The User's answers to Ares's filing, through the Core's filing module and the Item store, on a
// real database: Confirm on a dashed Badge files the Item by the User, Change files it elsewhere,
// `b` on an Item Ares filed re-files it, and each answer is recorded as a confirmation or a
// correction (Ares's suggestion, the User's choice, the Item), which add up to his filing record.

const user: ActionContext = { by: { kind: 'user' } };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };

let dir: string;
let store: ItemStore;
let gate: Gate;
let filing: Filing;
let tl: Project;
let tx: Project;
let next = 1;

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

function issue(title: string): string {
  const id = String(next++);
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier: `OPS-${id}`,
    url: `https://linear.app/acme/issue/OPS-${id}`,
    team: OPS,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee: null,
    creator: null,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
  return store.saveFromSource({
    source: 'linear',
    account: 'linear:org-acme',
    items: [{ externalId: id, kind: 'linear-issue', title, detail }],
  }).created[0] as string;
}

// A Teams Chat, as Teams sync saves it.
function chat(title: string): string {
  const id = `19:chat-${next++}`;
  return store.saveFromSource({
    source: 'teams',
    account: 'teams:tenant-1:u-sam',
    items: [
      {
        externalId: id,
        kind: 'chat',
        title,
        detail: {
          kind: 'chat',
          chatType: 'group',
          topic: title,
          webUrl: null,
          members: [],
          lastReadAt: null,
          hidden: false,
          joinUrl: null,
          messages: [],
          unreadCount: 0,
          mentionsMe: false,
          latestFromMe: false,
          lastMessageAt: null,
        },
      },
    ],
  }).created[0] as string;
}

// Ares's filing of an Item into a Project: confident (done at Auto when sure) or not (a suggestion).
function aresFiles(itemId: string, project: Project, confidence: number) {
  return gate.propose({
    actionKind: 'organise',
    action: FILE_INTO_PROJECTS,
    section: 'linear',
    itemId,
    itemActions: [
      { type: 'update', itemId, changes: { filing: { projectId: project.id, filedBy: 'ares' } } },
    ],
    confidence,
    reason: `Looks like ${project.name} work`,
  });
}

const suggestionOn = (itemId: string) => {
  const outcome = aresFiles(itemId, tx, 0.5);
  if (outcome.decision !== 'ask') throw new Error('Expected a suggestion');
  return outcome.suggestion.id;
};
const filingOf = (itemId: string) => store.get(itemId)?.item.filing ?? null;
const answers = (itemId: string) =>
  store
    .activity({ itemId })
    .filter((entry) => entry.action === 'correction' || entry.action === 'confirmation');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-filing-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
  gate = openGate({ itemStore: store });
  gate.registerAction({ action: FILE_INTO_PROJECTS, actionKind: 'organise', name: 'File into Projects' });
  filing = createFiling({ itemStore: store, gate });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('answering Ares’s filing', () => {
  it('Confirm files the Item by the User, and records a confirmation', () => {
    const item = issue('Pager rota');
    const proposalId = suggestionOn(item);

    const { proposal, entryId } = filing.settle(proposalId, tx.id);

    expect(proposal.status).toBe('accepted');
    expect(filingOf(item)).toEqual({ projectId: tx.id, filedBy: 'user' });
    expect(entryId).toBe(proposal.entryIds[0]);
    expect(store.get(item)?.item.filingSuggestion).toBeUndefined();
    const [confirmation] = answers(item);
    expect(confirmation).toMatchObject({ action: 'confirmation', by: { kind: 'user' } });
    expect(confirmation?.changes).toEqual([
      {
        field: 'filing',
        before: { projectId: tx.id, filedBy: 'ares' },
        after: { projectId: tx.id, filedBy: 'user' },
      },
    ]);
  });

  it('Change files it where the User chose, dismisses the suggestion and records a correction', () => {
    const item = issue('Pager rota');
    const proposalId = suggestionOn(item);

    const { proposal, entryId } = filing.settle(proposalId, tl.id);

    expect(proposal.status).toBe('dismissed');
    expect(filingOf(item)).toEqual({ projectId: tl.id, filedBy: 'user' });
    expect(store.entry(entryId as number)?.changes[0]).toMatchObject({ field: 'filing' });
    expect(
      answers(item).map((entry) => [entry.action, entry.changes[0]?.before, entry.changes[0]?.after]),
    ).toEqual([['correction', { projectId: tx.id, filedBy: 'ares' }, { projectId: tl.id, filedBy: 'user' }]]);
  });

  it('choosing Unfiled turns the suggestion down: a correction, and the Item stays Unfiled', () => {
    const item = issue('Pager rota');
    const proposalId = suggestionOn(item);

    const { proposal, entryId } = filing.settle(proposalId, null);

    expect(proposal.status).toBe('dismissed');
    expect(entryId).toBeNull();
    expect(filingOf(item)).toBeNull();
    expect(answers(item).map((entry) => [entry.action, entry.changes[0]?.after])).toEqual([
      ['correction', null],
    ]);
  });

  it('`b` on an Item Ares filed records a correction, or a confirmation when it keeps his Project', () => {
    const moved = issue('Relay latency');
    const kept = issue('Relay alerts');
    aresFiles(moved, tl, 0.95);
    aresFiles(kept, tl, 0.95);
    expect(filingOf(moved)).toEqual({ projectId: tl.id, filedBy: 'ares' });

    store.record(
      { type: 'update', itemId: moved, changes: { filing: { projectId: tx.id, filedBy: 'user' } } },
      user,
    );
    store.record(
      { type: 'update', itemId: kept, changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
      user,
    );

    expect(answers(moved).map((entry) => entry.action)).toEqual(['correction']);
    expect(answers(kept).map((entry) => entry.action)).toEqual(['confirmation']);
    // Filing it again by hand is between the User and the Item: Ares said nothing about it.
    store.record({ type: 'update', itemId: moved, changes: { filing: null } }, user);
    expect(answers(moved)).toHaveLength(1);
  });

  it('a Linear Todo filed with `b` answers for its issue', () => {
    const item = issue('Pager rota');
    aresFiles(item, tl, 0.95);
    const todo = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Pager rota',
          detail: { kind: 'todo', origin: 'linear', dueOn: null, backedBy: item },
        },
      },
      user,
    ).itemId;
    store.record(
      { type: 'update', itemId: todo, changes: { filing: { projectId: tx.id, filedBy: 'user' } } },
      user,
    );
    expect(answers(item).map((entry) => entry.action)).toEqual(['correction']);
  });

  it('answers can’t be undone, and the filing behind them can', () => {
    const item = issue('Pager rota');
    const { entryId } = filing.settle(suggestionOn(item), tl.id);
    const [correction] = answers(item);
    expect(() => store.record({ type: 'undo', entryId: correction?.id as number }, user)).toThrow(
      /what he learns from/,
    );
    store.record({ type: 'undo', entryId: entryId as number }, user);
    expect(filingOf(item)).toBeNull();
  });

  it('only a pending filing suggestion can be answered', () => {
    const item = issue('Pager rota');
    const proposalId = suggestionOn(item);
    gate.dismiss(proposalId);
    expect(() => filing.settle(proposalId, tx.id)).toThrow(/no longer waiting/);
  });

  it('accepting a suggestion the User or a Rule has since overruled dismisses it instead', () => {
    const item = issue('Pager rota');
    const proposalId = suggestionOn(item);
    store.record(
      { type: 'update', itemId: item, changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
      user,
    );
    expect(filing.dismissStale()).toEqual([proposalId]);
    expect(store.autonomy.proposal(proposalId)?.status).toBe('dismissed');

    const other = issue('Relay alerts');
    const stale = suggestionOn(other);
    store.record(
      { type: 'update', itemId: other, changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
      user,
    );
    expect(gate.accept(stale).status).toBe('dismissed');
    expect(filingOf(other)).toEqual({ projectId: tl.id, filedBy: 'user' });
  });

  it('adds up to Ares’s filing record: filed, suggested, confirmed and corrected', () => {
    const a = issue('A');
    const b = issue('B');
    const c = issue('C');
    const d = issue('D');
    aresFiles(a, tl, 0.95);
    aresFiles(b, tl, 0.95);
    filing.settle(suggestionOn(c), tx.id);
    filing.settle(suggestionOn(d), tl.id);
    store.record(
      { type: 'update', itemId: b, changes: { filing: { projectId: tx.id, filedBy: 'user' } } },
      user,
    );

    expect(filing.record()).toMatchObject({ filed: 2, suggested: 2, confirmed: 1, corrected: 2 });
  });

  it('breaks his record down by Source, so his filing on Teams can be read on its own', () => {
    const a = issue('A');
    const b = issue('B');
    aresFiles(a, tl, 0.95);
    filing.settle(suggestionOn(b), tx.id);
    const relay = chat('Relay rollout');
    const lunch = chat('Lunch');
    const pager = chat('Pager');
    aresFiles(relay, tl, 0.95);
    filing.settle(suggestionOn(lunch), null);
    filing.settle(suggestionOn(pager), tl.id);

    expect(filing.record()).toEqual({
      filed: 2,
      suggested: 3,
      confirmed: 1,
      corrected: 2,
      bySource: [
        { source: 'teams', filed: 1, suggested: 2, confirmed: 0, corrected: 2 },
        { source: 'linear', filed: 1, suggested: 1, confirmed: 1, corrected: 0 },
      ],
    });
  });
});
