import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, LinearIssueDetail, Project } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { learnAppearances } from './learn-appearances';

// People-to-Project facts learned from where People appear (#74, #25): a person on many of the Items
// the User (or a Rule) filed under one Project works mostly on it. Code, not a model. Unconfirmed until
// the User confirms them, so only ever background to Ares; they help filing but never act as Rules.

const user: ActionContext = { by: { kind: 'user' } };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const SAM = { id: 'user-sam', name: 'Sam Lee', displayName: 'sam', email: 'sam@acme.test' };

let dir: string;
let clock: number;
let store: ItemStore;
let tl: Project;
let tx: Project;
let n = 0;

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

// An issue assigned to someone, filed by the User (or Ares) under a Project.
function filedIssue(assignee: typeof PRIYA, projectId: string, filedBy: 'user' | 'ares' = 'user'): string {
  n += 1;
  clock += 1000;
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier: `OPS-${n}`,
    url: `https://linear.app/acme/issue/OPS-${n}`,
    team: OPS,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee,
    creator: null,
    labels: [],
    cycle: null,
    linearProject: null,
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
  const id = store.saveFromSource({
    source: 'linear',
    account: 'linear:org-acme',
    items: [{ externalId: `i${n}`, kind: 'linear-issue', title: `Issue ${n}`, detail }],
  }).created[0] as string;
  store.record(
    { type: 'update', itemId: id, changes: { filing: { projectId, filedBy } } },
    filedBy === 'ares' ? { by: { kind: 'ares' } } : user,
  );
  return id;
}

const facts = () => store.memory.list().memories.filter((memory) => memory.kind === 'fact');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-learn-appearances-'));
  clock = Date.UTC(2026, 9, 4, 9);
  n = 0;
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('learning where People work from where they appear', () => {
  it('learns that someone on most of the Items filed under one Project works mostly on it, unconfirmed', () => {
    const onTl = [filedIssue(PRIYA, tl.id), filedIssue(PRIYA, tl.id), filedIssue(PRIYA, tl.id)];
    filedIssue(PRIYA, tx.id);
    // Ares's own filings never count, so he never learns from himself.
    filedIssue(SAM, tx.id, 'ares');
    filedIssue(SAM, tx.id, 'ares');
    filedIssue(SAM, tx.id, 'ares');

    expect(learnAppearances(store)).toBe(1);
    const priya = store.people.list().find((person) => person.name === 'Priya Patel');
    expect(facts()).toEqual([
      expect.objectContaining({
        text: 'Priya Patel works mostly on TL (Titanlink): on 3 of the 4 filed Items with them',
        confirmed: false,
        personId: priya?.id,
        projectId: tl.id,
      }),
    ]);
    expect(
      facts()[0]
        ?.sources.map((source) => source.itemId)
        .sort(),
    ).toEqual([...onTl].sort());
    // Found by any of her handles.
    expect(store.memory.lookup({ text: '', handles: ['priya@acme.test'] })).toHaveLength(1);

    // Learned once; as more appear, the same fact follows them.
    expect(learnAppearances(store)).toBe(0);
    filedIssue(PRIYA, tl.id);
    learnAppearances(store);
    expect(facts().map((fact) => fact.text)).toEqual([
      'Priya Patel works mostly on TL (Titanlink): on 4 of the 5 filed Items with them',
    ]);

    // Deleted by the User, it is never learned again.
    store.memory.change({ type: 'delete', memoryId: facts()[0]?.id as string });
    filedIssue(PRIYA, tl.id);
    expect(learnAppearances(store)).toBe(0);
    expect(facts()).toEqual([]);
  });

  it('learns nothing from too few Items, or when someone’s Items are spread across Projects', () => {
    filedIssue(PRIYA, tl.id);
    filedIssue(PRIYA, tl.id);
    filedIssue(SAM, tl.id);
    filedIssue(SAM, tl.id);
    filedIssue(SAM, tx.id);
    filedIssue(SAM, tx.id);
    expect(learnAppearances(store)).toBe(0);
    expect(facts()).toEqual([]);
  });
});
